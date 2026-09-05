//! CLI skeleton (Deno `tests/cli_test.ts` help/init/unknown-command cases).

mod common;

use common::{IsolatedHome, WorkDir, json_stdout, run_cli, run_cli_with};
use lq::{HELP_PAGES, find_by_reach, reach_of};
use std::fs;

fn err_code(out: &common::CliOutput) -> String {
    json_stdout(out)["code"].as_str().unwrap_or("").to_string()
}

fn err_message(out: &common::CliOutput) -> String {
    json_stdout(out)["message"]
        .as_str()
        .unwrap_or("")
        .to_string()
}

#[test]
fn cli_global_help_is_the_home_page_map() {
    let out = run_cli(&["--help"]);
    assert_eq!(out.code, 0, "{}", out.stderr);
    assert!(out.stdout.contains("Help commands"));
    assert!(out.stdout.contains("Pages"));
    assert!(out.stdout.contains("model/"));
    assert!(out.stdout.contains("concepts/"));
    assert!(out.stdout.contains("commands/"));
    assert!(out.stdout.contains("lq help read"));
    assert!(out.stdout.contains("lq help set"));
    assert!(out.stdout.contains("lq help undo"));
    assert!(out.stdout.contains("lq help tracked-changes"));
}

#[test]
fn cli_per_command_help_preview() {
    let out = run_cli(&["preview", "--help"]);
    assert!(out.stdout.contains("lq preview"));
    assert!(out.stdout.contains("<file>"));
    assert!(out.stdout.contains("lyx-preview/live-1"));
    assert!(out.stdout.contains("sha256"));
    let output = out.stdout.split("Output").nth(1).expect("Output section");
    assert!(
        output.contains("outline"),
        "preview Output must name outline"
    );
    assert!(
        output.contains("navigate"),
        "preview Output must name navigate"
    );
}

#[test]
fn cli_per_command_help_read() {
    let out = run_cli(&["read", "--help"]);
    assert!(out.stdout.contains("lq read"));
    assert!(out.stdout.contains("--count"));
    assert!(out.stdout.contains("<file>"));
    assert!(out.stdout.contains("<selector>"));
}

#[test]
fn cli_per_command_help_insert() {
    let out = run_cli(&["insert", "--help"]);
    for s in [
        "lq insert",
        "<file>",
        "<selector>",
        "<position>",
        "split-after",
        "exactly once",
        "prepend",
        "--layout",
        "--cite",
        "--ref",
        "--label",
        "--footnote",
        "--raw-file",
    ] {
        assert!(out.stdout.contains(s), "missing {s}");
    }
}

#[test]
fn cli_per_command_help_init_documents_strict_cache_count() {
    let out = run_cli(&["init", "--help"]);
    for s in [
        "lq init",
        "--global",
        "local",
        "--max-cache-entries",
        "non-negative integer",
        "--track-changes",
        "State scope",
    ] {
        assert!(out.stdout.contains(s), "missing {s}");
    }
}

#[test]
fn cli_lq_help_opens_the_home_page_map() {
    let out = run_cli(&["help"]);
    assert!(out.stdout.contains("Pages"));
    assert!(out.stdout.contains("lq help selectors"));
}

#[test]
fn cli_lq_help_page_opens_that_page() {
    let out = run_cli(&["help", "tracked-changes"]);
    assert!(out.stdout.contains("change regions and tracked behavior"));
    assert!(out.stdout.contains("change_deleted"));
    assert!(out.stdout.contains("Further reading"));
}

#[test]
fn cli_unknown_help_page_fails_with_an_actionable_message() {
    let out = run_cli(&["help", "nope"]);
    assert_eq!(out.code, 1);
    assert_eq!(err_code(&out), "UNKNOWN_HELP_PAGE");
    assert!(err_message(&out).contains("lq help"));
}

#[test]
fn cli_invalid_rich_value_fails() {
    let out = run_cli(&["help", "--rich=bogus"]);
    assert_eq!(err_code(&out), "INVALID_FLAG");
    assert!(err_message(&out).contains("--rich"));
}

const COMMAND_REACHES: &[&str] = &[
    "init", "schema", "dump", "preview", "read", "bib", "set", "delete", "insert", "undo",
];
const TOPIC_REACHES: &[&str] = &[
    "cst",
    "guarantees",
    "state-scope",
    "private-notes",
    "insets",
    "selectors",
    "mutations",
    "tracked-changes",
];

#[test]
fn cli_every_help_page_is_reachable_via_lq_help_page() {
    for reach in COMMAND_REACHES.iter().chain(TOPIC_REACHES) {
        let out = run_cli(&["help", reach]);
        let title = find_by_reach(reach).unwrap().title;
        assert!(
            out.stdout.contains(title),
            "help page {reach} not reachable"
        );
    }
}

#[test]
fn cli_command_help_equals_lq_help_command() {
    for cmd in COMMAND_REACHES {
        let via_help = run_cli(&["help", cmd]);
        let via_flag = run_cli(&[cmd, "--help"]);
        assert_eq!(via_help.stdout, via_flag.stdout, "{cmd} alias mismatch");
    }
}

#[test]
fn cli_home_page_map_lists_every_page() {
    let out = run_cli(&["help"]);
    for reach in COMMAND_REACHES.iter().chain(TOPIC_REACHES) {
        assert!(
            out.stdout.contains(&format!("lq help {reach}")),
            "home map missing {reach}"
        );
    }
}

#[test]
fn cli_help_output_stays_plain_when_stdout_is_not_a_terminal() {
    for args in [
        &["help"] as &[&str],
        &["help", "read"],
        &["help", "--rich=auto"],
        &["help", "--rich=never"],
    ] {
        let out = run_cli(args);
        assert!(
            !out.stdout.contains("\x1b["),
            "ANSI leaked for '{}'",
            args.join(" ")
        );
    }
}

#[test]
fn cli_no_help_output_references_removed_selector_help() {
    for reach in COMMAND_REACHES.iter().chain(TOPIC_REACHES) {
        let out = run_cli(&["help", reach]);
        assert!(
            !out.stdout.contains("lq selector --help"),
            "{reach} references lq selector --help"
        );
    }
}

#[test]
fn cli_each_command_page_documents_its_high_risk_facts() {
    let facts: &[(&str, &[&str])] = &[
        (
            "init",
            &[
                "--global",
                "--refresh",
                "layoutSearch",
                "layoutRoots",
                "--track-changes",
                "save-reload",
            ],
        ),
        (
            "schema",
            &[
                "documentLayouts",
                "insetLayouts",
                "insets",
                "headingHierarchy",
                "textclass",
                "kind",
            ],
        ),
        ("dump", &["--depth", "--toc", "TocLevel", "truncated"]),
        (
            "preview",
            &[
                "lyx-preview/live-1",
                "sha256",
                "raw-file-bytes",
                "does not mutate",
                "LAYOUT_NOT_FOUND",
                "Preview shows what it can",
            ],
        ),
        (
            "read",
            &["--count", "--text-only", "change_deleted", "empty result"],
        ),
        ("bib", &["--search", ".bib"]),
        (
            "table",
            &[
                "File-order index",
                "Table N",
                "prose",
                "the new row or column is tracked",
                "--data is not",
                "exactly one table",
            ],
        ),
        ("set", &["--find", "--replace-all", "inset is rejected"]),
        ("delete", &["subtree"]),
        (
            "insert",
            &[
                "split-after",
                "--raw-file",
                "exactly once",
                "prepend",
                "--table",
            ],
        ),
        ("undo", &["Snapshot restore", "Replay undo", "substring"]),
    ];
    for (page, page_facts) in facts {
        let out = run_cli(&["help", page]);
        for fact in *page_facts {
            assert!(out.stdout.contains(fact), "{page} missing '{fact}'");
        }
    }
}

#[test]
fn cli_unknown_command_recommends_home_help() {
    let out = run_cli(&["unknown", "file.lyx", "layout"]);
    assert_eq!(err_code(&out), "UNKNOWN_COMMAND");
    assert!(err_message(&out).contains("lq help"));
}

#[test]
fn cli_unknown_command_with_one_file_arg_reports_unknown_command() {
    let out = run_cli(&["unknown", "file.lyx"]);
    assert_eq!(err_code(&out), "UNKNOWN_COMMAND");
    assert!(
        !err_message(&out).contains("MISSING_SELECTOR") && err_code(&out) != "MISSING_SELECTOR"
    );
}

#[test]
fn cli_unknown_command_alone_reports_unknown_command() {
    let out = run_cli(&["unknown"]);
    assert_eq!(err_code(&out), "UNKNOWN_COMMAND");
}

#[test]
fn cli_init_reject_invalid_refresh_mode() {
    let out = run_cli(&["init", "--refresh", "invalid"]);
    assert_eq!(err_code(&out), "INVALID_FLAG");
    assert!(err_message(&out).contains("refresh"));
}

#[test]
fn cli_init_reject_invalid_track_changes() {
    let out = run_cli(&["init", "--track-changes", "invalid"]);
    assert_eq!(err_code(&out), "INVALID_FLAG");
    assert!(err_message(&out).contains("track-changes"));
}

#[test]
fn cli_init_rejects_empty_and_whitespace_only_author_names() {
    let home = IsolatedHome::new();
    let layouts = WorkDir::new();
    let work = WorkDir::new();
    for value in ["", "   ", "\t"] {
        let out = run_cli_with(
            &[
                "init",
                "--layouts-dir",
                layouts.path().to_str().unwrap(),
                "--author-name",
                value,
            ],
            &home,
            work.path(),
        );
        assert_eq!(err_code(&out), "INVALID_FLAG", "{value:?}");
        assert!(err_message(&out).contains("author-name"));
        assert!(
            !work.path().join(".lq/config.json").is_file(),
            "invalid author must not create config"
        );
    }
}

#[test]
fn cli_init_rejects_malformed_max_cache_entries_values() {
    for value in ["7x", "1.5", "1e2", "-1"] {
        let out = run_cli(&["init", "--max-cache-entries", value]);
        assert_eq!(err_code(&out), "INVALID_FLAG", "{value}");
        assert!(err_message(&out).contains("max-cache-entries"));
        assert!(err_message(&out).contains(value));
    }
    let out = run_cli(&["init", "--max-cache-entries=-1"]);
    assert_eq!(err_code(&out), "INVALID_FLAG");
    assert!(err_message(&out).contains("max-cache-entries"));
    assert!(err_message(&out).contains("-1"));
}

#[test]
fn cli_init_accepts_exact_max_cache_entries_integers() {
    let home = IsolatedHome::new();
    let layouts = WorkDir::new();
    let work = WorkDir::new();
    for value in ["0", "7"] {
        let out = run_cli_with(
            &[
                "init",
                "--global",
                "--layouts-dir",
                layouts.path().to_str().unwrap(),
                "--max-cache-entries",
                value,
            ],
            &home,
            work.path(),
        );
        assert_eq!(out.code, 0, "{}", out.stdout);
        let config: serde_json::Value =
            serde_json::from_str(&fs::read_to_string(home.path().join(".lq/config.json")).unwrap())
                .unwrap();
        assert_eq!(config["maxCacheEntries"], value.parse::<u64>().unwrap());
    }
}

#[test]
fn cli_init_reject_nonexistent_layouts_dir() {
    let out = run_cli(&["init", "--layouts-dir", "/nonexistent/path/12345"]);
    assert_eq!(err_code(&out), "DIR_NOT_FOUND");
}

#[test]
fn cli_init_success_with_fake_home() {
    let home = IsolatedHome::new();
    let project = WorkDir::new();
    let layouts = WorkDir::new();
    let out = run_cli_with(
        &["init", "--layouts-dir", layouts.path().to_str().unwrap()],
        &home,
        project.path(),
    );
    assert_eq!(out.code, 0, "{}", out.stdout);
    let config: serde_json::Value =
        serde_json::from_str(&fs::read_to_string(project.path().join(".lq/config.json")).unwrap())
            .unwrap();
    assert_eq!(
        config["layoutsDir"].as_str().unwrap(),
        layouts.path().to_str().unwrap()
    );
    assert_eq!(config["refresh"], "none");
    assert_eq!(config["trackChanges"], true);
}

#[test]
fn cli_init_without_layouts_dir_omits_overlay_and_explains_policy() {
    let home = IsolatedHome::new();
    let project = WorkDir::new();
    let out = run_cli_with(
        &["init", "--author-name", "policy tester"],
        &home,
        project.path(),
    );
    assert_eq!(out.code, 0, "{}", out.stdout);
    let v = json_stdout(&out);
    let config: serde_json::Value =
        serde_json::from_str(&fs::read_to_string(project.path().join(".lq/config.json")).unwrap())
            .unwrap();
    assert!(config.get("layoutsDir").is_none());
    assert_eq!(config["authorName"], "policy tester");
    assert_eq!(v["layoutSearch"], "user → system → LocalLayout");
    assert!(v["layoutRoots"]["system"].is_string());
    assert!(v["layoutRoots"]["overlay"].is_null());
}

#[test]
fn cli_init_refresh_save_reload_succeeds() {
    let home = IsolatedHome::new();
    let layouts = WorkDir::new();
    let work = WorkDir::new();
    let out = run_cli_with(
        &[
            "init",
            "--global",
            "--layouts-dir",
            layouts.path().to_str().unwrap(),
            "--refresh",
            "save-reload",
        ],
        &home,
        work.path(),
    );
    assert_eq!(out.code, 0, "{}", out.stdout);
    assert_eq!(json_stdout(&out)["data"]["refresh"], "save-reload");
}

#[test]
fn help_pages_cover_catalog() {
    let reaches: Vec<&str> = HELP_PAGES
        .iter()
        .filter(|p| p.id != "home")
        .map(|p| reach_of(p.id))
        .collect();
    assert!(!reaches.is_empty());
}
