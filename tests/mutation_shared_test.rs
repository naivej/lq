//! Shared mutation preamble (Deno `tests/mutation_test.ts` + DL127 F5b).

mod common;

use common::{
    IsolatedHome, MutationSession, WorkDir, json_warnings, parse_cli_json, path_arg, run_cli_with,
};
use serde_json::json;
use std::fs;

const MINI_DOC: &str = "#LyX 2.5 created this file.\n\
\\begin_document\n\\begin_header\n\\author 1 \"Alice\"\n\\end_header\n\
\\begin_body\n\\begin_layout Standard\nHello world\n\\end_layout\n\\end_body\n\\end_document\n";

fn code(v: &serde_json::Value) -> &str {
    v["code"].as_str().unwrap_or("")
}

fn message(v: &serde_json::Value) -> &str {
    v["message"].as_str().unwrap_or("")
}

#[test]
fn mutation_engine_guard_core_document_nodes() {
    let env = MutationSession::new();
    let file = env.template("temp_guard_test.lyx");
    let p = path_arg(&file);
    let delete = env.run(&["delete", p, "body"]);
    assert_eq!(code(&delete), "INVALID_CONTEXT");
    let set = env.run(&["set", p, "document", "foo"]);
    assert_eq!(code(&set), "INVALID_CONTEXT");
}

#[test]
fn mutation_missing_selector_errors() {
    let env = MutationSession::new();
    let file = env.template("temp_missing_sel.lyx");
    let p = path_arg(&file);
    let out = env.run(&["set", p]);
    assert_eq!(code(&out), "MISSING_SELECTOR");
    assert!(message(&out).contains("CSS selector is required"));
}

#[test]
fn dl87_f7_unknown_and_misapplied_flags_hard_error_before_mutating() {
    let env = MutationSession::new();
    let file = env.write_lyx(
        "temp_dl87_f7_flags.lyx",
        "\\begin_layout Standard\nHello\n\\end_layout\n",
        "",
    );
    let p = path_arg(&file);
    let misapplied = env.run(&[
        "set",
        p,
        "layout[Standard]",
        "World",
        "--track-changes",
        "off",
    ]);
    assert_eq!(code(&misapplied), "INVALID_FLAG");
    assert!(message(&misapplied).contains("--track-changes is an 'init' flag"));
    assert!(message(&misapplied).contains("lq init --track-changes off"));
    let bogus = env.run(&["set", p, "layout[Standard]", "World", "--bogus-flag"]);
    assert_eq!(code(&bogus), "INVALID_FLAG");
    assert!(message(&bogus).contains("Unknown flag"));
    let stray = env.run(&["delete", p, "layout[Standard]", "--bogus-flag"]);
    assert_eq!(code(&stray), "INVALID_FLAG");
    let text = fs::read_to_string(&file).unwrap();
    assert!(!text.contains("World"), "no mutation may occur");
    assert!(text.contains("Hello"));
}

#[test]
fn dl88_f3_invalid_flag_error_carries_no_warnings() {
    let env = MutationSession::new();
    let file = env.write_lyx(
        "temp_dl88_f3_warnings.lyx",
        "\\begin_layout Standard\nAlpha\n\\end_layout\n\
         \\begin_layout Standard\nBeta\n\\end_layout\n",
        "",
    );
    let before = fs::read_to_string(&file).unwrap();
    let result = env.run(&[
        "set",
        path_arg(&file),
        "layout[Standard]",
        "X",
        "--track-changes",
        "off",
    ]);
    assert_eq!(code(&result), "INVALID_FLAG");
    assert!(
        json_warnings(&result).is_empty(),
        "an error response must not carry the blast-radius warning (D4-a)"
    );
    assert_eq!(fs::read_to_string(&file).unwrap(), before);
}

#[test]
fn dl85_f5_tracked_mutation_on_headerless_document_hard_errors() {
    let env = MutationSession::tracked("Alice");
    let file = env.write_file(
        "temp_dl85_f5_headerless.lyx",
        "#LyX 2.5 created this file.\n\
         \\begin_document\n\\begin_body\n\\begin_layout Standard\nHello\n\\end_layout\n\\end_body\n\\end_document\n",
    );
    let result = env.run(&[
        "set",
        path_arg(&file),
        "layout[Standard]",
        "NEW",
        "--find",
        "Hello",
    ]);
    assert_eq!(code(&result), "TRACKING_HEADER_MISSING");
    let text = fs::read_to_string(&file).unwrap();
    assert!(
        !text.contains("\\change_"),
        "no tracked markers may be written (test_report_36 F5)"
    );
}

#[test]
fn dl85_f5_untracked_mutation_on_headerless_document_still_works() {
    let env = MutationSession::new();
    let file = env.write_file(
        "temp_dl85_f5_untracked.lyx",
        "#LyX 2.5 created this file.\n\
         \\begin_document\n\\begin_body\n\\begin_layout Standard\nHello\n\\end_layout\n\\end_body\n\\end_document\n",
    );
    let result = env.run(&[
        "set",
        path_arg(&file),
        "layout[Standard]",
        "NEW",
        "--find",
        "Hello",
    ]);
    assert_eq!(result["modified_nodes"], json!(1));
    assert!(fs::read_to_string(&file).unwrap().contains("NEW"));
}

#[test]
fn blast_radius_warning_on_multi_match_set() {
    let env = MutationSession::new();
    let file = env.write_lyx(
        "temp_blast.lyx",
        "\\begin_layout Standard\nAlpha\n\\end_layout\n\
         \\begin_layout Standard\nBeta\n\\end_layout\n",
        "",
    );
    let p = path_arg(&file);
    let result = env.run(&["set", p, "layout[Standard]", "X"]);
    assert_eq!(result["modified_nodes"], json!(2));
    let warnings = json_warnings(&result);
    assert!(
        warnings
            .iter()
            .any(|w| w.contains("Selector matches 2 nodes")
                && w.contains("lq undo")
                && w.contains(p)),
        "expected blast-radius warning, got {warnings:?}"
    );
}

#[test]
fn refresh_pre_error_disconnect_aborts_before_write() {
    let env = MutationSession::with_config(json!({ "refresh": "save-reload" }));
    let file = env.write_lyx(
        "temp_refresh_pre.lyx",
        "\\begin_layout Standard\nHello\n\\end_layout\n",
        "",
    );
    let before = fs::read_to_string(&file).unwrap();
    let bogus = env.work.path().join("no-lyx-socket");
    let result = env.run_env(
        &["set", path_arg(&file), "layout[Standard]", "Changed"],
        &[("LYXSOCKET", path_arg(&bogus))],
    );
    assert_eq!(code(&result), "REFRESH_PRE_ERROR");
    assert!(message(&result).contains("Cannot connect to LyX"));
    assert_eq!(fs::read_to_string(&file).unwrap(), before);
}

#[test]
fn dl127_f5b_configless_local_lq_warns_on_mutation() {
    let project = WorkDir::new();
    fs::create_dir_all(project.path().join(".lq")).unwrap();
    let file = project.path().join("doc.lyx");
    fs::write(&file, MINI_DOC).unwrap();
    let home = IsolatedHome::new();
    let result = parse_cli_json(&run_cli_with(
        &["set", path_arg(&file), "layout[Standard]", "Changed"],
        &home,
        project.path(),
    ));
    assert_eq!(result["modified_nodes"], json!(1));
    let warnings = json_warnings(&result);
    assert!(
        warnings.iter().any(|w| w.contains("has no config.json")),
        "expected missing-config warning, got: {warnings:?}"
    );
    assert!(
        fs::read_to_string(&file)
            .unwrap()
            .contains("\\change_inserted"),
        "defaults applied: tracking on"
    );
}

#[test]
fn dl127_f5b_configured_local_scope_does_not_warn() {
    let project = WorkDir::new();
    fs::create_dir_all(project.path().join(".lq")).unwrap();
    fs::write(
        project.path().join(".lq/config.json"),
        json!({ "refresh": "none", "trackChanges": true, "authorName": "Local" }).to_string(),
    )
    .unwrap();
    let file = project.path().join("doc.lyx");
    fs::write(&file, MINI_DOC).unwrap();
    let home = IsolatedHome::new();
    let result = parse_cli_json(&run_cli_with(
        &["set", path_arg(&file), "layout[Standard]", "Changed"],
        &home,
        project.path(),
    ));
    assert_eq!(result["modified_nodes"], json!(1));
    assert!(
        !json_warnings(&result)
            .iter()
            .any(|w| w.contains("config.json")),
        "{:?}",
        json_warnings(&result)
    );
}

#[test]
fn dl127_f5b_init_in_configless_local_scope_does_not_warn() {
    let project = WorkDir::new();
    fs::create_dir_all(project.path().join(".lq")).unwrap();
    let home = IsolatedHome::new();
    let result = parse_cli_json(&run_cli_with(&["init"], &home, project.path()));
    assert_eq!(result["action"], "created");
    assert!(
        !json_warnings(&result)
            .iter()
            .any(|w| w.contains("config.json")),
        "{:?}",
        json_warnings(&result)
    );
}

#[test]
fn dl127_f5b_global_scope_without_config_does_not_warn() {
    let work = WorkDir::new();
    let file = work.path().join("doc.lyx");
    fs::write(&file, MINI_DOC).unwrap();
    let home = IsolatedHome::new();
    let result = parse_cli_json(&run_cli_with(
        &["set", path_arg(&file), "layout[Standard]", "Changed"],
        &home,
        work.path(),
    ));
    assert_eq!(result["modified_nodes"], json!(1));
    assert!(
        !json_warnings(&result)
            .iter()
            .any(|w| w.contains("config.json")),
        "{:?}",
        json_warnings(&result)
    );
}

#[test]
fn dl127_f5b_unreadable_local_config_warns_and_defaults_apply() {
    let project = WorkDir::new();
    fs::create_dir_all(project.path().join(".lq")).unwrap();
    fs::write(project.path().join(".lq/config.json"), "not valid json {{").unwrap();
    let file = project.path().join("doc.lyx");
    fs::write(&file, MINI_DOC).unwrap();
    let home = IsolatedHome::new();
    let result = parse_cli_json(&run_cli_with(
        &["set", path_arg(&file), "layout[Standard]", "Changed"],
        &home,
        project.path(),
    ));
    assert_eq!(result["modified_nodes"], json!(1));
    let warnings = json_warnings(&result);
    assert!(
        warnings.iter().any(|w| w.contains("could not be read")),
        "expected unreadable-config warning, got: {warnings:?}"
    );
    assert!(
        fs::read_to_string(&file)
            .unwrap()
            .contains("\\change_inserted"),
        "defaults applied: tracking on"
    );
}

#[test]
fn cross_node_contains() {
    let env = MutationSession::new();
    let file = env.copy_fixture(
        "PerDevLog/test_report_33_repro.lyx",
        "temp_cross_contains.lyx",
    );
    let result = env.run(&[
        "read",
        path_arg(&file),
        "layout:contains('Compared to the literature, we find')",
        "--count",
    ]);
    assert_eq!(result["count"]["layout[Standard]"], json!(1));
}

#[test]
fn f2_contains_still_matches_across_a_formatting_property() {
    let env = MutationSession::new();
    let file = env.write_lyx(
        "temp_f2_contains_emph.lyx",
        r"\begin_layout Standard
Alpha 
\emph on
Beta
\emph default
Gamma
\end_layout
",
        "",
    );
    let result = env.run(&[
        "read",
        path_arg(&file),
        "layout:contains('Alpha Beta')",
        "--count",
    ]);
    assert_eq!(result["count"]["layout[Standard]"], json!(1));
}
