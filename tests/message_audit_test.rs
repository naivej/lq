//! S12 message audit: help pointers in the catalog and diagnostics resolve.

use lq::{HELP_PAGES, find_by_reach, find_page};
use std::fs;
use std::path::{Path, PathBuf};

const KNOWN_COMMANDS: &[&str] = &[
    "init", "dump", "bib", "schema", "read", "preview", "set", "delete", "insert", "undo", "help",
];

#[test]
fn further_reading_already_covered_by_help_test() {
    // `further_reading_targets_resolve` in help_test.rs is the catalog half.
    assert!(!HELP_PAGES.is_empty());
}

#[test]
fn help_body_lq_help_tokens_resolve() {
    let mut hits = 0usize;
    for page in HELP_PAGES {
        for section in page.sections {
            for token in lq_help_tokens(section.body) {
                hits += 1;
                assert!(
                    find_by_reach(token).is_some() || find_page(token).is_some(),
                    "{} body cites unknown 'lq help {token}'",
                    page.id
                );
            }
        }
    }
    assert!(
        hits >= 2,
        "expected catalog 'lq help <reach>' tokens, got {hits}"
    );
}

#[test]
fn diagnostic_help_pointers_resolve() {
    let src = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("src");
    let mut help_hits = 0usize;
    let mut cmd_hits = 0usize;
    walk_rs(&src, &mut |path, text| {
        for token in lq_help_tokens(text) {
            if token.contains('{') {
                continue;
            }
            help_hits += 1;
            assert!(
                find_by_reach(token).is_some() || find_page(token).is_some(),
                "{} cites unknown 'lq help {token}'",
                path.display()
            );
        }
        for cmd in lq_cmd_help_tokens(text) {
            if cmd == "command" || cmd == "command_name" {
                cmd_hits += 1;
                continue;
            }
            cmd_hits += 1;
            assert!(
                KNOWN_COMMANDS.contains(&cmd),
                "{} cites unknown 'lq {cmd} --help'",
                path.display()
            );
        }
    });
    assert!(
        help_hits >= 1,
        "expected diagnostic 'lq help' pointers, got {help_hits}"
    );
    assert!(
        cmd_hits >= 1,
        "expected diagnostic 'lq <cmd> --help' pointers, got {cmd_hits}"
    );
    eprintln!("message audit: lq help tokens={help_hits} lq <cmd> --help tokens={cmd_hits}");
}

fn lq_help_tokens(text: &str) -> Vec<&str> {
    let mut out = Vec::new();
    let mut rest = text;
    while let Some(idx) = rest.find("lq help ") {
        let after = &rest[idx + "lq help ".len()..];
        let token = help_token(after);
        if !token.is_empty() {
            out.push(token);
        }
        rest = &after[token.len().max(1)..];
    }
    out
}

fn help_token(after: &str) -> &str {
    if after.starts_with('<') || after.starts_with('-') {
        return "";
    }
    let end = after
        .find(|c: char| !c.is_ascii_alphanumeric() && c != '-' && c != '/')
        .unwrap_or(after.len());
    &after[..end]
}

fn lq_cmd_help_tokens(text: &str) -> Vec<&str> {
    let mut out = Vec::new();
    let mut search = 0;
    while let Some(rel) = text[search..].find("lq ") {
        let abs = search + rel + 3;
        let after = &text[abs..];
        if after.starts_with('{')
            && let Some(close) = after.find('}')
        {
            let cmd = &after[1..close];
            if !cmd.is_empty() && after[close + 1..].starts_with(" --help") {
                out.push(cmd);
            }
            search = abs + close.max(1);
            continue;
        }
        let cmd_end = after
            .find(|c: char| !c.is_ascii_alphanumeric() && c != '_')
            .unwrap_or(after.len());
        let cmd = &after[..cmd_end];
        if !cmd.is_empty() && after[cmd_end..].starts_with(" --help") {
            out.push(cmd);
        }
        search = abs + cmd_end.max(1);
    }
    out
}

fn walk_rs(dir: &Path, visit: &mut impl FnMut(&Path, &str)) {
    let entries = fs::read_dir(dir).unwrap_or_else(|e| panic!("read {}: {e}", dir.display()));
    for entry in entries {
        let entry = entry.unwrap();
        let path = entry.path();
        if path.is_dir() {
            if path.file_name().and_then(|n| n.to_str()) == Some("generated") {
                continue;
            }
            walk_rs(&path, visit);
        } else if path.extension().and_then(|e| e.to_str()) == Some("rs") {
            let text = fs::read_to_string(&path).unwrap();
            visit(&path, &text);
        }
    }
}
