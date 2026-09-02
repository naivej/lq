//! LyXServer refresh helpers (Deno `tests/refresh_test.ts`).

mod common;

use common::{IsolatedHome, WorkDir, json_stdout, run_cli_with_env};
use lq::{RefreshMode, RefreshPreStep, build_pipe_command, filter_responses, refresh_pre_step};
use std::sync::Mutex;

static ENV_LOCK: Mutex<()> = Mutex::new(());

fn lock_lyxsocket() -> std::sync::MutexGuard<'static, ()> {
    ENV_LOCK.lock().unwrap_or_else(|e| e.into_inner())
}

#[test]
fn refresh_save_reload_pre_step_returns_a_status() {
    let _guard = lock_lyxsocket();
    let status = refresh_pre_step("/tmp/test.lyx", RefreshMode::SaveReload);
    assert!(
        matches!(
            status,
            RefreshPreStep::Ok
                | RefreshPreStep::Disconnect
                | RefreshPreStep::Unconfirmed
                | RefreshPreStep::Error
        ),
        "refresh_pre_step must return a status, got: {status:?}"
    );
}

#[test]
fn refresh_reload_mode_has_no_pre_step() {
    assert_eq!(
        refresh_pre_step("/tmp/test.lyx", RefreshMode::Reload),
        RefreshPreStep::Ok
    );
}

#[test]
fn refresh_none_mode_has_no_pre_step() {
    assert_eq!(
        refresh_pre_step("/tmp/test.lyx", RefreshMode::None),
        RefreshPreStep::Ok
    );
}

#[test]
fn refresh_out_responses_filtered_by_client_name() {
    let mine = "lq1785486000000";
    let other = "lq1785485999000";
    let data = [
        format!("ERROR:{other}:buffer-reload:Command disabled"),
        format!("INFO:{mine}:buffer-write:"),
        format!("ERROR:{other}:buffer-switch X:Document not loaded"),
    ]
    .join("\n");
    assert_eq!(
        filter_responses(&data, mine).as_deref(),
        Some("INFO:lq1785486000000:buffer-write:")
    );
    assert_eq!(
        filter_responses("ERROR:lq1785486000000:buffer-reload:Command disabled", mine).as_deref(),
        Some("ERROR:lq1785486000000:buffer-reload:Command disabled")
    );
    assert_eq!(filter_responses(&data, "lq1785487000000"), None);
}

#[test]
fn refresh_client_name_filter_is_exact_not_prefix() {
    let data = "INFO:lq123:buffer-write:\nINFO:lq1234:buffer-write:";
    assert_eq!(
        filter_responses(data, "lq123").as_deref(),
        Some("INFO:lq123:buffer-write:")
    );
    assert_eq!(
        filter_responses(data, "lq1234").as_deref(),
        Some("INFO:lq1234:buffer-write:")
    );
}

#[test]
fn refresh_pipe_command_uses_colon_separated_func_arg_form() {
    let c = "lq123";
    assert_eq!(
        build_pipe_command(c, "buffer-write"),
        "LYXCMD:lq123:buffer-write\n"
    );
    assert_eq!(
        build_pipe_command(c, "buffer-switch C:\\Users\\Shifu\\file.lyx"),
        "LYXCMD:lq123:buffer-switch:C:\\Users\\Shifu\\file.lyx\n"
    );
    assert_eq!(
        build_pipe_command(c, "buffer-switch C:\\Users\\Shifu\\LyX 2.5\\file.lyx"),
        "LYXCMD:lq123:buffer-switch:C:\\Users\\Shifu\\LyX 2.5\\file.lyx\n"
    );
}

#[test]
fn cli_init_refresh_warns_when_lyxsocket_unreachable() {
    let home = IsolatedHome::new();
    let layouts = WorkDir::new();
    let work = WorkDir::new();
    let bogus = work
        .path()
        .join(format!("no-lyx-socket-{}", std::process::id()));
    let out = run_cli_with_env(
        &[
            "init",
            "--global",
            "--layouts-dir",
            layouts.path().to_str().expect("layout path is utf-8"),
            "--refresh",
            "save-reload",
        ],
        &home,
        work.path(),
        &[("LYXSOCKET", bogus.to_str().expect("socket path is utf-8"))],
    );
    assert_eq!(out.code, 0, "{}", out.stdout);
    let v = json_stdout(&out);
    assert_eq!(v["data"]["refresh"], "save-reload");
    let warnings = v["warnings"]
        .as_array()
        .expect("init JSON includes warnings");
    assert!(
        warnings.iter().any(|w| w.as_str().is_some_and(|s| {
            s.contains("requires a running LyX instance with LyXServer enabled")
                && s.contains("server could not be reached")
        })),
        "expected unreachable-server warning, got {warnings:?}"
    );
}

#[cfg(unix)]
mod unix_mock {
    use super::*;
    use std::io::{Read, Write};
    use std::os::unix::net::UnixListener;

    #[test]
    fn refresh_mock_server_save_reload_returns_ok_unix_socket() {
        let _guard = super::lock_lyxsocket();
        let tmp = std::env::temp_dir().join(format!(
            "lq_lyxsocket_{}_{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_nanos())
                .unwrap_or(0)
        ));
        std::fs::create_dir_all(&tmp).expect("mock temp dir");
        let socket_path = tmp.join("lyxsocket");
        let file_path = tmp.join("doc.lyx");
        std::fs::write(
            &file_path,
            "#LyX 2.5 created this file.\n\
\\begin_document\n\\begin_header\n\\end_header\n\
\\begin_body\n\\begin_layout Standard\nhi\n\\end_layout\n\\end_body\\end_document\n",
        )
        .expect("write mock lyx");

        let listener = UnixListener::bind(&socket_path).expect("bind mock lyxsocket");
        let server = std::thread::spawn(move || {
            let (mut conn, _) = listener.accept().expect("accept mock client");
            let mut data = Vec::new();
            let mut buf = [0u8; 4096];
            let mut saw_buffer_switch = false;
            let mut saw_buffer_write = false;
            loop {
                let n = match conn.read(&mut buf) {
                    Ok(0) | Err(_) => break,
                    Ok(n) => n,
                };
                data.extend_from_slice(&buf[..n]);
                while let Some(nl) = data.iter().position(|&b| b == b'\n') {
                    let line = String::from_utf8_lossy(&data[..nl]).trim().to_string();
                    data.drain(..=nl);
                    if line.starts_with("HELLO:") {
                        let _ = conn.write_all(b"HELLO:\n");
                    } else if let Some(lfun) = line.strip_prefix("LYXCMD:") {
                        if lfun.contains("buffer-switch") {
                            saw_buffer_switch = true;
                        }
                        if lfun.contains("buffer-write") {
                            saw_buffer_write = true;
                        }
                        let reply = format!("INFO:{lfun}:\n");
                        let _ = conn.write_all(reply.as_bytes());
                    } else if line.starts_with("BYE:") {
                        return (saw_buffer_switch, saw_buffer_write);
                    }
                }
            }
            (saw_buffer_switch, saw_buffer_write)
        });

        let previous = std::env::var("LYXSOCKET").ok();
        // SAFETY: ENV_LOCK is held; this test target is the only mutator of LYXSOCKET.
        unsafe {
            std::env::set_var("LYXSOCKET", &socket_path);
        }
        let status = refresh_pre_step(
            file_path.to_str().expect("file path is utf-8"),
            RefreshMode::SaveReload,
        );
        match previous {
            Some(value) => unsafe { std::env::set_var("LYXSOCKET", value) },
            None => unsafe { std::env::remove_var("LYXSOCKET") },
        }

        let (saw_switch, saw_write) = server.join().expect("mock server thread");
        let _ = std::fs::remove_dir_all(&tmp);
        assert_eq!(status, RefreshPreStep::Ok);
        assert!(
            saw_switch,
            "server must receive buffer-switch before the save"
        );
        assert!(saw_write, "server must receive buffer-write");
    }
}
