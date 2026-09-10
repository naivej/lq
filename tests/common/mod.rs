//! Shared integration-test harness (Deno `tests/helpers.ts`).
#![allow(dead_code)]
//!
//! Cargo compiles each `tests/*.rs` file as its own crate, so this lives in a
//! subdirectory and is `mod common`’d by those files.
//!
//! `LQ_DENO_BIN`: optional path to a Deno `lq` binary built from the oracle
//! pin in `dev_logs/rust/masterplan.md`. Unset → [`deno_bin`] / [`run_gold`]
//! return `None`. CI does not set it.

use serde_json::{Value, json};
use std::fs;
use std::path::{Path, PathBuf};
use std::process::{Command, Output};
use std::sync::atomic::{AtomicU64, Ordering};

static SEQ: AtomicU64 = AtomicU64::new(0);

fn next_id() -> u64 {
    SEQ.fetch_add(1, Ordering::Relaxed)
}

pub fn fixtures_root() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures")
}

fn unique_dir(prefix: &str) -> PathBuf {
    let path =
        std::env::temp_dir().join(format!("lq_{prefix}_{}_{}", std::process::id(), next_id()));
    fs::create_dir_all(&path).unwrap_or_else(|e| {
        panic!("failed to create {}: {e}", path.display());
    });
    path
}

/// Temp `HOME` / `USERPROFILE` (and Windows `HOMEDRIVE`/`HOMEPATH`).
pub struct IsolatedHome {
    path: PathBuf,
}

impl IsolatedHome {
    pub fn new() -> Self {
        let path = unique_dir("test_home");
        fs::create_dir_all(path.join(".lq")).unwrap_or_else(|e| {
            panic!("failed to create .lq under {}: {e}", path.display());
        });
        Self { path }
    }

    pub fn path(&self) -> &Path {
        &self.path
    }

    fn apply_env(&self, cmd: &mut Command) {
        let home = self.path.to_string_lossy();
        cmd.env("HOME", home.as_ref());
        cmd.env("USERPROFILE", home.as_ref());
        cmd.env_remove("LYXSOCKET");
        // Do not overwrite HOMEDRIVE/HOMEPATH. Deno's test helpers don't, and
        // `find_local_state_root` skips the canonical Windows home using those
        // variables (lessons §7). Overwriting them to the fake HOME makes the
        // real `%USERPROFILE%\.lq` look like a project marker when cwd is under
        // the profile (Windows Temp is).
        // Clear LYXSOCKET so an in-process Windows pipe mock (or a host override)
        // cannot leak into CLI children; tests that need a socket pass it via
        // extra_env.
    }
}

impl Drop for IsolatedHome {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.path);
    }
}

/// Temp cwd for a CLI spawn. Default `run_cli` uses this so a later `init`
/// cannot drop `.lq/` on the crate or parent repo root.
pub struct WorkDir {
    path: PathBuf,
}

impl WorkDir {
    pub fn new() -> Self {
        Self {
            path: unique_dir("test_cwd"),
        }
    }

    pub fn path(&self) -> &Path {
        &self.path
    }
}

impl Drop for WorkDir {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.path);
    }
}

/// Copy a fixture (relative to [`fixtures_root`]) into `work`.
pub fn temp_lyx(work: &WorkDir, relative: &str) -> PathBuf {
    let src = fixtures_root().join(relative);
    let name = src.file_name().unwrap_or_else(|| {
        panic!("fixture path has no file name: {}", src.display());
    });
    let dest = work.path().join(name);
    fs::copy(&src, &dest).unwrap_or_else(|e| {
        panic!("copy {} -> {}: {e}", src.display(), dest.display());
    });
    dest
}

pub struct CliOutput {
    pub stdout: String,
    pub stderr: String,
    pub code: i32,
}

impl CliOutput {
    fn from_output(output: Output) -> Self {
        Self {
            stdout: String::from_utf8_lossy(&output.stdout).into_owned(),
            stderr: String::from_utf8_lossy(&output.stderr).into_owned(),
            code: output.status.code().unwrap_or(1),
        }
    }
}

fn lq_bin() -> &'static str {
    env!("CARGO_BIN_EXE_lq")
}

/// Spawn the Rust `lq` binary with an isolated home and temp cwd.
pub fn run_cli(args: &[&str]) -> CliOutput {
    let home = IsolatedHome::new();
    let work = WorkDir::new();
    run_cli_with(args, &home, work.path())
}

pub fn run_cli_with(args: &[&str], home: &IsolatedHome, cwd: &Path) -> CliOutput {
    run_cli_with_env(args, home, cwd, &[])
}

pub fn run_cli_with_env(
    args: &[&str],
    home: &IsolatedHome,
    cwd: &Path,
    extra_env: &[(&str, &str)],
) -> CliOutput {
    let mut cmd = Command::new(lq_bin());
    cmd.args(args).current_dir(cwd);
    home.apply_env(&mut cmd);
    for (key, value) in extra_env {
        cmd.env(key, value);
    }
    let output = cmd.output().unwrap_or_else(|e| {
        panic!("failed to spawn {}: {e}", lq_bin());
    });
    CliOutput::from_output(output)
}

/// Spawn with HOME/USERPROFILE cleared (local init without a home).
pub fn run_cli_no_home(args: &[&str], cwd: &Path) -> CliOutput {
    let mut cmd = Command::new(lq_bin());
    cmd.args(args).current_dir(cwd);
    cmd.env("HOME", "");
    cmd.env("USERPROFILE", "");
    let output = cmd.output().unwrap_or_else(|e| {
        panic!("failed to spawn {}: {e}", lq_bin());
    });
    CliOutput::from_output(output)
}

pub fn json_stdout(out: &CliOutput) -> serde_json::Value {
    serde_json::from_str(out.stdout.trim()).unwrap_or_else(|e| {
        panic!("stdout not JSON ({e}): {}", out.stdout);
    })
}

pub fn deno_bin() -> Option<PathBuf> {
    std::env::var_os("LQ_DENO_BIN").map(PathBuf::from)
}

/// Spawn the Deno gold binary with the same isolation as [`run_cli`].
/// `None` when `LQ_DENO_BIN` is unset.
pub fn run_gold(args: &[&str]) -> Option<CliOutput> {
    let bin = deno_bin()?;
    let home = IsolatedHome::new();
    let work = WorkDir::new();
    Some(run_gold_with(args, &bin, &home, work.path()))
}

/// `layoutsDir` from the host `~/.lq/config.json` (Deno `helpers.ts`).
pub fn host_layouts_dir() -> Option<String> {
    let real_home = std::env::var("USERPROFILE")
        .or_else(|_| std::env::var("HOME"))
        .ok()?;
    let text = fs::read_to_string(PathBuf::from(real_home).join(".lq/config.json")).ok()?;
    let v: Value = serde_json::from_str(&text).ok()?;
    v.get("layoutsDir")
        .and_then(Value::as_str)
        .map(str::to_owned)
}

/// Parse CLI stdout JSON the way Deno `runCliTest` does (including errors).
pub fn parse_cli_json(out: &CliOutput) -> Value {
    let trimmed = out.stdout.trim();
    serde_json::from_str(trimmed)
        .unwrap_or_else(|_| json!({ "message": format!("Failed to parse CLI output: {trimmed}") }))
}

pub fn path_arg(path: &Path) -> &str {
    path.to_str()
        .unwrap_or_else(|| panic!("path is not utf-8: {}", path.display()))
}

pub fn json_warnings(v: &Value) -> Vec<String> {
    v["warnings"]
        .as_array()
        .map(|arr| {
            arr.iter()
                .filter_map(|w| w.as_str().map(str::to_owned))
                .collect()
        })
        .unwrap_or_default()
}

/// Replace `\change_(inserted|deleted) <id> <ts>` so file compares ignore clocks.
pub fn normalize_change_markers(text: &str) -> String {
    let bytes = text.as_bytes();
    let mut out = String::with_capacity(text.len());
    let mut i = 0;
    while i < bytes.len() {
        let rest = &text[i..];
        let kind = if rest.starts_with("\\change_inserted ") {
            Some("inserted")
        } else if rest.starts_with("\\change_deleted ") {
            Some("deleted")
        } else {
            None
        };
        if let Some(kind) = kind {
            let prefix_len = 8 + kind.len() + 1; // \change_ + kind + space
            let after = &rest[prefix_len..];
            if let Some((id, ts_and_rest)) = after.split_once(' ')
                && id.bytes().all(|b| b.is_ascii_digit())
            {
                let ts: String = ts_and_rest
                    .chars()
                    .take_while(|c| c.is_ascii_digit())
                    .collect();
                if !ts.is_empty() {
                    out.push_str("\\change_");
                    out.push_str(kind);
                    out.push_str(" N TS");
                    i += prefix_len + id.len() + 1 + ts.len();
                    continue;
                }
            }
        }
        let ch = rest.chars().next().unwrap();
        out.push(ch);
        i += ch.len_utf8();
    }
    out
}

/// Isolated HOME + cwd with Deno mutation-test config (`refresh: none`, tracking off).
pub struct MutationSession {
    pub home: IsolatedHome,
    pub work: WorkDir,
}

impl MutationSession {
    pub fn new() -> Self {
        Self::with_config(json!({}))
    }

    pub fn with_config(overrides: Value) -> Self {
        let home = IsolatedHome::new();
        let work = WorkDir::new();
        let mut cfg = json!({
            "refresh": "none",
            "trackChanges": false,
        });
        if let Some(dir) = host_layouts_dir() {
            cfg["layoutsDir"] = json!(dir);
        }
        if let Value::Object(base) = &mut cfg
            && let Value::Object(over) = overrides
        {
            for (k, v) in over {
                base.insert(k, v);
            }
        }
        fs::write(home.path().join(".lq/config.json"), cfg.to_string()).unwrap();
        Self { home, work }
    }

    pub fn tracked(author: &str) -> Self {
        Self::with_config(json!({
            "trackChanges": true,
            "authorName": author,
        }))
    }

    pub fn run(&self, args: &[&str]) -> Value {
        parse_cli_json(&run_cli_with(args, &self.home, self.work.path()))
    }

    pub fn run_env(&self, args: &[&str], extra_env: &[(&str, &str)]) -> Value {
        parse_cli_json(&run_cli_with_env(
            args,
            &self.home,
            self.work.path(),
            extra_env,
        ))
    }

    pub fn run_at(&self, args: &[&str], cwd: &Path) -> Value {
        parse_cli_json(&run_cli_with(args, &self.home, cwd))
    }

    /// Deno `writeTempLyx`.
    pub fn write_lyx(&self, name: &str, body: &str, header: &str) -> PathBuf {
        let path = self.work.path().join(name);
        fs::write(
            &path,
            format!(
                "#LyX 2.5 created this file.\n\
                 \\begin_document\n\
                 \\begin_header\n\
                 {header}\
                 \\end_header\n\
                 \\begin_body\n\
                 {body}\
                 \\end_body\n\
                 \\end_document\n"
            ),
        )
        .unwrap();
        path
    }

    pub fn write_file(&self, name: &str, contents: &str) -> PathBuf {
        let path = self.work.path().join(name);
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent).unwrap();
        }
        fs::write(&path, contents).unwrap();
        path
    }

    pub fn copy_fixture(&self, relative: &str, dest_name: &str) -> PathBuf {
        let src = fixtures_root().join(relative);
        let dest = self.work.path().join(dest_name);
        fs::copy(&src, &dest).unwrap_or_else(|e| {
            panic!("copy {} -> {}: {e}", src.display(), dest.display());
        });
        dest
    }

    pub fn template(&self, dest_name: &str) -> PathBuf {
        self.copy_fixture("my_template.lyx", dest_name)
    }
}

/// Deno `deletedRegionContainsInset`.
pub fn deleted_region_contains_inset(text: &str) -> bool {
    let mut markers: Vec<(usize, &str)> = Vec::new();
    let mut search = 0;
    while let Some(rel) = text[search..].find("\\change_") {
        let abs = search + rel;
        let rest = &text[abs + 8..];
        let kind = if rest.starts_with("deleted") {
            "deleted"
        } else if rest.starts_with("inserted") {
            "inserted"
        } else if rest.starts_with("unchanged") {
            "unchanged"
        } else {
            search = abs + 8;
            continue;
        };
        markers.push((abs, kind));
        search = abs + 8 + kind.len();
    }
    for (i, &(start_idx, kind)) in markers.iter().enumerate() {
        if kind != "deleted" {
            continue;
        }
        let start = start_idx + "\\change_deleted".len();
        for &(end_idx, end_kind) in &markers[i + 1..] {
            if end_kind == "unchanged" || end_kind == "inserted" {
                if text[start..end_idx].contains("\\begin_inset") {
                    return true;
                }
                break;
            }
        }
    }
    false
}

pub fn run_gold_with(args: &[&str], bin: &Path, home: &IsolatedHome, cwd: &Path) -> CliOutput {
    let mut cmd = Command::new(bin);
    cmd.args(args).current_dir(cwd);
    home.apply_env(&mut cmd);
    let output = cmd.output().unwrap_or_else(|e| {
        panic!("failed to spawn {}: {e}", bin.display());
    });
    CliOutput::from_output(output)
}

/// Shared HOME/cwd so Rust and Deno gold see the same argv paths (S12 JC1 B).
pub struct GoldSession {
    pub home: IsolatedHome,
    pub work: WorkDir,
    pub bin: PathBuf,
}

impl GoldSession {
    /// `None` when `LQ_DENO_BIN` is unset. Panics if it is set but not a file.
    pub fn new() -> Option<Self> {
        let bin = deno_bin()?;
        if !bin.is_file() {
            panic!("LQ_DENO_BIN is set ({}) but is not a file", bin.display());
        }
        let home = IsolatedHome::new();
        let work = WorkDir::new();
        let mut cfg = json!({
            "refresh": "none",
            "trackChanges": false,
        });
        if let Some(dir) = host_layouts_dir() {
            cfg["layoutsDir"] = json!(dir);
        }
        fs::write(home.path().join(".lq/config.json"), cfg.to_string()).unwrap();
        Some(Self { home, work, bin })
    }

    pub fn run_rust(&self, args: &[&str]) -> CliOutput {
        run_cli_with(args, &self.home, self.work.path())
    }

    pub fn run_gold(&self, args: &[&str]) -> CliOutput {
        run_gold_with(args, &self.bin, &self.home, self.work.path())
    }

    pub fn run_rust_at(&self, args: &[&str], cwd: &Path) -> CliOutput {
        run_cli_with(args, &self.home, cwd)
    }

    pub fn run_gold_at(&self, args: &[&str], cwd: &Path) -> CliOutput {
        run_gold_with(args, &self.bin, &self.home, cwd)
    }

    pub fn compare(&self, args: &[&str], label: &str) {
        compare_cli(&self.run_rust(args), &self.run_gold(args), label);
    }

    /// Preview JSON, ignoring intended deviation #2 (`</section>` on headings).
    pub fn compare_preview(&self, args: &[&str], label: &str) {
        compare_cli_preview(&self.run_rust(args), &self.run_gold(args), label);
    }

    pub fn copy_fixture(&self, relative: &str, dest_name: &str) -> PathBuf {
        let src = fixtures_root().join(relative);
        let dest = self.work.path().join(dest_name);
        if let Some(parent) = dest.parent() {
            fs::create_dir_all(parent).unwrap();
        }
        fs::copy(&src, &dest).unwrap_or_else(|e| {
            panic!("copy {} -> {}: {e}", src.display(), dest.display());
        });
        dest
    }
}

/// JSON parsed when both stdout values parse; otherwise stdout bytes.
/// Exit and stderr are always compared.
pub fn compare_cli(rust: &CliOutput, gold: &CliOutput, label: &str) {
    assert_eq!(
        rust.code, gold.code,
        "{label}: exit rust={} gold={}\nrust stderr: {}\ngold stderr: {}",
        rust.code, gold.code, rust.stderr, gold.stderr
    );
    assert_eq!(
        rust.stderr, gold.stderr,
        "{label}: stderr mismatch\nrust: {:?}\ngold: {:?}",
        rust.stderr, gold.stderr
    );
    let rust_json = serde_json::from_str::<Value>(rust.stdout.trim());
    let gold_json = serde_json::from_str::<Value>(gold.stdout.trim());
    match (rust_json, gold_json) {
        (Ok(r), Ok(g)) => assert_eq!(r, g, "{label}: JSON mismatch"),
        (Err(_), Err(_)) => assert_eq!(rust.stdout, gold.stdout, "{label}: stdout bytes mismatch"),
        (Ok(_), Err(_)) => panic!(
            "{label}: rust stdout is JSON, gold is not:\n{}",
            gold.stdout
        ),
        (Err(_), Ok(_)) => panic!(
            "{label}: gold stdout is JSON, rust is not:\n{}",
            rust.stdout
        ),
    }
}

/// Like [`compare_cli`], but `html` is compared with `</section>` stripped
/// (intended deviation #2). Exit, stderr, and every other JSON field stay exact.
pub fn compare_cli_preview(rust: &CliOutput, gold: &CliOutput, label: &str) {
    assert_eq!(
        rust.code, gold.code,
        "{label}: exit rust={} gold={}\nrust stderr: {}\ngold stderr: {}",
        rust.code, gold.code, rust.stderr, gold.stderr
    );
    assert_eq!(
        rust.stderr, gold.stderr,
        "{label}: stderr mismatch\nrust: {:?}\ngold: {:?}",
        rust.stderr, gold.stderr
    );
    let rust_json = serde_json::from_str::<Value>(rust.stdout.trim());
    let gold_json = serde_json::from_str::<Value>(gold.stdout.trim());
    match (rust_json, gold_json) {
        (Ok(mut r), Ok(mut g)) => {
            strip_section_closes(&mut r);
            strip_section_closes(&mut g);
            assert_eq!(r, g, "{label}: JSON mismatch (html </section> stripped)");
        }
        (Err(_), Err(_)) => assert_eq!(rust.stdout, gold.stdout, "{label}: stdout bytes mismatch"),
        (Ok(_), Err(_)) => panic!(
            "{label}: rust stdout is JSON, gold is not:\n{}",
            gold.stdout
        ),
        (Err(_), Ok(_)) => panic!(
            "{label}: gold stdout is JSON, rust is not:\n{}",
            rust.stdout
        ),
    }
}

fn strip_section_closes(v: &mut Value) {
    if let Some(Value::String(html)) = v.get_mut("html") {
        *html = html.replace("</section>", "");
    }
}

pub fn lf_text(text: &str) -> String {
    text.replace("\r\n", "\n").replace('\r', "\n")
}

pub fn compare_lyx_files(rust_path: &Path, gold_path: &Path, label: &str) {
    let rust = fs::read_to_string(rust_path).unwrap_or_else(|e| {
        panic!("{label}: read rust {}: {e}", rust_path.display());
    });
    let gold = fs::read_to_string(gold_path).unwrap_or_else(|e| {
        panic!("{label}: read gold {}: {e}", gold_path.display());
    });
    assert_eq!(
        normalize_change_markers(&lf_text(&rust)),
        normalize_change_markers(&lf_text(&gold)),
        "{label}: .lyx bytes (LF + change-marker normalized)"
    );
}

#[cfg(windows)]
fn windows_home_parts(home: &Path) -> Option<(String, String)> {
    use std::path::{Component, Prefix};

    let mut comps = home.components();
    let drive = match comps.next()? {
        Component::Prefix(p) => match p.kind() {
            Prefix::Disk(d) | Prefix::VerbatimDisk(d) => format!("{}:", d as char),
            _ => return None,
        },
        _ => return None,
    };
    let mut homepath = String::from("\\");
    let mut empty = true;
    for c in comps {
        match c {
            Component::RootDir => {}
            Component::Normal(s) => {
                if !empty {
                    homepath.push('\\');
                }
                empty = false;
                homepath.push_str(&s.to_string_lossy());
            }
            _ => {}
        }
    }
    Some((drive, homepath))
}
