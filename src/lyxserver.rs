//! LyXServer client (Deno `lyxserver.ts`). Blocking I/O; no tokio (C5).

use std::fs;
use std::io::{self, Read, Write};
#[cfg(unix)]
use std::path::Path;
#[cfg(windows)]
use std::path::PathBuf;
#[cfg(windows)]
use std::thread;
use std::time::Duration;
#[cfg(windows)]
use std::time::{SystemTime, UNIX_EPOCH};

/// DL87 Option A: dispatch (`sent`) is reliable; a missing reply is unconfirmed, not failure.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct SendResult {
    pub sent: bool,
    pub confirmed: bool,
    pub errored: bool,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum RefreshMode {
    None,
    Reload,
    SaveReload,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum RefreshPreStep {
    Ok,
    Disconnect,
    Unconfirmed,
    Error,
}

/// First space becomes func/arg; arg runs to `\n` so `C:` stays intact (DL128).
pub fn build_pipe_command(client_name: &str, lfun: &str) -> String {
    let wire = match lfun.find(' ') {
        None => lfun.to_string(),
        Some(sep) => format!("{}:{}", &lfun[..sep], &lfun[sep + 1..]),
    };
    format!("LYXCMD:{client_name}:{wire}\n")
}

/// Last `INFO|ERROR:<client>:` line. Exact client name (DL82); not a prefix.
pub fn filter_responses(data: &str, client_name: &str) -> Option<String> {
    let info = format!("INFO:{client_name}:");
    let error = format!("ERROR:{client_name}:");
    data.split('\n')
        .filter(|line| !line.is_empty())
        .rfind(|line| line.starts_with(&info) || line.starts_with(&error))
        .map(str::to_string)
}

pub(crate) fn send_lyx_commands(lfuns: &[&str]) -> SendResult {
    #[cfg(windows)]
    {
        match discover_windows_pipe_path() {
            Some(base) => send_via_named_pipe(&base, lfuns),
            None => SendResult::default(),
        }
    }
    #[cfg(unix)]
    {
        match discover_unix_socket() {
            Some(path) => send_via_unix_socket(&path, lfuns),
            None => SendResult::default(),
        }
    }
    #[cfg(not(any(windows, unix)))]
    {
        let _ = lfuns;
        SendResult::default()
    }
}

pub(crate) fn check_lyx_server_available() -> bool {
    #[cfg(windows)]
    {
        match discover_windows_pipe_path() {
            Some(base) => probe_named_pipe(&base),
            None => false,
        }
    }
    #[cfg(unix)]
    {
        match discover_unix_socket() {
            Some(path) => send_via_unix_socket(&path, &["server-get-filename"]).sent,
            None => false,
        }
    }
    #[cfg(not(any(windows, unix)))]
    {
        false
    }
}

pub fn refresh_pre_step(file_path: &str, mode: RefreshMode) -> RefreshPreStep {
    if mode != RefreshMode::SaveReload {
        return RefreshPreStep::Ok;
    }
    let switch = format!("buffer-switch {}", absolute_file(file_path));
    let result = send_lyx_commands(&[switch.as_str(), "buffer-write"]);
    if !result.sent {
        RefreshPreStep::Disconnect
    } else if !result.confirmed {
        RefreshPreStep::Unconfirmed
    } else if result.errored {
        RefreshPreStep::Error
    } else {
        RefreshPreStep::Ok
    }
}

pub(crate) fn refresh_post_step(file_path: &str, mode: RefreshMode) -> Option<SendResult> {
    if mode == RefreshMode::None {
        return None;
    }
    let switch = format!("buffer-switch {}", absolute_file(file_path));
    Some(send_lyx_commands(&[switch.as_str(), "buffer-reload"]))
}

fn absolute_file(path: &str) -> String {
    std::path::absolute(path)
        .map(|p| p.to_string_lossy().into_owned())
        .unwrap_or_else(|_| path.to_string())
}

#[cfg(windows)]
fn now_millis() -> u128 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0)
}

fn env_nonempty(name: &str) -> Option<String> {
    match std::env::var(name) {
        Ok(value) if !value.is_empty() => Some(value),
        _ => None,
    }
}

fn is_error_response(resp: &str) -> bool {
    resp.starts_with("ERROR:") && !resp.contains("Command disabled")
}

// ---------------------------------------------------------------------------
// Windows named pipes
// ---------------------------------------------------------------------------

#[cfg(windows)]
fn discover_windows_pipe_path() -> Option<String> {
    if let Some(socket) = env_nonempty("LYXSOCKET") {
        return Some(socket);
    }
    let app_data = env_nonempty("APPDATA")?;
    let lyx_dir = PathBuf::from(app_data).join("LyX2.5");
    match fs::metadata(&lyx_dir) {
        Ok(meta) if meta.is_dir() => {}
        _ => return None,
    }
    if !is_lyx_running() {
        return None;
    }
    Some(lyx_dir.join("lyxpipe").to_string_lossy().into_owned())
}

#[cfg(windows)]
fn is_lyx_running() -> bool {
    use std::process::{Command, Stdio};
    let output = Command::new("tasklist")
        .args(["/fi", "IMAGENAME eq LyX.exe", "/nh"])
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .output();
    match output {
        Ok(out) => String::from_utf8_lossy(&out.stdout).contains("LyX.exe"),
        Err(_) => false,
    }
}

#[cfg(windows)]
fn win_pipe_path(base: &str, suffix: &str) -> String {
    let win_path = base.replace('/', "\\");
    format!(r"\\.\pipe\{win_path}{suffix}")
}

/// Wait until a pipe instance is connectable, then open with `std`.
/// `WaitNamedPipeW` is the timeout; the thread does not linger (JC2).
#[cfg(windows)]
fn open_named_pipe(path: &str, write: bool, timeout_ms: u32) -> io::Result<fs::File> {
    let wide: Vec<u16> = path.encode_utf16().chain(std::iter::once(0)).collect();
    // SAFETY: `wide` is a NUL-terminated UTF-16 pipe name; WaitNamedPipeW only
    // reads it for the duration of the call.
    let ready =
        unsafe { windows_sys::Win32::System::Pipes::WaitNamedPipeW(wide.as_ptr(), timeout_ms) };
    if ready == 0 {
        return Err(io::Error::last_os_error());
    }
    let mut opts = fs::OpenOptions::new();
    if write {
        opts.write(true);
    } else {
        opts.read(true);
    }
    opts.open(path)
}

#[cfg(windows)]
fn send_via_named_pipe(pipe_base: &str, lfuns: &[&str]) -> SendResult {
    let mut result = SendResult::default();
    for _ in 0..3 {
        if result.confirmed {
            break;
        }
        send_named_pipe_once(pipe_base, lfuns, &mut result);
    }
    result
}

#[cfg(windows)]
fn send_named_pipe_once(pipe_base: &str, lfuns: &[&str], result: &mut SendResult) {
    let in_pipe = win_pipe_path(pipe_base, ".in");
    let out_pipe = win_pipe_path(pipe_base, ".out");
    let client_name = format!("lq{}", now_millis());
    let mut in_file = match open_named_pipe(&in_pipe, true, 5000) {
        Ok(file) => file,
        Err(_) => return,
    };

    for lfun in lfuns {
        let line = build_pipe_command(&client_name, lfun);
        if in_file.write_all(line.as_bytes()).is_err() {
            return;
        }
        result.sent = true;

        let mut response = None;
        for delay in [50, 100, 200, 500, 1000] {
            thread::sleep(Duration::from_millis(delay));
            response = try_read_response(&out_pipe, &client_name);
            if response.is_some() {
                break;
            }
        }
        let Some(resp) = response else {
            return;
        };
        if is_error_response(&resp) {
            result.errored = true;
        }
    }
    result.confirmed = true;
}

#[cfg(windows)]
fn try_read_response(out_pipe: &str, client_name: &str) -> Option<String> {
    let mut out_file = match open_named_pipe(out_pipe, false, 2000) {
        Ok(file) => file,
        Err(_) => return None,
    };

    let mut data = String::new();
    let mut buf = [0u8; 512];
    for _ in 0..40 {
        match out_file.read(&mut buf) {
            Ok(0) => break,
            Ok(n) => data.push_str(&String::from_utf8_lossy(&buf[..n])),
            Err(err) => {
                if err.kind() == io::ErrorKind::BrokenPipe || err.raw_os_error() == Some(233) {
                    break;
                }
                break;
            }
        }
        thread::sleep(Duration::from_millis(30));
    }
    filter_responses(&data, client_name)
}

#[cfg(windows)]
fn probe_named_pipe(pipe_base: &str) -> bool {
    let in_pipe = win_pipe_path(pipe_base, ".in");
    let client_name = format!("lqprobe{}", now_millis());
    let mut in_file = match open_named_pipe(&in_pipe, true, 3000) {
        Ok(file) => file,
        Err(_) => return false,
    };
    let line = format!("LYXCMD:{client_name}:server-get-filename\n");
    in_file.write_all(line.as_bytes()).is_ok()
}

// ---------------------------------------------------------------------------
// Unix domain socket
// ---------------------------------------------------------------------------

#[cfg(unix)]
fn discover_unix_socket() -> Option<String> {
    if let Some(socket) = env_nonempty("LYXSOCKET") {
        return Some(socket);
    }
    let tmp = env_nonempty("TMPDIR").unwrap_or_else(|| "/tmp".into());
    let entries = fs::read_dir(&tmp).ok()?;
    for entry in entries.flatten() {
        let name = entry.file_name();
        let Some(name) = name.to_str() else {
            continue;
        };
        if !entry.file_type().ok().is_some_and(|t| t.is_dir()) || !name.starts_with("lyx_tmpdir") {
            continue;
        }
        let socket_path = Path::new(&tmp).join(name).join("lyxsocket");
        if let Ok(meta) = fs::metadata(&socket_path) {
            use std::os::unix::fs::FileTypeExt;
            let ft = meta.file_type();
            if ft.is_file() || ft.is_socket() {
                return Some(socket_path.to_string_lossy().into_owned());
            }
        }
    }
    None
}

#[cfg(unix)]
fn send_via_unix_socket(socket_path: &str, lfuns: &[&str]) -> SendResult {
    use std::os::unix::net::UnixStream;

    let stream = match UnixStream::connect(socket_path) {
        Ok(stream) => stream,
        Err(_) => return SendResult::default(),
    };
    if stream
        .set_read_timeout(Some(Duration::from_millis(5000)))
        .is_err()
        || stream
            .set_write_timeout(Some(Duration::from_millis(5000)))
            .is_err()
    {
        return SendResult::default();
    }

    let mut reader = LineReader {
        stream,
        leftover: String::new(),
    };
    if reader.send_line("HELLO:").is_err() {
        return SendResult::default();
    }
    match reader.read_line() {
        Ok(Some(hello)) if hello.starts_with("HELLO:") => {}
        _ => return SendResult::default(),
    }

    let mut result = SendResult::default();
    for lfun in lfuns {
        if reader.send_line(&format!("LYXCMD:{lfun}")).is_err() {
            return result;
        }
        result.sent = true;
        match reader.read_line() {
            Ok(Some(resp)) => {
                if is_error_response(&resp) {
                    result.errored = true;
                }
            }
            _ => return result,
        }
    }
    result.confirmed = true;
    let _ = reader.send_line("BYE:");
    result
}

#[cfg(unix)]
struct LineReader {
    stream: std::os::unix::net::UnixStream,
    leftover: String,
}

#[cfg(unix)]
impl LineReader {
    fn send_line(&mut self, line: &str) -> io::Result<()> {
        self.stream.write_all(line.as_bytes())?;
        self.stream.write_all(b"\n")
    }

    fn read_line(&mut self) -> io::Result<Option<String>> {
        let mut buf = [0u8; 4096];
        loop {
            if let Some(nl) = self.leftover.find('\n') {
                let line = self.leftover[..nl].to_string();
                self.leftover = self.leftover[nl + 1..].to_string();
                return Ok(Some(line));
            }
            match self.stream.read(&mut buf) {
                Ok(0) => {
                    if self.leftover.is_empty() {
                        return Ok(None);
                    }
                    let line = std::mem::take(&mut self.leftover);
                    return Ok(Some(line));
                }
                Ok(n) => self.leftover.push_str(&String::from_utf8_lossy(&buf[..n])),
                Err(err) if err.kind() == io::ErrorKind::TimedOut => return Ok(None),
                Err(err) => return Err(err),
            }
        }
    }
}
