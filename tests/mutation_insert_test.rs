//! Insert command parity (Deno `tests/mutation_test.ts` insert / split-after cases).

mod common;

use common::{MutationSession, host_layouts_dir, path_arg};
use lq::{Document, NodeId, NodeKind, advance_change_depths, parse, query};
use serde_json::{Value, json};
use std::fs;
use std::path::Path;

const AUTHOR_ALICE: &str = "\\author 1 \"Alice\"\n";

const DL99_NOTE_BODY: &str = r"\begin_layout Standard
Visible alpha.
\begin_inset Note Note
status collapsed

\begin_layout Plain Layout
PRIVATE SECRET note
\end_layout

\end_inset

Visible beta.
\end_layout
";

const FOOTNOTE_BODY: &str = r"\begin_layout Standard
Alpha 
\begin_inset Foot
status collapsed

\begin_layout Plain Layout
A footnote
\end_layout

\end_inset

Gamma
\end_layout
";

const ADJACENT_PAIR_BODY: &str = r"\begin_layout Standard
I 
\change_deleted 1 1776668506
write
\change_inserted 1 1776668507
edit
\change_unchanged
 something with tracked changes.
\end_layout
";

const DL121_SPLIT_BODY: &str = r"\begin_layout Standard
\change_inserted 1 1700000000
edit here
\change_unchanged
\end_layout
";

const DL121_SPLIT_DEL_BODY: &str = r"\begin_layout Standard
\change_deleted 1 1700000000
edit here
\change_unchanged
\end_layout
";

const DL122_SPLIT_END_BODY: &str = r"\begin_layout Standard
\change_inserted 1 1700000000
edit
\change_unchanged
\end_layout
";

const DL122_SPLIT_END_DEL_BODY: &str = r"\begin_layout Standard
\change_deleted 1 1700000000
edit
\change_unchanged
\end_layout
";

const DL122_SPLIT_END_NO_CLOSER_BODY: &str = r"\begin_layout Standard
\change_inserted 1 1700000000
edit
\end_layout
";

const DL108_BODY_ONE_OF_THREE: &str = r"\begin_layout Standard
Alpha
\end_layout

\begin_layout Standard
write here
\end_layout

\begin_layout Standard
Beta
\end_layout
";

const DL108_BODY_WORRYING_CASE: &str = r"\begin_layout Standard
write once
\end_layout

\begin_layout Standard
write again
\end_layout

\begin_layout Standard
write and write twice
\end_layout
";

const DL108_BODY_MIXED: &str = r"\begin_layout Standard
write and write twice
\end_layout

\begin_layout Standard
nothing here
\end_layout

\begin_layout Standard
write once
\end_layout
";

const DL108_BODY_ALL_ONCE: &str = r"\begin_layout Standard
write first
\end_layout

\begin_layout Standard
write second
\end_layout
";

fn layouts_available() -> bool {
    if let Some(dir) = host_layouts_dir()
        && Path::new(&dir).is_dir()
    {
        return true;
    }
    lq::get_default_layouts_dir().is_dir()
}

fn code(v: &Value) -> &str {
    v["code"].as_str().unwrap_or("")
}

fn message(v: &Value) -> &str {
    v["message"].as_str().unwrap_or("")
}

fn parse_lyx(text: &str) -> Document {
    parse(text, false).unwrap()
}

fn find_block(doc: &Document, parent: NodeId, tag: &str) -> NodeId {
    doc.node(parent)
        .children
        .iter()
        .copied()
        .find(|&id| matches!(&doc.node(id).kind, NodeKind::Block { tag: t, .. } if t == tag))
        .unwrap_or_else(|| panic!("missing block {tag}"))
}

fn body_id(doc: &Document) -> NodeId {
    let document = find_block(doc, doc.root(), "document");
    find_block(doc, document, "body")
}

fn first_layout_id(doc: &Document) -> NodeId {
    find_block(doc, body_id(doc), "layout")
}

fn layout_children(doc: &Document) -> &[NodeId] {
    &doc.node(first_layout_id(doc)).children
}

fn change_markers<'a>(doc: &'a Document, ids: &[NodeId]) -> Vec<(&'a str, Option<&'a str>)> {
    ids.iter()
        .filter_map(|&id| match &doc.node(id).kind {
            NodeKind::Property { key, value } if key.starts_with("change_") => {
                Some((key.as_str(), value.as_deref()))
            }
            _ => None,
        })
        .collect()
}

fn change_marker_keys(doc: &Document, ids: &[NodeId]) -> Vec<String> {
    change_markers(doc, ids)
        .into_iter()
        .map(|(k, _)| k.to_string())
        .collect()
}

fn all_text(doc: &Document, ids: &[NodeId]) -> String {
    ids.iter()
        .filter_map(|&id| match &doc.node(id).kind {
            NodeKind::Text { text } => Some(text.as_str()),
            _ => None,
        })
        .collect()
}

fn max_marker_depth(doc: &Document, ids: &[NodeId]) -> i32 {
    let mut deleted_depth = 0;
    let mut inserted_depth = 0;
    let mut max = 0;
    for (key, _) in change_markers(doc, ids) {
        let (d, i) = advance_change_depths(key, deleted_depth, inserted_depth);
        deleted_depth = d;
        inserted_depth = i;
        let depth = deleted_depth + inserted_depth;
        if depth > max {
            max = depth;
        }
    }
    max
}

fn max_insert_nesting(text: &str) -> i32 {
    let mut insert_depth = 0i32;
    let mut max_depth = 0i32;
    let mut i = 0;
    while i < text.len() {
        let rest = &text[i..];
        if rest.starts_with("\\change_inserted") {
            insert_depth += 1;
            if insert_depth > max_depth {
                max_depth = insert_depth;
            }
            i += "\\change_inserted".len();
        } else if rest.starts_with("\\change_unchanged") {
            insert_depth -= 1;
            i += "\\change_unchanged".len();
        } else {
            i += rest.chars().next().unwrap().len_utf8();
        }
    }
    max_depth
}

fn citation_inset_body(text: &str) -> Option<&str> {
    let start_tag = "\\begin_inset CommandInset citation\n";
    let start = text.find(start_tag)? + start_tag.len();
    let end = text[start..].find("\\end_inset")?;
    Some(&text[start..start + end])
}

#[test]
fn mutation_engine_insert_auto_spacer() {
    let env = MutationSession::new();
    let file = env.template("temp_spacer_test.lyx");
    let result = env.run(&[
        "insert",
        path_arg(&file),
        "layout[Title]",
        "after",
        "--layout",
        "Standard",
        "--text",
        "Test Insert",
    ]);
    assert_eq!(result["matched_nodes"], json!(1));

    let text = fs::read_to_string(&file).unwrap();
    let doc = parse_lyx(&text);
    let body_children = doc.node(body_id(&doc)).children.clone();
    let title_index = body_children
        .iter()
        .position(|&id| {
            matches!(
                &doc.node(id).kind,
                NodeKind::Block { tag, args, .. }
                    if tag == "layout" && args.as_deref() == Some("Title")
            )
        })
        .expect("Title layout");
    assert!(matches!(
        &doc.node(body_children[title_index + 1]).kind,
        NodeKind::Text { text } if text.is_empty()
    ));
    assert!(matches!(
        &doc.node(body_children[title_index + 2]).kind,
        NodeKind::Block { tag, args, .. }
            if tag == "layout" && args.as_deref() == Some("Standard")
    ));
    assert!(matches!(
        &doc.node(body_children[title_index + 3]).kind,
        NodeKind::Text { text } if text.is_empty()
    ));
    assert!(text.contains(
        "\\end_layout\n\n\\begin_layout Standard\nTest Insert\n\\end_layout\n\n\\begin_layout Author"
    ));
}

#[test]
fn mutation_engine_reject_inset_in_document_body() {
    let env = MutationSession::new();
    let file = env.template("temp_inset_test.lyx");
    let raw = env.write_file("inset.raw", "\\begin_inset Formula\nE=mc^2\n\\end_inset");
    let result = env.run(&[
        "insert",
        path_arg(&file),
        "layout[Title]",
        "after",
        "--raw-file",
        path_arg(&raw),
    ]);
    assert_eq!(code(&result), "INVALID_CONTEXT");
    assert!(message(&result).contains("Cannot insert inset directly into the document body"));
}

#[test]
fn mutation_engine_reject_invalid_raw_strings() {
    let env = MutationSession::new();
    let file = env.template("temp_raw_test.lyx");
    let raw = env.write_file("plain.raw", "Just plain text");
    let result = env.run(&[
        "insert",
        path_arg(&file),
        "layout[Title]",
        "after",
        "--raw-file",
        path_arg(&raw),
    ]);
    assert_eq!(code(&result), "INVALID_RAW");
    assert!(message(&result).contains("did not parse into any valid LyX blocks or properties"));
}

#[test]
fn mutation_engine_reject_layout_with_split_after() {
    let env = MutationSession::new();
    let file = env.template("temp_layout_split_after.lyx");
    let result = env.run(&[
        "insert",
        path_arg(&file),
        "layout[Standard]:first",
        "split-after",
        "writing",
        "--layout",
        "Standard",
        "--text",
        "x",
    ]);
    assert_eq!(code(&result), "INVALID_FLAG");
    let msg = message(&result);
    assert!(
        msg.contains("split-after") && msg.contains("--layout"),
        "dedicated combo reject, not layout-in-layout: {msg}"
    );
    assert!(
        !msg.contains("inside an Inset"),
        "must not wait for layout-in-layout: {msg}"
    );
}

#[test]
fn mutation_engine_reject_empty_layout_insert() {
    let env = MutationSession::new();
    let file = env.template("temp_empty_test.lyx");
    let p = path_arg(&file);
    let result = env.run(&[
        "insert",
        p,
        "layout[Title]",
        "after",
        "--layout",
        "Standard",
    ]);
    assert_eq!(code(&result), "MISSING_ARGS");
    let result = env.run(&[
        "insert",
        p,
        "layout[Title]",
        "after",
        "--layout",
        "Standard",
        "--text",
        "   ",
    ]);
    assert_eq!(code(&result), "MISSING_ARGS");
}

#[test]
fn mutation_engine_reject_unrecognized_layout_name() {
    if !layouts_available() {
        eprintln!(
            "skip: LyX layouts dir not found — install LyX or set layoutsDir via 'lq init --layouts-dir'"
        );
        return;
    }
    let env = MutationSession::new();
    let file = env.template("temp_bad_layout_test.lyx");
    let result = env.run(&[
        "insert",
        path_arg(&file),
        "layout[Title]",
        "after",
        "--layout",
        "NonExistentLayout",
        "--text",
        "Foo",
    ]);
    assert_eq!(code(&result), "INVALID_LAYOUT");
    assert!(message(&result).contains("NonExistentLayout"));
}

#[test]
fn mutation_engine_insert_before_position() {
    let env = MutationSession::new();
    let file = env.template("temp_before_test.lyx");
    let result = env.run(&[
        "insert",
        path_arg(&file),
        "layout[Author]",
        "before",
        "--layout",
        "Standard",
        "--text",
        "Before Author",
    ]);
    assert_eq!(result["matched_nodes"], json!(1));
    let text = fs::read_to_string(&file).unwrap();
    assert!(
        text.contains(
            "\\begin_layout Standard\nBefore Author\n\\end_layout\n\n\\begin_layout Author"
        )
    );
}

#[test]
fn mutation_engine_insert_append_position() {
    let env = MutationSession::new();
    let file = env.template("temp_append_test.lyx");
    let result = env.run(&[
        "insert",
        path_arg(&file),
        "layout[Title]",
        "append",
        "--footnote",
        "Appended footnote",
    ]);
    assert_eq!(result["matched_nodes"], json!(1));
    let text = fs::read_to_string(&file).unwrap();
    let title_idx = text.find("\\begin_layout Title");
    let author_idx = text.find("\\begin_layout Author");
    let fn_idx = text.find("\\begin_inset Foot");
    assert!(
        title_idx.is_some() && author_idx.is_some() && fn_idx.is_some(),
        "Title, Author and footnote must exist"
    );
    let title_idx = title_idx.unwrap();
    let author_idx = author_idx.unwrap();
    let fn_idx = fn_idx.unwrap();
    assert!(
        title_idx < fn_idx && fn_idx < author_idx,
        "footnote must be appended inside layout[Title], before Author"
    );
    assert!(text.contains("Appended footnote"));
}

#[test]
fn mutation_engine_insert_prepend_position_single_block() {
    let env = MutationSession::new();
    let file = env.template("temp_prepend_test.lyx");
    let result = env.run(&[
        "insert",
        path_arg(&file),
        "layout[Title]",
        "prepend",
        "--footnote",
        "Prepended footnote",
    ]);
    assert_eq!(result["matched_nodes"], json!(1));
    let text = fs::read_to_string(&file).unwrap();
    assert!(text.contains("Prepended footnote"));
    let fn_pos = text.find("Prepended footnote").unwrap();
    let title_pos = text.find("\\begin_layout Title").unwrap();
    assert!(fn_pos > title_pos, "Footnote should be inside Title layout");
}

#[test]
fn mutation_engine_insert_prepend_multi_block_order_preservation() {
    let env = MutationSession::new();
    let file = env.template("temp_prepend_multi.lyx");
    let raw = env.write_file(
        "blocks.raw",
        "\\begin_layout Plain Layout\nBLOCK_A\n\\end_layout\n\
         \\begin_layout Plain Layout\nBLOCK_B\n\\end_layout\n",
    );
    let result = env.run(&[
        "insert",
        path_arg(&file),
        "inset[Foot]:first",
        "prepend",
        "--raw-file",
        path_arg(&raw),
    ]);
    assert_eq!(result["matched_nodes"], json!(1));
    let text = fs::read_to_string(&file).unwrap();
    assert!(text.contains("BLOCK_A"));
    assert!(text.contains("BLOCK_B"));
    let pos_a = text.find("BLOCK_A").unwrap();
    let pos_b = text.find("BLOCK_B").unwrap();
    assert!(
        pos_a < pos_b,
        "BLOCK_A should appear before BLOCK_B (order must be preserved)"
    );
}

#[test]
fn mutation_engine_split_after_explains_block_target_requirement() {
    let env = MutationSession::new();
    let file = env.write_lyx(
        "temp_split_after_text_target.lyx",
        r"\begin_layout Standard
\change_inserted 1 1700000000
Inserted phrase
\change_unchanged
\end_layout
",
        AUTHOR_ALICE,
    );
    let result = env.run(&[
        "insert",
        path_arg(&file),
        "text:change(inserted)",
        "split-after",
        "Inserted",
        "--text",
        " X",
    ]);
    assert_eq!(code(&result), "INVALID_TARGET");
    assert!(message(&result).contains("Select a layout or inset block"));
    assert!(message(&result).contains("text selectors cannot be split directly"));
}

#[test]
fn mutation_engine_insert_split_after_with_track_changes() {
    let env = MutationSession::with_config(json!({ "trackChanges": true }));
    let file = env.template("temp_split_tc.lyx");
    env.run(&[
        "insert",
        path_arg(&file),
        "layout[Title]",
        "split-after",
        "Tit",
        "--footnote",
        "Tracked split",
    ]);
    let text = fs::read_to_string(&file).unwrap();
    assert!(text.contains("\\change_inserted"));
    assert!(text.contains("Tracked split"));
    assert!(text.contains("\\tracking_changes true"));
    assert_eq!(
        max_insert_nesting(&text),
        1,
        "Should never nest \\change_inserted markers (no double-wrapping)"
    );
}

#[test]
fn mutation_engine_tracked_commandinset_insert_atomic_wrap() {
    let env = MutationSession::with_config(json!({ "trackChanges": true }));
    let file = env.template("temp_tracked_cite.lyx");
    env.run(&[
        "insert",
        path_arg(&file),
        "layout[Standard]:first",
        "append",
        "--cite",
        "Mena2000",
    ]);
    let text = fs::read_to_string(&file).unwrap();
    let body = citation_inset_body(&text).expect("citation inset should be present");
    assert!(
        !body.contains("\\change_"),
        "change markers must not appear inside the CommandInset body: {body}"
    );
    let before_idx = text.find("\\begin_inset CommandInset citation").unwrap();
    let after_idx = before_idx + text[before_idx..].find("\\end_inset").unwrap();
    let inserted_idx = text[..before_idx].rfind("\\change_inserted");
    let unchanged_idx = text[after_idx..]
        .find("\\change_unchanged")
        .map(|i| after_idx + i);
    assert!(
        inserted_idx.is_some_and(|i| i < before_idx),
        "change_inserted must precede the inset"
    );
    assert!(
        unchanged_idx.is_some_and(|i| i > after_idx),
        "change_unchanged must follow the inset"
    );
    assert_eq!(
        max_insert_nesting(&text),
        1,
        "Should never nest \\change_inserted markers"
    );
}

#[test]
fn mutation_engine_insert_split_after_with_text() {
    let env = MutationSession::new();
    let file = env.template("temp_split_text.lyx");
    let result = env.run(&[
        "insert",
        path_arg(&file),
        "layout[Title]",
        "split-after",
        "Tit",
        "--text",
        "NEW",
    ]);
    assert_eq!(result["matched_nodes"], json!(1));
    let text = fs::read_to_string(&file).unwrap();
    let tit_idx = text.find("Tit").unwrap();
    let new_idx = text.find("NEW").unwrap();
    let le_idx = text[new_idx..].find("le").map(|i| new_idx + i).unwrap();
    assert!(
        tit_idx < new_idx && new_idx < le_idx,
        "NEW should appear between 'Tit' and 'le'"
    );
}

#[test]
fn mutation_engine_insert_split_after_with_text_and_track_changes() {
    let env = MutationSession::with_config(json!({ "trackChanges": true }));
    let file = env.template("temp_split_text_tc.lyx");
    env.run(&[
        "insert",
        path_arg(&file),
        "layout[Title]",
        "split-after",
        "Tit",
        "--text",
        "NEW",
    ]);
    let text = fs::read_to_string(&file).unwrap();
    assert!(text.contains("\\change_inserted"));
    assert!(text.contains("NEW"));
    assert!(text.contains("\\change_unchanged"));
    assert_eq!(
        max_insert_nesting(&text),
        1,
        "Should never nest \\change_inserted markers (no double-wrapping)"
    );
}

#[test]
fn mutation_engine_insert_split_after_multi_block_order_preservation() {
    let env = MutationSession::new();
    let file = env.template("temp_split_multi.lyx");
    let raw = env.write_file(
        "fns.raw",
        "\\begin_inset Foot\n\
         \\begin_layout Plain Layout\nFN_A\n\\end_layout\n\
         \\end_inset\n\
         \\begin_inset Foot\n\
         \\begin_layout Plain Layout\nFN_B\n\\end_layout\n\
         \\end_inset\n",
    );
    let result = env.run(&[
        "insert",
        path_arg(&file),
        "layout[Title]",
        "split-after",
        "Tit",
        "--raw-file",
        path_arg(&raw),
    ]);
    assert_eq!(result["matched_nodes"], json!(1));
    let text = fs::read_to_string(&file).unwrap();
    assert!(text.contains("FN_A"));
    assert!(text.contains("FN_B"));
    let pos_a = text.find("FN_A").unwrap();
    let pos_b = text.find("FN_B").unwrap();
    assert!(
        pos_a < pos_b,
        "FN_A should appear before FN_B (order must be preserved)"
    );
}

#[test]
fn mutation_engine_multi_target_insert_with_track_changes_no_double_wrap() {
    let env = MutationSession::with_config(json!({ "trackChanges": true }));
    let file = env.write_file(
        "temp_multi_target.lyx",
        "#LyX 2.5 created this file.\n\
         \\begin_document\n\\begin_header\n\\end_header\n\
         \\begin_body\n\
         \\begin_layout Standard\nTarget A\n\\end_layout\n\
         \\begin_layout Standard\nTarget B\n\\end_layout\n\
         \\end_body\n\\end_document\n",
    );
    let result = env.run(&[
        "insert",
        path_arg(&file),
        "layout[Standard]",
        "after",
        "--layout",
        "Standard",
        "--text",
        "TRACKED",
    ]);
    assert_eq!(result["matched_nodes"], json!(2));
    let text = fs::read_to_string(&file).unwrap();
    assert!(text.contains("\\tracking_changes true"));
    assert!(text.contains("TRACKED"));
    assert_eq!(
        max_insert_nesting(&text),
        1,
        "Multi-target insert should never double-wrap \\change_inserted markers"
    );
}

#[test]
fn mutation_engine_multi_block_raw_file_after_order_preservation() {
    let env = MutationSession::new();
    let file = env.template("temp_after_multi.lyx");
    let raw = env.write_file(
        "after.raw",
        "\\begin_layout Standard\nBLOCK_A\n\\end_layout\n\
         \\begin_layout Standard\nBLOCK_B\n\\end_layout\n",
    );
    let result = env.run(&[
        "insert",
        path_arg(&file),
        "layout[Title]",
        "after",
        "--raw-file",
        path_arg(&raw),
    ]);
    assert_eq!(result["matched_nodes"], json!(1));
    let text = fs::read_to_string(&file).unwrap();
    assert!(text.contains("BLOCK_A"));
    assert!(text.contains("BLOCK_B"));
    let pos_a = text.find("BLOCK_A").unwrap();
    let pos_b = text.find("BLOCK_B").unwrap();
    assert!(
        pos_a < pos_b,
        "BLOCK_A should appear before BLOCK_B (order must be preserved)"
    );
}

#[test]
fn dl120_d4_inserted_blocks_counts_payload_blocks_independent_of_tracking() {
    let env = MutationSession::new();
    let file = env.write_lyx(
        "temp_dl120_d4.lyx",
        r"\begin_layout Standard
Base
\end_layout
",
        "",
    );
    let p = path_arg(&file);
    let untracked = env.run(&[
        "insert",
        p,
        "layout[Standard]",
        "append",
        "--label",
        "sec:probe",
    ]);
    let tracked_env = MutationSession::tracked("Alice");
    let tracked = tracked_env.run(&[
        "insert",
        p,
        "layout[Standard]",
        "append",
        "--label",
        "sec:probe2",
    ]);
    assert_eq!(untracked["matched_nodes"], json!(1));
    assert_eq!(tracked["matched_nodes"], json!(1));
    assert_eq!(
        untracked["inserted_blocks"],
        json!(1),
        "untracked single inset = 1 block"
    );
    assert_eq!(
        tracked["inserted_blocks"],
        json!(1),
        "tracked single inset = 1 block (DL26 contract, not 3)"
    );
}

#[test]
fn dl99_split_after_on_a_visible_layout_does_not_leak_into_a_note() {
    let env = MutationSession::new();
    let file = env.write_lyx(
        "temp_dl99_split.lyx",
        DL99_NOTE_BODY,
        "\\textclass article\n",
    );
    let result = env.run(&[
        "insert",
        path_arg(&file),
        "layout[Standard]:first",
        "split-after",
        "PRIVATE SECRET",
        "--text",
        "Y",
    ]);
    assert_eq!(code(&result), "SPLIT_NO_MATCH");
    assert!(message(&result).contains("exists only inside a private note"));
    let text = fs::read_to_string(&file).unwrap();
    assert!(!text.contains("\\nY"), "must not insert into the note");
}

#[test]
fn dl99_split_after_on_a_note_layout_still_matches_note_prose() {
    let env = MutationSession::new();
    let file = env.write_lyx(
        "temp_dl99_split_note.lyx",
        DL99_NOTE_BODY,
        "\\textclass article\n",
    );
    let result = env.run(&[
        "insert",
        path_arg(&file),
        "inset[Note Note] layout[Plain Layout]",
        "split-after",
        "PRIVATE SECRET",
        "--text",
        "Y",
    ]);
    assert!(result["code"].is_null());
    let text = fs::read_to_string(&file).unwrap();
    assert!(text.contains("Y"));
}

#[test]
fn dl99_footnote_split_after_workflow_keeps_working() {
    let env = MutationSession::new();
    let file = env.write_lyx(
        "temp_dl99_footnote.lyx",
        r"\begin_layout Standard
Before
\begin_inset Foot
status open

\begin_layout Plain Layout
footnote text
\end_layout

\end_inset

 after.
\end_layout
",
        "\\textclass article\n",
    );
    let result = env.run(&[
        "insert",
        path_arg(&file),
        "layout[Standard]:first",
        "split-after",
        "footnote text",
        "--text",
        "Y",
    ]);
    assert!(result["code"].is_null());
    let text = fs::read_to_string(&file).unwrap();
    assert!(text.contains("Y"));
}

#[test]
fn cross_node_split_after() {
    let env = MutationSession::new();
    let file = env.copy_fixture("PerDevLog/test_report_33_repro.lyx", "temp_cross_split.lyx");
    let result = env.run(&[
        "insert",
        path_arg(&file),
        "layout[Standard]:first",
        "split-after",
        "literature, we find",
        "--text",
        "INSERTED",
    ]);
    assert_eq!(result["matched_nodes"], json!(1));
    let text = fs::read_to_string(&file).unwrap();
    assert!(text.contains("INSERTED"));
    let pos_literature = text.find("literature,").unwrap();
    let pos_inserted = text.find("INSERTED").unwrap();
    let pos_significant = text.find("significant effects").unwrap();
    assert!(
        pos_literature < pos_inserted,
        "INSERTED should be after literature,"
    );
    assert!(
        pos_inserted < pos_significant,
        "INSERTED should be before significant effects"
    );
}

#[test]
fn f3_split_after_on_inset_foot_reaches_the_nested_plain_layout_text() {
    let env = MutationSession::new();
    let file = env.write_lyx("temp_f3_footnote_split.lyx", FOOTNOTE_BODY, "");
    let result = env.run(&[
        "insert",
        path_arg(&file),
        "inset[Foot]",
        "split-after",
        "A footnote",
        "--text",
        " with a citation",
    ]);
    assert_eq!(
        result["matched_nodes"],
        json!(1),
        "split-after must succeed, not SPLIT_NO_MATCH"
    );
    let text = fs::read_to_string(&file).unwrap();
    let pos_footnote = text.find("A footnote");
    let pos_inserted = text.find(" with a citation");
    assert!(
        pos_footnote.is_some() && pos_inserted.unwrap_or(0) > pos_footnote.unwrap(),
        "inserted text must appear after 'A footnote' inside the footnote"
    );
}

#[test]
fn f3_split_after_on_layout_standard_reaches_nested_footnote_text() {
    let env = MutationSession::new();
    let file = env.write_lyx("temp_f3_layout_split.lyx", FOOTNOTE_BODY, "");
    let result = env.run(&[
        "insert",
        path_arg(&file),
        "layout[Standard]",
        "split-after",
        "A footnote",
        "--text",
        " INS",
    ]);
    assert_eq!(
        result["matched_nodes"],
        json!(1),
        "split-after on the layout must succeed"
    );
    let text = fs::read_to_string(&file).unwrap();
    assert!(
        text.find("A footnote").unwrap() < text.find(" INS").unwrap(),
        "inserted text must land inside the footnote"
    );
}

#[test]
fn f3_split_after_on_commandinset_label_stays_opaque() {
    let env = MutationSession::new();
    let file = env.write_lyx(
        "temp_f3_label_opaque.lyx",
        r#"\begin_layout Standard
Alpha 
\begin_inset CommandInset label
LatexCommand label
name "sec:Section_label"
\end_inset

\begin_inset Foot
status collapsed

\begin_layout Plain Layout
A footnote
\end_layout

\end_inset

Gamma
\end_layout
"#,
        "",
    );
    let result = env.run(&[
        "insert",
        path_arg(&file),
        "inset[CommandInset label]",
        "split-after",
        "A footnote",
        "--text",
        " INS",
    ]);
    assert_eq!(code(&result), "SPLIT_NO_MATCH");
    let text = fs::read_to_string(&file).unwrap();
    assert!(!text.contains(" INS"), "file must be untouched");
}

#[test]
fn report_42_f2_scoped_split_after_reaches_deleted_foot_prose() {
    let env = MutationSession::tracked("Alice");
    let file = env.write_lyx(
        "temp_report42_f2_nested_split.lyx",
        r"\begin_layout Standard
\change_deleted 1 1700000000
\begin_inset Foot
status collapsed

\begin_layout Plain Layout
Details about me and more
\end_layout

\end_inset
\change_unchanged
current text
\end_layout
",
        AUTHOR_ALICE,
    );
    let result = env.run(&[
        "insert",
        path_arg(&file),
        "inset[Foot]:change(deleted)",
        "split-after",
        "Details about me",
        "--text",
        " X",
    ]);
    assert_eq!(result["matched_nodes"], json!(1), "{}", result);
    let text = fs::read_to_string(&file).unwrap();
    assert!(text.contains("Details about me"));
    assert!(text.contains(" X"));
    assert!(text.contains("and more"));
    assert!(text.find("status collapsed").unwrap() < text.find("\\change_inserted").unwrap());
    let parsed = parse_lyx(&text);
    let nested_deleted = query(&parsed, "text:change(deleted)").unwrap();
    assert!(
        nested_deleted.iter().any(|&id| matches!(
            &parsed.node(id).kind,
            NodeKind::Text { text } if text.trim() == "and more"
        )),
        "trailing nested prose must retain the enclosing deleted state"
    );
    let nested_layout = query(&parsed, "layout[Plain Layout]").unwrap()[0];
    assert_eq!(
        max_marker_depth(&parsed, &parsed.node(nested_layout).children),
        1,
        "nested markers must remain flat"
    );
}

#[test]
fn report_42_f2_property_scoped_split_after_reaches_styled_foot_prose() {
    let env = MutationSession::tracked("Alice");
    let file = env.write_lyx(
        "temp_report42_f2_nested_property_split.lyx",
        r"\begin_layout Standard
\emph on
\begin_inset Foot
status collapsed

\begin_layout Plain Layout
foot content
\end_layout

\end_inset
\emph default
\end_layout
",
        AUTHOR_ALICE,
    );
    let result = env.run(&[
        "insert",
        path_arg(&file),
        "inset[Foot]:property(emph)",
        "split-after",
        "foot content",
        "--text",
        " Y",
    ]);
    assert_eq!(result["matched_nodes"], json!(1), "{}", result);
    let text = fs::read_to_string(&file).unwrap();
    assert!(text.contains("foot content"));
    assert!(text.contains(" Y"));
    assert!(text.contains("\\change_inserted"));
    assert!(text.find("\\emph on").unwrap() < text.find("\\begin_inset Foot").unwrap());
    assert!(text.find("\\emph default").unwrap() > text.find("\\end_inset").unwrap());
}

#[test]
fn dl84_f1_split_after_works_on_inserted_text() {
    let env = MutationSession::tracked("Alice");
    let file = env.write_lyx("temp_dl84_f1_split.lyx", ADJACENT_PAIR_BODY, AUTHOR_ALICE);
    let result = env.run(&[
        "insert",
        path_arg(&file),
        "layout[Standard]",
        "split-after",
        "edit",
        "--text",
        "X",
    ]);
    assert_eq!(
        result["matched_nodes"],
        json!(1),
        "split-after on inserted text must not SPLIT_NO_MATCH"
    );
    assert!(fs::read_to_string(&file).unwrap().contains("X"));
}

#[test]
fn dl84_f4_footnote_insert_emits_status_line_untracked() {
    let env = MutationSession::new();
    let file = env.write_lyx(
        "temp_dl84_f4_untracked.lyx",
        r"\begin_layout Standard
Base
\end_layout
",
        "",
    );
    env.run(&[
        "insert",
        path_arg(&file),
        "layout[Standard]",
        "append",
        "--footnote",
        "A footnote",
    ]);
    let text = fs::read_to_string(&file).unwrap();
    let idx = text.find("\\begin_inset Foot");
    assert!(idx.is_some(), "Foot inset must exist");
    let after = text[idx.unwrap() + "\\begin_inset Foot".len()..].trim_start();
    assert!(
        after.starts_with("status collapsed\n\n\\begin_layout Plain Layout"),
        "status line must precede the layout (dev log 84 F4)"
    );
    assert!(text.contains("A footnote"));
}

#[test]
fn dl84_f4_footnote_insert_emits_status_line_tracked() {
    let env = MutationSession::tracked("Alice");
    let file = env.write_lyx(
        "temp_dl84_f4_tracked.lyx",
        r"\begin_layout Standard
Base
\end_layout
",
        "",
    );
    env.run(&[
        "insert",
        path_arg(&file),
        "layout[Standard]",
        "append",
        "--footnote",
        "A footnote",
    ]);
    let text = fs::read_to_string(&file).unwrap();
    let idx = text.find("\\begin_inset Foot");
    assert!(idx.is_some(), "Foot inset must exist");
    let after = text[idx.unwrap() + "\\begin_inset Foot".len()..].trim_start();
    assert!(
        after.starts_with("status collapsed\n\n\\begin_layout Plain Layout"),
        "status line must precede the layout (dev log 84 F4)"
    );
}

#[test]
fn dl85_f2_split_after_at_a_text_node_boundary_inserts_after_the_match_not_at_block_end() {
    let env = MutationSession::new();
    let file = env.write_lyx(
        "temp_dl85_f2_split.lyx",
        r"\begin_layout Standard
Hello,
 world
\end_layout
",
        "",
    );
    let result = env.run(&[
        "insert",
        path_arg(&file),
        "layout[Standard]",
        "split-after",
        "Hello,",
        "--text",
        "INS",
    ]);
    assert_eq!(result["matched_nodes"], json!(1));
    let text = fs::read_to_string(&file).unwrap();
    let idx_hello = text.find("Hello,");
    let idx_ins = text.find("INS");
    let idx_world = text.find(" world");
    assert!(
        idx_hello.is_some() && idx_ins.is_some() && idx_world.is_some(),
        "all three fragments present"
    );
    assert!(
        idx_hello.unwrap() < idx_ins.unwrap() && idx_ins.unwrap() < idx_world.unwrap(),
        "INS must land between 'Hello,' and ' world' (test_report_36 F2)"
    );
}

#[test]
fn dl85_f2_split_after_on_tracked_inserted_text_lands_right_after_the_match() {
    let env = MutationSession::tracked("Alice");
    let file = env.write_lyx("temp_dl85_f2_tracked.lyx", ADJACENT_PAIR_BODY, AUTHOR_ALICE);
    let result = env.run(&[
        "insert",
        path_arg(&file),
        "layout[Standard]",
        "split-after",
        "edit",
        "--text",
        "INS",
    ]);
    assert_eq!(result["matched_nodes"], json!(1));
    let text = fs::read_to_string(&file).unwrap();
    let idx_edit = text.find("edit");
    let idx_ins = text.find("INS");
    let idx_something = text.find(" something");
    assert!(
        idx_edit.is_some() && idx_ins.is_some() && idx_something.is_some(),
        "all fragments present"
    );
    assert!(
        idx_edit.unwrap() < idx_ins.unwrap() && idx_ins.unwrap() < idx_something.unwrap(),
        "INS must land between 'edit' and ' something' (test_report_36 F2)"
    );
}

#[test]
fn dl90_split_after_inside_a_same_author_inserted_region_merges() {
    let env = MutationSession::tracked("Alice");
    let file = env.write_lyx(
        "temp_dl90_splitins.lyx",
        r"\begin_layout Standard
\change_inserted 1 1700000000
Title
\change_unchanged
\end_layout
",
        AUTHOR_ALICE,
    );
    let result = env.run(&[
        "insert",
        path_arg(&file),
        "layout[Standard]",
        "split-after",
        "Tit",
        "--text",
        " X",
    ]);
    assert_eq!(result["matched_nodes"], json!(1));
    let text = fs::read_to_string(&file).unwrap();
    let doc = parse_lyx(&text);
    let children = layout_children(&doc);
    assert_eq!(
        change_marker_keys(&doc, children),
        ["change_inserted", "change_unchanged"],
        "merged into one region"
    );
    assert!(
        all_text(&doc, children).contains("Tit X"),
        "payload merged into the region"
    );
    assert_eq!(max_marker_depth(&doc, children), 1, "flat, never nested");
}

#[test]
fn dl90_split_after_inside_a_different_author_inserted_region_emits_adjacent_flat_blocks() {
    let env = MutationSession::tracked("Bob");
    let file = env.write_lyx(
        "temp_dl90_splitdiff.lyx",
        r"\begin_layout Standard
\change_inserted 1 1700000000
Title
\change_unchanged
\end_layout
",
        AUTHOR_ALICE,
    );
    let result = env.run(&[
        "insert",
        path_arg(&file),
        "layout[Standard]",
        "split-after",
        "Tit",
        "--text",
        " X",
    ]);
    assert_eq!(result["matched_nodes"], json!(1));
    let text = fs::read_to_string(&file).unwrap();
    let doc = parse_lyx(&text);
    let children = layout_children(&doc);
    assert_eq!(
        change_marker_keys(&doc, children),
        [
            "change_inserted",
            "change_inserted",
            "change_inserted",
            "change_unchanged"
        ],
        "byte-exact adjacent flat blocks, never nested"
    );
    assert!(
        all_text(&doc, children).contains("Tit Xle"),
        "both parts present"
    );
}

#[test]
fn dl90_split_after_inside_a_deleted_region_splits_flat() {
    let env = MutationSession::tracked("Alice");
    let file = env.write_lyx(
        "temp_dl90_splitdel.lyx",
        r"\begin_layout Standard
\change_deleted 1 1700000000
This is bad text
\change_unchanged
\end_layout
",
        AUTHOR_ALICE,
    );
    let result = env.run(&[
        "insert",
        path_arg(&file),
        "layout[Standard]",
        "split-after",
        "This",
        "--text",
        " NEW",
    ]);
    assert_eq!(
        result["matched_nodes"],
        json!(1),
        "split-after reaches rejected text under see-all"
    );
    let text = fs::read_to_string(&file).unwrap();
    assert!(text.contains("NEW"), "payload inserted");
    let doc = parse_lyx(&text);
    let children = layout_children(&doc);
    assert_eq!(max_marker_depth(&doc, children), 1, "flat, never nested");
    assert!(
        all_text(&doc, children).contains("This"),
        "pre-split rejected text survives"
    );
}

#[test]
fn dl121_block_footnote_split_after_inside_a_same_author_inserted_region_merges_into_the_region() {
    let env = MutationSession::tracked("Alice");
    let file = env.write_lyx("temp_dl121_block_same.lyx", DL121_SPLIT_BODY, AUTHOR_ALICE);
    let result = env.run(&[
        "insert",
        path_arg(&file),
        "layout[Standard]",
        "split-after",
        "edit",
        "--footnote",
        "FN",
    ]);
    assert_eq!(result["matched_nodes"], json!(1));
    let text = fs::read_to_string(&file).unwrap();
    let doc = parse_lyx(&text);
    let children = layout_children(&doc);
    let markers = change_markers(&doc, children);
    assert_eq!(
        markers.iter().map(|(k, _)| *k).collect::<Vec<_>>(),
        ["change_inserted", "change_unchanged"],
        "one merged region, no double opener"
    );
    assert_eq!(
        markers[0].1.unwrap_or("").split(' ').next(),
        Some("1"),
        "region stays Alice's (author 1)"
    );
    assert!(
        text.contains("\\begin_inset Foot"),
        "footnote inside the region"
    );
    let joined = all_text(&doc, children);
    assert!(joined.contains("edit"), "pre-split text in region");
    assert!(
        joined.contains("here"),
        "continuation stays inside the region"
    );
    assert_eq!(max_marker_depth(&doc, children), 1, "flat");
}

#[test]
fn dl121_block_split_after_inside_a_different_author_inserted_region_reopens_alices_region() {
    let env = MutationSession::tracked("Bob");
    let file = env.write_lyx("temp_dl121_block_diff.lyx", DL121_SPLIT_BODY, AUTHOR_ALICE);
    let result = env.run(&[
        "insert",
        path_arg(&file),
        "layout[Standard]",
        "split-after",
        "edit",
        "--footnote",
        "FN",
    ]);
    assert_eq!(result["matched_nodes"], json!(1));
    let text = fs::read_to_string(&file).unwrap();
    let doc = parse_lyx(&text);
    let children = layout_children(&doc);
    assert_eq!(
        change_marker_keys(&doc, children),
        [
            "change_inserted",
            "change_inserted",
            "change_inserted",
            "change_unchanged"
        ],
        "byte-exact: ci(Alice) ci(Bob) ci(Alice-reopen) cu — no closer between the block and the reopen"
    );
    let here_idx = children
        .iter()
        .position(
            |&id| matches!(&doc.node(id).kind, NodeKind::Text { text } if text.contains("here")),
        )
        .expect("here");
    assert!(
        here_idx >= 1
            && matches!(
                &doc.node(children[here_idx - 1]).kind,
                NodeKind::Property { key, .. } if key == "change_inserted"
            ),
        "continuation reopens Alice's inserted region"
    );
}

#[test]
fn dl121_block_split_after_inside_a_deleted_region_keeps_the_continuation_deleted() {
    let env = MutationSession::tracked("Bob");
    let file = env.write_lyx(
        "temp_dl121_block_del.lyx",
        DL121_SPLIT_DEL_BODY,
        AUTHOR_ALICE,
    );
    let result = env.run(&[
        "insert",
        path_arg(&file),
        "layout[Standard]",
        "split-after",
        "edit",
        "--footnote",
        "FN",
    ]);
    assert_eq!(result["matched_nodes"], json!(1));
    let text = fs::read_to_string(&file).unwrap();
    let doc = parse_lyx(&text);
    let children = layout_children(&doc);
    assert_eq!(
        change_marker_keys(&doc, children),
        [
            "change_deleted",
            "change_inserted",
            "change_deleted",
            "change_unchanged"
        ],
        "byte-exact: cd(Alice) ci(Bob) cd(Alice-reopen) cu"
    );
    let here_idx = children
        .iter()
        .position(
            |&id| matches!(&doc.node(id).kind, NodeKind::Text { text } if text.contains("here")),
        )
        .expect("here");
    assert!(
        here_idx >= 1
            && matches!(
                &doc.node(children[here_idx - 1]).kind,
                NodeKind::Property { key, .. } if key == "change_deleted"
            ),
        "continuation stays inside the reopened deleted region"
    );
}

#[test]
fn dl122_f1_text_split_after_at_the_end_of_a_different_author_inserted_region_shares_the_regions_closer()
 {
    let env = MutationSession::tracked("Bob");
    let file = env.write_lyx("temp_dl122_f1_text.lyx", DL122_SPLIT_END_BODY, AUTHOR_ALICE);
    let result = env.run(&[
        "insert",
        path_arg(&file),
        "layout[Standard]",
        "split-after",
        "edit",
        "--text",
        " TX",
    ]);
    assert_eq!(result["matched_nodes"], json!(1));
    let text = fs::read_to_string(&file).unwrap();
    let doc = parse_lyx(&text);
    let children = layout_children(&doc);
    assert_eq!(
        change_marker_keys(&doc, children),
        ["change_inserted", "change_inserted", "change_unchanged"],
        "byte-exact: ci(Alice) ci(Bob) cu — one closer, no `cu cu`"
    );
    let joined = all_text(&doc, children);
    assert!(
        joined.contains("edit"),
        "pre-split text stays in Alice's region"
    );
    assert!(joined.contains(" TX"), "payload lands in Bob's region");
}

#[test]
fn dl122_f1_block_split_after_at_the_end_of_a_deleted_region_shares_the_regions_closer() {
    let env = MutationSession::tracked("Bob");
    let file = env.write_lyx(
        "temp_dl122_f1_block.lyx",
        DL122_SPLIT_END_DEL_BODY,
        AUTHOR_ALICE,
    );
    let result = env.run(&[
        "insert",
        path_arg(&file),
        "layout[Standard]",
        "split-after",
        "edit",
        "--footnote",
        "FN",
    ]);
    assert_eq!(result["matched_nodes"], json!(1));
    let text = fs::read_to_string(&file).unwrap();
    let doc = parse_lyx(&text);
    let children = layout_children(&doc);
    assert_eq!(
        change_marker_keys(&doc, children),
        ["change_deleted", "change_inserted", "change_unchanged"],
        "byte-exact: cd(Alice) ci(Bob) cu — one closer"
    );
    assert!(
        text.contains("\\begin_inset Foot"),
        "footnote present in Bob's region"
    );
    assert!(
        all_text(&doc, children).contains("edit"),
        "deleted text survives"
    );
}

#[test]
fn dl122_f1_split_after_at_the_end_of_a_region_with_no_trailing_closer_keeps_the_block_self_contained()
 {
    let env = MutationSession::tracked("Bob");
    let file = env.write_lyx(
        "temp_dl122_f1_nocloser.lyx",
        DL122_SPLIT_END_NO_CLOSER_BODY,
        AUTHOR_ALICE,
    );
    let result = env.run(&[
        "insert",
        path_arg(&file),
        "layout[Standard]",
        "split-after",
        "edit",
        "--text",
        " TX",
    ]);
    assert_eq!(result["matched_nodes"], json!(1));
    let text = fs::read_to_string(&file).unwrap();
    let doc = parse_lyx(&text);
    let children = layout_children(&doc);
    assert_eq!(
        change_marker_keys(&doc, children),
        ["change_inserted", "change_inserted", "change_unchanged"],
        "region runs to paragraph end: the block closes itself with its own closer (still a single closer)"
    );
}

#[test]
fn dl90_split_after_split_ambiguous_resolved_by_change_deleted() {
    let env = MutationSession::tracked("Alice");
    let file = env.write_lyx(
        "temp_dl90_splitamb.lyx",
        r"\begin_layout Standard
and
\change_deleted 1 1700000000
and
\change_unchanged
\end_layout
",
        AUTHOR_ALICE,
    );
    let p = path_arg(&file);
    let ambiguous = env.run(&[
        "insert",
        p,
        "layout[Standard]",
        "split-after",
        "and",
        "--text",
        " X",
    ]);
    assert_eq!(
        code(&ambiguous),
        "SPLIT_AMBIGUOUS",
        "phrase in both regions is ambiguous without scoping"
    );
    assert!(
        message(&ambiguous).contains(":change"),
        "error names the escape hatch"
    );
    let scoped = env.run(&[
        "insert",
        p,
        "layout[Standard]:change(deleted)",
        "split-after",
        "and",
        "--text",
        " X",
    ]);
    assert_eq!(
        scoped["matched_nodes"],
        json!(1),
        "scoped split-after succeeds"
    );
    assert!(
        fs::read_to_string(&file).unwrap().contains(" X"),
        "payload inserted in the rejected region"
    );
}

#[test]
fn dl108_multi_target_no_match_reports_the_aggregate_breakdown() {
    let env = MutationSession::new();
    let file = env.write_lyx(
        "temp_dl108_nomatch.lyx",
        DL108_BODY_ONE_OF_THREE,
        "\\textclass article\n",
    );
    let result = env.run(&[
        "insert",
        path_arg(&file),
        "layout[Standard]",
        "split-after",
        "write",
        "--text",
        "!",
    ]);
    assert_eq!(code(&result), "SPLIT_NO_MATCH");
    let msg = message(&result);
    assert!(msg.contains("matched 3 blocks"));
    assert!(msg.contains("appears exactly once in 1 of them"));
    assert!(msg.contains("in none of the others"));
    assert!(msg.contains("(tracked changes included)"));
    assert!(msg.contains("appears exactly once in every matched block"));
    assert!(
        !fs::read_to_string(&file).unwrap().contains('!'),
        "abort must precede any splice"
    );
}

#[test]
fn dl108_phrase_in_every_block_once_in_some_and_multiple_times_in_others() {
    let env = MutationSession::new();
    let file = env.write_lyx(
        "temp_dl108_amb.lyx",
        DL108_BODY_WORRYING_CASE,
        "\\textclass article\n",
    );
    let result = env.run(&[
        "insert",
        path_arg(&file),
        "layout[Standard]",
        "split-after",
        "write",
        "--text",
        "!",
    ]);
    assert_eq!(code(&result), "SPLIT_AMBIGUOUS");
    let msg = message(&result);
    assert!(msg.contains("matched 3 blocks"));
    assert!(msg.contains("appears exactly once in 2 of them"));
    assert!(msg.contains("multiple times in 1"));
    assert!(msg.contains("(tracked changes included)"));
    assert!(msg.contains("appears exactly once in every matched block"));
    assert!(
        !fs::read_to_string(&file).unwrap().contains('!'),
        "abort must precede any splice"
    );
}

#[test]
fn dl108_deterministic_precedence_any_0_occurrence_target_wins_over_ambiguity() {
    let env = MutationSession::new();
    let file = env.write_lyx(
        "temp_dl108_precedence.lyx",
        DL108_BODY_MIXED,
        "\\textclass article\n",
    );
    let result = env.run(&[
        "insert",
        path_arg(&file),
        "layout[Standard]",
        "split-after",
        "write",
        "--text",
        "!",
    ]);
    assert_eq!(
        code(&result),
        "SPLIT_NO_MATCH",
        "NO_MATCH wins when any target has 0"
    );
    let msg = message(&result);
    assert!(msg.contains("appears exactly once in 1 of them"));
    assert!(msg.contains("multiple times in 1"));
    assert!(msg.contains("in none of the others"));
}

#[test]
fn dl108_multi_target_all_exactly_once_still_splits_every_block() {
    let env = MutationSession::new();
    let file = env.write_lyx(
        "temp_dl108_allonce.lyx",
        DL108_BODY_ALL_ONCE,
        "\\textclass article\n",
    );
    let result = env.run(&[
        "insert",
        path_arg(&file),
        "layout[Standard]",
        "split-after",
        "write",
        "--text",
        "!",
    ]);
    assert!(result["code"].is_null());
    assert_eq!(result["matched_nodes"], json!(2), "both targets split");
    let text = fs::read_to_string(&file).unwrap();
    assert_eq!(text.matches('!').count(), 2, "payload lands in both blocks");
}

#[test]
fn dl92_b_split_after_under_the_union_scope_works_in_any_listed_region() {
    let env = MutationSession::tracked("Alice");
    let file = env.write_lyx(
        "temp_dl92b_split.lyx",
        r"\begin_layout Standard
current and
\change_deleted 1 1700000000
rejected
\change_unchanged
\end_layout
",
        AUTHOR_ALICE,
    );
    let result = env.run(&[
        "insert",
        path_arg(&file),
        "layout[Standard]:change(current), layout[Standard]:change(deleted)",
        "split-after",
        "and",
        "--text",
        " Y",
    ]);
    assert_eq!(
        result["matched_nodes"],
        json!(1),
        "split in a listed region is allowed"
    );
    let text = fs::read_to_string(&file).unwrap();
    let doc = parse_lyx(&text);
    let joined = all_text(&doc, layout_children(&doc));
    assert!(
        joined.contains("and Y"),
        "payload inserted at the split point"
    );
}

#[test]
fn dl124_b1_cite_emits_canonical_blank_line() {
    let env = MutationSession::new();
    let file = env.template("temp_dl124_b1_cite.lyx");
    env.run(&[
        "insert",
        path_arg(&file),
        "layout[Standard]:first",
        "append",
        "--cite",
        "K1",
    ]);
    let text = fs::read_to_string(&file).unwrap();
    assert!(
        text.contains("literal \"false\"\n\n\\end_inset"),
        "citation inset must carry the blank line LyX writes before \\end_inset"
    );
}

#[test]
fn dl124_b2_ref_emits_canonical_blank_line() {
    let env = MutationSession::new();
    let file = env.template("temp_dl124_b2_ref.lyx");
    env.run(&[
        "insert",
        path_arg(&file),
        "layout[Standard]:first",
        "append",
        "--ref",
        "sec:x",
    ]);
    let text = fs::read_to_string(&file).unwrap();
    assert!(
        text.contains("tuple \"list\"\n\n\\end_inset"),
        "ref inset must carry the blank line LyX writes before \\end_inset"
    );
}

#[test]
fn dl124_b3_label_emits_canonical_blank_line() {
    let env = MutationSession::new();
    let file = env.template("temp_dl124_b3_label.lyx");
    env.run(&[
        "insert",
        path_arg(&file),
        "layout[Standard]:first",
        "append",
        "--label",
        "sec:x",
    ]);
    let text = fs::read_to_string(&file).unwrap();
    assert!(
        text.contains("name \"sec:x\"\n\n\\end_inset"),
        "label inset must carry the blank line LyX writes before \\end_inset"
    );
}

#[test]
fn dl124_b4_footnote_emits_canonical_blank_line() {
    let env = MutationSession::new();
    let file = env.template("temp_dl124_b4_footnote.lyx");
    env.run(&[
        "insert",
        path_arg(&file),
        "layout[Standard]:first",
        "append",
        "--footnote",
        "note",
    ]);
    let text = fs::read_to_string(&file).unwrap();
    assert!(
        text.contains("\\end_layout\n\n\\end_inset"),
        "footnote inset must carry the blank line LyX writes before \\end_inset"
    );
}

#[test]
fn dl124_b5_tracked_cite_keeps_markers_outside_and_the_blank_line_inside() {
    let env = MutationSession::with_config(json!({ "trackChanges": true }));
    let file = env.template("temp_dl124_b5_tracked_cite.lyx");
    env.run(&[
        "insert",
        path_arg(&file),
        "layout[Standard]:first",
        "append",
        "--cite",
        "K1",
    ]);
    let text = fs::read_to_string(&file).unwrap();
    let body = citation_inset_body(&text).expect("citation inset should be present");
    assert!(
        !body.contains("\\change_"),
        "no markers inside the inset body (atomic wrap, DL81)"
    );
    assert!(
        body.contains("literal \"false\"\n\n"),
        "blank line preserved inside the tracked body"
    );
    let before_idx = text.find("\\begin_inset CommandInset citation").unwrap();
    let after_idx = before_idx + text[before_idx..].find("\\end_inset").unwrap();
    let inserted_idx = text[..before_idx].rfind("\\change_inserted");
    let unchanged_idx = text[after_idx..]
        .find("\\change_unchanged")
        .map(|i| after_idx + i);
    assert!(
        inserted_idx.is_some_and(|i| i < before_idx),
        "change_inserted must precede the inset"
    );
    assert!(
        unchanged_idx.is_some_and(|i| i > after_idx),
        "change_unchanged must follow the inset"
    );
}

#[test]
fn dl124_b6_raw_file_passes_through_byte_identical() {
    let env = MutationSession::new();
    let file = env.template("temp_dl124_b6_raw.lyx");
    let raw_content = "\\begin_inset CommandInset citation\n\
         LatexCommand citet\n\
         key \"DL124B6\"\n\
         literal \"false\"\n\
         \\end_inset\n";
    let raw = env.write_file("cite.raw", raw_content);
    env.run(&[
        "insert",
        path_arg(&file),
        "layout[Standard]:first",
        "append",
        "--raw-file",
        path_arg(&raw),
    ]);
    let text = fs::read_to_string(&file).unwrap();
    assert!(
        text.contains("key \"DL124B6\"\nliteral \"false\"\n\\end_inset"),
        "raw-file content must pass through verbatim (no synthesized blank line)"
    );
    assert!(
        !text.contains("key \"DL124B6\"\nliteral \"false\"\n\n\\end_inset"),
        "raw-file must not gain the generator's blank line"
    );
}
