//! Leftover `tests/cli_test.ts` mutation / DL74 / DL111 / DL118 cases
//! (S8/S10 split `cli_test.ts` and `mutation_test.ts`; these CLI smokes were
//! not in `mutation_test.ts`).

mod common;

use common::{MutationSession, path_arg};
use serde_json::{Value, json};
use std::fs;

fn code(v: &Value) -> &str {
    v["code"].as_str().unwrap_or("")
}

fn message(v: &Value) -> &str {
    v["message"].as_str().unwrap_or("")
}

fn original_bytes(env: &MutationSession, dest: &str) -> (std::path::PathBuf, String) {
    let file = env.template(dest);
    let before = fs::read_to_string(&file).unwrap();
    (file, before)
}

#[test]
fn cli_set_command_success() {
    let env = MutationSession::new();
    let file = env.template("temp_cli_set_test.lyx");
    env.run(&["set", path_arg(&file), "layout[Title]", "Changed Title"]);
    let read = env.run(&["read", path_arg(&file), "layout[Title]", "--text-only"]);
    assert!(
        read["text"]
            .as_str()
            .unwrap_or("")
            .contains("Changed Title"),
        "{read}"
    );
}

#[test]
fn cli_delete_command_success() {
    let env = MutationSession::new();
    let file = env.template("temp_cli_delete_test.lyx");
    let before = env.run(&["read", "--count", path_arg(&file), "layout[Standard]"]);
    let total_before: i64 = before["count"]
        .as_object()
        .unwrap()
        .values()
        .filter_map(|v| v.as_i64())
        .sum();
    env.run(&["delete", path_arg(&file), "layout[Standard]:first"]);
    let after = env.run(&["read", "--count", path_arg(&file), "layout[Standard]"]);
    let total_after: i64 = after["count"]
        .as_object()
        .unwrap()
        .values()
        .filter_map(|v| v.as_i64())
        .sum();
    assert_eq!(total_after, total_before - 1);
}

#[test]
fn cli_set_with_track_changes() {
    let env = MutationSession::with_config(json!({ "trackChanges": true }));
    let file = env.template("temp_tc_set.lyx");
    env.run(&["set", path_arg(&file), "layout[Title]", "Tracked Title"]);
    let text = fs::read_to_string(&file).unwrap();
    assert!(text.contains("\\change_deleted"));
    assert!(text.contains("\\change_inserted"));
    assert!(text.contains("Tracked Title"));
    assert!(text.contains("\\tracking_changes true"));
    assert!(
        regex_author_lq_user(&text),
        "expected default author lq user, got header excerpt"
    );
}

fn regex_author_lq_user(text: &str) -> bool {
    text.lines()
        .any(|l| l.starts_with("\\author ") && l.contains("\"lq user\""))
}

#[test]
fn cli_delete_with_track_changes() {
    let env = MutationSession::with_config(json!({ "trackChanges": true }));
    let file = env.template("temp_tc_delete.lyx");
    let before = env.run(&["read", "--count", path_arg(&file), "layout[Standard]"]);
    let total_before: i64 = before["count"]
        .as_object()
        .unwrap()
        .values()
        .filter_map(|v| v.as_i64())
        .sum();
    env.run(&["delete", path_arg(&file), "layout[Standard]:first"]);
    let after = env.run(&["read", "--count", path_arg(&file), "layout[Standard]"]);
    let total_after: i64 = after["count"]
        .as_object()
        .unwrap()
        .values()
        .filter_map(|v| v.as_i64())
        .sum();
    assert_eq!(total_after, total_before);
    let text = fs::read_to_string(&file).unwrap();
    assert!(text.contains("\\change_deleted"));
    assert!(text.contains("\\tracking_changes true"));
    assert!(regex_author_lq_user(&text));
}

#[test]
fn cli_insert_with_track_changes() {
    let env = MutationSession::with_config(json!({ "trackChanges": true }));
    let file = env.template("temp_tc_insert.lyx");
    let result = env.run(&[
        "insert",
        path_arg(&file),
        "layout[Title]",
        "after",
        "--layout",
        "Standard",
        "--text",
        "Tracked Insert",
    ]);
    assert_eq!(code(&result), "", "{result}");
    let text = fs::read_to_string(&file).unwrap();
    assert!(text.contains("\\change_inserted"));
    assert!(text.contains("Tracked Insert"));
    assert!(text.contains("\\tracking_changes true"));
    assert!(regex_author_lq_user(&text));
}

#[test]
fn cli_set_find_basic_substring_replacement() {
    let env = MutationSession::new();
    let file = env.template("temp_find_basic.lyx");
    env.run(&[
        "set",
        path_arg(&file),
        "layout[Standard]:contains('writing')",
        "text",
        "--find",
        "writing",
    ]);
    let read = env.run(&[
        "read",
        path_arg(&file),
        "layout[Standard]:contains('text')",
        "--text-only",
    ]);
    let t = read["text"].as_str().unwrap_or("");
    assert!(!t.contains("writing"), "{t}");
    assert!(t.contains("text"), "{t}");
}

#[test]
fn cli_set_find_replaces_all_occurrences() {
    let env = MutationSession::new();
    let file = env.template("temp_find_multi.lyx");
    env.run(&[
        "set",
        path_arg(&file),
        "layout[Standard]:contains('paper')",
        "article",
        "--find",
        "paper",
    ]);
    let read = env.run(&[
        "read",
        path_arg(&file),
        "layout[Standard]:contains('article')",
        "--text-only",
    ]);
    let t = read["text"].as_str().unwrap_or("");
    assert!(!t.contains("paper"), "{t}");
    assert!(t.contains("article"), "{t}");
}

#[test]
fn cli_set_find_no_match_errors() {
    let env = MutationSession::new();
    let file = env.template("temp_find_none.lyx");
    let result = env.run(&[
        "set",
        path_arg(&file),
        "layout[Standard]:first",
        "replacement",
        "--find",
        "nonexistent_xyz",
    ]);
    assert_eq!(code(&result), "NO_MATCH");
    assert!(
        message(&result).contains("--text-only"),
        "{}",
        message(&result)
    );
}

#[test]
fn cli_set_find_and_replace_all_conflict() {
    let env = MutationSession::new();
    let file = env.template("temp_find_conflict.lyx");
    let result = env.run(&[
        "set",
        path_arg(&file),
        "layout[Standard]:first",
        "text",
        "--find",
        "foo",
        "--replace-all",
    ]);
    assert_eq!(code(&result), "FLAG_CONFLICT");
}

#[test]
fn cli_set_find_with_track_changes() {
    let env = MutationSession::with_config(json!({ "trackChanges": true }));
    let file = env.template("temp_find_tc.lyx");
    env.run(&[
        "set",
        path_arg(&file),
        "layout[Standard]:contains('writing')",
        "text",
        "--find",
        "writing",
    ]);
    let text = fs::read_to_string(&file).unwrap();
    assert!(text.contains("\\change_deleted"));
    assert!(text.contains("\\change_inserted"));
    assert!(text.contains("\\tracking_changes true"));
    assert!(regex_author_lq_user(&text));
}

#[test]
fn cli_set_find_on_property_node() {
    let env = MutationSession::new();
    let file = env.template("temp_find_prop.lyx");
    env.run(&[
        "set",
        path_arg(&file),
        "property[language]",
        "english",
        "--find",
        "british",
    ]);
    let read = env.run(&["read", path_arg(&file), "property[language]"]);
    assert_eq!(read["data"][0]["value"], json!("english"));
}

#[test]
fn cli_tracked_set_on_inset_block_rejects_with_tracking_error() {
    let env = MutationSession::with_config(json!({ "trackChanges": true }));
    let file = env.template("temp_inset_tc_set.lyx");
    let result = env.run(&[
        "set",
        path_arg(&file),
        "inset[CommandInset label]:first",
        "new label",
    ]);
    assert_eq!(code(&result), "TRACKING_ERROR");
    assert!(
        message(&result).contains("Cannot track changes inside inset parameters"),
        "{}",
        message(&result)
    );
}

#[test]
fn cli_default_set_on_inset_block_rejects_with_invalid_context_tracking_off() {
    let env = MutationSession::new();
    let file = env.template("temp_inset_default_set.lyx");
    let result = env.run(&[
        "set",
        path_arg(&file),
        "inset[CommandInset label]:first",
        "new label",
    ]);
    assert_eq!(code(&result), "INVALID_CONTEXT");
    let msg = message(&result);
    assert!(
        msg.contains("Default 'set' on an inset would destroy its structure"),
        "{msg}"
    );
    assert!(
        msg.contains("\n  --find"),
        "list indent must survive string continuation: {msg:?}"
    );
}

#[test]
fn cli_untracked_find_on_inset_block_allowed() {
    let env = MutationSession::new();
    let file = env.template("temp_inset_find_ok.lyx");
    let result = env.run(&[
        "set",
        path_arg(&file),
        "inset[CommandInset label]:first",
        "sec:new",
        "--find",
        "sec:",
    ]);
    assert_eq!(code(&result), "", "{result}");
}

#[test]
fn cli_delete_on_nested_inset_rejects_with_tracking_error() {
    let env = MutationSession::with_config(json!({ "trackChanges": true }));
    let file = env.template("temp_nested_inset_del.lyx");
    let result = env.run(&["delete", path_arg(&file), "inset[Text]:first"]);
    assert_eq!(code(&result), "TRACKING_ERROR");
    assert!(
        message(&result).contains("Cannot track-delete an inset nested inside another inset"),
        "{}",
        message(&result)
    );
}

#[test]
fn cli_delete_on_top_level_inset_wraps_markers_around_whole_inset() {
    let env = MutationSession::with_config(json!({ "trackChanges": true }));
    let file = env.template("temp_toplevel_inset_del.lyx");
    env.run(&["delete", path_arg(&file), "inset[Foot]:first"]);
    let text = fs::read_to_string(&file).unwrap();
    assert!(text.contains("\\change_deleted"));
    assert!(
        text.contains("\\change_deleted") && text.contains("\\begin_inset Foot"),
        "markers present with Foot inset"
    );
    let deleted_before_foot = text
        .match_indices("\\begin_inset Foot")
        .any(|(i, _)| text[..i].contains("\\change_deleted"));
    assert!(deleted_before_foot, "opener before Foot inset");
    assert!(
        text.contains("\\end_inset\n\\change_unchanged"),
        "closer after end_inset"
    );
}

#[test]
fn cli_tracked_set_on_preamble_block_rejects_with_tracking_error() {
    let env = MutationSession::with_config(json!({ "trackChanges": true }));
    let (file, before) = original_bytes(&env, "temp_dl111_preamble_set.lyx");
    let result = env.run(&["set", path_arg(&file), "preamble", "X"]);
    assert_eq!(code(&result), "TRACKING_ERROR");
    assert!(
        message(&result).contains("only valid inside a layout's text"),
        "{}",
        message(&result)
    );
    assert_eq!(fs::read_to_string(&file).unwrap(), before);
}

#[test]
fn cli_tracked_set_find_on_preamble_text_rejects_with_tracking_error() {
    let env = MutationSession::with_config(json!({ "trackChanges": true }));
    let (file, before) = original_bytes(&env, "temp_dl111_preamble_find.lyx");
    let result = env.run(&[
        "set",
        path_arg(&file),
        "preamble text",
        "X",
        "--find",
        "threeparttable",
    ]);
    assert_eq!(code(&result), "TRACKING_ERROR");
    assert!(message(&result).contains("only valid inside a layout's text"));
    assert_eq!(fs::read_to_string(&file).unwrap(), before);
}

#[test]
fn cli_tracked_delete_on_preamble_block_rejects_with_tracking_error() {
    let env = MutationSession::with_config(json!({ "trackChanges": true }));
    let (file, before) = original_bytes(&env, "temp_dl111_preamble_delete.lyx");
    let result = env.run(&["delete", path_arg(&file), "preamble"]);
    assert_eq!(code(&result), "TRACKING_ERROR");
    assert!(message(&result).contains("only valid inside a layout's text"));
    assert_eq!(fs::read_to_string(&file).unwrap(), before);
}

#[test]
fn cli_tracked_set_on_root_comment_rejects_with_tracking_error() {
    let env = MutationSession::with_config(json!({ "trackChanges": true }));
    let (file, before) = original_bytes(&env, "temp_dl111_comment_set.lyx");
    let result = env.run(&["set", path_arg(&file), "text:first()", "X"]);
    assert_eq!(code(&result), "TRACKING_ERROR");
    assert!(message(&result).contains("only valid inside a layout's text"));
    assert_eq!(fs::read_to_string(&file).unwrap(), before);
}

#[test]
fn cli_tracked_set_find_on_inset_metadata_text_rejects_with_tracking_error() {
    let env = MutationSession::with_config(json!({ "trackChanges": true }));
    let (file, before) = original_bytes(&env, "temp_dl111_inset_meta.lyx");
    let result = env.run(&[
        "set",
        path_arg(&file),
        "inset[Foot] text",
        "X",
        "--find",
        "status",
    ]);
    assert_eq!(code(&result), "TRACKING_ERROR");
    assert!(message(&result).contains("only valid inside a layout's text"));
    assert_eq!(fs::read_to_string(&file).unwrap(), before);
}

#[test]
fn cli_tracked_set_find_on_header_property_still_allowed_regression() {
    let env = MutationSession::with_config(json!({ "trackChanges": true }));
    let file = env.template("temp_dl111_prop_ok.lyx");
    let result = env.run(&[
        "set",
        path_arg(&file),
        "property[language]",
        "english",
        "--find",
        "british",
    ]);
    assert_eq!(code(&result), "", "{result}");
    assert!(
        fs::read_to_string(&file)
            .unwrap()
            .contains("\\language english")
    );
}

#[test]
fn cli_untracked_preamble_set_find_edits_cleanly() {
    let env = MutationSession::new();
    let file = env.template("temp_dl111_preamble_untracked.lyx");
    let result = env.run(&[
        "set",
        path_arg(&file),
        "preamble",
        "X",
        "--find",
        "threeparttable",
    ]);
    assert_eq!(result["modified_nodes"], json!(1));
    let text = fs::read_to_string(&file).unwrap();
    assert!(text.contains("\\usepackage{X}"));
    let start = text.find("\\begin_preamble").unwrap();
    let end = text.find("\\end_preamble").unwrap();
    let preamble = &text[start..end];
    assert!(!preamble.contains("\\change_deleted"));
    assert!(!preamble.contains("\\change_inserted"));
}

#[test]
fn dl118_set_errors_on_anchorless_until_file_unchanged() {
    let env = MutationSession::new();
    let (file, before) = original_bytes(&env, "temp_dl118_set_until.lyx");
    let result = env.run(&[
        "set",
        path_arg(&file),
        "layout[Standard]:until(layout[Section])",
        "X",
    ]);
    assert_eq!(code(&result), "INVALID_SELECTOR");
    assert!(message(&result).contains(":until()"));
    assert_eq!(fs::read_to_string(&file).unwrap(), before);
}

#[test]
fn dl118_undo_replay_errors_on_anchorless_until() {
    let env = MutationSession::new();
    let file = env.template("temp_dl118_undo_until.lyx");
    let result = env.run(&[
        "undo",
        path_arg(&file),
        "layout[Standard]:until(layout[Section])",
    ]);
    assert_eq!(code(&result), "INVALID_SELECTOR");
    assert!(message(&result).contains(":until()"));
}

#[test]
fn dl118_set_with_text_contains_x_errors_file_unchanged() {
    let env = MutationSession::new();
    let (file, before) = original_bytes(&env, "temp_dl118_set_text_contains.lyx");
    let result = env.run(&["set", path_arg(&file), "text:contains(world)", "X"]);
    assert_eq!(code(&result), "INVALID_SELECTOR");
    assert!(message(&result).contains("never matches"));
    assert_eq!(fs::read_to_string(&file).unwrap(), before);
}

#[test]
fn dl118_second_snapshot_undo_names_the_consumed_snapshot_possibility() {
    let env = MutationSession::with_config(json!({ "trackChanges": true }));
    let file = env.template("temp_dl118_undo_twice.lyx");
    env.run(&["set", path_arg(&file), "layout[Title]", "First edit"]);
    env.run(&["set", path_arg(&file), "layout[Title]", "Second edit"]);
    let first = env.run(&["undo", path_arg(&file)]);
    assert_eq!(first["method"], json!("snapshot"));
    let second = env.run(&["undo", path_arg(&file)]);
    assert_eq!(code(&second), "UNDO_SNAPSHOT_UNAVAILABLE");
    assert!(
        message(&second)
            .contains("Possibly because a previous 'undo' already consumed the snapshot"),
        "{}",
        message(&second)
    );
    assert!(!message(&second).contains("Verify"), "{}", message(&second));
}
