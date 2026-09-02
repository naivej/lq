//! `read` command parity (Deno `tests/cli_test.ts` and `tests/mutation_test.ts`).

mod common;

use common::{CliOutput, IsolatedHome, WorkDir, fixtures_root, json_stdout, run_cli_with};
use serde_json::{Value, json};
use std::fs;
use std::path::{Path, PathBuf};

const MISSING_ARGS_MESSAGE: &str =
    "Usage: lq <command> <file> [selector] [value]. Run 'lq help' for details.";
const MISSING_SELECTOR_MESSAGE: &str =
    "A CSS selector is required for this command. Run 'lq help selectors' for selector syntax.";
const UNTIL_MESSAGE: &str = ":until() has no effect here: it only bounds the target of a ~ sibling range. Move it after a ~ (e.g. 'layout[A] ~ layout[B]:until(layout[C])') or drop ':until'.";
const TEXT_CONTAINS_MESSAGE: &str = "text:contains(...) never matches — text nodes are not returned for :contains. Select the block instead (e.g. 'layout[Standard]:contains(foo)') or do content work with 'set --find' / 'insert split-after'.";

struct ReadEnv {
    home: IsolatedHome,
    work: WorkDir,
}

impl ReadEnv {
    fn new() -> Self {
        let home = IsolatedHome::new();
        let work = WorkDir::new();
        fs::write(
            home.path().join(".lq/config.json"),
            json!({
                "refresh": "none",
                "trackChanges": false,
            })
            .to_string(),
        )
        .unwrap();
        Self { home, work }
    }

    fn run(&self, args: &[&str]) -> CliOutput {
        run_cli_with(args, &self.home, self.work.path())
    }

    fn write_lyx(&self, name: &str, body: &str, header: &str) -> PathBuf {
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
}

fn fixture(relative: &str) -> PathBuf {
    fixtures_root().join(relative)
}

fn path_arg(path: &Path) -> &str {
    path.to_str().unwrap()
}

fn success_json(out: &CliOutput) -> Value {
    assert_eq!(
        out.code, 0,
        "stdout: {}\nstderr: {}",
        out.stdout, out.stderr
    );
    assert_eq!(out.stderr, "");
    json_stdout(out)
}

fn assert_error(out: &CliOutput, code: &str, message: &str) {
    assert_eq!(
        out.code, 1,
        "stdout: {}\nstderr: {}",
        out.stdout, out.stderr
    );
    assert_eq!(out.stderr, "");
    assert_eq!(
        json_stdout(out),
        json!({
            "code": code,
            "message": message,
            "warnings": [],
        })
    );
}

#[test]
fn cli_reject_non_lyx_files() {
    let env = ReadEnv::new();
    let out = env.run(&["read", "not-a-lyx.txt", "layout"]);
    assert_error(
        &out,
        "INVALID_EXTENSION",
        "Target file 'not-a-lyx.txt' must have a .lyx extension. Select the LyX document to edit.",
    );
}

#[test]
fn cli_missing_arguments() {
    let env = ReadEnv::new();
    let out = env.run(&["read"]);
    assert_error(&out, "MISSING_ARGS", MISSING_ARGS_MESSAGE);
}

#[test]
fn cli_read_mode_flags_without_a_file_report_missing_args() {
    let env = ReadEnv::new();
    for args in [
        &["read", "--count"][..],
        &["read", "--text-only"][..],
        &["read", "--count", "--text-only"][..],
    ] {
        let out = env.run(args);
        assert_error(&out, "MISSING_ARGS", MISSING_ARGS_MESSAGE);
    }
}

#[test]
fn cli_missing_selector_recommends_selector_help() {
    let env = ReadEnv::new();
    let file = fixture("my_template.lyx");
    let out = env.run(&["read", path_arg(&file)]);
    assert_error(&out, "MISSING_SELECTOR", MISSING_SELECTOR_MESSAGE);
}

#[test]
fn cli_selector_position_flag_typos_are_rejected() {
    let env = ReadEnv::new();
    let file = fixture("my_template.lyx");
    let out = env.run(&["read", path_arg(&file), "--text-ony"]);
    assert_error(
        &out,
        "INVALID_FLAG",
        "Unknown flag for 'read': --text-ony. Run 'lq read --help' to list valid flags.",
    );
}

#[test]
fn cli_read_default_returns_annotated_data_and_numeric_count() {
    let env = ReadEnv::new();
    let file = fixture("my_template.lyx");
    let out = env.run(&[
        "read",
        path_arg(&file),
        "layout[Standard]:contains('something with tracked changes')",
    ]);
    assert_eq!(
        success_json(&out),
        json!({
            "data": [{
                "type": "block",
                "tag": "layout",
                "args": "Standard",
                "isBeginVariant": true,
                "children": [
                    {"type": "text", "text": "I "},
                    {
                        "type": "property",
                        "key": "change_deleted",
                        "value": "236438948 1776668506",
                    },
                    {"type": "text", "text": "write", "changeStatus": "deleted"},
                    {
                        "type": "property",
                        "key": "change_inserted",
                        "value": "236438948 1776668507",
                    },
                    {"type": "text", "text": "edit", "changeStatus": "inserted"},
                    {"type": "property", "key": "change_unchanged"},
                    {"type": "text", "text": " something with tracked changes."},
                ],
            }],
            "count": 1,
            "warnings": [],
        })
    );
}

#[test]
fn cli_read_count_groups_matches_by_node_label() {
    let env = ReadEnv::new();
    let file = fixture("my_template.lyx");
    let out = env.run(&[
        "read",
        "--count",
        path_arg(&file),
        "layout[Title], property[language]",
    ]);
    assert_eq!(
        success_json(&out),
        json!({
            "count": {
                "layout[Title]": 1,
                "property[language]": 1,
            },
            "warnings": [],
        })
    );
}

#[test]
fn cli_read_text_only_basic() {
    let env = ReadEnv::new();
    let file = fixture("my_template.lyx");
    let out = env.run(&["read", path_arg(&file), "layout[Title]", "--text-only"]);
    assert_eq!(
        success_json(&out),
        json!({
            "text": "layout[Title] Title\n",
            "warnings": [],
        })
    );
}

#[test]
fn cli_read_text_only_and_count_combined() {
    let env = ReadEnv::new();
    let file = fixture("my_template.lyx");
    let out = env.run(&[
        "read",
        path_arg(&file),
        "layout[Title]",
        "--text-only",
        "--count",
    ]);
    assert_eq!(
        success_json(&out),
        json!({
            "count": {"layout[Title]": 1},
            "text": "layout[Title] Title\n",
            "warnings": [],
        })
    );
}

#[test]
fn cli_read_empty_result_shapes() {
    let env = ReadEnv::new();
    let file = fixture("my_template.lyx");
    let file = path_arg(&file);
    let selector = "layout[NoSuchLayout]";

    let default = env.run(&["read", file, selector]);
    assert_eq!(
        success_json(&default),
        json!({"data": [], "count": 0, "warnings": []})
    );

    let count = env.run(&["read", file, selector, "--count"]);
    assert_eq!(success_json(&count), json!({"count": {}, "warnings": []}));

    let text = env.run(&["read", file, selector, "--text-only"]);
    assert_eq!(success_json(&text), json!({"text": "\n", "warnings": []}));

    let combined = env.run(&["read", file, selector, "--count", "--text-only"]);
    assert_eq!(
        success_json(&combined),
        json!({"count": {}, "text": "\n", "warnings": []})
    );
}

#[test]
fn dl118_read_errors_on_anchorless_until() {
    let env = ReadEnv::new();
    let file = fixture("my_template.lyx");
    let out = env.run(&[
        "read",
        path_arg(&file),
        "layout[Standard]:until(layout[Section])",
        "--count",
    ]);
    assert_error(&out, "INVALID_SELECTOR", UNTIL_MESSAGE);
}

#[test]
fn dl118_anchor_side_until_errors_on_read() {
    let env = ReadEnv::new();
    let file = fixture("my_template.lyx");
    let out = env.run(&[
        "read",
        path_arg(&file),
        "layout[Standard]:until(layout[Section]) ~ layout[Standard]",
        "--count",
    ]);
    assert_error(&out, "INVALID_SELECTOR", UNTIL_MESSAGE);
}

#[test]
fn dl118_text_contains_x_errors_on_read() {
    let env = ReadEnv::new();
    let file = fixture("my_template.lyx");
    let out = env.run(&["read", path_arg(&file), "text:contains(world)"]);
    assert_error(&out, "INVALID_SELECTOR", TEXT_CONTAINS_MESSAGE);
}

#[test]
fn dl118_a_union_with_one_dead_arm_errors_strict() {
    let env = ReadEnv::new();
    let file = fixture("my_template.lyx");
    let out = env.run(&[
        "read",
        path_arg(&file),
        "text:contains(world) | layout[Standard]",
        "--count",
    ]);
    assert_error(&out, "INVALID_SELECTOR", "Invalid pseudo-class syntax: |");
}

#[test]
fn dl118_invalid_nth_match_formulas_error() {
    let env = ReadEnv::new();
    let file = fixture("my_template.lyx");
    for formula in ["abc", "2n+"] {
        let selector = format!("layout[Standard]:nth-match({formula})");
        let out = env.run(&["read", path_arg(&file), &selector, "--count"]);
        assert_error(
            &out,
            "INVALID_SELECTOR",
            &format!(
                ":nth-match({formula}) has an invalid formula — it would match nothing. Use an integer, 'odd', 'even', or a formula like '2n+1'."
            ),
        );
    }
}

#[test]
fn dl118_nth_match_0_is_a_valid_formula_matching_nothing() {
    let env = ReadEnv::new();
    let file = fixture("my_template.lyx");
    let out = env.run(&[
        "read",
        path_arg(&file),
        "layout[Standard]:nth-match(0)",
        "--count",
    ]);
    assert_eq!(success_json(&out), json!({"count": {}, "warnings": []}));
}

#[test]
fn dl118_negative_valid_selectors_neither_warn_nor_error() {
    let env = ReadEnv::new();
    let file = fixture("my_template.lyx");
    let file = path_arg(&file);

    let contains = env.run(&["read", file, "layout:contains(text)"]);
    assert_eq!(
        success_json(&contains),
        json!({
            "data": [{
                "type": "block",
                "tag": "layout",
                "args": "Standard",
                "isBeginVariant": true,
                "children": [{
                    "type": "text",
                    "text": "Something not in main text.",
                }],
            }],
            "count": 1,
            "warnings": [],
        })
    );

    let bounded = env.run(&[
        "read",
        file,
        "layout[Section]:first ~ layout[Standard]:until(layout[Section])",
        "--count",
    ]);
    assert_eq!(
        success_json(&bounded),
        json!({"count": {"layout[Standard]": 8}, "warnings": []})
    );

    let nth = env.run(&["read", file, "layout[Standard]:nth-match(2n+1)", "--count"]);
    assert_eq!(
        success_json(&nth),
        json!({"count": {"layout[Standard]": 6}, "warnings": []})
    );
}

#[test]
fn dl99_read_text_only_on_a_visible_layout_collapses_the_note_to_a_marker() {
    let env = ReadEnv::new();
    let body = concat!(
        "\\begin_layout Standard\n",
        "Visible alpha.\n",
        "\\begin_inset Note Note\n",
        "status collapsed\n",
        "\n",
        "\\begin_layout Plain Layout\n",
        "PRIVATE SECRET note\n",
        "\\end_layout\n",
        "\n",
        "\\end_inset\n",
        "\n",
        "Visible beta.\n",
        "\\end_layout\n",
    );
    let file = env.write_lyx("temp_dl99_textonly.lyx", body, "\\textclass article\n");
    let out = env.run(&[
        "read",
        path_arg(&file),
        "layout[Standard]:first",
        "--text-only",
    ]);
    assert_eq!(
        success_json(&out),
        json!({
            "text": "layout[Standard] Visible alpha. inset[Note Note] Visible beta.\n",
            "warnings": [],
        })
    );
}

#[test]
fn dl84_f1_read_annotations_inserted_text_labeled_inserted_trailing_unchanged() {
    let env = ReadEnv::new();
    let body = concat!(
        "\\begin_layout Standard\n",
        "I \n",
        "\\change_deleted 1 1776668506\n",
        "write\n",
        "\\change_inserted 1 1776668507\n",
        "edit\n",
        "\\change_unchanged\n",
        " something with tracked changes.\n",
        "\\end_layout\n",
    );
    let file = env.write_lyx("temp_dl84_f1_read.lyx", body, "\\author 1 \"Alice\"\n");
    let out = env.run(&["read", path_arg(&file), "layout[Standard]"]);
    assert_eq!(
        success_json(&out),
        json!({
            "data": [{
                "type": "block",
                "tag": "layout",
                "args": "Standard",
                "isBeginVariant": true,
                "children": [
                    {"type": "text", "text": "I "},
                    {
                        "type": "property",
                        "key": "change_deleted",
                        "value": "1 1776668506",
                    },
                    {"type": "text", "text": "write", "changeStatus": "deleted"},
                    {
                        "type": "property",
                        "key": "change_inserted",
                        "value": "1 1776668507",
                    },
                    {"type": "text", "text": "edit", "changeStatus": "inserted"},
                    {"type": "property", "key": "change_unchanged"},
                    {"type": "text", "text": " something with tracked changes."},
                ],
            }],
            "count": 1,
            "warnings": [],
        })
    );
}

#[test]
fn cli_read_text_only_warns_over_10_kib_using_js_utf_16_length() {
    let env = ReadEnv::new();
    let payload = "😀".repeat(6_000);
    let body = format!("\\begin_layout Standard\n{payload}\n\\end_layout\n");
    let file = env.write_lyx("temp_large_textonly.lyx", &body, "");
    let expected_text = format!("layout[Standard] {payload}\n");
    let utf16_len = expected_text.encode_utf16().count();
    assert_eq!(utf16_len, 12_018);
    assert!(utf16_len > 10 * 1024);
    let size_kb = (utf16_len + 512) / 1024;

    let out = env.run(&["read", path_arg(&file), "layout[Standard]", "--text-only"]);
    assert_eq!(
        success_json(&out),
        json!({
            "text": expected_text,
            "warnings": [format!(
                "--text-only output is {size_kb}KB across 1 nodes. Consider a more specific selector to reduce noise."
            )],
        })
    );
}
