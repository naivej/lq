//! `lq dump` process tests (Deno `tests/cli_test.ts` and `tests/mutation_test.ts`).

mod common;

use common::{CliOutput, IsolatedHome, WorkDir, fixtures_root, json_stdout, run_cli_with};
use serde_json::{Value, json};
use std::fs;
use std::path::{Path, PathBuf};

const MAIN_FIXTURE: &str = "my_template.lyx";

fn fixture(relative: &str) -> PathBuf {
    fixtures_root().join(relative)
}

fn run_dump_with(file: &Path, tail: &[&str], home: &IsolatedHome, cwd: &Path) -> CliOutput {
    let file = file.to_str().expect("fixture path must be valid UTF-8");
    let mut args = Vec::with_capacity(2 + tail.len());
    args.extend(["dump", file]);
    args.extend_from_slice(tail);
    run_cli_with(&args, home, cwd)
}

fn run_fixture_dump(relative: &str, tail: &[&str]) -> CliOutput {
    let home = IsolatedHome::new();
    let work = WorkDir::new();
    run_dump_with(&fixture(relative), tail, &home, work.path())
}

fn success_json(out: &CliOutput) -> Value {
    assert_eq!(
        out.code, 0,
        "dump failed\nstdout:\n{}\nstderr:\n{}",
        out.stdout, out.stderr
    );
    assert!(out.stderr.is_empty(), "unexpected stderr: {}", out.stderr);
    let value = json_stdout(out);
    assert!(
        value.get("code").is_none(),
        "success response carried an error: {value}"
    );
    value
}

fn assert_error(out: &CliOutput, code: &str, message_fragment: &str) {
    assert_eq!(
        out.code, 1,
        "error response exited {}\nstdout:\n{}\nstderr:\n{}",
        out.code, out.stdout, out.stderr
    );
    assert!(out.stderr.is_empty(), "unexpected stderr: {}", out.stderr);
    let value = json_stdout(out);
    assert_eq!(value["code"].as_str(), Some(code), "{value}");
    assert!(
        value["message"]
            .as_str()
            .is_some_and(|message| message.contains(message_fragment)),
        "{value}"
    );
    assert_eq!(value["warnings"], json!([]), "{value}");
}

fn write_minimal_lyx(work: &WorkDir, name: &str, header: &str, body: &str) -> PathBuf {
    let path = work.path().join(name);
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

fn write_layout_config(home: &IsolatedHome, layouts_dir: &Path) {
    fs::write(
        home.path().join(".lq/config.json"),
        json!({
            "refresh": "none",
            "trackChanges": false,
            "layoutsDir": layouts_dir.to_string_lossy().into_owned(),
        })
        .to_string(),
    )
    .unwrap();
}

fn assert_clean_toc(nodes: &[Value]) {
    for node in nodes {
        let text = node["text"].as_str().expect("TOC text must be a string");
        assert!(
            !text.contains("inset["),
            "heading text must not contain inset markers: {text:?}"
        );
        assert_clean_toc(
            node["children"]
                .as_array()
                .expect("TOC children must be an array"),
        );
    }
}

fn toc_contains_layout(nodes: &[Value], layout: &str) -> bool {
    nodes.iter().any(|node| {
        node["layout"].as_str() == Some(layout)
            || toc_contains_layout(
                node["children"]
                    .as_array()
                    .expect("TOC children must be an array"),
                layout,
            )
    })
}

fn find_text_node<'a>(value: &'a Value, text: &str) -> Option<&'a Value> {
    if value["type"].as_str() == Some("text") && value["text"].as_str() == Some(text) {
        return Some(value);
    }
    match value {
        Value::Array(values) => values.iter().find_map(|value| find_text_node(value, text)),
        Value::Object(values) => values
            .values()
            .find_map(|value| find_text_node(value, text)),
        _ => None,
    }
}

#[test]
fn cli_dump_outputs_full_cst() {
    let result = success_json(&run_fixture_dump(MAIN_FIXTURE, &[]));
    assert_eq!(result["warnings"], json!([]));
    assert!(result.get("count").is_none());

    let data = &result["data"];
    assert_eq!(data["type"], "document");
    let children = data["children"]
        .as_array()
        .expect("document children must be an array");
    assert_eq!(children.len(), 4);
    assert_eq!(
        children[0],
        json!({
            "type": "text",
            "text": "#LyX 2.5 created this file. For more info see https://www.lyx.org/"
        })
    );
    assert_eq!(
        children[1],
        json!({"type": "property", "key": "lyxformat", "value": "643"})
    );
    assert_eq!(children[2]["type"], "block");
    assert_eq!(children[2]["tag"], "document");
    assert_eq!(children[2]["isBeginVariant"], true);
    assert_eq!(children[3], json!({"type": "text", "text": ""}));
}

#[test]
fn cli_dump_selector_wraps_single_and_multiple_matches_with_count() {
    let single = success_json(&run_fixture_dump(MAIN_FIXTURE, &["layout[Title]"]));
    assert_eq!(single["count"], 1);
    assert!(single["data"].is_object(), "single match must be an object");
    assert_eq!(single["data"]["type"], "document");
    let single_children = single["data"]["children"]
        .as_array()
        .expect("single wrapper children must be an array");
    assert_eq!(single_children.len(), 1);
    assert_eq!(single_children[0]["tag"], "layout");
    assert_eq!(single_children[0]["args"], "Title");

    let multiple = success_json(&run_fixture_dump(MAIN_FIXTURE, &["layout[Section]"]));
    assert_eq!(multiple["count"], 2);
    let documents = multiple["data"]
        .as_array()
        .expect("multiple matches must be an array");
    assert_eq!(documents.len(), 2);
    for document in documents {
        assert_eq!(document["type"], "document");
        let children = document["children"]
            .as_array()
            .expect("match wrapper children must be an array");
        assert_eq!(children.len(), 1);
        assert_eq!(children[0]["tag"], "layout");
        assert_eq!(children[0]["args"], "Section");
    }
}

#[test]
fn cli_dump_structural_depth_exceed_warnings() {
    let document = success_json(&run_fixture_dump(MAIN_FIXTURE, &["--depth", "99"]));
    assert_eq!(
        document["warnings"],
        json!(["Depth 99 exceeds document depth (9). Showing full CST."])
    );
    assert_eq!(document["data"]["type"], "document");

    let subtree = success_json(&run_fixture_dump(
        MAIN_FIXTURE,
        &["layout[Title]", "--depth", "99"],
    ));
    assert_eq!(subtree["count"], 1);
    assert_eq!(
        subtree["warnings"],
        json!(["Depth 99 exceeds subtree depth (1). Showing full subtree."])
    );
    assert_eq!(subtree["data"]["type"], "document");
}

#[test]
fn cli_dump_annotates_change_status_by_default() {
    let result = success_json(&run_fixture_dump(MAIN_FIXTURE, &[]));
    let data = &result["data"];

    let deleted = find_text_node(data, "write").expect("tracked deleted text");
    assert_eq!(deleted["changeStatus"], "deleted");

    let inserted = find_text_node(data, "edit").expect("tracked inserted text");
    assert_eq!(inserted["changeStatus"], "inserted");

    let current =
        find_text_node(data, " something with tracked changes.").expect("trailing current text");
    assert!(
        current.get("changeStatus").is_none(),
        "current text must not be annotated: {current}"
    );
}

#[test]
fn cli_dump_toc_on_beamer_textclass() {
    let home = IsolatedHome::new();
    let work = WorkDir::new();
    let layouts = WorkDir::new();
    fs::write(
        layouts.path().join("beamer.layout"),
        "Format 104\nStyle Frame\n  TocLevel 4\nEnd\n",
    )
    .unwrap();
    write_layout_config(&home, layouts.path());

    let result = success_json(&run_dump_with(
        &fixture("Presentations/Beamer.lyx"),
        &["--toc"],
        &home,
        work.path(),
    ));
    let data = result["data"].as_array().expect("TOC must be an array");
    assert!(!data.is_empty(), "Beamer TOC should have entries");
    assert!(
        toc_contains_layout(data, "Frame"),
        "Beamer TOC should contain Frame"
    );
}

#[test]
fn cli_dump_toc_heading_text_clean_and_depth_is_absolute_toc_level() {
    let full = success_json(&run_fixture_dump(MAIN_FIXTURE, &["--toc"]));
    let full_data = full["data"].as_array().expect("TOC must be an array");
    assert!(!full_data.is_empty(), "TOC should have entries");
    assert_clean_toc(full_data);
    assert_eq!(full_data[0]["text"], "Section");

    let depth_one = success_json(&run_fixture_dump(MAIN_FIXTURE, &["--toc", "--depth", "1"]));
    let depth_one_data = depth_one["data"].as_array().expect("TOC must be an array");
    assert!(
        !depth_one_data.is_empty(),
        "depth 1 should show top-level headings"
    );
    for node in depth_one_data {
        assert_eq!(
            node["layout"], "Section",
            "depth 1 must contain only Sections"
        );
        assert_eq!(node["children"], json!([]), "depth 1 must drop subsections");
    }

    let depth_two = success_json(&run_fixture_dump(MAIN_FIXTURE, &["--toc", "--depth", "2"]));
    let depth_two_data = depth_two["data"].as_array().expect("TOC must be an array");
    assert!(
        toc_contains_layout(depth_two_data, "Subsection"),
        "depth 2 must include Subsection under Section"
    );

    let depth_zero = success_json(&run_fixture_dump(MAIN_FIXTURE, &["--toc", "--depth", "0"]));
    assert_eq!(depth_zero["data"], json!([]));
    assert!(
        !depth_zero["warnings"]
            .as_array()
            .expect("warnings must be an array")
            .is_empty(),
        "empty depth must report a warning"
    );

    let depth_negative = success_json(&run_fixture_dump(MAIN_FIXTURE, &["--toc", "--depth", "-1"]));
    assert_eq!(depth_negative["data"], json!([]));

    assert_error(
        &run_fixture_dump(MAIN_FIXTURE, &["--toc", "--depth", "1.5"]),
        "INVALID_FLAG",
        "integer",
    );

    let book = success_json(&run_fixture_dump(
        "Books/KOMA-Script_Book.lyx",
        &["--toc", "--depth", "0"],
    ));
    let book_data = book["data"].as_array().expect("book TOC must be an array");
    assert!(!book_data.is_empty(), "book depth 0 should show Chapters");
    for node in book_data {
        assert_eq!(
            node["layout"], "Chapter",
            "book depth 0 must contain only Chapters"
        );
    }
}

#[test]
fn cli_dump_count_flag_is_rejected() {
    let out = run_fixture_dump(MAIN_FIXTURE, &["--count"]);
    assert_error(&out, "INVALID_FLAG", "--count");
}

#[test]
fn cli_raw_dump_depth_rejects_incomplete_numeric_values() {
    for value in ["1.5", "1x", "1e2", "+1", "-1"] {
        assert_error(
            &run_fixture_dump(MAIN_FIXTURE, &["--depth", value]),
            "INVALID_FLAG",
            "non-negative integer",
        );
    }
}

#[test]
fn cli_raw_dump_depth_zero_and_one_remain_valid() {
    for value in ["0", "1"] {
        let result = success_json(&run_fixture_dump(MAIN_FIXTURE, &["--depth", value]));
        assert_eq!(result["data"]["type"], "document", "depth {value}");
    }
}

#[test]
fn cli_raw_dump_depth_zero_keeps_the_count_indicator_string() {
    let result = success_json(&run_fixture_dump(
        "Synthetic/headings_paragraphs.lyx",
        &["--depth", "0"],
    ));
    assert_eq!(
        result["data"]["children"],
        json!(["... (1 blocks, 2 text nodes, 1 properties)"])
    );
}

#[test]
fn dl118_dump_errors_on_anchorless_until() {
    assert_error(
        &run_fixture_dump(MAIN_FIXTURE, &["layout[Standard]:until(layout[Section])"]),
        "INVALID_SELECTOR",
        ":until()",
    );
}

#[test]
fn dl99_dump_toc_excludes_note_headings_and_note_text_inside_headings() {
    let home = IsolatedHome::new();
    let work = WorkDir::new();
    let body = concat!(
        "\\begin_layout Section\n",
        "Visible Heading\n",
        "\\end_layout\n",
        "\n",
        "\\begin_layout Standard\n",
        "\\begin_inset Note Note\n",
        "status collapsed\n",
        "\n",
        "\\begin_layout Section\n",
        "Hidden Note Section\n",
        "\\end_layout\n",
        "\n",
        "\\end_inset\n",
        "\n",
        "\\end_layout\n",
        "\n",
        "\\begin_layout Section\n",
        "Heading with\n",
        "\\begin_inset Note Note\n",
        "status collapsed\n",
        "\n",
        "\\begin_layout Plain Layout\n",
        "LEAK NOTE TEXT\n",
        "\\end_layout\n",
        "\n",
        "\\end_inset\n",
        "\n",
        "\\end_layout\n",
    );
    let file = write_minimal_lyx(&work, "temp_dl99_toc.lyx", "\\textclass article\n", body);
    let result = success_json(&run_dump_with(&file, &["--toc"], &home, work.path()));
    let data = serde_json::to_string(&result["data"]).unwrap();
    assert!(!data.contains("Hidden Note Section"), "{data}");
    assert!(!data.contains("LEAK NOTE TEXT"), "{data}");
    assert!(data.contains("Visible Heading"), "{data}");
}
