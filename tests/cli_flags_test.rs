//! A-1 / A-3 typed flags (023). CLI process seam.

mod common;

use common::{
    IsolatedHome, MutationSession, WorkDir, json_stdout, path_arg, run_cli, run_cli_with,
};
use serde_json::json;
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

fn template_file(work: &WorkDir) -> std::path::PathBuf {
    let dest = work.path().join("doc.lyx");
    fs::copy(common::fixtures_root().join("my_template.lyx"), &dest).unwrap();
    dest
}

#[test]
fn switch_rejects_equals_false() {
    let home = IsolatedHome::new();
    let work = WorkDir::new();
    let file = template_file(&work);
    let out = run_cli_with(
        &["dump", path_arg(&file), "--toc=false"],
        &home,
        work.path(),
    );
    assert_eq!(err_code(&out), "INVALID_FLAG");
    assert!(err_message(&out).contains("--toc"));
    assert!(err_message(&out).contains("does not take a value"));
}

#[test]
fn switch_rejects_following_true() {
    let home = IsolatedHome::new();
    let work = WorkDir::new();
    let file = template_file(&work);
    let out = run_cli_with(
        &["read", path_arg(&file), "layout[Title]", "--count", "true"],
        &home,
        work.path(),
    );
    assert_eq!(err_code(&out), "INVALID_FLAG");
    assert!(err_message(&out).contains("Unexpected argument 'true'"));
}

#[test]
fn unknown_flag_does_not_eat_selector() {
    let home = IsolatedHome::new();
    let work = WorkDir::new();
    let file = template_file(&work);
    let out = run_cli_with(
        &["read", path_arg(&file), "--bogus", "layout[Title]"],
        &home,
        work.path(),
    );
    assert_eq!(err_code(&out), "INVALID_FLAG");
    let msg = err_message(&out);
    assert!(msg.contains("--bogus"), "{msg}");
    assert!(!msg.contains("layout[Title]"), "{msg}");
}

#[test]
fn extra_positional_on_init_is_rejected() {
    let home = IsolatedHome::new();
    let work = WorkDir::new();
    let out = run_cli_with(&["init", "leftover"], &home, work.path());
    assert_eq!(err_code(&out), "INVALID_FLAG");
    assert!(err_message(&out).contains("Unexpected argument 'leftover'"));
}

#[test]
fn extra_positional_on_dump_toc_is_rejected() {
    let home = IsolatedHome::new();
    let work = WorkDir::new();
    let file = template_file(&work);
    let out = run_cli_with(
        &["dump", path_arg(&file), "--toc", "leftover"],
        &home,
        work.path(),
    );
    assert_eq!(err_code(&out), "INVALID_FLAG");
    assert!(err_message(&out).contains("Unexpected argument 'leftover'"));
}

#[test]
fn extra_positional_on_read_is_rejected() {
    let home = IsolatedHome::new();
    let work = WorkDir::new();
    let file = template_file(&work);
    let out = run_cli_with(
        &["read", path_arg(&file), "layout[Title]", "leftover"],
        &home,
        work.path(),
    );
    assert_eq!(err_code(&out), "INVALID_FLAG");
    assert!(err_message(&out).contains("Unexpected argument 'leftover'"));
}

#[test]
fn toc_depth_space_minus_one_is_accepted() {
    let home = IsolatedHome::new();
    let work = WorkDir::new();
    let file = template_file(&work);
    let out = run_cli_with(
        &["dump", path_arg(&file), "--toc", "--depth", "-1"],
        &home,
        work.path(),
    );
    assert_eq!(out.code, 0, "{}", out.stdout);
}

#[test]
fn find_does_not_consume_replace_all() {
    let env = MutationSession::new();
    let file = env.template("find_flags.lyx");
    let result = env.run(&[
        "set",
        path_arg(&file),
        "layout[Title]",
        "x",
        "--find",
        "--replace-all",
    ]);
    assert_eq!(result["code"], "INVALID_FLAG");
    assert!(
        result["message"]
            .as_str()
            .unwrap_or("")
            .contains("'--find' requires a value"),
        "{result}"
    );
}

#[test]
fn lone_dash_dash_is_rejected() {
    let home = IsolatedHome::new();
    let work = WorkDir::new();
    let file = template_file(&work);
    let out = run_cli_with(
        &["read", path_arg(&file), "--", "layout[Title]"],
        &home,
        work.path(),
    );
    assert_eq!(err_code(&out), "INVALID_FLAG");
    assert!(err_message(&out).contains("'--' is not valid here"));
}

#[test]
fn set_dash_dash_find_is_rejected() {
    let env = MutationSession::new();
    let file = env.template("set_endopt.lyx");
    let result = env.run(&["set", path_arg(&file), "layout[Title]", "--", "--find"]);
    assert_eq!(result["code"], "INVALID_FLAG");
    assert!(
        result["message"]
            .as_str()
            .unwrap_or("")
            .contains("'--' is not valid here"),
        "{result}"
    );
}

#[test]
fn set_positional_minus_one() {
    let env = MutationSession::new();
    let file = env.template("set_minus.lyx");
    let result = env.run(&["set", path_arg(&file), "layout[Title]", "-1"]);
    assert!(result.get("code").is_none(), "{result}");
    let read = env.run(&["read", path_arg(&file), "layout[Title]", "--text-only"]);
    assert!(read["text"].as_str().unwrap_or("").contains("-1"), "{read}");
}

#[test]
fn insert_text_equals_looks_like_flag() {
    let env = MutationSession::new();
    let file = env.template("ins_eq.lyx");
    let result = env.run(&[
        "insert",
        path_arg(&file),
        "layout[Title]",
        "after",
        "--layout",
        "Standard",
        "--text=--find",
    ]);
    assert_eq!(result["matched_nodes"], json!(1), "{result}");
    let text = fs::read_to_string(&file).unwrap();
    assert!(text.contains("--find"), "{text}");
}

#[test]
fn insert_text_then_find_flag_is_missing_value() {
    let env = MutationSession::new();
    let file = env.template("ins_two.lyx");
    let result = env.run(&[
        "insert",
        path_arg(&file),
        "layout[Title]",
        "after",
        "--layout",
        "Standard",
        "--text",
        "--find",
    ]);
    assert_eq!(result["code"], "INVALID_FLAG");
    assert!(
        result["message"]
            .as_str()
            .unwrap_or("")
            .contains("'--text' requires a value"),
        "{result}"
    );
}

#[test]
fn insert_help_does_not_teach_text_equals_flag_lookalike() {
    let out = run_cli(&["insert", "--help"]);
    assert!(!out.stdout.contains("--text=--find"));
}

#[test]
fn read_count_before_file_still_works() {
    let home = IsolatedHome::new();
    let work = WorkDir::new();
    let file = template_file(&work);
    let out = run_cli_with(
        &["read", "--count", path_arg(&file), "layout[Title]"],
        &home,
        work.path(),
    );
    assert_eq!(out.code, 0, "{}", out.stdout);
    assert!(json_stdout(&out)["count"].is_object());
}

#[test]
fn dump_toc_after_file_still_works() {
    let home = IsolatedHome::new();
    let work = WorkDir::new();
    let file = template_file(&work);
    let out = run_cli_with(&["dump", path_arg(&file), "--toc"], &home, work.path());
    assert_eq!(out.code, 0, "{}", out.stdout);
}

#[test]
fn init_max_cache_entries_space_minus_one_is_range_error() {
    let out = run_cli(&["init", "--max-cache-entries", "-1"]);
    assert_eq!(err_code(&out), "INVALID_FLAG");
    assert!(err_message(&out).contains("max-cache-entries"));
}

#[test]
fn home_help_names_typed_flags() {
    let out = run_cli(&["help"]);
    assert!(out.stdout.contains(
        "Flags are typed: a boolean flag takes no value; unknown flags and extra arguments are errors."
    ));
}

#[test]
fn dump_help_names_depth_minus_one() {
    let out = run_cli(&["dump", "--help"]);
    assert!(out.stdout.contains("--depth -1"));
    assert!(!out.stdout.contains("Use an equal sign to pass a negative"));
}
