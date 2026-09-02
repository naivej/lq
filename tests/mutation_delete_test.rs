//! `lq delete` CLI process tests (Deno `tests/mutation_test.ts` delete-primary cases).
//!
//! Skipped (undo file): DL78 Snapshot Undo After Untracked Delete;
//! DL84 F2 tracked delete then snapshot undo.
//! Library walkers already in `tracked_changes_test.rs` are not re-ported here;
//! the CLI cases for the same DL123/125/126 names are.

mod common;

use common::{MutationSession, path_arg};
use lq::{Document, NodeId, NodeKind, advance_change_depths, parse};
use serde_json::{Value, json};
use std::fs;
use std::path::Path;

fn code(v: &Value) -> &str {
    v["code"].as_str().unwrap_or("")
}

fn message(v: &Value) -> &str {
    v["message"].as_str().unwrap_or("")
}

fn no_success_count(v: &Value) {
    assert!(
        v.get("tracked_deleted_nodes").is_none_or(Value::is_null),
        "no false success count: {v}"
    );
}

fn read(path: &Path) -> String {
    fs::read_to_string(path).unwrap()
}

fn parse_file(path: &Path) -> Document {
    parse(&read(path), false).unwrap()
}

fn body_layouts(doc: &Document) -> Vec<NodeId> {
    let document = doc
        .node(doc.root())
        .children
        .iter()
        .copied()
        .find(|&id| matches!(&doc.node(id).kind, NodeKind::Block { tag, .. } if tag == "document"))
        .expect("document");
    let body = doc
        .node(document)
        .children
        .iter()
        .copied()
        .find(|&id| matches!(&doc.node(id).kind, NodeKind::Block { tag, .. } if tag == "body"))
        .expect("body");
    doc.node(body)
        .children
        .iter()
        .copied()
        .filter(|&id| matches!(&doc.node(id).kind, NodeKind::Block { tag, .. } if tag == "layout"))
        .collect()
}

fn layout_children(doc: &Document, n: usize) -> Vec<NodeId> {
    let layouts = body_layouts(doc);
    doc.node(layouts[n]).children.clone()
}

fn first_layout_children(doc: &Document) -> Vec<NodeId> {
    layout_children(doc, 0)
}

fn change_markers<'a>(
    doc: &'a Document,
    children: &[NodeId],
) -> Vec<(NodeId, &'a str, Option<&'a str>)> {
    children
        .iter()
        .copied()
        .filter_map(|id| match &doc.node(id).kind {
            NodeKind::Property { key, value } if key.starts_with("change_") => {
                Some((id, key.as_str(), value.as_deref()))
            }
            _ => None,
        })
        .collect()
}

fn marker_keys<'a>(doc: &'a Document, children: &[NodeId]) -> Vec<&'a str> {
    change_markers(doc, children)
        .into_iter()
        .map(|(_, key, _)| key)
        .collect()
}

fn marker_author(value: Option<&str>) -> &str {
    value.unwrap_or("").split(' ').next().unwrap_or("")
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
    for (_, key, _) in change_markers(doc, children) {
        let d = advance_change_depths(key, deleted_depth, inserted_depth);
        deleted_depth = d.0;
        inserted_depth = d.1;
        max = max.max(deleted_depth + inserted_depth);
    }
    max
}

fn render_sequence(doc: &Document, children: &[NodeId]) -> Vec<String> {
    children
        .iter()
        .map(|&id| match &doc.node(id).kind {
            NodeKind::Property { key, value } if key == "change_deleted" => {
                format!("cd:{}", marker_author(value.as_deref()))
            }
            NodeKind::Property { key, .. } if key == "change_unchanged" => "cu".into(),
            NodeKind::Property { key, value } => {
                format!("{key}={}", value.as_deref().unwrap_or(""))
            }
            NodeKind::Text { text } => text.clone(),
            NodeKind::Block { tag, .. } => tag.clone(),
            NodeKind::Document => "document".into(),
        })
        .collect()
}

fn crlf(s: &str) -> String {
    s.replace("\r\n", "\n")
}

const ALICE: &str = r#"\author 1 "Alice"
"#;

#[test]
fn dl123_f1a_tracked_delete_of_a_co_authors_pending_insert_drops_the_emptied_region() {
    let env = MutationSession::tracked("Bob");
    let file = env.write_lyx(
        "temp_dl123_f1a.lyx",
        r#"\begin_layout Standard
\change_inserted 1 1700000000
alpha
\change_unchanged
\end_layout
"#,
        ALICE,
    );
    let result = env.run(&[
        "delete",
        path_arg(&file),
        "layout[Standard] text:change(inserted)",
    ]);
    assert_eq!(result["tracked_deleted_nodes"], json!(1));
    let doc = parse_file(&file);
    let children = first_layout_children(&doc);
    assert_eq!(
        marker_keys(&doc, &children),
        ["change_deleted", "change_unchanged"],
        "cd(Bob){{alpha}} cu — no emptied ci opener, single closer"
    );
    let markers = change_markers(&doc, &children);
    assert_eq!(
        marker_author(markers[0].2),
        "2",
        "deletion attributed to Bob"
    );
    assert!(all_text(&doc, &children).contains("alpha"));
    assert_eq!(max_marker_depth(&doc, &children), 1, "flat");
}

#[test]
fn dl123_f1b_tracked_delete_of_part_of_a_co_authors_insert_reopens_the_region_around_the_surviving_content()
 {
    let env = MutationSession::tracked("Bob");
    let file = env.write_lyx(
        "temp_dl123_f1b.lyx",
        r#"\begin_layout Standard
\change_inserted 1 1700000000
alpha
 beta
\change_unchanged
\end_layout
"#,
        ALICE,
    );
    let result = env.run(&[
        "delete",
        path_arg(&file),
        "layout[Standard] text:change(inserted):nth-match(1)",
    ]);
    assert_eq!(result["tracked_deleted_nodes"], json!(1));
    let doc = parse_file(&file);
    let children = first_layout_children(&doc);
    assert_eq!(
        marker_keys(&doc, &children),
        ["change_deleted", "change_inserted", "change_unchanged"],
        "cd(Bob){{alpha}} ci(Alice){{ beta}} cu — the surviving ' beta' stays in Alice's region"
    );
    let markers = change_markers(&doc, &children);
    assert_eq!(
        marker_author(markers[0].2),
        "2",
        "deletion attributed to Bob"
    );
    assert_eq!(
        marker_author(markers[1].2),
        "1",
        "reopened region keeps Alice's author"
    );
    assert_eq!(all_text(&doc, &children), "alpha beta");
    assert_eq!(max_marker_depth(&doc, &children), 1, "flat");
}

#[test]
fn dl123_f1c_tracked_delete_of_the_deleters_own_pending_insert_consumes_it() {
    let env = MutationSession::tracked("Bob");
    let file = env.write_lyx(
        "temp_dl123_f1c.lyx",
        r#"\begin_layout Standard
\change_inserted 1 1700000000
alpha
\change_inserted 2 1700000001
beta
\change_unchanged
\end_layout
"#,
        r#"\author 1 "Alice"
\author 2 "Bob"
"#,
    );
    let result = env.run(&[
        "delete",
        path_arg(&file),
        "layout[Standard] text:change(inserted):nth-match(2)",
    ]);
    assert_eq!(result["tracked_deleted_nodes"], json!(1));
    let doc = parse_file(&file);
    let children = first_layout_children(&doc);
    assert_eq!(
        marker_keys(&doc, &children),
        ["change_inserted", "change_unchanged"],
        "only Alice's region survives; Bob's 'beta' consumed"
    );
    let markers = change_markers(&doc, &children);
    assert_eq!(
        marker_author(markers[0].2),
        "1",
        "survivor is Alice's region"
    );
    assert_eq!(
        all_text(&doc, &children),
        "alpha",
        "beta physically removed, no cd marker"
    );
    assert_eq!(max_marker_depth(&doc, &children), 1, "flat");
}

#[test]
fn dl123_f1d_tracked_delete_of_already_deleted_text_is_a_no_op() {
    let env = MutationSession::tracked("Bob");
    let file = env.write_lyx(
        "temp_dl123_f1d.lyx",
        r#"\begin_layout Standard
\change_deleted 1 1700000000
old
\change_unchanged
 new
\end_layout
"#,
        ALICE,
    );
    let result = env.run(&[
        "delete",
        path_arg(&file),
        "layout[Standard] text:change(deleted)",
    ]);
    assert_eq!(result["tracked_deleted_nodes"], json!(1));
    let doc = parse_file(&file);
    let children = first_layout_children(&doc);
    assert_eq!(
        marker_keys(&doc, &children),
        ["change_deleted", "change_unchanged"],
        "Alice's deletion untouched, no re-authoring"
    );
    let markers = change_markers(&doc, &children);
    assert_eq!(marker_author(markers[0].2), "1", "still Alice's author");
    assert_eq!(all_text(&doc, &children), "old new", "nothing removed");
    assert_eq!(max_marker_depth(&doc, &children), 1, "flat");
}

#[test]
fn dl123_f1e_tracked_delete_of_3_adjacent_inserts_merges_to_one_deleted_region() {
    let env = MutationSession::tracked("Bob");
    let file = env.write_lyx(
        "temp_dl123_f1e.lyx",
        r#"\begin_layout Standard
\change_inserted 1 1700000000
alpha
\change_inserted 2 1700000001
beta
\change_inserted 3 1700000002
gamma
\change_unchanged
\end_layout
"#,
        r#"\author 1 "Alice"
\author 2 "Bob"
\author 3 "Carol"
"#,
    );
    let result = env.run(&[
        "delete",
        path_arg(&file),
        "layout[Standard] text:change(inserted)",
    ]);
    assert_eq!(result["tracked_deleted_nodes"], json!(3));
    let doc = parse_file(&file);
    let children = first_layout_children(&doc);
    assert_eq!(
        marker_keys(&doc, &children),
        ["change_deleted", "change_unchanged"],
        "one merged cd region, single closer"
    );
    let markers = change_markers(&doc, &children);
    assert_eq!(
        marker_author(markers[0].2),
        "2",
        "deletion attributed to Bob"
    );
    assert_eq!(
        all_text(&doc, &children),
        "alphagamma",
        "Bob's own 'beta' consumed, alpha+gamma merged"
    );
    assert_eq!(max_marker_depth(&doc, &children), 1, "flat");
}

#[test]
fn dl123_f1f_whole_layout_tracked_delete_of_a_layout_containing_a_change_region_is_canonicalized() {
    let env = MutationSession::tracked("Bob");
    let file = env.write_lyx(
        "temp_dl123_f1f.lyx",
        r#"\begin_layout Standard
\change_inserted 1 1700000000
alpha
\change_unchanged
\end_layout
"#,
        ALICE,
    );
    let result = env.run(&["delete", path_arg(&file), "layout[Standard]"]);
    assert_eq!(result["tracked_deleted_nodes"], json!(1));
    let doc = parse_file(&file);
    let children = first_layout_children(&doc);
    assert_eq!(
        marker_keys(&doc, &children),
        ["change_deleted", "change_unchanged"],
        "no emptied ci opener, no redundant closer"
    );
    let markers = change_markers(&doc, &children);
    assert_eq!(
        marker_author(markers[0].2),
        "2",
        "wrapped as Bob's deletion"
    );
    assert!(all_text(&doc, &children).contains("alpha"));
    assert_eq!(max_marker_depth(&doc, &children), 1, "flat");
}

#[test]
fn dl123_f1g_delete_of_current_text_after_a_co_authors_deletion_keeps_two_adjacent_regions() {
    let env = MutationSession::tracked("Bob");
    let file = env.write_lyx(
        "temp_dl123_f1g.lyx",
        r#"\begin_layout Standard
\change_deleted 1 1700000000
old
\change_unchanged
 new
\end_layout
"#,
        ALICE,
    );
    let result = env.run(&[
        "delete",
        path_arg(&file),
        "layout[Standard] text:nth-match(2)",
    ]);
    assert_eq!(result["tracked_deleted_nodes"], json!(1));
    let doc = parse_file(&file);
    let children = first_layout_children(&doc);
    assert_eq!(
        marker_keys(&doc, &children),
        ["change_deleted", "change_deleted", "change_unchanged"],
        "cd(Alice){{old}} cd(Bob){{new}} cu — different authors, shared closer"
    );
    let markers = change_markers(&doc, &children);
    assert_eq!(marker_author(markers[0].2), "1");
    assert_eq!(marker_author(markers[1].2), "2");
    assert_eq!(all_text(&doc, &children), "old new");
}

#[test]
fn dl123_f1h_delete_of_current_text_after_a_same_author_deletion_merges_into_one_region() {
    let env = MutationSession::tracked("Alice");
    let file = env.write_lyx(
        "temp_dl123_f1h.lyx",
        r#"\begin_layout Standard
\change_deleted 1 1700000000
old
\change_unchanged
 new
\end_layout
"#,
        ALICE,
    );
    let result = env.run(&[
        "delete",
        path_arg(&file),
        "layout[Standard] text:nth-match(2)",
    ]);
    assert_eq!(result["tracked_deleted_nodes"], json!(1));
    let doc = parse_file(&file);
    let children = first_layout_children(&doc);
    assert_eq!(
        marker_keys(&doc, &children),
        ["change_deleted", "change_unchanged"],
        "merged into Alice's single cd region"
    );
    let markers = change_markers(&doc, &children);
    assert_eq!(marker_author(markers[0].2), "1");
    assert_eq!(all_text(&doc, &children), "old new");
    assert_eq!(max_marker_depth(&doc, &children), 1, "flat");
}

#[test]
fn dl125_w1_whole_layout_delete_merges_text_plus_inset_into_one_deleted_region() {
    let env = MutationSession::tracked("Bob");
    let file = env.write_lyx(
        "temp_dl125_w1.lyx",
        r#"\begin_layout Standard
Some text
\begin_inset Foot
status collapsed

\begin_layout Plain Layout
Note.
\end_layout

\end_inset

\end_layout
"#,
        ALICE,
    );
    let result = env.run(&["delete", path_arg(&file), "layout[Standard]"]);
    assert_eq!(result["tracked_deleted_nodes"], json!(1));
    let doc = parse_file(&file);
    let children = first_layout_children(&doc);
    assert_eq!(
        marker_keys(&doc, &children),
        ["change_deleted", "change_unchanged"],
        "one merged cd(Bob) region — no separate text/inset regions"
    );
    let markers = change_markers(&doc, &children);
    assert_eq!(marker_author(markers[0].2), "2", "attributed to Bob");
    assert!(
        all_text(&doc, &children).contains("Some text"),
        "text inside the merged region"
    );
    assert_eq!(max_marker_depth(&doc, &children), 1, "flat");
}

#[test]
fn dl125_w2_whole_layout_delete_merges_change_region_content_plus_inset_plus_text() {
    let env = MutationSession::tracked("Bob");
    let file = env.write_lyx(
        "temp_dl125_w2.lyx",
        r#"\begin_layout Standard
\change_inserted 1 1700000000
alpha
\change_unchanged
 plus an inset
\begin_inset Foot
status collapsed

\begin_layout Plain Layout
Note.
\end_layout

\end_inset

\end_layout
"#,
        ALICE,
    );
    let result = env.run(&["delete", path_arg(&file), "layout[Standard]"]);
    assert_eq!(result["tracked_deleted_nodes"], json!(1));
    let doc = parse_file(&file);
    let children = first_layout_children(&doc);
    assert_eq!(
        marker_keys(&doc, &children),
        ["change_deleted", "change_unchanged"],
        "co-author insert re-authored + merged into a single cd(Bob) region"
    );
    let markers = change_markers(&doc, &children);
    assert_eq!(marker_author(markers[0].2), "2", "attributed to Bob");
    assert!(
        all_text(&doc, &children).contains("alpha plus an inset"),
        "all content merged"
    );
    assert_eq!(max_marker_depth(&doc, &children), 1, "flat");
}

#[test]
fn dl125_w3_whole_layout_delete_of_a_paragraph_ending_inside_a_region_writes_no_closer() {
    let env = MutationSession::tracked("Bob");
    let file = env.write_lyx(
        "temp_dl125_w3.lyx",
        r#"\begin_layout Standard
current text
\change_inserted 1 1700000000
alpha
\end_layout
"#,
        ALICE,
    );
    let result = env.run(&["delete", path_arg(&file), "layout[Standard]"]);
    assert_eq!(result["tracked_deleted_nodes"], json!(1));
    let doc = parse_file(&file);
    let children = first_layout_children(&doc);
    assert_eq!(
        marker_keys(&doc, &children),
        ["change_deleted"],
        "one merged cd(Bob) region with NO final closer (paragraph ends inside the region)"
    );
    assert!(
        all_text(&doc, &children).contains("current textalpha"),
        "all content merged"
    );
    assert_eq!(max_marker_depth(&doc, &children), 1, "flat");
}

#[test]
fn dl125_w4_whole_layout_delete_preserves_the_original_author_of_already_deleted_text() {
    let env = MutationSession::tracked("Bob");
    let file = env.write_lyx(
        "temp_dl125_w4.lyx",
        r#"\begin_layout Standard
\change_deleted 1 1700000000
old
\change_unchanged
 current
\end_layout
"#,
        ALICE,
    );
    let result = env.run(&["delete", path_arg(&file), "layout[Standard]"]);
    assert_eq!(result["tracked_deleted_nodes"], json!(1));
    let doc = parse_file(&file);
    let children = first_layout_children(&doc);
    assert_eq!(
        marker_keys(&doc, &children),
        ["change_deleted", "change_deleted", "change_unchanged"],
        "Alice's 'old' keeps author 1 (eraseChar no-op), Bob's ' current' is his own — not merged"
    );
    let markers = change_markers(&doc, &children);
    assert_eq!(
        marker_author(markers[0].2),
        "1",
        "already-deleted stays Alice's"
    );
    assert_eq!(
        marker_author(markers[1].2),
        "2",
        "current text re-authored to Bob"
    );
    assert_eq!(all_text(&doc, &children), "old current");
}

#[test]
fn dl125_w5_whole_layout_delete_folds_inline_properties_inside_the_deleted_region() {
    let env = MutationSession::tracked("Bob");
    let file = env.write_lyx(
        "temp_dl125_w5.lyx",
        r#"\begin_layout Standard
\emph on
emphasized
\emph default
plain
\end_layout
"#,
        ALICE,
    );
    let result = env.run(&["delete", path_arg(&file), "layout[Standard]"]);
    assert_eq!(result["tracked_deleted_nodes"], json!(1));
    let doc = parse_file(&file);
    let children = first_layout_children(&doc);
    assert_eq!(
        marker_keys(&doc, &children),
        ["change_deleted", "change_unchanged"],
        "one merged cd(Bob) region"
    );
    let cd = children.iter().position(|&id| {
        matches!(&doc.node(id).kind, NodeKind::Property { key, .. } if key == "change_deleted")
    });
    let cu = children.iter().position(|&id| {
        matches!(&doc.node(id).kind, NodeKind::Property { key, .. } if key == "change_unchanged")
    });
    assert!(cd.is_some() && cu.is_some(), "opener and closer present");
    let inside = &children[cd.unwrap() + 1..cu.unwrap()];
    let emph = inside
        .iter()
        .filter(
            |&&id| matches!(&doc.node(id).kind, NodeKind::Property { key, .. } if key == "emph"),
        )
        .count();
    assert_eq!(
        emph, 2,
        "both \\emph markers folded inside the deleted region"
    );
    assert!(
        all_text(&doc, inside).contains("emphasizedplain"),
        "all text inside the region"
    );
}

#[test]
fn dl125_e1_unrelated_delete_leaves_a_truly_empty_pre_existing_region_byte_identical() {
    let env = MutationSession::tracked("Bob");
    let file = env.write_lyx(
        "temp_dl125_e1.lyx",
        r#"\begin_layout Standard
Target text
\end_layout

\begin_layout Standard
\change_inserted 1 1700000000
\change_unchanged
surviving text
\end_layout
"#,
        ALICE,
    );
    let result = env.run(&[
        "delete",
        path_arg(&file),
        "layout[Standard]:nth-match(1) text",
    ]);
    assert_eq!(result["tracked_deleted_nodes"], json!(1));
    let doc = parse_file(&file);
    let layout1 = layout_children(&doc, 0);
    assert_eq!(
        marker_keys(&doc, &layout1),
        ["change_deleted", "change_unchanged"],
        "layout 1 text becomes Bob's deletion"
    );
    let layout2 = layout_children(&doc, 1);
    assert_eq!(
        marker_keys(&doc, &layout2),
        ["change_inserted", "change_unchanged"],
        "unrelated layout's empty ci region survives (byte-identity on unmatched lists)"
    );
    assert!(
        all_text(&doc, &layout2).contains("surviving text"),
        "layout 2 text intact"
    );
    let ci = layout2.iter().position(|&id| {
        matches!(&doc.node(id).kind, NodeKind::Property { key, .. } if key == "change_inserted")
    });
    let cu = layout2.iter().position(|&id| {
        matches!(&doc.node(id).kind, NodeKind::Property { key, .. } if key == "change_unchanged")
    });
    assert!(
        ci.is_some() && cu == Some(ci.unwrap() + 1),
        "opener immediately followed by closer, no content between"
    );
}

#[test]
fn dl126_f1a_whole_layout_delete_of_a_props_only_layout_refuses() {
    let env = MutationSession::tracked("Bob");
    let file = env.write_lyx(
        "temp_dl126_f1a.lyx",
        r#"\begin_layout Standard
\emph on
\emph default
\end_layout
"#,
        ALICE,
    );
    let before = read(&file);
    let result = env.run(&["delete", path_arg(&file), "layout[Standard]"]);
    assert_eq!(
        code(&result),
        "TRACKING_ERROR",
        "refuses with TRACKING_ERROR"
    );
    assert!(
        message(&result).contains("no trackable content"),
        "message names the gap: {}",
        message(&result)
    );
    assert!(
        message(&result).contains("\n  - Disable"),
        "list indent must survive string continuation: {:?}",
        message(&result)
    );
    no_success_count(&result);
    assert_eq!(crlf(&read(&file)), crlf(&before), "file untouched");
}

#[test]
fn dl126_f1b_whole_layout_delete_of_an_empty_region_only_layout_refuses() {
    let env = MutationSession::tracked("Bob");
    let file = env.write_lyx(
        "temp_dl126_f1b.lyx",
        r#"\begin_layout Standard
\change_inserted 1 1700000000
\change_unchanged
\end_layout
"#,
        ALICE,
    );
    let before = read(&file);
    let result = env.run(&["delete", path_arg(&file), "layout[Standard]"]);
    assert_eq!(
        code(&result),
        "TRACKING_ERROR",
        "refuses with TRACKING_ERROR"
    );
    assert!(
        message(&result).contains("no trackable content"),
        "message names the gap: {}",
        message(&result)
    );
    no_success_count(&result);
    assert_eq!(crlf(&read(&file)), crlf(&before), "file untouched");
}

#[test]
fn dl126_f1c_mixed_contentful_plus_contentless_layouts_refuse_atomically() {
    let env = MutationSession::tracked("Bob");
    let file = env.write_lyx(
        "temp_dl126_f1c.lyx",
        r#"\begin_layout Standard
Real text
\end_layout

\begin_layout Standard
\emph on
\emph default
\end_layout
"#,
        ALICE,
    );
    let before = read(&file);
    let result = env.run(&["delete", path_arg(&file), "layout[Standard]"]);
    assert_eq!(
        code(&result),
        "TRACKING_ERROR",
        "refuses with TRACKING_ERROR"
    );
    no_success_count(&result);
    assert_eq!(
        crlf(&read(&file)),
        crlf(&before),
        "BOTH layouts byte-unchanged (fail closed)"
    );
}

#[test]
fn dl126_f2a_leading_property_before_a_change_region_opener_folds_inside_the_deleted_region() {
    let env = MutationSession::tracked("Bob");
    let file = env.write_lyx(
        "temp_dl126_f2a.lyx",
        r#"\begin_layout Standard
\emph on
\change_inserted 1 1700000000
alpha
\change_unchanged
\emph default
plain
\end_layout
"#,
        ALICE,
    );
    let result = env.run(&["delete", path_arg(&file), "layout[Standard]"]);
    assert_eq!(result["tracked_deleted_nodes"], json!(1));
    let doc = parse_file(&file);
    let children = first_layout_children(&doc);
    assert_eq!(
        render_sequence(&doc, &children),
        ["cd:2", "emph=on", "alpha", "emph=default", "plain", "cu"],
        "LyX-canonical: the leading \\emph on rides INSIDE Bob's deleted region"
    );
    assert_eq!(max_marker_depth(&doc, &children), 1, "flat");
}

#[test]
fn dl126_f2b_leading_property_before_a_pre_existing_deletion_rides_inside_alices_region() {
    let env = MutationSession::tracked("Bob");
    let file = env.write_lyx(
        "temp_dl126_f2b.lyx",
        r#"\begin_layout Standard
\emph on
\change_deleted 1 1700000000
old
\change_unchanged
 current
\end_layout
"#,
        ALICE,
    );
    let result = env.run(&["delete", path_arg(&file), "layout[Standard]"]);
    assert_eq!(result["tracked_deleted_nodes"], json!(1));
    let doc = parse_file(&file);
    let children = first_layout_children(&doc);
    assert_eq!(
        render_sequence(&doc, &children),
        ["cd:1", "emph=on", "old", "cd:2", " current", "cu"],
        "the property folds inside Alice's pre-existing deletion; adjacent different-author regions share one closer (byte-exact transitions)"
    );
}

#[test]
fn dl126_f3a_header_property_refusal_names_the_actual_key_and_leads_with_tracking_off() {
    let env = MutationSession::tracked("Bob");
    let file = env.write_lyx(
        "temp_dl126_f3a.lyx",
        r#"\begin_layout Standard
Plain text
\end_layout
"#,
        r#"\author 1 "Alice"
\use_hyperref false
"#,
    );
    let result = env.run(&["delete", path_arg(&file), "property[use_hyperref]"]);
    assert_eq!(
        code(&result),
        "TRACKING_ERROR",
        "refuses with TRACKING_ERROR"
    );
    assert!(
        message(&result).contains("property[use_hyperref]"),
        "message names the actual property key: {}",
        message(&result)
    );
    assert!(
        !message(&result).contains("text:property"),
        "no inapplicable text-targeting example for a header property"
    );
    let alts = message(&result).split("Alternatives:").nth(1).unwrap_or("");
    assert!(
        alts.trim().starts_with("- Disable tracking first"),
        "header variant leads with the tracking-off option: {}",
        message(&result)
    );
}

#[test]
fn dl125_p1_tracked_delete_of_a_property_node_refuses_with_guidance() {
    let env = MutationSession::tracked("Bob");
    let file = env.write_lyx(
        "temp_dl125_p1.lyx",
        r#"\begin_layout Standard
\emph on
emphasized
\emph default
plain
\end_layout
"#,
        ALICE,
    );
    let before = read(&file);
    let result = env.run(&["delete", path_arg(&file), "property[emph]"]);
    assert_eq!(
        code(&result),
        "TRACKING_ERROR",
        "refuses with TRACKING_ERROR"
    );
    assert!(
        message(&result).contains("cannot track-delete a property node"),
        "message names the non-trackable target: {}",
        message(&result)
    );
    assert!(
        message(&result).contains("text:property"),
        "message offers the text-targeting alternative: {}",
        message(&result)
    );
    no_success_count(&result);
    assert_eq!(crlf(&read(&file)), crlf(&before), "file untouched");
}
