//! Tracked-change primitives (Deno unit-shaped cases from `mutation_test.ts`).

use lq::{
    ChangeKind, Document, NodeId, NodeKind, annotate_changes, annotate_changes_in_place,
    apply_cross_node_replace, apply_tracked_delete_to_children, ensure_tracking_changes_in_header,
    extract_all_text, flatten_nested_changes, get_header, has_direct_tracked_changes,
    has_layout_ancestor, has_tracked_changes, is_change_closer, is_change_opener, is_content_node,
    parse, parse_change_marker, resolve_author_id, scan_region_end, serialize, wrap_with_tracking,
};
use std::collections::{HashMap, HashSet};

fn mk_prop(doc: &mut Document, key: &str, value: Option<&str>) -> NodeId {
    doc.alloc(NodeKind::Property {
        key: key.to_string(),
        value: value.map(str::to_string),
    })
}

fn mk_text(doc: &mut Document, text: &str) -> NodeId {
    doc.alloc(NodeKind::Text {
        text: text.to_string(),
    })
}

fn keys(doc: &Document, ids: &[NodeId]) -> Vec<String> {
    ids.iter()
        .map(|&id| match &doc.node(id).kind {
            NodeKind::Property { key, .. } => key.clone(),
            NodeKind::Text { .. } => "text".into(),
            NodeKind::Block { tag, .. } => tag.clone(),
            NodeKind::Document => "document".into(),
        })
        .collect()
}

fn prop_value(doc: &Document, id: NodeId) -> Option<&str> {
    match &doc.node(id).kind {
        NodeKind::Property { value, .. } => value.as_deref(),
        _ => None,
    }
}

fn texts(doc: &Document, ids: &[NodeId]) -> Vec<String> {
    ids.iter()
        .filter_map(|&id| match &doc.node(id).kind {
            NodeKind::Text { text } => Some(text.clone()),
            _ => None,
        })
        .collect()
}

fn parse_layout(body: &str) -> (Document, NodeId) {
    let doc = parse(body, true).unwrap();
    let layout = doc.node(doc.root()).children[0];
    (doc, layout)
}

fn all_text(doc: &Document, ids: &[NodeId]) -> String {
    ids.iter()
        .filter_map(|&id| match &doc.node(id).kind {
            NodeKind::Text { text } => Some(text.as_str()),
            _ => None,
        })
        .collect()
}

fn change_marker_keys(doc: &Document, ids: &[NodeId]) -> Vec<String> {
    ids.iter()
        .filter_map(|&id| match &doc.node(id).kind {
            NodeKind::Property { key, .. } if is_change_opener(key) || is_change_closer(key) => {
                Some(key.clone())
            }
            _ => None,
        })
        .collect()
}

fn author_of(doc: &Document, id: NodeId) -> Option<&str> {
    prop_value(doc, id).and_then(|v| v.split(' ').next())
}

fn header_doc(authors: &[&str]) -> Document {
    let mut src = String::from("#LyX 2.5 created this file.\n\\begin_document\n\\begin_header\n");
    for a in authors {
        src.push_str(a);
        src.push('\n');
    }
    src.push_str("\\end_header\n\\begin_body\n\\begin_layout Standard\nHello\n\\end_layout\n\\end_body\n\\end_document\n");
    parse(&src, false).unwrap()
}

fn author_values(doc: &Document) -> Vec<String> {
    let header = get_header(doc).expect("header");
    doc.node(header)
        .children
        .iter()
        .filter_map(|&id| match &doc.node(id).kind {
            NodeKind::Property { key, value } if key == "author" => value.clone(),
            _ => None,
        })
        .collect()
}

#[test]
fn dl120_scan_region_end_flat_mode_keeps_one_region_per_type_author_run() {
    let mut doc = Document::new();
    let cu = mk_prop(&mut doc, "change_unchanged", None);

    let ci_ci = vec![
        mk_prop(&mut doc, "change_inserted", Some("1 1700000000")),
        mk_text(&mut doc, "Alice"),
        mk_prop(&mut doc, "change_inserted", Some("2 1700000001")),
        mk_text(&mut doc, "Bob"),
        cu,
    ];
    assert_eq!(
        scan_region_end(&doc, &ci_ci, 1, "change_inserted", true),
        lq::RegionEnd {
            closer: None,
            next_opener: Some(2)
        },
        "same-type different-author opener ends the region"
    );

    let ci_ci_ts = vec![
        mk_prop(&mut doc, "change_inserted", Some("1 1700000000")),
        mk_text(&mut doc, "A"),
        mk_prop(&mut doc, "change_inserted", Some("1 1700000002")),
        mk_text(&mut doc, "B"),
        mk_prop(&mut doc, "change_unchanged", None),
    ];
    assert_eq!(
        scan_region_end(&doc, &ci_ci_ts, 1, "change_inserted", true),
        lq::RegionEnd {
            closer: Some(4),
            next_opener: None
        },
        "same-type same-author opener (any timestamp) continues the region"
    );

    let cd_cd = vec![
        mk_prop(&mut doc, "change_deleted", Some("1 1700000000")),
        mk_text(&mut doc, "Hello"),
        mk_prop(&mut doc, "change_deleted", Some("2 1700000001")),
        mk_text(&mut doc, " world"),
        mk_prop(&mut doc, "change_unchanged", None),
    ];
    assert_eq!(
        scan_region_end(&doc, &cd_cd, 1, "change_deleted", true),
        lq::RegionEnd {
            closer: None,
            next_opener: Some(2)
        },
        "same-type different-author deleted opener ends the region"
    );

    let identical = vec![
        mk_prop(&mut doc, "change_inserted", Some("1 1700000000")),
        mk_prop(&mut doc, "change_inserted", Some("1 1700000000")),
        mk_text(&mut doc, "x"),
        mk_prop(&mut doc, "change_unchanged", None),
        mk_prop(&mut doc, "change_unchanged", None),
    ];
    assert_eq!(
        scan_region_end(&doc, &identical, 1, "change_inserted", true),
        lq::RegionEnd {
            closer: Some(3),
            next_opener: None
        },
        "identical-state opener is not a boundary"
    );

    let ci_cd = vec![
        mk_prop(&mut doc, "change_inserted", Some("1 1700000000")),
        mk_text(&mut doc, "A"),
        mk_prop(&mut doc, "change_deleted", Some("1 1700000001")),
        mk_text(&mut doc, "D"),
    ];
    assert_eq!(
        scan_region_end(&doc, &ci_cd, 1, "change_inserted", true),
        lq::RegionEnd {
            closer: None,
            next_opener: Some(2)
        },
        "different-type opener ends the region"
    );
}

#[test]
fn dl121_15_flatten_passes_flat_interleave_sharing_one_closer_through_verbatim() {
    let mut doc = Document::new();
    let cu = mk_prop(&mut doc, "change_unchanged", None);
    let interleave = vec![
        mk_prop(&mut doc, "change_inserted", Some("1 1700000000")),
        mk_text(&mut doc, "X"),
        mk_prop(&mut doc, "change_deleted", Some("2 1700000001")),
        mk_text(&mut doc, "Z"),
        cu,
    ];
    let out = flatten_nested_changes(&mut doc, &interleave);
    assert_eq!(
        keys(&doc, &out),
        [
            "change_inserted",
            "text",
            "change_deleted",
            "text",
            "change_unchanged"
        ],
        "adjacent ci/cd flat interleave passes through byte-exact (no synthetic closer)"
    );

    let ci_ci_shared = vec![
        mk_prop(&mut doc, "change_inserted", Some("1 1700000000")),
        mk_text(&mut doc, "A"),
        mk_prop(&mut doc, "change_inserted", Some("2 1700000001")),
        mk_text(&mut doc, "B"),
        mk_prop(&mut doc, "change_unchanged", None),
    ];
    let out = flatten_nested_changes(&mut doc, &ci_ci_shared);
    assert_eq!(
        keys(&doc, &out),
        [
            "change_inserted",
            "text",
            "change_inserted",
            "text",
            "change_unchanged"
        ],
        "same-type different-author adjacent regions pass through (no closer between)"
    );
}

#[test]
fn dl121_15_flatten_merges_same_author_nested_opener() {
    let mut doc = Document::new();
    let nested = vec![
        mk_prop(&mut doc, "change_inserted", Some("1 1700000100")),
        mk_text(&mut doc, "A"),
        mk_prop(&mut doc, "change_inserted", Some("1 1700000200")),
        mk_text(&mut doc, "B"),
        mk_prop(&mut doc, "change_unchanged", None),
    ];
    let out = flatten_nested_changes(&mut doc, &nested);
    assert_eq!(
        keys(&doc, &out),
        ["change_inserted", "text", "text", "change_unchanged"],
        "same-author double opener collapses to a single region"
    );
    let openers: Vec<_> = out
        .iter()
        .copied()
        .filter(|&id| {
            matches!(
                &doc.node(id).kind,
                NodeKind::Property { key, .. } if key == "change_inserted"
            )
        })
        .collect();
    assert_eq!(openers.len(), 1, "double opener collapsed to one");
    assert_eq!(
        prop_value(&doc, openers[0]),
        Some("1 1700000200"),
        "timestamp becomes max(old, new)"
    );
    assert_eq!(texts(&doc, &out), ["A", "B"], "content absorbed in order");
}

#[test]
fn parse_change_marker_js_parseint_and_space_split() {
    let m = parse_change_marker(Some("1 1700000000"));
    assert_eq!(m.author_id, 1);
    assert_eq!(m.ts, "1700000000");
    let m = parse_change_marker(Some("-443692588 1"));
    assert_eq!(m.author_id, -443692588);
    assert_eq!(parse_change_marker(None).author_id, 0);
    assert_eq!(parse_change_marker(None).ts, "0");
    assert_eq!(parse_change_marker(Some("1abc 2")).author_id, 1);
    assert_eq!(parse_change_marker(Some("1  2")).ts, "0");
}

#[test]
fn opener_closer_predicates() {
    assert!(is_change_opener("change_deleted"));
    assert!(is_change_opener("change_inserted"));
    assert!(!is_change_opener("change_unchanged"));
    assert!(is_change_closer("change_unchanged"));
    assert!(!is_change_closer("change_deleted"));
}

#[test]
fn dl124_a1_email_bearing_author_line_is_recognized_and_reused() {
    let mut doc = header_doc(&[r#"\author 236438948 "lq user" lquser@example.com"#]);
    let id = resolve_author_id(&mut doc, "lq user");
    assert_eq!(id, 236438948);
    assert_eq!(author_values(&doc).len(), 1);
}

#[test]
fn dl124_a2_negative_hash_author_line_is_recognized_and_reused() {
    let mut doc = header_doc(&[r#"\author -443692588 "Hans Wurst""#]);
    let id = resolve_author_id(&mut doc, "Hans Wurst");
    assert_eq!(id, -443692588);
    assert_eq!(author_values(&doc).len(), 1);
}

#[test]
fn dl124_a3_mixed_header_new_author_gets_max_id_plus_one() {
    let mut doc = header_doc(&[
        r#"\author 236438948 "me" me@example.com"#,
        r#"\author 5 "Alice""#,
    ]);
    let id = resolve_author_id(&mut doc, "Bob");
    assert_eq!(id, 236438949);
    assert_eq!(author_values(&doc).len(), 3);
    assert!(
        author_values(&doc)
            .iter()
            .any(|v| v == r#"236438949 "Bob""#)
    );
}

#[test]
fn dl124_a4_email_only_header_new_author_still_sequential() {
    let mut doc = header_doc(&[r#"\author 236438948 "me" me@example.com"#]);
    let id = resolve_author_id(&mut doc, "Bob");
    assert_eq!(id, 236438949);
}

#[test]
fn dl124_a5_negative_id_email_line_not_counted_for_max_id() {
    let mut doc = header_doc(&[r#"\author -443692588 "me" me@example.com"#]);
    let id = resolve_author_id(&mut doc, "Bob");
    assert_eq!(id, 1);
}

#[test]
fn ensure_tracking_overwrites_false() {
    let src = "#LyX 2.5 created this file.\n\\begin_document\n\\begin_header\n\\tracking_changes false\n\\end_header\n\\begin_body\n\\begin_layout Standard\nHello\n\\end_layout\n\\end_body\n\\end_document\n";
    let mut doc = parse(src, false).unwrap();
    ensure_tracking_changes_in_header(&mut doc);
    let header = get_header(&doc).unwrap();
    let vals: Vec<_> = doc
        .node(header)
        .children
        .iter()
        .filter_map(|&id| match &doc.node(id).kind {
            NodeKind::Property { key, value } if key == "tracking_changes" => value.clone(),
            _ => None,
        })
        .collect();
    assert_eq!(vals, ["true"]);
}

#[test]
fn has_layout_ancestor_nearest_container() {
    let src = "\\begin_layout Author\n\
\\begin_inset Foot\n\
status collapsed\n\
\\begin_layout Plain Layout\ninner\n\\end_layout\n\
\\end_inset\n\
\\end_layout\n";
    let (doc, layout) = parse_layout(src);
    let root = doc.root();
    assert!(has_layout_ancestor(&doc, layout, root));

    fn find_text(doc: &Document, id: NodeId, want: &str) -> Option<NodeId> {
        if let NodeKind::Text { text } = &doc.node(id).kind
            && text == want
        {
            return Some(id);
        }
        for &c in &doc.node(id).children {
            if let Some(f) = find_text(doc, c, want) {
                return Some(f);
            }
        }
        None
    }
    let inner = find_text(&doc, layout, "inner").unwrap();
    assert!(
        has_layout_ancestor(&doc, inner, root),
        "text whose parent is a layout is trackable"
    );
    let status = find_text(&doc, layout, "status collapsed").unwrap();
    assert!(
        !has_layout_ancestor(&doc, status, root),
        "inset metadata is not trackable even inside a layout ancestor"
    );
}

#[test]
fn has_tracked_changes_direct_vs_nested() {
    let (doc, layout) = parse_layout(
        "\\begin_layout Standard\n\\change_inserted 1 1\nx\n\\change_unchanged\n\\end_layout\n",
    );
    assert!(has_tracked_changes(&doc, &doc.node(layout).children));
    assert!(has_direct_tracked_changes(&doc, &doc.node(layout).children));

    let (doc, outer) = parse_layout(
        "\\begin_layout Standard\nkeep\n\\begin_inset Foot\nstatus open\n\\begin_layout Plain Layout\n\\change_inserted 1 1\nnest\n\\change_unchanged\n\\end_layout\n\\end_inset\n\\end_layout\n",
    );
    assert!(has_tracked_changes(&doc, &doc.node(outer).children));
    assert!(!has_direct_tracked_changes(&doc, &doc.node(outer).children));
}

#[test]
fn extract_all_text_ert_and_inset_placeholder() {
    let (doc, layout) = parse_layout(
        "\\begin_layout Standard\nHello\n\\begin_inset Foot\nstatus open\n\\begin_layout Plain Layout\nhid\n\\end_layout\n\\end_inset\n\\end_layout\n",
    );
    let t = extract_all_text(&doc, layout, usize::MAX, false);
    assert!(t.contains("Hello"));
    assert!(t.contains(" inset[Foot] "));
    assert!(!t.contains("hid"));

    let (doc, layout) = parse_layout(
        "\\begin_layout Standard\n\\begin_inset ERT\nstatus open\n\\begin_layout Plain Layout\n\\foo\n\\end_layout\n\\end_inset\n\\end_layout\n",
    );
    let t = extract_all_text(&doc, layout, usize::MAX, false);
    assert!(t.contains(" inset[ERT] ") || t.contains("\\foo"));
}

#[test]
fn annotate_changes_labels_deleted_and_inserted() {
    let (doc, layout) = parse_layout(
        "\\begin_layout Standard\nkeep\n\\change_deleted 1 1\ngone\n\\change_inserted 1 2\nnew\n\\change_unchanged\n\\end_layout\n",
    );
    let v = annotate_changes(&doc, layout);
    let children = v["children"].as_array().unwrap();
    let texts: Vec<_> = children.iter().filter(|c| c["type"] == "text").collect();
    assert_eq!(texts[0]["text"], "keep");
    assert!(texts[0].get("changeStatus").is_none());
    assert_eq!(texts[1]["changeStatus"], "deleted");
    assert_eq!(texts[2]["changeStatus"], "inserted");

    let mut overlay = HashMap::new();
    annotate_changes_in_place(&doc, layout, 0, 0, &mut overlay);
    assert_eq!(overlay.len(), 2);
}

#[test]
fn wrap_with_tracking_buffers_text_passes_properties() {
    let (mut doc, layout) =
        parse_layout("\\begin_layout Standard\nA\nB\n\\emph on\nC\n\\end_layout\n");
    let children = doc.node(layout).children.clone();
    let out = wrap_with_tracking(&mut doc, &children, ChangeKind::Inserted, 1, Some("9"));
    let k = keys(&doc, &out);
    assert_eq!(k[0], "change_inserted");
    assert!(k.contains(&"emph".to_string()));
    assert_eq!(*k.last().unwrap(), "change_unchanged");
}

#[test]
fn dl123_f1a_tracked_delete_of_coauthor_insert_drops_emptied_region() {
    let (mut doc, layout) = parse_layout(
        "\\begin_layout Standard\n\\change_inserted 1 1700000000\nalpha\n\\change_unchanged\n\\end_layout\n",
    );
    let children = doc.node(layout).children.clone();
    let alpha = children
        .iter()
        .copied()
        .find(|&id| matches!(&doc.node(id).kind, NodeKind::Text { text } if text == "alpha"))
        .unwrap();
    let matched = HashSet::from([alpha]);
    let out = apply_tracked_delete_to_children(
        &mut doc,
        &children,
        |_, id| matched.contains(&id),
        2,
        "9",
        false,
    );
    assert_eq!(
        change_marker_keys(&doc, &out),
        ["change_deleted", "change_unchanged"]
    );
    let cd = out
        .iter()
        .copied()
        .find(|&id| {
            matches!(&doc.node(id).kind, NodeKind::Property { key, .. } if key == "change_deleted")
        })
        .unwrap();
    assert_eq!(author_of(&doc, cd), Some("2"));
    assert!(all_text(&doc, &out).contains("alpha"));
}

#[test]
fn dl123_f1b_partial_coauthor_insert_reopens_survivor() {
    let (mut doc, layout) = parse_layout(
        "\\begin_layout Standard\n\\change_inserted 1 1700000000\nalpha\n beta\n\\change_unchanged\n\\end_layout\n",
    );
    let children = doc.node(layout).children.clone();
    let alpha = children
        .iter()
        .copied()
        .find(|&id| matches!(&doc.node(id).kind, NodeKind::Text { text } if text == "alpha"))
        .unwrap();
    let matched = HashSet::from([alpha]);
    let out = apply_tracked_delete_to_children(
        &mut doc,
        &children,
        |_, id| matched.contains(&id),
        2,
        "9",
        false,
    );
    assert_eq!(
        change_marker_keys(&doc, &out),
        ["change_deleted", "change_inserted", "change_unchanged"]
    );
    let markers: Vec<_> = out
        .iter()
        .copied()
        .filter(|&id| {
            matches!(
                &doc.node(id).kind,
                NodeKind::Property { key, .. } if is_change_opener(key) || is_change_closer(key)
            )
        })
        .collect();
    assert_eq!(author_of(&doc, markers[0]), Some("2"));
    assert_eq!(author_of(&doc, markers[1]), Some("1"));
    assert_eq!(all_text(&doc, &out), "alpha beta");
}

#[test]
fn dl123_f1c_own_pending_insert_is_consumed() {
    let (mut doc, layout) = parse_layout(
        "\\begin_layout Standard\n\\change_inserted 1 1700000000\nalpha\n\\change_inserted 2 1700000001\nbeta\n\\change_unchanged\n\\end_layout\n",
    );
    let children = doc.node(layout).children.clone();
    let beta = children
        .iter()
        .copied()
        .find(|&id| matches!(&doc.node(id).kind, NodeKind::Text { text } if text == "beta"))
        .unwrap();
    let matched = HashSet::from([beta]);
    let out = apply_tracked_delete_to_children(
        &mut doc,
        &children,
        |_, id| matched.contains(&id),
        2,
        "9",
        false,
    );
    assert_eq!(
        change_marker_keys(&doc, &out),
        ["change_inserted", "change_unchanged"]
    );
    assert_eq!(all_text(&doc, &out), "alpha");
}

#[test]
fn dl123_f1d_already_deleted_is_noop() {
    let (mut doc, layout) = parse_layout(
        "\\begin_layout Standard\n\\change_deleted 1 1700000000\nold\n\\change_unchanged\n new\n\\end_layout\n",
    );
    let children = doc.node(layout).children.clone();
    let old = children
        .iter()
        .copied()
        .find(|&id| matches!(&doc.node(id).kind, NodeKind::Text { text } if text == "old"))
        .unwrap();
    let matched = HashSet::from([old]);
    let out = apply_tracked_delete_to_children(
        &mut doc,
        &children,
        |_, id| matched.contains(&id),
        2,
        "9",
        false,
    );
    assert_eq!(
        change_marker_keys(&doc, &out),
        ["change_deleted", "change_unchanged"]
    );
    let cd = out
        .iter()
        .copied()
        .find(|&id| {
            matches!(&doc.node(id).kind, NodeKind::Property { key, .. } if key == "change_deleted")
        })
        .unwrap();
    assert_eq!(author_of(&doc, cd), Some("1"));
    assert_eq!(all_text(&doc, &out), "old new");
}

#[test]
fn dl123_f1e_three_adjacent_inserts_merge_own_consumed() {
    let (mut doc, layout) = parse_layout(
        "\\begin_layout Standard\n\\change_inserted 1 1700000000\nalpha\n\\change_inserted 2 1700000001\nbeta\n\\change_inserted 3 1700000002\ngamma\n\\change_unchanged\n\\end_layout\n",
    );
    let children = doc.node(layout).children.clone();
    let out = apply_tracked_delete_to_children(&mut doc, &children, is_content_node, 2, "9", false);
    assert_eq!(
        change_marker_keys(&doc, &out),
        ["change_deleted", "change_unchanged"]
    );
    let cd = out
        .iter()
        .copied()
        .find(|&id| {
            matches!(&doc.node(id).kind, NodeKind::Property { key, .. } if key == "change_deleted")
        })
        .unwrap();
    assert_eq!(author_of(&doc, cd), Some("2"));
    assert_eq!(all_text(&doc, &out), "alphagamma");
}

#[test]
fn dl123_f1g_current_after_coauthor_delete_not_merged() {
    let (mut doc, layout) = parse_layout(
        "\\begin_layout Standard\n\\change_deleted 1 1700000000\nold\n\\change_unchanged\n new\n\\end_layout\n",
    );
    let children = doc.node(layout).children.clone();
    let cur = children
        .iter()
        .copied()
        .find(|&id| matches!(&doc.node(id).kind, NodeKind::Text { text } if text == " new"))
        .unwrap();
    let matched = HashSet::from([cur]);
    let out = apply_tracked_delete_to_children(
        &mut doc,
        &children,
        |_, id| matched.contains(&id),
        2,
        "9",
        false,
    );
    assert_eq!(
        change_marker_keys(&doc, &out),
        ["change_deleted", "change_deleted", "change_unchanged"]
    );
}

#[test]
fn dl125_w4_whole_layout_preserves_original_deleted_author() {
    let (mut doc, layout) = parse_layout(
        "\\begin_layout Standard\n\\change_deleted 1 1700000000\nold\n\\change_unchanged\n current\n\\end_layout\n",
    );
    let children = doc.node(layout).children.clone();
    let out = apply_tracked_delete_to_children(&mut doc, &children, is_content_node, 2, "9", true);
    assert_eq!(
        change_marker_keys(&doc, &out),
        ["change_deleted", "change_deleted", "change_unchanged"]
    );
    let cds: Vec<_> = out
        .iter()
        .copied()
        .filter(|&id| {
            matches!(&doc.node(id).kind, NodeKind::Property { key, .. } if key == "change_deleted")
        })
        .collect();
    assert_eq!(author_of(&doc, cds[0]), Some("1"));
    assert_eq!(author_of(&doc, cds[1]), Some("2"));
    assert_eq!(all_text(&doc, &out), "old current");
}

#[test]
fn dl125_w5_whole_layout_folds_inline_properties_inside_deleted() {
    let (mut doc, layout) = parse_layout(
        "\\begin_layout Standard\n\\emph on\nemphasized\n\\emph default\nplain\n\\end_layout\n",
    );
    let children = doc.node(layout).children.clone();
    let out = apply_tracked_delete_to_children(&mut doc, &children, is_content_node, 2, "9", true);
    assert_eq!(
        change_marker_keys(&doc, &out),
        ["change_deleted", "change_unchanged"]
    );
    let cd = out
        .iter()
        .position(|&id| {
            matches!(&doc.node(id).kind, NodeKind::Property { key, .. } if key == "change_deleted")
        })
        .unwrap();
    let cu = out
        .iter()
        .position(|&id| {
            matches!(&doc.node(id).kind, NodeKind::Property { key, .. } if key == "change_unchanged")
        })
        .unwrap();
    let inside = &out[cd + 1..cu];
    let emph = inside
        .iter()
        .filter(
            |&&id| matches!(&doc.node(id).kind, NodeKind::Property { key, .. } if key == "emph"),
        )
        .count();
    assert_eq!(emph, 2);
    assert_eq!(all_text(&doc, inside), "emphasizedplain");
}

#[test]
fn dl125_e1_no_matched_content_is_byte_identical() {
    let (mut doc, layout) = parse_layout(
        "\\begin_layout Standard\n\\change_inserted 1 1700000000\n\\change_unchanged\nsurviving text\n\\end_layout\n",
    );
    let children = doc.node(layout).children.clone();
    let out = apply_tracked_delete_to_children(&mut doc, &children, |_, _| false, 2, "9", true);
    assert_eq!(out, children);
}

#[test]
fn dl126_f2a_leading_property_before_opener_folds_inside() {
    let (mut doc, layout) = parse_layout(
        "\\begin_layout Standard\n\\emph on\n\\change_inserted 1 1700000000\nalpha\n\\change_unchanged\n\\end_layout\n",
    );
    let children = doc.node(layout).children.clone();
    let out = apply_tracked_delete_to_children(&mut doc, &children, is_content_node, 2, "9", true);
    let cd = out
        .iter()
        .position(|&id| {
            matches!(&doc.node(id).kind, NodeKind::Property { key, .. } if key == "change_deleted")
        })
        .unwrap();
    let cu = out
        .iter()
        .position(|&id| {
            matches!(&doc.node(id).kind, NodeKind::Property { key, .. } if key == "change_unchanged")
        })
        .unwrap();
    let inside = &out[cd + 1..cu];
    assert!(
        inside.iter().any(
            |&id| matches!(&doc.node(id).kind, NodeKind::Property { key, .. } if key == "emph")
        )
    );
}

#[test]
fn cross_node_untracked_replace_across_text_nodes() {
    let (mut doc, layout) = parse_layout(
        "\\begin_layout Standard\nCompared to the literature,\n we find\n significant effects\n\\end_layout\n",
    );
    let r = apply_cross_node_replace(
        &mut doc,
        layout,
        "Compared to the literature, we find",
        "REPLACED",
        false,
        1,
        "9",
        None,
        None,
    );
    assert_eq!(r.match_count, 1);
    doc.set_children(layout, r.new_children);
    let s = serialize(&doc);
    assert!(s.contains("REPLACED"));
    assert!(s.contains("significant effects"));
}

#[test]
fn dl98_f1_find_before_ref_inset_keeps_inset_current() {
    let (mut doc, layout) = parse_layout(
        "\\begin_layout Standard\nSee Section\n\\begin_inset CommandInset ref\nLatexCommand ref\nreference \"sec:intro\"\n\n\\end_inset\n\n for details.\n\\end_layout\n",
    );
    let r = apply_cross_node_replace(
        &mut doc,
        layout,
        "See Section",
        "Section 2",
        true,
        1,
        "9",
        None,
        None,
    );
    assert_eq!(r.match_count, 1);
    doc.set_children(layout, r.new_children);
    let s = serialize(&doc);
    let cd = s.find("\\change_deleted").unwrap();
    let cu = s.find("\\change_unchanged").unwrap();
    let inset = s.find("\\begin_inset CommandInset ref").unwrap();
    assert!(cd < cu);
    assert!(
        cu < inset,
        "inset must sit after the closer, not inside the deleted span"
    );
}

#[test]
fn f2_find_spanning_emph_drops_inside_span_property() {
    let (mut doc, layout) = parse_layout(
        "\\begin_layout Standard\nAlpha \n\\emph on\nBeta\n\\emph default\nGamma\n\\end_layout\n",
    );
    let r = apply_cross_node_replace(
        &mut doc,
        layout,
        "Alpha Beta",
        "XYZ",
        false,
        1,
        "9",
        None,
        None,
    );
    assert_eq!(r.match_count, 1);
    doc.set_children(layout, r.new_children);
    let s = serialize(&doc);
    assert!(s.contains("XYZ"));
    assert!(
        !s.contains("\\emph on"),
        "inside-span \\emph on must be dropped"
    );
    assert!(s.contains("\\emph default"));
    assert!(s.find("XYZ").unwrap() < s.find("\\emph default").unwrap());
}

#[test]
fn apply_cross_node_replace_skips_inset_crossing() {
    let (mut doc, layout) = parse_layout(
        "\\begin_layout Standard\nAB\n\\begin_inset Foot\nstatus open\n\\begin_layout Plain Layout\nx\n\\end_layout\n\\end_inset\nCD\n\\end_layout\n",
    );
    let r = apply_cross_node_replace(&mut doc, layout, "ABCD", "Z", false, 1, "9", None, None);
    assert_eq!(r.match_count, 0);
    assert_eq!(r.crossed_inset_count, 1);
}
