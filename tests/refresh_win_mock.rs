#![cfg(windows)]
//! Windows named-pipe mock for `refresh_pre_step` (JC1 B).
//! Own test binary so `LYXSOCKET` does not race other refresh tests.

use lq::{RefreshMode, RefreshPreStep, refresh_pre_step};
use std::sync::Mutex;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{self, RecvTimeoutError};
use std::time::Duration;
use windows_sys::Win32::Foundation::{
    CloseHandle, ERROR_PIPE_CONNECTED, GetLastError, HANDLE, INVALID_HANDLE_VALUE, TRUE,
};
use windows_sys::Win32::Storage::FileSystem::{
    FlushFileBuffers, PIPE_ACCESS_INBOUND, PIPE_ACCESS_OUTBOUND, ReadFile, WriteFile,
};
use windows_sys::Win32::System::Pipes::{
    ConnectNamedPipe, CreateNamedPipeW, DisconnectNamedPipe, PIPE_WAIT, PeekNamedPipe,
};

static ENV_LOCK: Mutex<()> = Mutex::new(());

struct Seen {
    buffer_switch: bool,
    buffer_write: bool,
}

#[derive(Clone, Copy)]
struct SendHandle(HANDLE);
// SAFETY: each handle is used by one server thread; the test thread only
// CloseHandle's after join.
unsafe impl Send for SendHandle {}

fn wide(name: &str) -> Vec<u16> {
    name.encode_utf16().chain(std::iter::once(0)).collect()
}

fn create_pipe(path: &str, access: u32) -> HANDLE {
    let wide = wide(path);
    // SAFETY: `wide` is a NUL-terminated UTF-16 pipe name; null security
    // attributes use the default DACL. The caller checks the handle.
    // LyX uses INBOUND .in / OUTBOUND .out, byte mode, PIPE_WAIT (Server.cpp).
    unsafe {
        CreateNamedPipeW(
            wide.as_ptr(),
            access,
            PIPE_WAIT,
            1,
            4096,
            4096,
            50,
            std::ptr::null(),
        )
    }
}

fn connect_pipe(handle: SendHandle) -> bool {
    // SAFETY: `handle` is a live pipe from CreateNamedPipeW; null overlapped
    // means synchronous wait.
    let ok = unsafe { ConnectNamedPipe(handle.0, std::ptr::null_mut()) };
    if ok == TRUE {
        return true;
    }
    unsafe { GetLastError() == ERROR_PIPE_CONNECTED }
}

fn peek_available(handle: SendHandle) -> Result<u32, u32> {
    let mut avail = 0u32;
    // SAFETY: `handle` is a live pipe; null buffer means "size only".
    let ok = unsafe {
        PeekNamedPipe(
            handle.0,
            std::ptr::null_mut(),
            0,
            std::ptr::null_mut(),
            &mut avail,
            std::ptr::null_mut(),
        )
    };
    if ok == 0 {
        Err(unsafe { GetLastError() })
    } else {
        Ok(avail)
    }
}

fn read_available(handle: SendHandle, buf: &mut [u8]) -> Option<usize> {
    let mut n = 0u32;
    // SAFETY: `handle` is connected; `buf`/`n` are valid out params.
    let ok = unsafe {
        ReadFile(
            handle.0,
            buf.as_mut_ptr(),
            buf.len() as u32,
            &mut n,
            std::ptr::null_mut(),
        )
    };
    if ok == 0 || n == 0 {
        None
    } else {
        Some(n as usize)
    }
}

fn write_pipe(handle: SendHandle, msg: &str) {
    let mut written = 0u32;
    // SAFETY: `handle` is connected; `msg` lives for the call.
    unsafe {
        let _ = WriteFile(
            handle.0,
            msg.as_ptr(),
            msg.len() as u32,
            &mut written,
            std::ptr::null_mut(),
        );
        // DisconnectNamedPipe discards unread data. The client open lives on a
        // worker thread, so FlushFileBuffers waits until that thread actually
        // ReadFile's (same as LyX keeping the instance until the client drains).
        let _ = FlushFileBuffers(handle.0);
    }
}

fn disconnect_pipe(handle: SendHandle) {
    unsafe {
        let _ = DisconnectNamedPipe(handle.0);
    }
}

#[test]
fn refresh_mock_server_save_reload_returns_ok_named_pipe() {
    let _guard = ENV_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let base = format!(
        "lq_s9_{}_{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0)
    );
    let in_name = format!(r"\\.\pipe\{base}.in");
    let out_name = format!(r"\\.\pipe\{base}.out");

    let in_handle = SendHandle(create_pipe(&in_name, PIPE_ACCESS_INBOUND));
    assert_ne!(in_handle.0, INVALID_HANDLE_VALUE, "create .in pipe");
    let out_handle = SendHandle(create_pipe(&out_name, PIPE_ACCESS_OUTBOUND));
    assert_ne!(out_handle.0, INVALID_HANDLE_VALUE, "create .out pipe");

    let (tx, rx) = mpsc::channel::<String>();
    let seen = std::sync::Arc::new(std::sync::Mutex::new(Seen {
        buffer_switch: false,
        buffer_write: false,
    }));
    let stop = std::sync::Arc::new(AtomicBool::new(false));

    let out_stop = std::sync::Arc::clone(&stop);
    let out_thread = std::thread::spawn(move || {
        loop {
            if out_stop.load(Ordering::SeqCst) {
                break;
            }
            let msg = match rx.recv_timeout(Duration::from_millis(50)) {
                Ok(msg) => msg,
                Err(RecvTimeoutError::Timeout) => continue,
                Err(RecvTimeoutError::Disconnected) => break,
            };
            if !connect_pipe(out_handle) {
                break;
            }
            write_pipe(out_handle, &msg);
            disconnect_pipe(out_handle);
        }
    });

    let in_seen = std::sync::Arc::clone(&seen);
    let in_stop = std::sync::Arc::clone(&stop);
    let in_thread = std::thread::spawn(move || {
        if !connect_pipe(in_handle) {
            return;
        }
        let mut data = Vec::new();
        loop {
            if in_stop.load(Ordering::SeqCst) {
                break;
            }
            match peek_available(in_handle) {
                Err(_) => break,
                Ok(0) => {
                    std::thread::sleep(Duration::from_millis(5));
                    continue;
                }
                Ok(avail) => {
                    let n = (avail as usize).min(512);
                    let mut buf = [0u8; 512];
                    let Some(got) = read_available(in_handle, &mut buf[..n]) else {
                        break;
                    };
                    data.extend_from_slice(&buf[..got]);
                }
            }
            while let Some(nl) = data.iter().position(|&c| c == b'\n') {
                let line = String::from_utf8_lossy(&data[..nl]).trim().to_string();
                data.drain(..=nl);
                let Some(rest) = line.strip_prefix("LYXCMD:") else {
                    continue;
                };
                let mut parts = rest.splitn(3, ':');
                let Some(client) = parts.next() else {
                    continue;
                };
                let Some(func) = parts.next() else {
                    continue;
                };
                {
                    let mut seen = in_seen.lock().unwrap_or_else(|e| e.into_inner());
                    if func.contains("buffer-switch") {
                        seen.buffer_switch = true;
                    }
                    if func.contains("buffer-write") {
                        seen.buffer_write = true;
                    }
                }
                let _ = tx.send(format!("INFO:{client}:{func}:\n"));
            }
        }
        disconnect_pipe(in_handle);
    });

    std::thread::sleep(Duration::from_millis(50));
    let previous = std::env::var("LYXSOCKET").ok();
    // SAFETY: ENV_LOCK is held for this test.
    unsafe {
        std::env::set_var("LYXSOCKET", &base);
    }
    let tmp = std::env::temp_dir().join(format!("{base}.lyx"));
    std::fs::write(&tmp, "#LyX 2.5 created this file.\n").expect("write mock lyx");
    let status = refresh_pre_step(
        tmp.to_str().expect("file path is utf-8"),
        RefreshMode::SaveReload,
    );
    match previous {
        Some(value) => unsafe { std::env::set_var("LYXSOCKET", value) },
        None => unsafe { std::env::remove_var("LYXSOCKET") },
    }
    let _ = std::fs::remove_file(&tmp);
    stop.store(true, Ordering::SeqCst);
    let _ = std::fs::OpenOptions::new().read(true).open(&out_name);
    let _ = std::fs::OpenOptions::new().write(true).open(&in_name);
    let _ = in_thread.join();
    let _ = out_thread.join();
    unsafe {
        let _ = CloseHandle(in_handle.0);
        let _ = CloseHandle(out_handle.0);
    }

    let seen = seen.lock().unwrap_or_else(|e| e.into_inner());
    assert_eq!(status, RefreshPreStep::Ok);
    assert!(
        seen.buffer_switch,
        "server must receive buffer-switch before the save"
    );
    assert!(seen.buffer_write, "server must receive buffer-write");
}
