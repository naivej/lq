//! `set` CLI tests (Deno `tests/mutation_test.ts`).

mod common;

use common::{MutationSession, deleted_region_contains_inset, json_warnings, path_arg};
use lq::{Document, NodeId, NodeKind, advance_change_depths, parse, serialize};
use serde_json::json;
use std::fs;

fn code(v: &serde_json::Value) -> &str {
    v["code"].as_str().unwrap_or("")
}

fn message(v: &serde_json::Value) -> &str {
    v["message"].as_str().unwrap_or("")
}

fn parse_lyx(text: &str) -> Document {
    parse(text, false).unwrap_or_else(|e| panic!("parse failed: {}", e.message))
}

fn find_child_block(doc: &Document, parent: NodeId, tag: &str) -> NodeId {
    doc.node(parent)
        .children
        .iter()
        .copied()
        .find(|&id| matches!(&doc.node(id).kind, NodeKind::Block { tag: t, .. } if t == tag))
        .unwrap_or_else(|| panic!("missing block {tag}"))
}

fn first_layout(doc: &Document) -> NodeId {
    let document = find_child_block(doc, doc.root(), "document");
    let body = find_child_block(doc, document, "body");
    doc.node(body)
        .children
        .iter()
        .copied()
        .find(|&id| matches!(&doc.node(id).kind, NodeKind::Block { tag, .. } if tag == "layout"))
        .expect("layout")
}

fn first_layout_children(doc: &Document) -> &[NodeId] {
    &doc.node(first_layout(doc)).children
}

fn change_markers(doc: &Document, children: &[NodeId]) -> Vec<NodeId> {
    children
        .iter()
        .copied()
        .filter(|&id| {
            matches!(
                &doc.node(id).kind,
                NodeKind::Property { key, .. } if key.starts_with("change_")
            )
        })
        .collect()
}

fn marker_keys<'a>(doc: &'a Document, markers: &[NodeId]) -> Vec<&'a str> {
    markers
        .iter()
        .map(|&id| match &doc.node(id).kind {
            NodeKind::Property { key, .. } => key.as_str(),
            _ => unreachable!("change marker is a property"),
        })
        .collect()
}

fn prop_value(doc: &Document, id: NodeId) -> Option<&str> {
    match &doc.node(id).kind {
        NodeKind::Property { value, .. } => value.as_deref(),
        _ => None,
    }
}

fn all_text(doc: &Document, children: &[NodeId]) -> String {
    children
        .iter()
        .filter_map(|&id| match &doc.node(id).kind {
            NodeKind::Text { text } => Some(text.as_str()),
            _ => None,
        })
        .collect()
}

fn max_marker_depth(doc: &Document, children: &[NodeId]) -> i32 {
    let mut deleted_depth = 0;
    let mut inserted_depth = 0;
    let mut max = 0;
    for m in change_markers(doc, children) {
        let key = match &doc.node(m).kind {
            NodeKind::Property { key, .. } => key.as_str(),
            _ => continue,
        };
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

fn author_lines(text: &str) -> Vec<&str> {
    text.lines()
        .filter(|l| l.starts_with("\\author "))
        .collect()
}

fn find_first_layout_args(doc: &Document, args: &str) -> NodeId {
    fn walk(doc: &Document, id: NodeId, args: &str) -> Option<NodeId> {
        if let NodeKind::Block {
            tag, args: Some(a), ..
        } = &doc.node(id).kind
            && tag == "layout"
            && a == args
        {
            return Some(id);
        }
        for &c in &doc.node(id).children {
            if let Some(found) = walk(doc, c, args) {
                return Some(found);
            }
        }
        None
    }
    walk(doc, doc.root(), args).expect("layout with args")
}

fn find_first_inset(doc: &Document) -> NodeId {
    doc.node(first_layout(doc))
        .children
        .iter()
        .copied()
        .find(|&id| matches!(&doc.node(id).kind, NodeKind::Block { tag, .. } if tag == "inset"))
        .expect("inset")
}

fn child_index(children: &[NodeId], id: NodeId) -> usize {
    children
        .iter()
        .position(|&c| c == id)
        .expect("marker is a child")
}

fn assert_roundtrip(text: &str) {
    assert_eq!(serialize(&parse_lyx(text)), text);
}

fn count_substr(haystack: &str, needle: &str) -> usize {
    haystack.matches(needle).count()
}

const DL98_REF_INSET: &str = r#"\begin_inset CommandInset ref
LatexCommand ref
reference "sec:intro"

\end_inset
"#;

const DL98_HEADER: &str = "\\author 1 \"lq user\"\n";

const ADJACENT_CI_CI_BODY: &str = r"\begin_layout Standard
\change_inserted 1 1700000000
Alice's text
\change_inserted 2 1700000001
Bob's text
\change_unchanged
\end_layout
";

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

const TRACKED_BODY: &str = r"\begin_layout Standard
The quick brown fox
\change_inserted 1 1700000000
QUICK
LY brown
\change_unchanged
 jumps over
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

const ADJACENT_INSERT_DELETE_BODY: &str = r"\begin_layout Standard
\change_inserted 1 1700000000
X
\change_deleted 1 1700000001
Z
\change_unchanged
 tail
\end_layout
";

#[test]
fn mutation_engine_untracked_find_on_label_metadata_single_line() {
    let env = MutationSession::with_config(json!({ "trackChanges": false }));
    let file = env.write_file(
        "temp_label_find.lyx",
        r#"#LyX 2.5 created this file.
\begin_document
\begin_header
\textclass article
\end_header
\begin_body
\begin_layout Standard
\begin_inset CommandInset label
LatexCommand label
name "sec:Section_label"
\end_inset
\end_layout
\end_body
\end_document
"#,
    );
    let result = env.run(&[
        "set",
        path_arg(&file),
        "inset[CommandInset label]:first",
        "sec:Section_label_NEW",
        "--find",
        "sec:Section_label",
    ]);
    assert_eq!(result["modified_nodes"], json!(1));
    let text = fs::read_to_string(&file).unwrap();
    assert!(
        text.contains(r#"name "sec:Section_label_NEW""#),
        "label rename must stay on one line"
    );
    assert!(
        !text.contains(r#"name "sec:Section_label""#),
        "old label value must be replaced"
    );
}

#[test]
fn cross_node_find_untracked() {
    let env = MutationSession::new();
    let file = env.copy_fixture(
        "PerDevLog/test_report_33_repro.lyx",
        "temp_cross_find_untracked.lyx",
    );
    let result = env.run(&[
        "set",
        path_arg(&file),
        "layout[Standard]:first",
        "REPLACED",
        "--find",
        "Compared to the literature, we find",
    ]);
    assert_eq!(result["modified_nodes"], json!(1));
    assert!(
        result["changes"][0]["text"]
            .as_str()
            .unwrap()
            .contains("REPLACED")
    );
    let text = fs::read_to_string(&file).unwrap();
    assert!(text.contains("REPLACED"));
    assert!(text.contains("significant effects"));
}

#[test]
fn cross_node_find_tracked() {
    let env = MutationSession::with_config(json!({ "trackChanges": true }));
    let file = env.copy_fixture(
        "PerDevLog/test_report_33_repro.lyx",
        "temp_cross_find_tracked.lyx",
    );
    let result = env.run(&[
        "set",
        path_arg(&file),
        "layout[Standard]:first",
        "REPLACED",
        "--find",
        "Compared to the literature, we find",
    ]);
    assert_eq!(result["modified_nodes"], json!(1));
    assert!(
        result["changes"][0]["text"]
            .as_str()
            .unwrap()
            .contains("\\change_deleted{Compared to the literature, we find}")
    );
    let text = fs::read_to_string(&file).unwrap();
    assert!(text.contains("\\change_deleted"));
    assert!(text.contains("\\change_inserted"));
    assert!(text.contains("REPLACED"));
}

#[test]
fn dl98_f1_find_before_a_ref_inset_keeps_the_inset_current() {
    let env = MutationSession::with_config(json!({ "trackChanges": true }));
    let file = env.write_lyx(
        "temp_dl98_f1_ref.lyx",
        &format!(
            "\\begin_layout Standard\nSee Section\n{DL98_REF_INSET}\n for details.\n\\end_layout\n"
        ),
        DL98_HEADER,
    );
    let result = env.run(&[
        "set",
        path_arg(&file),
        "layout[Standard]",
        "Section 2",
        "--find",
        "See Section",
    ]);
    assert_eq!(result["modified_nodes"], json!(1));
    let text = fs::read_to_string(&file).unwrap();
    assert!(text.contains("\\begin_inset CommandInset ref"));
    assert!(
        !deleted_region_contains_inset(&text),
        "the ref inset must stay OUTSIDE the \\change_deleted span"
    );
}

#[test]
fn dl98_f1_find_before_a_citation_inset_keeps_the_inset_current() {
    let env = MutationSession::with_config(json!({ "trackChanges": true }));
    let file = env.write_lyx(
        "temp_dl98_f1_citation.lyx",
        r#"\begin_layout Standard
See
\begin_inset CommandInset citation
LatexCommand citet
key "Einstein1905"
literal "false"

\end_inset

 for details.
\end_layout
"#,
        DL98_HEADER,
    );
    let result = env.run(&[
        "set",
        path_arg(&file),
        "layout[Standard]",
        "Read",
        "--find",
        "See",
    ]);
    assert_eq!(result["modified_nodes"], json!(1));
    let text = fs::read_to_string(&file).unwrap();
    assert!(text.contains("\\begin_inset CommandInset citation"));
    assert!(
        !deleted_region_contains_inset(&text),
        "the citation inset must stay OUTSIDE the \\change_deleted span"
    );
}

#[test]
fn dl98_f1_find_before_a_label_inset_keeps_the_inset_current() {
    let env = MutationSession::with_config(json!({ "trackChanges": true }));
    let file = env.write_lyx(
        "temp_dl98_f1_label.lyx",
        r#"\begin_layout Standard
intro
\begin_inset CommandInset label
LatexCommand label
name "sec:intro"

\end_inset


\end_layout
"#,
        DL98_HEADER,
    );
    let result = env.run(&[
        "set",
        path_arg(&file),
        "layout[Standard]",
        "introduction",
        "--find",
        "intro",
    ]);
    assert_eq!(result["modified_nodes"], json!(1));
    let text = fs::read_to_string(&file).unwrap();
    assert!(text.contains("\\begin_inset CommandInset label"));
    assert!(
        !deleted_region_contains_inset(&text),
        "the label inset must stay OUTSIDE the \\change_deleted span"
    );
}

#[test]
fn dl98_f1_find_before_a_note_inset_keeps_the_inset_current() {
    let env = MutationSession::with_config(json!({ "trackChanges": true }));
    let file = env.write_lyx(
        "temp_dl98_f1_note.lyx",
        r"\begin_layout Standard
intro note
\begin_inset Note Note
status collapsed

\begin_layout Plain Layout
PRIVATE secret
\end_layout

\end_inset


\end_layout
",
        DL98_HEADER,
    );
    let result = env.run(&[
        "set",
        path_arg(&file),
        "layout[Standard]",
        "introduction",
        "--find",
        "intro note",
    ]);
    assert_eq!(result["modified_nodes"], json!(1));
    let text = fs::read_to_string(&file).unwrap();
    assert!(text.contains("\\begin_inset Note Note"));
    assert!(
        !deleted_region_contains_inset(&text),
        "the Note inset must stay OUTSIDE the \\change_deleted span"
    );
}

#[test]
fn dl98_f1_find_before_a_closing_quote_inset_keeps_the_inset_current() {
    let env = MutationSession::with_config(json!({ "trackChanges": true }));
    let file = env.write_lyx(
        "temp_dl98_f1_quote.lyx",
        r"\begin_layout Standard
He said
\begin_inset Quotes erd
\end_inset

 to them.
\end_layout
",
        DL98_HEADER,
    );
    let result = env.run(&[
        "set",
        path_arg(&file),
        "layout[Standard]",
        "They said",
        "--find",
        "He said",
    ]);
    assert_eq!(result["modified_nodes"], json!(1));
    let text = fs::read_to_string(&file).unwrap();
    assert!(text.contains("\\begin_inset Quotes erd"));
    assert!(
        !deleted_region_contains_inset(&text),
        "the quote inset must stay OUTSIDE the \\change_deleted span"
    );
}

#[test]
fn dl98_f1_control_find_with_trailing_text_before_an_inset_stays_correct() {
    let env = MutationSession::with_config(json!({ "trackChanges": true }));
    let file = env.write_lyx(
        "temp_dl98_f1_control.lyx",
        &format!(
            "\\begin_layout Standard\nSee Section~\n{DL98_REF_INSET}\n for details.\n\\end_layout\n"
        ),
        DL98_HEADER,
    );
    let result = env.run(&[
        "set",
        path_arg(&file),
        "layout[Standard]",
        "Section 2",
        "--find",
        "See Section",
    ]);
    assert_eq!(result["modified_nodes"], json!(1));
    let text = fs::read_to_string(&file).unwrap();
    assert!(
        !deleted_region_contains_inset(&text),
        "trailing text must keep the ref inset OUTSIDE the \\change_deleted span"
    );
}

#[test]
fn dl98_f1_find_inside_change_deleted_before_an_inset_keeps_the_inset_in_its_original_deleted_region_dl106_a1()
 {
    let env = MutationSession::tracked("Bob");
    let file = env.write_lyx(
        "temp_dl98_f1_deleted_inset.lyx",
        &format!(
            "\\begin_layout Standard\n\
             \\change_deleted 1 1700000000\n\
             old text\n{DL98_REF_INSET}\
             \\change_unchanged\n\
              rest\n\
             \\end_layout\n"
        ),
        "\\author 1 \"Alice\"\n",
    );
    let result = env.run(&[
        "set",
        path_arg(&file),
        "layout[Standard]",
        "new",
        "--find",
        "old text",
    ]);
    assert_eq!(result["modified_nodes"], json!(1));
    let text = fs::read_to_string(&file).unwrap();
    assert!(
        text.contains("\\change_inserted 2"),
        "replacement is Bob's insert"
    );
    assert!(
        text.contains("\\change_deleted 1"),
        "Alice's rejected run stays Alice's"
    );
    assert!(
        !text.contains("\\change_deleted 2"),
        "Bob must NOT re-author Alice's rejected text (DL106 A1)"
    );
    let del_alice = text.find("\\change_deleted 1");
    let inset_pos = text.find("\\begin_inset CommandInset ref");
    let unchanged_pos = text.rfind("\\change_unchanged");
    assert!(
        del_alice.is_some() && inset_pos.is_some() && unchanged_pos.is_some(),
        "expected Alice-deleted, inset, unchanged in order"
    );
    assert!(
        del_alice.unwrap() < inset_pos.unwrap() && inset_pos.unwrap() < unchanged_pos.unwrap(),
        "the inset must stay inside Alice's original \\change_deleted region"
    );
}

#[test]
fn dl106_b1_find_spanning_deleted_current_keeps_the_deleted_parts_author_re_authors_the_current_part()
 {
    let env = MutationSession::tracked("Bob");
    let file = env.write_lyx(
        "temp_dl106_b1_span.lyx",
        r"\begin_layout Standard
\change_deleted 1 1700000000
Hello
\change_unchanged
 world
\end_layout
",
        "\\author 1 \"Alice\"\n",
    );
    let result = env.run(&[
        "set",
        path_arg(&file),
        "layout[Standard]",
        "Hi",
        "--find",
        "Hello world",
    ]);
    assert_eq!(result["modified_nodes"], json!(1));
    let text = fs::read_to_string(&file).unwrap();
    assert!(
        text.contains("\\change_inserted 2"),
        "replacement is Bob's insert"
    );
    assert!(
        text.contains("\\change_deleted 1"),
        "deleted part keeps Alice's author"
    );
    assert!(
        text.contains("\\change_deleted 2"),
        "current part re-authored to Bob"
    );
    let del_alice = text.find("\\change_deleted 1").unwrap();
    let hello_pos = text.find("Hello").unwrap();
    let del_bob = text.find("\\change_deleted 2").unwrap();
    let world_pos = text.find(" world").unwrap();
    assert!(
        del_alice < hello_pos && hello_pos < del_bob && del_bob < world_pos,
        "order: Alice-deleted{{Hello}} then Bob-deleted{{ world}}"
    );
    let doc = parse_lyx(&text);
    let children = first_layout_children(&doc);
    let markers = change_markers(&doc, children);
    assert_eq!(
        marker_keys(&doc, &markers),
        [
            "change_inserted",
            "change_deleted",
            "change_deleted",
            "change_unchanged"
        ],
        "byte-exact (D-15A): inserted{{Hi}} then Alice-deleted{{Hello}} adjacent Bob-deleted{{ world}}, shared closer, final unchanged"
    );
}

#[test]
fn dl106_b1_same_author_find_inside_own_change_deleted_keeps_the_same_author_guard() {
    let env = MutationSession::tracked("Alice");
    let file = env.write_lyx(
        "temp_dl106_b1_sameauthor.lyx",
        r"\begin_layout Standard
\change_deleted 1 1700000000
Hello world
\change_unchanged
\end_layout
",
        "\\author 1 \"Alice\"\n",
    );
    let result = env.run(&[
        "set",
        path_arg(&file),
        "layout[Standard]",
        "Hi",
        "--find",
        "Hello world",
    ]);
    assert_eq!(result["modified_nodes"], json!(1));
    let text = fs::read_to_string(&file).unwrap();
    assert!(
        text.contains("\\change_inserted 1"),
        "replacement is Alice's insert"
    );
    assert!(
        text.contains("\\change_deleted 1"),
        "rejected run stays Alice's"
    );
    assert!(
        !text.contains("\\change_deleted 2") && !text.contains("\\change_inserted 2"),
        "no second author introduced"
    );
    let doc = parse_lyx(&text);
    assert_eq!(
        max_marker_depth(&doc, first_layout_children(&doc)),
        1,
        "flat, never nested"
    );
}

#[test]
fn dl120_a4_plain_set_consumes_the_authors_own_pending_insert_next_to_a_co_authors_flat_no_nesting()
{
    let env = MutationSession::tracked("Bob");
    let file = env.write_lyx(
        "temp_dl120_a4.lyx",
        ADJACENT_CI_CI_BODY,
        "\\author 1 \"Alice\"\n\\author 2 \"Bob\"\n",
    );
    let result = env.run(&[
        "set",
        path_arg(&file),
        "layout[Standard]",
        "Bob's replacement",
    ]);
    assert_eq!(result["modified_nodes"], json!(1));
    let text = fs::read_to_string(&file).unwrap();
    let doc = parse_lyx(&text);
    let children = first_layout_children(&doc);
    assert!(
        text.contains("\\change_deleted 2"),
        "Alice's text becomes Bob's deletion"
    );
    assert!(
        !text.contains("\\change_deleted 1"),
        "no author-1 deletion remains (re-authored)"
    );
    assert!(
        !text.contains("Bob's text"),
        "Bob's own pending insert consumed"
    );
    assert!(
        text.contains("\\change_inserted 2"),
        "replacement inserted by Bob"
    );
    assert!(all_text(&doc, children).contains("Bob's replacement"));
    let markers = change_markers(&doc, children);
    assert_eq!(
        marker_keys(&doc, &markers),
        ["change_deleted", "change_inserted", "change_unchanged"],
        "byte-exact: Bob-deleted{{Alice}} ci 2{{replacement}} cu (shared closer)"
    );
}

#[test]
fn dl99_find_on_a_visible_layout_does_not_leak_into_a_note() {
    let env = MutationSession::new();
    let file = env.write_lyx(
        "temp_dl99_find.lyx",
        DL99_NOTE_BODY,
        "\\textclass article\n",
    );
    let result = env.run(&[
        "set",
        path_arg(&file),
        "layout[Standard]:first",
        "X",
        "--find",
        "PRIVATE SECRET",
    ]);
    assert_eq!(code(&result), "NO_MATCH");
    assert!(message(&result).contains("exists only inside a private note"));
    assert!(message(&result).contains(":note"));
}

#[test]
fn dl99_find_no_match_without_a_note_only_phrase_carries_no_note_hint() {
    let env = MutationSession::new();
    let file = env.write_lyx(
        "temp_dl99_find_nohint.lyx",
        DL99_NOTE_BODY,
        "\\textclass article\n",
    );
    let result = env.run(&[
        "set",
        path_arg(&file),
        "layout[Standard]:first",
        "X",
        "--find",
        "NOWHERE AT ALL",
    ]);
    assert_eq!(code(&result), "NO_MATCH");
    assert!(!message(&result).contains("exists only inside a private note"));
}

#[test]
fn dl99_no_match_hint_requires_the_phrase_to_be_private_only() {
    let env = MutationSession::new();
    let duplicate =
        format!("{DL99_NOTE_BODY}\\begin_layout Standard\nPRIVATE SECRET note\n\\end_layout\n");
    let find_file = env.write_lyx(
        "temp_dl99_find_duplicate.lyx",
        &duplicate,
        "\\textclass article\n",
    );
    let split_file = env.write_lyx(
        "temp_dl99_split_duplicate.lyx",
        &duplicate,
        "\\textclass article\n",
    );
    let find_result = env.run(&[
        "set",
        path_arg(&find_file),
        "layout[Standard]:first",
        "X",
        "--find",
        "PRIVATE SECRET",
    ]);
    assert_eq!(code(&find_result), "NO_MATCH");
    assert!(!message(&find_result).contains("exists only inside a private note"));

    let split_result = env.run(&[
        "insert",
        path_arg(&split_file),
        "layout[Standard]:first",
        "split-after",
        "PRIVATE SECRET",
        "--text",
        "Y",
    ]);
    assert_eq!(code(&split_result), "SPLIT_NO_MATCH");
    assert!(!message(&split_result).contains("exists only inside a private note"));
}

#[test]
fn f2_find_spanning_emph_drops_the_inside_span_property_mimic_lyx() {
    let env = MutationSession::new();
    let file = env.write_lyx(
        "temp_f2_emph_span.lyx",
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
        "set",
        path_arg(&file),
        "layout[Standard]",
        "XYZ",
        "--find",
        "Alpha Beta",
    ]);
    assert_eq!(result["modified_nodes"], json!(1));
    let text = fs::read_to_string(&file).unwrap();
    assert!(text.contains("XYZ"));
    assert!(
        !text.contains("\\emph on"),
        "inside-span \\emph on must be dropped"
    );
    assert!(text.contains("\\emph default"));
    assert!(
        text.find("XYZ").unwrap() < text.find("\\emph default").unwrap(),
        "\\emph default must come after the replacement"
    );
}

#[test]
fn f2_find_fully_inside_emph_keeps_the_replacement_emphasized() {
    let env = MutationSession::new();
    let file = env.write_lyx(
        "temp_f2_emph_inside.lyx",
        r"\begin_layout Standard
\emph on
Alpha Beta
\emph default
\end_layout
",
        "",
    );
    let result = env.run(&[
        "set",
        path_arg(&file),
        "layout[Standard]",
        "XYZ",
        "--find",
        "Alpha Beta",
    ]);
    assert_eq!(result["modified_nodes"], json!(1));
    let text = fs::read_to_string(&file).unwrap();
    assert!(text.contains("XYZ"));
    assert!(text.contains("\\emph on"));
    assert!(text.contains("\\emph default"));
    let pos_on = text.find("\\emph on").unwrap();
    let pos_xyz = text.find("XYZ").unwrap();
    let pos_default = text.find("\\emph default").unwrap();
    assert!(
        pos_on < pos_xyz && pos_xyz < pos_default,
        "replacement must sit between \\emph on and \\emph default (emphasized)"
    );
}

#[test]
fn f9_contains_matches_text_inside_change_deleted_selectors_see_all() {
    let env = MutationSession::new();
    let file = env.write_lyx(
        "temp_f9_contains_deleted.lyx",
        r"\begin_layout Standard
\change_deleted 1 1700000000
old deleted words
\change_unchanged
current text
\end_layout
",
        "",
    );
    let p = path_arg(&file);
    let found = env.run(&["read", p, "layout:contains('old deleted words')", "--count"]);
    assert_eq!(found["count"]["layout[Standard]"], json!(1));
    let current = env.run(&["read", p, "layout:contains('current text')", "--count"]);
    assert_eq!(current["count"]["layout[Standard]"], json!(1));
    let set_result = env.run(&[
        "set",
        p,
        "layout[Standard]",
        "X",
        "--find",
        "old deleted words",
    ]);
    assert_eq!(
        set_result["modified_nodes"],
        json!(1),
        "--find now matches rejected text"
    );
    let after = fs::read_to_string(&file).unwrap();
    assert!(
        after.contains("X"),
        "replacement applied to the rejected region"
    );
    assert!(!after.contains("old deleted words"), "rejected text erased");
    assert!(
        json_warnings(&set_result)
            .iter()
            .any(|w| w.contains("change_deleted")),
        "deleted-hit warning fires so editing rejected text is not silent"
    );
}

#[test]
fn report_42_f2_nested_deleted_text_find_stays_tracked() {
    let env = MutationSession::tracked("Alice");
    let file = env.write_lyx(
        "temp_report42_f2_nested_find.lyx",
        r"\begin_layout Standard
\change_deleted 1 1700000000
\begin_inset Foot
status collapsed

\begin_layout Plain Layout
Details about me
\end_layout

\end_inset
\change_unchanged
current text
\end_layout
",
        "\\author 1 \"Alice\"\n",
    );
    let result = env.run(&[
        "set",
        path_arg(&file),
        "text:change(deleted)",
        "TAIL",
        "--find",
        "Details about me",
    ]);
    assert_eq!(result["modified_nodes"], json!(1), "{result}");
    let text = fs::read_to_string(&file).unwrap();
    assert!(text.contains("Details about me"));
    assert!(text.contains("TAIL"));
    assert!(text.contains("\\change_inserted"));
    let doc = parse_lyx(&text);
    let nested = find_first_layout_args(&doc, "Plain Layout");
    assert_eq!(
        max_marker_depth(&doc, &doc.node(nested).children),
        1,
        "nested markers must remain flat"
    );
}

#[test]
fn report_42_f2_nested_styled_text_find_stays_inside_the_style_scope() {
    let env = MutationSession::tracked("Alice");
    let file = env.write_lyx(
        "temp_report42_f2_nested_property_find.lyx",
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
        "\\author 1 \"Alice\"\n",
    );
    let result = env.run(&[
        "set",
        path_arg(&file),
        "text:property(emph)",
        "TAIL",
        "--find",
        "foot content",
    ]);
    assert_eq!(result["modified_nodes"], json!(1), "{result}");
    let text = fs::read_to_string(&file).unwrap();
    assert!(text.contains("foot content"));
    assert!(text.contains("TAIL"));
    assert!(text.contains("\\change_inserted"));
}

#[test]
fn report_42_f1_direct_nested_full_set_stays_tracked() {
    let env = MutationSession::tracked("Alice");
    let file = env.write_lyx(
        "temp_report42_f1_nested_full.lyx",
        r"\begin_layout Standard
\change_deleted 1 1700000000
\begin_inset Foot
status collapsed

\begin_layout Plain Layout
old nested text
\end_layout

\end_inset
\change_unchanged
current text
\end_layout
",
        "\\author 1 \"Alice\"\n",
    );
    let result = env.run(&[
        "set",
        path_arg(&file),
        "text:change(deleted)",
        "NEW nested text",
    ]);
    assert_eq!(result["modified_nodes"], json!(1), "{result}");
    let text = fs::read_to_string(&file).unwrap();
    assert!(text.contains("old nested text"));
    assert!(text.contains("NEW nested text"));
    assert!(text.contains("\\change_inserted"));
    let doc = parse_lyx(&text);
    let nested = find_first_layout_args(&doc, "Plain Layout");
    assert_eq!(
        max_marker_depth(&doc, &doc.node(nested).children),
        1,
        "nested markers must remain flat"
    );
}

#[test]
fn dl87_f6_find_reports_modified_nodes_as_nodes_actually_modified() {
    let env = MutationSession::new();
    let file = env.write_lyx(
        "temp_dl87_f6_modified.lyx",
        r"\begin_layout Standard
Alpha
\end_layout
\begin_layout Standard
Beta gamma
\end_layout
",
        "",
    );
    let result = env.run(&[
        "set",
        path_arg(&file),
        "layout[Standard]",
        "GAMMA",
        "--find",
        "gamma",
    ]);
    assert_eq!(
        result["modified_nodes"],
        json!(1),
        "only one of two matched layouts was actually modified"
    );
}

#[test]
fn dl88_f1_tracked_plain_full_replace_keeps_properties_inside_the_deleted_region() {
    let env = MutationSession::with_config(json!({ "trackChanges": true }));
    let file = env.write_lyx(
        "temp_dl88_f1_plain.lyx",
        r"\begin_layout Standard
The 
\emph on
quick
\emph default
 fox
\end_layout
",
        "",
    );
    let result = env.run(&["set", path_arg(&file), "layout[Standard]", "NEW TEXT"]);
    assert_eq!(result["modified_nodes"], json!(1));
    let text = fs::read_to_string(&file).unwrap();
    assert!(text.contains("NEW TEXT"));
    let deleted_pos = text.find("\\change_deleted");
    let inserted_pos = text.find("\\change_inserted");
    let emph_on_pos = text.find("\\emph on");
    let emph_default_pos = text.find("\\emph default");
    assert!(
        deleted_pos.is_some() && inserted_pos.is_some(),
        "deleted/inserted markers must be present"
    );
    assert!(
        emph_on_pos.unwrap() > deleted_pos.unwrap() && emph_on_pos.unwrap() < inserted_pos.unwrap(),
        "\\emph on must stay inside the deleted region"
    );
    assert!(
        emph_default_pos.unwrap() > deleted_pos.unwrap()
            && emph_default_pos.unwrap() < inserted_pos.unwrap(),
        "\\emph default must stay inside the deleted region"
    );
    assert!(
        text.rfind("\\emph").unwrap() < inserted_pos.unwrap(),
        "no \\emph may trail after the inserted region"
    );
}

#[test]
fn dl88_f2_untracked_plain_full_replace_drops_dead_properties_keeps_insets() {
    let env = MutationSession::new();
    let file = env.write_lyx(
        "temp_dl88_f2_untracked.lyx",
        r"\begin_layout Standard
The 
\emph on
quick
\emph default
 fox
\begin_inset Foot
status collapsed

\begin_layout Plain Layout
a note
\end_layout

\end_inset
\end_layout
",
        "",
    );
    let result = env.run(&["set", path_arg(&file), "layout[Standard]", "NEW TEXT"]);
    assert_eq!(result["modified_nodes"], json!(1));
    let text = fs::read_to_string(&file).unwrap();
    assert!(text.contains("NEW TEXT"));
    assert!(
        !text.contains("\\emph on"),
        "dead \\emph on must be dropped"
    );
    assert!(
        !text.contains("\\emph default"),
        "dead \\emph default must be dropped"
    );
    assert!(
        text.contains("\\begin_inset Foot"),
        "inset must survive as current content"
    );
    assert!(
        text.find("NEW TEXT").unwrap() < text.find("\\begin_inset Foot").unwrap(),
        "replacement text must precede the preserved inset"
    );
}

#[test]
fn dl88_f1b_tracked_plain_full_replace_keeps_inset_outside_the_change_pair() {
    let env = MutationSession::with_config(json!({ "trackChanges": true }));
    let file = env.write_lyx(
        "temp_dl88_f1b_inset.lyx",
        r"\begin_layout Standard
The quick brown fox
\begin_inset Foot
status collapsed

\begin_layout Plain Layout
a note
\end_layout

\end_inset
\end_layout
",
        "",
    );
    let result = env.run(&["set", path_arg(&file), "layout[Standard]", "NEW TEXT"]);
    assert_eq!(result["modified_nodes"], json!(1));
    let text = fs::read_to_string(&file).unwrap();
    let last_unchanged = text.rfind("\\change_unchanged");
    let inset_pos = text.find("\\begin_inset Foot");
    assert!(
        inset_pos.is_some() && last_unchanged.is_some(),
        "inset and closer must be present"
    );
    assert!(
        inset_pos.unwrap() > last_unchanged.unwrap(),
        "inset must stay outside the change pair (survive accept)"
    );
}

#[test]
fn dl88_d2b_flatten_keeps_inset_outside_the_change_pair_survives_accept() {
    let env = MutationSession::tracked("Alice");
    let file = env.write_lyx(
        "temp_dl88_d2b_flatten_inset.lyx",
        r"\begin_layout Standard
The quick brown fox
\change_inserted 1 1700000000
QUICK
\change_unchanged
\begin_inset Foot
status collapsed

\begin_layout Plain Layout
a note
\end_layout

\end_inset
\end_layout
",
        "\\author 1 \"Alice\"\n",
    );
    let result = env.run(&["set", path_arg(&file), "layout[Standard]", "NEW TEXT"]);
    assert_eq!(result["modified_nodes"], json!(1));
    let text = fs::read_to_string(&file).unwrap();
    let last_unchanged = text.rfind("\\change_unchanged");
    let inset_pos = text.find("\\begin_inset Foot");
    assert!(
        inset_pos.is_some() && last_unchanged.is_some(),
        "inset and closer must be present"
    );
    assert!(
        inset_pos.unwrap() > last_unchanged.unwrap(),
        "flatten must keep the inset outside the change pair (D2-b)"
    );
    assert!(text.contains("NEW TEXT"));
}

#[test]
fn dl78_flatten_same_author_merge_timestamp_updated() {
    let env = MutationSession::tracked("Alice");
    let file = env.write_lyx(
        "temp_dl78_merge.lyx",
        TRACKED_BODY,
        "\\author 1 \"Alice\"\n",
    );
    let result = env.run(&[
        "set",
        path_arg(&file),
        "layout[Standard]",
        "FAST",
        "--find",
        "QUICK",
    ]);
    assert_eq!(result["modified_nodes"], json!(1));
    let doc = parse_lyx(&fs::read_to_string(&file).unwrap());
    let children = first_layout_children(&doc);
    let markers = change_markers(&doc, children);
    assert_eq!(
        marker_keys(&doc, &markers),
        ["change_inserted", "change_unchanged"]
    );
    let value = prop_value(&doc, markers[0]).unwrap_or("");
    let (aid, ts) = value.split_once(' ').unwrap();
    assert_eq!(aid, "1");
    assert!(
        ts.parse::<i64>().unwrap() > 1_700_000_000,
        "timestamp must update to max(old, new)"
    );
    let text = all_text(&doc, children);
    assert!(
        text.contains("FASTLY brown"),
        "inner content merged into outer block"
    );
    assert!(
        !text.contains("QUICK"),
        "same-author deletion of own insertion drops the text"
    );
}

#[test]
fn dl78_flatten_different_author_split_adjacent_flat_blocks() {
    let env = MutationSession::tracked("Bob");
    let file = env.write_lyx(
        "temp_dl78_split.lyx",
        TRACKED_BODY,
        "\\author 1 \"Alice\"\n",
    );
    let result = env.run(&[
        "set",
        path_arg(&file),
        "layout[Standard]",
        "FAST",
        "--find",
        "QUICK",
    ]);
    assert_eq!(result["modified_nodes"], json!(1));
    let doc = parse_lyx(&fs::read_to_string(&file).unwrap());
    let children = first_layout_children(&doc);
    let markers = change_markers(&doc, children);
    assert_eq!(
        marker_keys(&doc, &markers),
        [
            "change_inserted",
            "change_deleted",
            "change_inserted",
            "change_unchanged"
        ]
    );
    let aid = prop_value(&doc, markers[0])
        .unwrap_or("")
        .split_once(' ')
        .map(|(a, _)| a)
        .unwrap();
    assert_eq!(aid, "2", "Bob's replacement first (id 2)");
    let text = all_text(&doc, children);
    assert!(text.contains("FAST"));
    assert!(
        text.contains("QUICK"),
        "different-author pending text is preserved as deleted, not dropped"
    );
    assert_eq!(max_marker_depth(&doc, children), 1, "no nesting");
}

#[test]
fn dl78_flatten_full_replace_on_tracked_node_properties_preserved() {
    let env = MutationSession::with_config(json!({ "trackChanges": true }));
    let file = env.write_lyx(
        "temp_dl78_fullreplace.lyx",
        r"\begin_layout Standard
The 
\emph on
quick
\emph default
 brown fox
\end_layout
",
        "",
    );
    let p = path_arg(&file);
    env.run(&["set", p, "layout[Standard]", "BROWN", "--find", "brown"]);
    let result = env.run(&["set", p, "layout[Standard]", "REPLACED"]);
    assert_eq!(result["modified_nodes"], json!(1));
    let text = fs::read_to_string(&file).unwrap();
    assert!(
        text.contains("\\emph on"),
        "inline properties must survive the flatten (dev log 79 N4)"
    );
    let deleted_pos = text.find("\\change_deleted");
    let inserted_pos = text.find("\\change_inserted");
    let emph_pos = text.find("\\emph on");
    assert!(
        deleted_pos.is_some() && inserted_pos.is_some() && emph_pos.is_some(),
        "deleted/inserted markers and \\emph must all be present"
    );
    assert!(
        emph_pos.unwrap() > deleted_pos.unwrap() && emph_pos.unwrap() < inserted_pos.unwrap(),
        "\\emph must stay inside the deleted region, before the inserted region (test_report_38 F8)"
    );
    let doc = parse_lyx(&text);
    let children = first_layout_children(&doc);
    let keys = marker_keys(&doc, &change_markers(&doc, children));
    let mut depth = 0i32;
    for k in &keys {
        if *k == "change_unchanged" {
            depth -= 1;
        } else {
            depth += 1;
            assert!(
                depth <= 1,
                "markers must not nest after full-replace flatten"
            );
        }
    }
    assert!(keys.contains(&"change_inserted"));
    assert!(text.contains("REPLACED"));
}

#[test]
fn dl78_straddling_find_now_succeeds_range_erase_dev_log_90() {
    let env = MutationSession::tracked("Alice");
    let file = env.write_lyx(
        "temp_dl78_straddle.lyx",
        r"\begin_layout Standard
\change_inserted 1 1700000000
accepted word
\change_unchanged
 plus normal text
\end_layout
",
        "\\author 1 \"Alice\"\n",
    );
    let result = env.run(&[
        "set",
        path_arg(&file),
        "layout[Standard]",
        "X",
        "--find",
        "word plus",
    ]);
    assert_eq!(
        result["modified_nodes"],
        json!(1),
        "straddling match must now succeed"
    );
    let doc = parse_lyx(&fs::read_to_string(&file).unwrap());
    let children = first_layout_children(&doc);
    let text = all_text(&doc, children);
    assert!(
        text.contains("accepted X"),
        "replacement merged at the match start"
    );
    assert!(
        text.contains(" plus"),
        "current part of the erased range preserved as deleted"
    );
    assert_eq!(max_marker_depth(&doc, children), 1, "no nested markers");
}

#[test]
fn dl78_find_inside_change_deleted_matches_see_all_dev_log_90() {
    let env = MutationSession::tracked("Alice");
    let file = env.write_lyx(
        "temp_dl78_deleted_nomatch.lyx",
        r"\begin_layout Standard
The quick brown fox
\change_deleted 1 1700000000
lazy dog
\change_unchanged
 jumps over
\end_layout
",
        "\\author 1 \"Alice\"\n",
    );
    let result = env.run(&[
        "set",
        path_arg(&file),
        "layout[Standard]",
        "X",
        "--find",
        "lazy dog",
    ]);
    assert_eq!(
        result["modified_nodes"],
        json!(1),
        "deleted text is a valid edit target under see-all"
    );
    let text = fs::read_to_string(&file).unwrap();
    assert!(text.contains("X"), "replacement inserted");
    assert!(
        text.contains("lazy dog"),
        "rejected text preserved as deleted"
    );
    assert!(
        json_warnings(&result)
            .iter()
            .any(|w| w.contains("change_deleted")),
        "deleted-hit warning fires so editing rejected text is not silent"
    );
}

#[test]
fn dl103_f4_wholesale_set_preserves_another_authors_rejected_deleted_text() {
    let env = MutationSession::tracked("Bob");
    let file = env.write_lyx(
        "temp_dl103_f4_preserve.lyx",
        r"\begin_layout Standard
\change_deleted 1 1700000000
ALICE REJECTED THIS
\change_unchanged
 plain original 
\change_inserted 1 1700000001
ALICE INSERTED THIS
\change_unchanged
\end_layout
",
        "\\author 1 \"Alice\"\n\\author 2 \"Bob\"\n",
    );
    let result = env.run(&["set", path_arg(&file), "layout[Standard]", "BOB REWRITE"]);
    assert_eq!(result["modified_nodes"], json!(1));
    let doc = parse_lyx(&fs::read_to_string(&file).unwrap());
    let children = first_layout_children(&doc);
    let markers = change_markers(&doc, children);
    assert!(
        markers.len() >= 6,
        "expect deleted2/unchanged/deleted1/unchanged/inserted2/unchanged"
    );
    assert!(
        prop_value(&doc, markers[0]).unwrap_or("").contains("2 "),
        "first region is Bob's re-authored deletion"
    );
    let bob_start = child_index(children, markers[0]) + 1;
    let bob_end = child_index(children, markers[1]);
    let bob_deleted = all_text(&doc, &children[bob_start..bob_end]);
    assert!(
        bob_deleted.contains("plain original"),
        "plain text re-authored under Bob"
    );
    assert!(
        bob_deleted.contains("ALICE INSERTED THIS"),
        "co-author's pending insert re-marked under Bob (LyX eraseChar)"
    );
    assert!(
        prop_value(&doc, markers[2]).unwrap_or("").contains("1 "),
        "Alice's rejected region preserved with her author id"
    );
    let alice_start = child_index(children, markers[2]) + 1;
    let alice_end = child_index(children, markers[3]);
    let alice_rejected = all_text(&doc, &children[alice_start..alice_end]);
    assert_eq!(
        alice_rejected.trim(),
        "ALICE REJECTED THIS",
        "rejected text kept verbatim"
    );
    assert!(
        prop_value(&doc, markers[4]).unwrap_or("").contains("2 "),
        "new value inserted under Bob"
    );
}

#[test]
fn dl103_f4_wholesale_set_consumes_the_current_authors_own_pending_insert() {
    let env = MutationSession::tracked("Alice");
    let file = env.write_lyx(
        "temp_dl103_f4_consume.lyx",
        r"\begin_layout Standard
Old text
\end_layout
",
        "",
    );
    let p = path_arg(&file);
    env.run(&["set", p, "layout[Standard]", "EDIT_A"]);
    env.run(&["set", p, "layout[Standard]", "EDIT_B"]);
    let text = fs::read_to_string(&file).unwrap();
    assert!(text.contains("EDIT_B"), "final value inserted");
    assert!(
        !text.contains("EDIT_A"),
        "same-author pending insert is consumed, not kept"
    );
    assert!(
        text.contains("\\change_deleted 1"),
        "original text re-deleted by the same author"
    );
    assert_roundtrip(&text);
}

#[test]
fn dl103_f4_shared_closer_input_rejected_region_preserved_with_synthesized_closer() {
    let env = MutationSession::tracked("Carol");
    let file = env.write_lyx(
        "temp_dl103_f4_shared.lyx",
        r"\begin_layout Standard
\change_deleted 1 1700000000
A REJECTED
\change_inserted 2 1700000001
B INSERTED
\change_unchanged
\end_layout
",
        "\\author 1 \"Alice\"\n\\author 2 \"Bob\"\n\\author 3 \"Carol\"\n",
    );
    env.run(&["set", path_arg(&file), "layout[Standard]", "CAROL REWRITE"]);
    let text = fs::read_to_string(&file).unwrap();
    assert!(
        text.contains("\\change_deleted 1"),
        "Alice's rejected region preserved"
    );
    assert!(text.contains("A REJECTED"), "rejected text intact");
    assert!(
        text.contains("\\change_deleted 3"),
        "Bob's pending insert re-marked under Carol"
    );
    assert!(
        text.contains("B INSERTED"),
        "Bob's insert text still present, now Carol's deletion"
    );
    assert!(text.contains("CAROL REWRITE"), "new value inserted");
    assert_roundtrip(&text);
}

#[test]
fn dl103_f4_clean_input_regression_wholesale_set_output_unchanged() {
    let env = MutationSession::tracked("Alice");
    let file = env.write_lyx(
        "temp_dl103_f4_clean.lyx",
        r"\begin_layout Standard
Original sentence here.
\end_layout
",
        "",
    );
    env.run(&["set", path_arg(&file), "layout[Standard]", "New sentence"]);
    let text = fs::read_to_string(&file).unwrap();
    let doc = parse_lyx(&text);
    let children = first_layout_children(&doc);
    let markers = change_markers(&doc, children);
    assert_eq!(
        markers.len(),
        3,
        "clean input emits deleted/inserted/unchanged (shared closer)"
    );
    assert!(
        prop_value(&doc, markers[0]).unwrap_or("").contains("1 "),
        "deleted under Alice"
    );
    assert!(
        prop_value(&doc, markers[1]).unwrap_or("").contains("1 "),
        "inserted under Alice"
    );
    assert_eq!(marker_keys(&doc, &markers)[2], "change_unchanged");
    assert_roundtrip(&text);
}

#[test]
fn dl103_f4_replace_all_on_tracked_nodes_follows_the_preservation_path_no_wipe() {
    let env = MutationSession::tracked("Bob");
    let file = env.write_lyx(
        "temp_dl103_f4_replaceall.lyx",
        r"\begin_layout Standard
\change_deleted 1 1700000000
ALICE REJECTED
\change_unchanged
 plain 
\begin_inset Foot
status open
\begin_layout Plain Layout
FN TEXT
\end_layout
\end_inset
\change_inserted 1 1700000001
ALICE PENDING
\change_unchanged
\end_layout
",
        "\\author 1 \"Alice\"\n\\author 2 \"Bob\"\n",
    );
    env.run(&[
        "set",
        path_arg(&file),
        "layout[Standard]",
        "BOB NEW",
        "--replace-all",
    ]);
    let text = fs::read_to_string(&file).unwrap();
    let doc = parse_lyx(&text);
    let children = first_layout_children(&doc);
    let markers = change_markers(&doc, children);
    assert!(
        prop_value(&doc, markers[2]).unwrap_or("").contains("1 "),
        "Alice's rejected region preserved despite --replace-all"
    );
    let alice_start = child_index(children, markers[2]) + 1;
    let alice_end = child_index(children, markers[3]);
    let alice_rejected = all_text(&doc, &children[alice_start..alice_end]);
    assert_eq!(
        alice_rejected.trim(),
        "ALICE REJECTED",
        "rejected text kept verbatim"
    );
    assert!(
        text.contains("begin_inset Foot"),
        "inset survives --replace-all when tracked changes exist (F4 path, no wipe)"
    );
    assert!(text.contains("FN TEXT"), "inset content intact");
    assert!(text.contains("BOB NEW"), "new value inserted");
    assert_roundtrip(&text);
}

#[test]
fn dl84_f1_find_matches_current_text_after_adjacent_delete_insert_pair() {
    let env = MutationSession::tracked("Alice");
    let file = env.write_lyx(
        "temp_dl84_f1_find.lyx",
        ADJACENT_PAIR_BODY,
        "\\author 1 \"Alice\"\n",
    );
    let result = env.run(&[
        "set",
        path_arg(&file),
        "layout[Standard]",
        "EDIT",
        "--find",
        "edit",
    ]);
    assert_eq!(
        result["modified_nodes"],
        json!(1),
        "--find on current (inserted) text must match"
    );
}

#[test]
fn dl84_f1_find_on_deleted_text_now_matches_see_all() {
    let env = MutationSession::tracked("Alice");
    let file = env.write_lyx(
        "temp_dl84_f1_deleted.lyx",
        ADJACENT_PAIR_BODY,
        "\\author 1 \"Alice\"\n",
    );
    let result = env.run(&[
        "set",
        path_arg(&file),
        "layout[Standard]",
        "X",
        "--find",
        "write",
    ]);
    assert_eq!(
        result["modified_nodes"],
        json!(1),
        "deleted text matches under see-all"
    );
    let text = fs::read_to_string(&file).unwrap();
    assert!(text.contains("X"), "replacement present");
    assert!(text.contains("write"), "deleted text preserved as deleted");
    assert!(text.contains("edit"), "adjacent inserted text untouched");
}

#[test]
fn dl84_f3_same_author_match_consuming_whole_region_merges_not_a_pair() {
    let env = MutationSession::tracked("Alice");
    let file = env.write_lyx(
        "temp_dl84_f3_whole.lyx",
        r"\begin_layout Standard
\change_inserted 1 1700000000
FIXED
\change_unchanged
\end_layout
",
        "\\author 1 \"Alice\"\n",
    );
    let result = env.run(&[
        "set",
        path_arg(&file),
        "layout[Standard]",
        "FIXEDX",
        "--find",
        "FIXED",
    ]);
    assert_eq!(result["modified_nodes"], json!(1));
    let doc = parse_lyx(&fs::read_to_string(&file).unwrap());
    let children = first_layout_children(&doc);
    let markers = change_markers(&doc, children);
    assert_eq!(
        marker_keys(&doc, &markers),
        ["change_inserted", "change_unchanged"],
        "full-consumption same-author match must merge, not emit a delete+insert pair"
    );
    let value = prop_value(&doc, markers[0]).unwrap_or("");
    let (aid, ts) = value.split_once(' ').unwrap();
    assert_eq!(aid, "1");
    assert!(
        ts.parse::<i64>().unwrap() > 1_700_000_000,
        "timestamp must update to max(old, new)"
    );
    assert_eq!(all_text(&doc, children), "FIXEDX");
}

#[test]
fn dl84_f3_different_author_full_consumption_emits_insert_then_delete_dev_log_90() {
    let env = MutationSession::tracked("Bob");
    let file = env.write_lyx(
        "temp_dl84_f3_whole_diff.lyx",
        r"\begin_layout Standard
\change_inserted 1 1700000000
FIXED
\change_unchanged
\end_layout
",
        "\\author 1 \"Alice\"\n",
    );
    env.run(&[
        "set",
        path_arg(&file),
        "layout[Standard]",
        "FIXEDX",
        "--find",
        "FIXED",
    ]);
    let doc = parse_lyx(&fs::read_to_string(&file).unwrap());
    let children = first_layout_children(&doc);
    let markers = change_markers(&doc, children);
    assert_eq!(
        marker_keys(&doc, &markers),
        ["change_inserted", "change_deleted", "change_unchanged"],
        "insert-first (dev log 90) byte-exact (D-15A): replacement at match start, old text deleted — shared closer"
    );
}

#[test]
fn dl85_f1_same_author_find_on_adjacent_inserted_deleted_shape_preserves_replacement_deleted_region()
 {
    let env = MutationSession::tracked("Alice");
    let file = env.write_lyx(
        "temp_dl85_f1_adjacent.lyx",
        ADJACENT_INSERT_DELETE_BODY,
        "\\author 1 \"Alice\"\n",
    );
    let result = env.run(&[
        "set",
        path_arg(&file),
        "layout[Standard]",
        "newValue",
        "--find",
        "X",
    ]);
    assert_eq!(result["modified_nodes"], json!(1));
    let doc = parse_lyx(&fs::read_to_string(&file).unwrap());
    let children = first_layout_children(&doc);
    assert_eq!(
        marker_keys(&doc, &change_markers(&doc, children)),
        ["change_inserted", "change_deleted", "change_unchanged"],
        "byte-exact (D-15A): inserted region stays open into the pre-existing deleted region (shared closer); flatten passes it through, no drop"
    );
    let text = all_text(&doc, children);
    assert!(text.contains("newValue"), "replacement text must survive");
    assert!(
        text.contains("Z"),
        "pre-existing deleted region must survive"
    );
    assert!(text.contains(" tail"), "trailing text must stay plain");
}

#[test]
fn dl85_f1_adjacent_shape_without_trailing_text_paragraph_not_wiped() {
    let env = MutationSession::tracked("Alice");
    let file = env.write_lyx(
        "temp_dl85_f1_notail.lyx",
        r"\begin_layout Standard
\change_inserted 1 1700000000
X
\change_deleted 1 1700000001
Z
\change_unchanged
\end_layout
",
        "\\author 1 \"Alice\"\n",
    );
    let result = env.run(&[
        "set",
        path_arg(&file),
        "layout[Standard]",
        "newValue",
        "--find",
        "X",
    ]);
    assert_eq!(result["modified_nodes"], json!(1));
    let doc = parse_lyx(&fs::read_to_string(&file).unwrap());
    let children = first_layout_children(&doc);
    let text = all_text(&doc, children);
    assert!(text.contains("newValue"), "replacement must survive");
    assert!(text.contains("Z"), "deleted region must survive");
    assert_eq!(max_marker_depth(&doc, children), 1, "no nested markers");
}

#[test]
fn dl85_f1_adjacent_shape_with_other_author_deleted_region_preserved() {
    let env = MutationSession::tracked("Alice");
    let file = env.write_lyx(
        "temp_dl85_f1_other.lyx",
        r"\begin_layout Standard
\change_inserted 1 1700000000
X
\change_deleted 2 1700000001
Z
\change_unchanged
 tail
\end_layout
",
        "\\author 1 \"Alice\"\n\\author 2 \"Bob\"\n",
    );
    env.run(&[
        "set",
        path_arg(&file),
        "layout[Standard]",
        "newValue",
        "--find",
        "X",
    ]);
    let doc = parse_lyx(&fs::read_to_string(&file).unwrap());
    let children = first_layout_children(&doc);
    let text = all_text(&doc, children);
    assert!(text.contains("newValue"));
    assert!(
        text.contains("Z"),
        "other-author deleted region must survive"
    );
    assert_eq!(max_marker_depth(&doc, children), 1, "no nested markers");
}

#[test]
fn dl85_f1_find_on_trailing_text_preserves_the_interleaved_deleted_region_no_pending_match_at_boundary()
 {
    let env = MutationSession::tracked("Alice");
    let file = env.write_lyx(
        "temp_dl85_f1_tailfind.lyx",
        ADJACENT_INSERT_DELETE_BODY,
        "\\author 1 \"Alice\"\n",
    );
    let result = env.run(&[
        "set",
        path_arg(&file),
        "layout[Standard]",
        "newTail",
        "--find",
        "tail",
    ]);
    assert_eq!(result["modified_nodes"], json!(1));
    let doc = parse_lyx(&fs::read_to_string(&file).unwrap());
    let children = first_layout_children(&doc);
    let text = all_text(&doc, children);
    assert!(text.contains("X"), "inserted region must survive");
    assert!(text.contains("Z"), "deleted region must survive");
    assert!(text.contains("newTail"));
    assert_eq!(max_marker_depth(&doc, children), 1, "no nested markers");
}

#[test]
fn dl85_f3_set_find_preserves_empty_text_nodes_blank_lines_in_an_ert_inset() {
    let env = MutationSession::new();
    let file = env.write_lyx(
        "temp_dl85_f3_ert.lyx",
        r"\begin_layout Standard
\begin_inset ERT
status open

\backslash newcommand{foo}

\end_inset
\end_layout
",
        "",
    );
    env.run(&[
        "set",
        path_arg(&file),
        "inset[ERT]",
        "NEW",
        "--find",
        "newcommand",
    ]);
    let doc = parse_lyx(&fs::read_to_string(&file).unwrap());
    let inset = find_first_inset(&doc);
    let kids = &doc.node(inset).children;
    let empty = kids
        .iter()
        .filter(|&&id| matches!(&doc.node(id).kind, NodeKind::Text { text } if text.is_empty()))
        .count();
    assert_eq!(
        empty, 2,
        "blank spacer lines must survive the --find mutation (test_report_36 F3)"
    );
    let joined = all_text(&doc, kids);
    let pipe: String = kids
        .iter()
        .filter_map(|&id| match &doc.node(id).kind {
            NodeKind::Text { text } => Some(text.as_str()),
            _ => None,
        })
        .collect::<Vec<_>>()
        .join("|");
    assert!(pipe.contains("NEW{foo}"), "got {joined}");
}

#[test]
fn dl85_f3_set_find_preserves_an_internal_blank_line_in_a_paragraph_tracked() {
    let env = MutationSession::tracked("Alice");
    let file = env.write_lyx(
        "temp_dl85_f3_blank.lyx",
        r"\begin_layout Standard
Alpha

Beta
\end_layout
",
        "",
    );
    env.run(&[
        "set",
        path_arg(&file),
        "layout[Standard]",
        "X",
        "--find",
        "Alpha",
    ]);
    let doc = parse_lyx(&fs::read_to_string(&file).unwrap());
    let children = first_layout_children(&doc);
    let empty = children
        .iter()
        .filter(|&&id| matches!(&doc.node(id).kind, NodeKind::Text { text } if text.is_empty()))
        .count();
    assert_eq!(
        empty, 1,
        "internal blank line must survive tracked --find (test_report_36 F3)"
    );
}

#[test]
fn dl90_f3_find_spanning_a_deleted_region_erases_one_contiguous_range_spec_2() {
    let env = MutationSession::tracked("Alice");
    let file = env.write_lyx(
        "temp_dl90_f3.lyx",
        r"\begin_layout Standard
A
\change_deleted 1 1700000000
B
\change_unchanged
C
\end_layout
",
        "\\author 1 \"Alice\"\n",
    );
    let result = env.run(&[
        "set",
        path_arg(&file),
        "layout[Standard]",
        "X",
        "--find",
        "ABC",
    ]);
    assert_eq!(
        result["modified_nodes"],
        json!(1),
        "spanning match succeeds"
    );
    let doc = parse_lyx(&fs::read_to_string(&file).unwrap());
    let children = first_layout_children(&doc);
    let markers = change_markers(&doc, children);
    assert_eq!(
        marker_keys(&doc, &markers),
        ["change_inserted", "change_deleted", "change_unchanged"]
    );
    let text = all_text(&doc, children);
    assert!(text.contains("X"));
    assert!(
        text.contains("B"),
        "interposed deleted text absorbed into the erased range"
    );
    assert_eq!(max_marker_depth(&doc, children), 1, "flat, never nested");
}

#[test]
fn dl90_find_fully_inside_change_deleted_splits_the_region_flat_see_all() {
    let env = MutationSession::tracked("Alice");
    let file = env.write_lyx(
        "temp_dl90_insidedeleted.lyx",
        r"\begin_layout Standard
\change_deleted 1 1700000000
This is bad text
\change_unchanged
\end_layout
",
        "\\author 1 \"Alice\"\n",
    );
    let result = env.run(&[
        "set",
        path_arg(&file),
        "layout[Standard]",
        "terrible",
        "--find",
        "bad",
    ]);
    assert_eq!(
        result["modified_nodes"],
        json!(1),
        "rejected text is a valid edit target under see-all"
    );
    let doc = parse_lyx(&fs::read_to_string(&file).unwrap());
    let children = first_layout_children(&doc);
    let text = all_text(&doc, children);
    assert!(
        text.contains("This is "),
        "pre-match rejected text survives"
    );
    assert!(text.contains("terrible"), "replacement inserted adjacent");
    assert!(
        text.contains("bad text"),
        "matched rejected text preserved as deleted"
    );
    assert_eq!(max_marker_depth(&doc, children), 1, "flat, never nested");
}

#[test]
fn dl123_f2_replace_all_on_an_empty_paragraph_emits_no_contentless_change_deleted_opener() {
    let env = MutationSession::tracked("Bob");
    let file = env.write_lyx(
        "temp_dl123_f2.lyx",
        r"\begin_layout Standard
\end_layout
",
        "",
    );
    let result = env.run(&[
        "set",
        path_arg(&file),
        "layout[Standard]",
        "content",
        "--replace-all",
    ]);
    assert_eq!(result["modified_nodes"], json!(1));
    let doc = parse_lyx(&fs::read_to_string(&file).unwrap());
    let children = first_layout_children(&doc);
    let markers = change_markers(&doc, children);
    assert_eq!(
        marker_keys(&doc, &markers),
        ["change_inserted", "change_unchanged"],
        "ci(Bob){{content}} cu — no empty cd"
    );
    assert_eq!(all_text(&doc, children), "content");
    assert_eq!(max_marker_depth(&doc, children), 1, "flat");

    let file_b = env.write_lyx(
        "temp_dl123_f2b.lyx",
        r"\begin_layout Standard

\end_layout
",
        "",
    );
    env.run(&[
        "set",
        path_arg(&file_b),
        "layout[Standard]",
        "content",
        "--replace-all",
    ]);
    let doc_b = parse_lyx(&fs::read_to_string(&file_b).unwrap());
    let children_b = first_layout_children(&doc_b);
    assert_eq!(
        marker_keys(&doc_b, &change_markers(&doc_b, children_b)),
        ["change_inserted", "change_unchanged"],
        "blank-line empty paragraph: ci(Bob){{content}} cu — no empty cd"
    );
}

#[test]
fn dl125_p1b_set_on_a_property_stays_an_untracked_physical_edit_d5() {
    let env = MutationSession::tracked("Bob");
    let file = env.write_lyx(
        "temp_dl125_p1b.lyx",
        r"\begin_layout Standard
\emph on
emphasized
\emph default
plain
\end_layout
",
        "\\author 1 \"Alice\"\n",
    );
    let result = env.run(&["set", path_arg(&file), "property[emph]:nth-match(2)", "on"]);
    assert!(
        result.get("code").is_none(),
        "set on a property is not refused"
    );
    let doc = parse_lyx(&fs::read_to_string(&file).unwrap());
    let children = first_layout_children(&doc);
    let emphs: Vec<_> = children
        .iter()
        .copied()
        .filter(|&id| matches!(&doc.node(id).kind, NodeKind::Property { key, .. } if key == "emph"))
        .collect();
    assert_eq!(emphs.len(), 2, "both emph markers present");
    assert_eq!(
        prop_value(&doc, emphs[1]),
        Some("on"),
        "second marker value edited physically"
    );
    assert_eq!(
        change_markers(&doc, children).len(),
        0,
        "no tracked markers emitted (untracked physical edit)"
    );
}

#[test]
fn dl90_change_deleted_scoped_find_touches_only_the_rejected_region() {
    let env = MutationSession::tracked("Alice");
    let file = env.write_lyx(
        "temp_dl90_scope_del.lyx",
        r"\begin_layout Standard
and
\change_deleted 1 1700000000
and
\change_unchanged
\end_layout
",
        "\\author 1 \"Alice\"\n",
    );
    let result = env.run(&[
        "set",
        path_arg(&file),
        "layout[Standard]:change(deleted)",
        "X",
        "--find",
        "and",
    ]);
    assert_eq!(
        result["modified_nodes"],
        json!(1),
        "scoped find matches the rejected phrase"
    );
    let doc = parse_lyx(&fs::read_to_string(&file).unwrap());
    let children = first_layout_children(&doc);
    let text = all_text(&doc, children);
    assert!(text.contains("X"), "rejected 'and' replaced");
    assert!(
        text.split("\\change_").next().unwrap().contains("and"),
        "current-text 'and' untouched"
    );
    assert_eq!(
        count_substr(&text, "and"),
        2,
        "current + rejected 'and' both survive"
    );
}

#[test]
fn dl90_change_current_scoped_find_touches_only_current_text() {
    let env = MutationSession::tracked("Alice");
    let file = env.write_lyx(
        "temp_dl90_scope_cur.lyx",
        r"\begin_layout Standard
and
\change_deleted 1 1700000000
and
\change_unchanged
\end_layout
",
        "\\author 1 \"Alice\"\n",
    );
    let result = env.run(&[
        "set",
        path_arg(&file),
        "layout[Standard]:change(current)",
        "X",
        "--find",
        "and",
    ]);
    assert_eq!(
        result["modified_nodes"],
        json!(1),
        "scoped find matches the current phrase"
    );
    let doc = parse_lyx(&fs::read_to_string(&file).unwrap());
    let text = all_text(&doc, first_layout_children(&doc));
    assert!(text.contains("X"), "current 'and' replaced");
    assert!(text.contains("and"), "rejected 'and' preserved");
}

#[test]
fn dl90_change_inserted_scoped_find_touches_only_the_pending_insertion() {
    let env = MutationSession::tracked("Alice");
    let file = env.write_lyx(
        "temp_dl90_scope_ins.lyx",
        r"\begin_layout Standard
and
\change_inserted 1 1700000000
and
\change_unchanged
\change_deleted 1 1700000001
and
\change_unchanged
\end_layout
",
        "\\author 1 \"Alice\"\n",
    );
    let result = env.run(&[
        "set",
        path_arg(&file),
        "layout[Standard]:change(inserted)",
        "X",
        "--find",
        "and",
    ]);
    assert_eq!(
        result["modified_nodes"],
        json!(1),
        "scoped find matches only the inserted phrase"
    );
    let doc = parse_lyx(&fs::read_to_string(&file).unwrap());
    let children = first_layout_children(&doc);
    let text = all_text(&doc, children);
    assert!(text.contains("X"), "inserted 'and' replaced");
    assert!(
        text.split("\\change_").next().unwrap().contains("and"),
        "current-text 'and' untouched"
    );
    assert_eq!(
        count_substr(&text, "and"),
        2,
        "current + rejected 'and' both survive"
    );
    assert_eq!(
        marker_keys(&doc, &change_markers(&doc, children)),
        ["change_inserted", "change_deleted", "change_unchanged"],
        "replacement stays inside one flat inserted region (same-author merge); shared closer with the rejected region (D-15A)"
    );
    assert_eq!(max_marker_depth(&doc, children), 1, "flat, never nested");
}

#[test]
fn dl90_text_change_deleted_set_find_is_tracked_not_swallowed() {
    let env = MutationSession::tracked("Alice");
    let file = env.write_lyx(
        "temp_dl90_baretext.lyx",
        r"\begin_layout Standard
\change_deleted 1 1700000000
rejected old text
\change_unchanged
 current text
\end_layout
",
        "\\author 1 \"Alice\"\n",
    );
    let result = env.run(&[
        "set",
        path_arg(&file),
        "text:change(deleted)",
        "X",
        "--find",
        "old",
    ]);
    assert_eq!(
        result["modified_nodes"],
        json!(1),
        "bare text node inside a deletion is editable"
    );
    let text = fs::read_to_string(&file).unwrap();
    assert!(
        text.contains("\\change_inserted"),
        "replacement is a tracked insert, not embedded in the deletion"
    );
    assert!(text.contains("X"), "replacement present");
    assert!(text.contains(" current text"), "current text untouched");
    let doc = parse_lyx(&text);
    assert_eq!(
        max_marker_depth(&doc, first_layout_children(&doc)),
        1,
        "flat, never nested"
    );
}

#[test]
fn user_report_scoped_bare_text_find_preserves_region_boundaries() {
    let env = MutationSession::tracked("Alice");
    let file = env.write_lyx(
        "temp_user_report_region_scope.lyx",
        r"\begin_layout Standard
current before
\change_inserted 1 1700000000
Inserted region with mainly through internal sources.
\change_unchanged
current after
\end_layout
",
        "\\author 1 \"Alice\"\n",
    );
    let result = env.run(&[
        "set",
        path_arg(&file),
        "layout[Standard]:contains('mainly through internal sources.'):first text:change(inserted)",
        "Fourth",
        "--find",
        "mainly through internal sources.",
    ]);
    assert_eq!(result["modified_nodes"], json!(1));
    let doc = parse_lyx(&fs::read_to_string(&file).unwrap());
    let children = first_layout_children(&doc);
    let inserted_start = children.iter().position(|&id| {
        matches!(&doc.node(id).kind, NodeKind::Property { key, .. } if key == "change_inserted")
    });
    let inserted_end = children.iter().position(|&id| {
        matches!(&doc.node(id).kind, NodeKind::Property { key, .. } if key == "change_unchanged")
    });
    let before_index = children.iter().position(|&id| {
        matches!(&doc.node(id).kind, NodeKind::Text { text } if text.contains("current before"))
    });
    let after_index = children.iter().position(|&id| {
        matches!(&doc.node(id).kind, NodeKind::Text { text } if text.contains("current after"))
    });
    assert!(inserted_start.is_some() && inserted_end.unwrap() > inserted_start.unwrap());
    assert!(
        before_index.unwrap() < inserted_start.unwrap(),
        "current text before the region must stay current"
    );
    assert!(
        after_index.unwrap() > inserted_end.unwrap(),
        "current text after the region must stay current"
    );
    let inserted_text = all_text(
        &doc,
        &children[inserted_start.unwrap() + 1..inserted_end.unwrap()],
    );
    assert!(inserted_text.contains("Fourth"));
}

#[test]
fn report_42_f1_direct_current_text_find_preserves_tracking_and_warning_breakdown() {
    let env = MutationSession::tracked("Alice");
    let file = env.write_lyx(
        "temp_report42_f1_direct_current.lyx",
        r"\begin_layout Standard
current phrase
\end_layout
",
        "\\author 1 \"Alice\"\n",
    );
    let result = env.run(&[
        "set",
        path_arg(&file),
        "text:change(current)",
        "TAIL",
        "--find",
        "current phrase",
    ]);
    assert_eq!(result["modified_nodes"], json!(1));
    let text = fs::read_to_string(&file).unwrap();
    assert!(text.contains("\\change_deleted"));
    assert!(text.contains("current phrase"));
    assert!(text.contains("\\change_inserted"));
    assert!(text.contains("TAIL"));
    assert!(
        json_warnings(&result)
            .iter()
            .any(|w| w.contains("text (1 occurrence)")),
        "expected a text occurrence breakdown, got: {:?}",
        json_warnings(&result)
    );
}

#[test]
fn report_42_f1_direct_styled_text_and_full_set_remain_reviewable() {
    let env = MutationSession::tracked("Alice");
    let file = env.write_lyx(
        "temp_report42_f1_direct_styled.lyx",
        r"\begin_layout Standard
\emph on
emphasized phrase
\emph default
\end_layout
",
        "\\author 1 \"Alice\"\n",
    );
    let surgical = env.run(&[
        "set",
        path_arg(&file),
        "text:property(emph)",
        "TAIL",
        "--find",
        "phrase",
    ]);
    assert_eq!(surgical["modified_nodes"], json!(1));
    let text = fs::read_to_string(&file).unwrap();
    assert!(text.find("\\emph on").unwrap() < text.find("\\change_deleted").unwrap());
    assert!(text.find("\\change_inserted").unwrap() < text.find("\\emph default").unwrap());
    assert!(text.contains("phrase"));
    assert!(text.contains("TAIL"));
}

#[test]
fn report_42_f1_direct_current_text_full_set_remains_reviewable() {
    let env = MutationSession::tracked("Alice");
    let file = env.write_lyx(
        "temp_report42_f1_direct_full.lyx",
        r"\begin_layout Standard
\emph on
emphasized phrase
\emph default
\end_layout
",
        "\\author 1 \"Alice\"\n",
    );
    let result = env.run(&["set", path_arg(&file), "text:property(emph)", "REPLACED"]);
    assert_eq!(result["modified_nodes"], json!(1), "{result}");
    let text = fs::read_to_string(&file).unwrap();
    assert!(text.contains("\\change_deleted"));
    assert!(text.contains("\\change_inserted"));
    assert!(text.contains("REPLACED"));
}

#[test]
fn dl91_find_spanning_an_inset_no_match_names_the_blocker() {
    let env = MutationSession::tracked("Alice");
    let file = env.write_lyx(
        "temp_dl91_inset.lyx",
        r"\begin_layout Standard
A
\begin_inset Foot
\begin_layout Plain Layout
foot
\end_layout
\end_inset
B
\end_layout
",
        "\\author 1 \"Alice\"\n",
    );
    let result = env.run(&[
        "set",
        path_arg(&file),
        "layout[Standard]",
        "X",
        "--find",
        "AB",
    ]);
    assert_eq!(
        code(&result),
        "NO_MATCH",
        "phrase spanning an inset cannot match"
    );
    assert!(
        message(&result).contains("spans an inset"),
        "NO_MATCH names the inset blocker"
    );
    assert!(
        message(&result).contains("split the phrase"),
        "NO_MATCH suggests the escape hatch"
    );
    let text = fs::read_to_string(&file).unwrap();
    assert!(text.contains("A\n"), "pre-match text intact");
    assert!(text.contains("B\n"), "post-match text intact");
}

#[test]
fn dl92_b_union_scope_change_current_change_deleted_spans_both_regions_order_independent() {
    let body = r"\begin_layout Standard
\change_deleted 1 1700000000
and
\change_unchanged
\change_inserted 1 1700000001
zzz
\change_unchanged
and
\end_layout
";
    let selectors = [
        "layout[Standard]:change(current), layout[Standard]:change(deleted)",
        "layout[Standard]:change(deleted), layout[Standard]:change(current)",
    ];
    for sel in selectors {
        let env = MutationSession::tracked("Alice");
        let file = env.write_lyx("temp_dl92b_union.lyx", body, "\\author 1 \"Alice\"\n");
        let result = env.run(&["set", path_arg(&file), sel, "X", "--find", "and"]);
        assert_eq!(result["modified_nodes"], json!(1), "{sel}: layout replaced");
        let doc = parse_lyx(&fs::read_to_string(&file).unwrap());
        let text = all_text(&doc, first_layout_children(&doc));
        assert_eq!(
            count_substr(&text, "X"),
            2,
            "{sel}: both current + rejected 'and' replaced"
        );
        assert_eq!(
            count_substr(&text, "and"),
            2,
            "{sel}: both erased 'and's preserved as rejected text"
        );
        assert!(
            text.contains("zzz"),
            "inserted text untouched by the union scope"
        );
    }
}

#[test]
fn dl92_b_union_scope_excludes_the_omitted_region_inserted_from_find() {
    let env = MutationSession::tracked("Alice");
    let file = env.write_lyx(
        "temp_dl92b_excl.lyx",
        r"\begin_layout Standard
and
\change_deleted 1 1700000000
and
\change_unchanged
\change_inserted 1 1700000001
zzz
\change_unchanged
\end_layout
",
        "\\author 1 \"Alice\"\n",
    );
    let result = env.run(&[
        "set",
        path_arg(&file),
        "layout[Standard]:change(current), layout[Standard]:change(deleted)",
        "X",
        "--find",
        "zzz",
    ]);
    assert_eq!(
        code(&result),
        "NO_MATCH",
        "inserted text is outside the union scope"
    );
    assert!(
        fs::read_to_string(&file).unwrap().contains("zzz"),
        "file untouched"
    );
}

#[test]
fn dl92_b_an_unscoped_or_arm_widens_the_scope_to_see_all_e4() {
    let env = MutationSession::tracked("Alice");
    let file = env.write_lyx(
        "temp_dl92b_e4.lyx",
        r"\begin_layout Standard
\change_deleted 1 1700000000
and
\change_unchanged
\change_inserted 1 1700000001
zzz
\change_unchanged
and
\end_layout
",
        "\\author 1 \"Alice\"\n",
    );
    let result = env.run(&[
        "set",
        path_arg(&file),
        "layout[Standard]:change(deleted), layout[Standard]",
        "X",
        "--find",
        "and",
    ]);
    assert_eq!(
        result["modified_nodes"],
        json!(1),
        "see-all scope still replaces the layout"
    );
    let doc = parse_lyx(&fs::read_to_string(&file).unwrap());
    let text = all_text(&doc, first_layout_children(&doc));
    assert_eq!(
        count_substr(&text, "X"),
        2,
        "both current + rejected 'and' replaced (see-all)"
    );
}

#[test]
fn dl92_b_property_scope_restricts_find_to_the_styled_text() {
    let env = MutationSession::with_config(json!({
        "trackChanges": false,
        "authorName": "me",
    }));
    let file = env.write_lyx(
        "temp_dl92b_prop.lyx",
        r"\begin_layout Standard
plain foo
\emph on
emph foo
\emph default
plain foo
\end_layout
",
        "",
    );
    let result = env.run(&[
        "set",
        path_arg(&file),
        "layout[Standard]:property(emph)",
        "X",
        "--find",
        "foo",
    ]);
    assert_eq!(
        result["modified_nodes"],
        json!(1),
        "property-scoped find replaces in the layout"
    );
    let text = fs::read_to_string(&file).unwrap();
    assert!(text.contains("emph X"), "only the emphasized foo replaced");
    assert_eq!(
        count_substr(&text, "plain foo"),
        2,
        "both plain foo occurrences untouched"
    );
}

#[test]
fn dl92_b_chained_property_emph_change_deleted_requires_both_axes_e9() {
    let env = MutationSession::tracked("Alice");
    let file = env.write_lyx(
        "temp_dl92b_chain.lyx",
        r"\begin_layout Standard
\emph on
\change_deleted 1 1700000000
and
\change_unchanged
\emph default
\change_deleted 1 1700000000
and
\change_unchanged
\end_layout
",
        "\\author 1 \"Alice\"\n",
    );
    let result = env.run(&[
        "set",
        path_arg(&file),
        "layout[Standard]:property(emph):change(deleted)",
        "X",
        "--find",
        "and",
    ]);
    assert_eq!(
        result["modified_nodes"],
        json!(1),
        "conjunction scope replaces in the layout"
    );
    let doc = parse_lyx(&fs::read_to_string(&file).unwrap());
    let text = all_text(&doc, first_layout_children(&doc));
    assert_eq!(
        count_substr(&text, "X"),
        1,
        "only the emph+deleted 'and' replaced"
    );
    assert_eq!(
        count_substr(&text, "and"),
        2,
        "both deleted 'and's preserved as rejected text"
    );
}

#[test]
fn dl92_b_the_rejected_text_warning_is_suppressed_under_any_explicit_scope_e7() {
    let env = MutationSession::tracked("Alice");
    let file = env.write_lyx(
        "temp_dl92b_warn.lyx",
        r"\begin_layout Standard
\change_deleted 1 1700000000
and
\change_unchanged
\end_layout
",
        "\\author 1 \"Alice\"\n",
    );
    let result = env.run(&[
        "set",
        path_arg(&file),
        "layout[Standard]:change(deleted)",
        "X",
        "--find",
        "and",
    ]);
    assert!(
        !json_warnings(&result)
            .iter()
            .any(|w| w.contains("matched inside \\change_deleted")),
        "no rejected-text warning under an explicit scope"
    );
}

#[test]
fn dl124_a1_email_bearing_author_line_is_recognized_and_reused() {
    let env = MutationSession::tracked("lq user");
    let file = env.write_lyx(
        "temp_dl124_a1_email.lyx",
        r"\begin_layout Standard
Hello
\end_layout
",
        "\\author 236438948 \"lq user\" lquser@example.com\n",
    );
    let result = env.run(&["set", path_arg(&file), "layout[Standard]", "Goodbye"]);
    assert_eq!(result["modified_nodes"], json!(1));
    let text = fs::read_to_string(&file).unwrap();
    let authors = author_lines(&text);
    assert_eq!(authors.len(), 1, "no duplicate \\author entry may be added");
    assert_eq!(
        authors[0],
        "\\author 236438948 \"lq user\" lquser@example.com"
    );
    assert!(
        text.contains("\\change_deleted 236438948"),
        "markers reuse the existing author ID"
    );
    assert!(
        text.contains("\\change_inserted 236438948"),
        "markers reuse the existing author ID"
    );
    assert!(
        !text.contains("\\author 1"),
        "no fresh sequential author may be injected"
    );
}

#[test]
fn dl124_a2_negative_hash_author_line_is_recognized_and_reused() {
    let env = MutationSession::tracked("Hans Wurst");
    let file = env.write_lyx(
        "temp_dl124_a2_negid.lyx",
        r"\begin_layout Standard
Hello
\end_layout
",
        "\\author -443692588 \"Hans Wurst\"\n",
    );
    let result = env.run(&["set", path_arg(&file), "layout[Standard]", "Bye"]);
    assert_eq!(result["modified_nodes"], json!(1));
    let text = fs::read_to_string(&file).unwrap();
    let authors = author_lines(&text);
    assert_eq!(authors.len(), 1, "no duplicate \\author entry may be added");
    assert_eq!(authors[0], "\\author -443692588 \"Hans Wurst\"");
    assert!(
        text.contains("\\change_deleted -443692588"),
        "markers reuse the negative existing ID"
    );
    assert!(
        text.contains("\\change_inserted -443692588"),
        "markers reuse the negative existing ID"
    );
}

#[test]
fn dl124_a3_mixed_header_new_author_gets_maxid_plus_1_over_parsed_positives() {
    let env = MutationSession::tracked("Bob");
    let file = env.write_lyx(
        "temp_dl124_a3_mixed.lyx",
        r"\begin_layout Standard
Hello
\end_layout
",
        "\\author 236438948 \"me\" me@example.com\n\\author 5 \"Alice\"\n",
    );
    let result = env.run(&["set", path_arg(&file), "layout[Standard]", "X"]);
    assert_eq!(result["modified_nodes"], json!(1));
    let text = fs::read_to_string(&file).unwrap();
    let authors = author_lines(&text);
    assert_eq!(authors.len(), 3);
    assert!(
        text.contains("\\author 236438949 \"Bob\""),
        "new ID = max parsed positive + 1"
    );
    assert!(text.contains("\\change_deleted 236438949"));
    assert!(text.contains("\\change_inserted 236438949"));
}

#[test]
fn dl124_a4_email_only_header_new_author_still_sequential_past_email_id() {
    let env = MutationSession::tracked("Bob");
    let file = env.write_lyx(
        "temp_dl124_a4_seq.lyx",
        r"\begin_layout Standard
Hello
\end_layout
",
        "\\author 236438948 \"me\" me@example.com\n",
    );
    let result = env.run(&["set", path_arg(&file), "layout[Standard]", "X"]);
    assert_eq!(result["modified_nodes"], json!(1));
    let text = fs::read_to_string(&file).unwrap();
    let authors = author_lines(&text);
    assert_eq!(authors.len(), 2);
    assert!(
        text.contains("\\author 236438949 \"Bob\""),
        "new ID = email line's positive ID + 1 (no collision)"
    );
    assert!(text.contains("\\change_deleted 236438949"));
    assert!(text.contains("\\change_inserted 236438949"));
}

#[test]
fn dl124_a5_negative_id_email_line_recognized_but_not_counted_for_maxid() {
    let env = MutationSession::tracked("Bob");
    let file = env.write_lyx(
        "temp_dl124_a5_negemail.lyx",
        r"\begin_layout Standard
Hello
\end_layout
",
        "\\author -443692588 \"me\" me@example.com\n",
    );
    let result = env.run(&["set", path_arg(&file), "layout[Standard]", "X"]);
    assert_eq!(result["modified_nodes"], json!(1));
    let text = fs::read_to_string(&file).unwrap();
    let authors = author_lines(&text);
    assert_eq!(authors.len(), 2);
    assert!(
        text.contains("\\author 1 \"Bob\""),
        "negative IDs never count for maxId; new ID starts at 1"
    );
    assert!(text.contains("\\change_deleted 1"));
    assert!(text.contains("\\change_inserted 1"));
}
