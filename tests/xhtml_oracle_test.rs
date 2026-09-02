//! Development-only XHTML oracle tests (Deno `tests/xhtml_oracle_test.ts`).
//!
//! Missing LyX skips the export comparison; sanitizer tests always run.

mod common;

use common::fixtures_root;
use lq::{
    LiveRenderOptions, format_sem, get_default_layouts_dir, normalize_reader_html, parse,
    render_live_html, semantic_equal,
};
use std::fs;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::Mutex;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{Duration, Instant};

static LYX_EXPORT: Mutex<()> = Mutex::new(());
static ORACLE_SEQ: AtomicU64 = AtomicU64::new(0);

const PARITY_FIXTURES: &[&str] = &[
    "headings_paragraphs.lyx",
    "lists_quotes.lyx",
    "table_figure_foot_math.lyx",
    "hostile.lyx",
    "front_matter_math.lyx",
    "review_changes_parity.lyx",
];

const SLICE_FIXTURES: &[&str] = &[
    "nameref_titles.lyx",
    "logical_charstyles.lyx",
    "info_icon_shortcut.lyx",
];

#[derive(Debug)]
struct XhtmlOracleError {
    code: String,
    message: String,
}

impl std::fmt::Display for XhtmlOracleError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}: {}", self.code, self.message)
    }
}

fn extract_xhtml_body(html: &str) -> Result<String, XhtmlOracleError> {
    let lower = html.to_ascii_lowercase();
    let start = lower
        .find("<body")
        .and_then(|s| html[s..].find('>').map(|e| s + e + 1));
    let end = lower.rfind("</body>");
    match (start, end) {
        (Some(s), Some(e)) if s < e => Ok(html[s..e].to_string()),
        _ => Err(XhtmlOracleError {
            code: "LYX_EXPORT_NO_BODY".into(),
            message: "LyX HTML export contained no <body> element.".into(),
        }),
    }
}

fn sanitize_xhtml_body(body: &str) -> String {
    let mut s = strip_comments(body);
    s = strip_tag_block(&s, "script");
    s = strip_tag_block(&s, "style");
    s = strip_hazard_tags(&s);
    s = strip_event_attrs(&s);
    strip_js_hrefs(&s)
}

fn strip_comments(s: &str) -> String {
    let mut out = String::new();
    let mut rest = s;
    while let Some(i) = rest.find("<!--") {
        out.push_str(&rest[..i]);
        rest = &rest[i + 4..];
        if let Some(e) = rest.find("-->") {
            rest = &rest[e + 3..];
        } else {
            rest = "";
        }
    }
    out.push_str(rest);
    out
}

fn strip_tag_block(s: &str, tag: &str) -> String {
    let open = format!("<{tag}");
    let close = format!("</{tag}");
    let mut out = String::new();
    let mut rest = s;
    loop {
        let lower = rest.to_ascii_lowercase();
        let Some(i) = lower.find(&open) else {
            out.push_str(rest);
            break;
        };
        out.push_str(&rest[..i]);
        let after = &rest[i + open.len()..];
        let lower_after = after.to_ascii_lowercase();
        if let Some(c) = lower_after.find(&close) {
            if let Some(gt) = after[c..].find('>') {
                rest = &after[c + gt + 1..];
            } else {
                rest = "";
            }
        } else {
            rest = "";
        }
    }
    out
}

fn strip_hazard_tags(s: &str) -> String {
    let hazards = [
        "iframe", "object", "embed", "form", "link", "meta", "base", "svg",
    ];
    let mut out = String::new();
    let mut rest = s;
    while let Some(lt) = rest.find('<') {
        out.push_str(&rest[..lt]);
        let after = &rest[lt + 1..];
        let trimmed = after.trim_start_matches('/');
        let name_end = trimmed
            .find(|c: char| !c.is_ascii_alphanumeric())
            .unwrap_or(trimmed.len());
        let name = trimmed[..name_end].to_ascii_lowercase();
        if hazards.contains(&name.as_str())
            && let Some(gt) = after.find('>')
        {
            rest = &after[gt + 1..];
            continue;
        }
        out.push('<');
        rest = after;
    }
    out.push_str(rest);
    out
}

fn strip_event_attrs(s: &str) -> String {
    let mut out = String::new();
    let mut rest = s;
    while let Some(i) = find_event_attr(rest) {
        out.push_str(&rest[..i]);
        rest = &rest[i..];
        rest = rest.trim_start();
        if let Some(eq) = rest.find('=') {
            rest = rest[eq + 1..].trim_start();
            if rest.starts_with('"') {
                rest = rest.get(1..).unwrap_or("");
                if let Some(e) = rest.find('"') {
                    rest = &rest[e + 1..];
                }
            } else if rest.starts_with('\'') {
                rest = rest.get(1..).unwrap_or("");
                if let Some(e) = rest.find('\'') {
                    rest = &rest[e + 1..];
                }
            }
        } else {
            break;
        }
    }
    out.push_str(rest);
    out
}

fn find_event_attr(s: &str) -> Option<usize> {
    let bytes = s.as_bytes();
    let mut i = 0;
    while i + 4 < bytes.len() {
        if bytes[i].is_ascii_whitespace()
            && bytes[i + 1].eq_ignore_ascii_case(&b'o')
            && bytes[i + 2].eq_ignore_ascii_case(&b'n')
            && bytes[i + 3].is_ascii_alphabetic()
        {
            let mut j = i + 3;
            while j < bytes.len() && bytes[j].is_ascii_alphabetic() {
                j += 1;
            }
            while j < bytes.len() && bytes[j].is_ascii_whitespace() {
                j += 1;
            }
            if j < bytes.len() && bytes[j] == b'=' {
                j += 1;
                while j < bytes.len() && bytes[j].is_ascii_whitespace() {
                    j += 1;
                }
                if j < bytes.len() && (bytes[j] == b'"' || bytes[j] == b'\'') {
                    return Some(i);
                }
            }
        }
        i += 1;
    }
    None
}

fn strip_js_hrefs(s: &str) -> String {
    let mut out = String::new();
    let mut rest = s;
    loop {
        let lower = rest.to_ascii_lowercase();
        let href = lower.find("href");
        let src = lower.find("src");
        let hit = match (href, src) {
            (Some(a), Some(b)) => Some(a.min(b)),
            (Some(a), None) => Some(a),
            (None, Some(b)) => Some(b),
            (None, None) => None,
        };
        let Some(i) = hit else {
            out.push_str(rest);
            break;
        };
        out.push_str(&rest[..i]);
        let after = &rest[i..];
        let eq = after.find('=');
        if let Some(eq) = eq {
            let val = after[eq + 1..].trim_start();
            let is_js = val.to_ascii_lowercase().starts_with("\"javascript:")
                || val.to_ascii_lowercase().starts_with("'javascript:");
            if is_js {
                let quote = val.as_bytes()[0];
                rest = &val[1..];
                if let Some(e) = rest.as_bytes().iter().position(|&b| b == quote) {
                    rest = &rest[e + 1..];
                } else {
                    rest = "";
                }
                continue;
            }
        }
        out.push_str(&after[..1]);
        rest = &after[1..];
    }
    out
}

fn assert_sanitized(body: &str) {
    let lower = body.to_ascii_lowercase();
    assert!(
        !lower.contains("<script"),
        "Sanitized body still contains <script>."
    );
    assert!(
        !lower.contains("<style"),
        "Sanitized body still contains <style>."
    );
}

fn find_lyx_binary() -> Option<PathBuf> {
    for key in ["LYX_BINARY", "LYX_PATH"] {
        if let Ok(env) = std::env::var(key) {
            let p = PathBuf::from(env);
            if p.is_file() {
                return Some(p);
            }
        }
    }
    let mut candidates = Vec::new();
    let layouts = get_default_layouts_dir();
    if layouts.is_dir() {
        let root = layouts.join("..").join("..");
        candidates.push(root.join("bin").join("LyX.exe"));
        candidates.push(root.join("bin").join("lyx.exe"));
        candidates.push(root.join("bin").join("lyx"));
    }
    if let Ok(local) = std::env::var("LOCALAPPDATA") {
        let programs = PathBuf::from(local).join("Programs");
        if let Ok(rd) = fs::read_dir(&programs) {
            for e in rd.flatten() {
                if e.file_type().map(|t| t.is_dir()).unwrap_or(false)
                    && e.file_name().to_string_lossy().starts_with("LyX ")
                {
                    candidates.push(e.path().join("bin").join("LyX.exe"));
                    candidates.push(e.path().join("bin").join("lyx.exe"));
                }
            }
        }
    }
    candidates.into_iter().find(|c| c.is_file())
}

fn export_sanitized_xhtml(
    lyx: &Path,
    file: &Path,
    timeout: Duration,
) -> Result<String, XhtmlOracleError> {
    let _guard = LYX_EXPORT.lock().unwrap_or_else(|e| e.into_inner());
    let tmp = std::env::temp_dir().join(format!(
        "lq-oracle-{}-{}.xhtml",
        std::process::id(),
        ORACLE_SEQ.fetch_add(1, Ordering::Relaxed)
    ));
    let mut child = Command::new(lyx)
        .args(["-E", "xhtml"])
        .arg(&tmp)
        .arg(std::path::absolute(file).unwrap_or_else(|_| file.to_path_buf()))
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| XhtmlOracleError {
            code: "LYX_EXPORT_SPAWN".into(),
            message: format!("Could not start LyX for HTML export: {e}"),
        })?;
    let start = Instant::now();
    loop {
        match child.try_wait() {
            Ok(Some(status)) => {
                if !status.success() {
                    let _ = fs::remove_file(&tmp);
                    return Err(XhtmlOracleError {
                        code: "LYX_EXPORT_FAILED".into(),
                        message: format!("LyX export exited with code {:?}.", status.code()),
                    });
                }
                break;
            }
            Ok(None) => {
                if start.elapsed() > timeout {
                    let _ = child.kill();
                    let _ = child.wait();
                    let _ = fs::remove_file(&tmp);
                    return Err(XhtmlOracleError {
                        code: "LYX_EXPORT_FAILED".into(),
                        message: "LyX export timed out.".into(),
                    });
                }
                std::thread::sleep(Duration::from_millis(50));
            }
            Err(e) => {
                let _ = fs::remove_file(&tmp);
                return Err(XhtmlOracleError {
                    code: "LYX_EXPORT_FAILED".into(),
                    message: e.to_string(),
                });
            }
        }
    }
    let html = fs::read_to_string(&tmp).map_err(|_| {
        let _ = fs::remove_file(&tmp);
        XhtmlOracleError {
            code: "LYX_EXPORT_NO_OUTPUT".into(),
            message:
                "LyX reported success but produced no XHTML output; the document may fail to parse."
                    .into(),
        }
    })?;
    let _ = fs::remove_file(&tmp);
    let body = extract_xhtml_body(&html)?;
    let sanitized = sanitize_xhtml_body(&body);
    assert_sanitized(&sanitized);
    Ok(sanitized)
}

#[test]
fn oracle_sanitizer_drops_head_material_scripts_handlers_javascript_urls() {
    let export_doc = r#"<!DOCTYPE html><html><head><style>body{color:red}</style><script>alert(1)</script></head><body><p onclick="alert(1)">Hi</p><a href="javascript:alert(1)">x</a><iframe src="https://evil.example"></iframe></body></html>"#;
    let body = extract_xhtml_body(export_doc).expect("body");
    let sanitized = sanitize_xhtml_body(&body);
    assert_sanitized(&sanitized);
    assert!(!sanitized.to_ascii_lowercase().contains("<script"));
    assert!(!sanitized.to_ascii_lowercase().contains("onclick"));
    assert!(!sanitized.to_ascii_lowercase().contains("javascript:"));
    assert!(!sanitized.to_ascii_lowercase().contains("<iframe"));
    assert!(!sanitized.to_ascii_lowercase().contains("<style"));
}

#[test]
fn oracle_sanitizer_missing_body_is_a_clean_failure() {
    let err = extract_xhtml_body("<html><div>no body</div></html>").unwrap_err();
    assert_eq!(err.code, "LYX_EXPORT_NO_BODY");
}

fn compare_live_to_oracle(lyx: &Path, file: &Path) -> Result<(), String> {
    let text = fs::read_to_string(file).map_err(|e| e.to_string())?;
    let ast = parse(&text, false).map_err(|e| e.to_string())?;
    let live = render_live_html(
        &ast,
        LiveRenderOptions {
            file_path: Some(file.to_path_buf()),
            ..Default::default()
        },
    )
    .map_err(|e| e.message)?;
    let oracle =
        export_sanitized_xhtml(lyx, file, Duration::from_secs(30)).map_err(|e| e.message)?;
    let live_sem = normalize_reader_html(&live.html, Some("accepted"));
    let oracle_sem = normalize_reader_html(&oracle, Some("accepted"));
    if semantic_equal(&live_sem, &oracle_sem) {
        Ok(())
    } else {
        Err(format!(
            "{}\n---\n{}",
            format_sem(&live_sem, 0),
            format_sem(&oracle_sem, 0)
        ))
    }
}

#[test]
fn oracle_export_representative_fixture_when_lyx_is_available() {
    let Some(lyx) = find_lyx_binary() else {
        eprintln!("LyX binary not found; skipping oracle export comparison.");
        return;
    };
    let root = fixtures_root().join("Synthetic");
    for name in PARITY_FIXTURES {
        let file = root.join(name);
        compare_live_to_oracle(&lyx, &file).unwrap_or_else(|diff| {
            panic!("{name} Live vs oracle:\n{diff}");
        });
    }
}

#[test]
fn oracle_export_dl130_help_slice_synthetic_isolates_when_lyx_is_available() {
    let Some(lyx) = find_lyx_binary() else {
        eprintln!("LyX binary not found; skipping oracle export comparison.");
        return;
    };
    let root = fixtures_root().join("Synthetic");
    for name in SLICE_FIXTURES {
        let file = root.join(name);
        compare_live_to_oracle(&lyx, &file).unwrap_or_else(|diff| {
            panic!("{name} Live vs oracle:\n{diff}");
        });
    }
}
