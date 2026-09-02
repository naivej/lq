//! Undo CLI tests (Deno `tests/mutation_test.ts` snapshot + replay, including
//! chained set/insert/delete then undo).

mod common;

use common::{MutationSession, json_warnings, path_arg};
use lq::{Document, NodeId, NodeKind};
use serde_json::{Value, json};
use std::fs;

const ADJACENT_CI_CI_BODY: &str = r"\begin_layout Standard
\change_inserted 1 1700000000
Alice's text
\change_inserted 2 1700000001
Bob's text
\change_unchanged
\end_layout
";

const ADJACENT_CI_CD_SPAN_BODY: &str = r"\begin_layout Standard
\change_inserted 2 1700000001
Hi
\change_unchanged
\change_deleted 1 1700000000
Hello
\change_deleted 2 1700000001
 world
\change_unchanged
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

const DL121_SPLIT_BODY: &str = r"\begin_layout Standard
\change_inserted 1 1700000000
edit here
\change_unchanged
\end_layout
";

fn code(v: &Value) -> &str {
    v["code"].as_str().unwrap_or("")
}

fn message(v: &Value) -> &str {
    v["message"].as_str().unwrap_or("")
}

fn labels(v: &Value) -> Vec<String> {
    v["changes"]
        .as_array()
        .map(|arr| {
            arr.iter()
                .filter_map(|c| c["label"].as_str().map(str::to_owned))
                .collect()
        })
        .unwrap_or_default()
}

fn set_author(env: &MutationSession, author: &str) {
    let path = env.home.path().join(".lq/config.json");
    let mut cfg: Value = serde_json::from_str(&fs::read_to_string(&path).unwrap()).unwrap();
    cfg["trackChanges"] = json!(true);
    cfg["authorName"] = json!(author);
    fs::write(&path, cfg.to_string()).unwrap();
}

fn parse_doc(text: &str) -> Document {
    lq::parse(text, false).unwrap_or_else(|e| panic!("parse failed: {e}"))
}

fn first_layout(doc: &Document) -> NodeId {
    let document = doc
        .node(doc.root())
        .children
        .iter()
        .copied()
        .find(|&id| matches!(&doc.node(id).kind, NodeKind::Block { tag, .. } if tag == "document"))
        .expect("document block");
    let body = doc
        .node(document)
        .children
        .iter()
        .copied()
        .find(|&id| matches!(&doc.node(id).kind, NodeKind::Block { tag, .. } if tag == "body"))
        .expect("body block");
    doc.node(body)
        .children
        .iter()
        .copied()
        .find(|&id| matches!(&doc.node(id).kind, NodeKind::Block { tag, .. } if tag == "layout"))
        .expect("layout")
}

fn change_marker_keys(doc: &Document, layout: NodeId) -> Vec<&str> {
    doc.node(layout)
        .children
        .iter()
        .filter_map(|&id| match &doc.node(id).kind {
            NodeKind::Property { key, .. } if key.starts_with("change_") => Some(key.as_str()),
            _ => None,
        })
        .collect()
}

fn first_opener_author(doc: &Document, layout: NodeId) -> &str {
    for &id in &doc.node(layout).children {
        if let NodeKind::Property { key, value } = &doc.node(id).kind
            && key.starts_with("change_")
            && key != "change_unchanged"
        {
            return value
                .as_deref()
                .unwrap_or("")
                .split(' ')
                .next()
                .unwrap_or("");
        }
    }
    ""
}

fn all_text(doc: &Document, layout: NodeId) -> String {
    doc.node(layout)
        .children
        .iter()
        .filter_map(|&id| match &doc.node(id).kind {
            NodeKind::Text { text } => Some(text.as_str()),
            _ => None,
        })
        .collect::<Vec<_>>()
        .join("")
}

fn text_nodes(doc: &Document, layout: NodeId) -> Vec<String> {
    doc.node(layout)
        .children
        .iter()
        .filter_map(|&id| match &doc.node(id).kind {
            NodeKind::Text { text } => Some(text.clone()),
            _ => None,
        })
        .collect()
}

fn max_marker_depth(doc: &Document, layout: NodeId) -> i32 {
    let mut deleted = 0;
    let mut inserted = 0;
    let mut max = 0;
    for &id in &doc.node(layout).children {
        if let NodeKind::Property { key, .. } = &doc.node(id).kind
            && key.starts_with("change_")
        {
            let (d, i) = lq::advance_change_depths(key, deleted, inserted);
            deleted = d;
            inserted = i;
            max = max.max(deleted + inserted);
        }
    }
    max
}

#[test]
fn mutation_engine_undo_with_zero_changes_undo_stale() {
    let env = MutationSession::with_config(json!({ "trackChanges": true }));
    let file = env.write_lyx(
        "temp_undo_clean.lyx",
        "\\begin_layout Standard\nClean text\n\\end_layout\n",
        "",
    );
    let before = fs::read_to_string(&file).unwrap();
    let result = env.run(&["undo", path_arg(&file)]);
    assert_eq!(code(&result), "UNDO_STALE");
    assert!(message(&result).contains("Nothing to undo"));
    let text = fs::read_to_string(&file).unwrap();
    assert_eq!(text, before, "UNDO_STALE undo must not write the file");
    assert_eq!(
        text.matches("\\author").count(),
        0,
        "Undo on clean file should not add spurious \\author entries"
    );
}

#[test]
fn dl106_b1_bobs_find_inside_alices_change_deleted_keeps_alices_author_bobs_replay_undo_does_not_resurrect_the_rejected_text()
 {
    let env = MutationSession::tracked("Bob");
    let file = env.write_lyx(
        "temp_dl106_b1_reauthor.lyx",
        "\\begin_layout Standard\n\
         \\change_deleted 1 1700000000\n\
         Hello world\n\
         \\change_unchanged\n\
         \\change_inserted 1 1700000000\n\
         Alice's new text\n\
         \\change_unchanged\n\
         \\end_layout\n",
        "\\author 1 \"Alice\"\n",
    );
    let p = path_arg(&file);
    let set_result = env.run(&["set", p, "layout[Standard]", "Hi", "--find", "Hello world"]);
    assert_eq!(set_result["modified_nodes"], json!(1));
    let text = fs::read_to_string(&file).unwrap();
    assert!(
        text.contains("\\change_inserted 2"),
        "replacement is Bob's insert"
    );
    assert!(
        text.contains("\\change_deleted 1"),
        "Alice's rejection keeps her author (DL106 A1)"
    );
    assert!(
        !text.contains("\\change_deleted 2"),
        "Bob must NOT re-author Alice's rejected text"
    );
    let doc = parse_doc(&text);
    let layout = first_layout(&doc);
    assert_eq!(max_marker_depth(&doc, layout), 1, "flat, never nested");

    let undo_result = env.run(&["undo", p, "layout[Standard]"]);
    assert_eq!(
        undo_result["undone_changes"],
        json!(1),
        "only Bob's insert block is undone"
    );
    let text = fs::read_to_string(&file).unwrap();
    assert!(
        !text.contains("\\change_inserted 2"),
        "Bob's insert removed"
    );
    assert!(
        text.contains("\\change_deleted 1"),
        "Alice's rejection survives Bob's undo"
    );
    let del_pos = text.find("\\change_deleted 1");
    let hello_pos = text.find("Hello world");
    assert!(
        del_pos.is_some() && hello_pos.is_some() && del_pos.unwrap() < hello_pos.unwrap(),
        "Hello world must remain rejected text after Bob's undo"
    );
}

#[test]
fn dl127_f1_cross_author_replay_of_an_edit_inside_another_authors_insert_matches_lyxs_reject_chain()
{
    let env = MutationSession::tracked("Alice");
    let file = env.write_lyx(
        "temp_dl127_f1_replay_chain.lyx",
        "\\begin_layout Standard\nThe quick brown fox\n\\end_layout\n",
        "\\author 1 \"Alice\"\n",
    );
    let p = path_arg(&file);

    let step1 = env.run(&[
        "set",
        p,
        "layout[Standard]",
        "very quick",
        "--find",
        "quick",
    ]);
    assert_eq!(step1["modified_nodes"], json!(1));
    let text = fs::read_to_string(&file).unwrap();
    assert!(text.contains("\\change_inserted 1"), "Alice's insert");
    assert!(text.contains("\\change_deleted 1"), "Alice's deletion");

    set_author(&env, "Bob");
    let step2 = env.run(&[
        "set",
        p,
        "layout[Standard]",
        "extremely quick",
        "--find",
        "very quick",
    ]);
    assert_eq!(step2["modified_nodes"], json!(1));
    let text = fs::read_to_string(&file).unwrap();
    assert!(text.contains("\\change_inserted 2"), "Bob's insert");
    assert!(
        text.contains("\\change_deleted 2"),
        "Bob's deletion of Alice's insert"
    );
    assert!(
        text.contains("\\change_deleted 1"),
        "Alice's original deletion survives"
    );

    let step3 = env.run(&["undo", p, "layout[Standard]"]);
    assert!(code(&step3).is_empty(), "Bob's replay must succeed");
    let text = fs::read_to_string(&file).unwrap();
    assert!(
        !text.contains("\\change_inserted 2"),
        "Bob's insert removed"
    );
    assert!(
        !text.contains("\\change_deleted 2"),
        "Bob's deletion removed"
    );
    assert!(
        text.contains("\\change_deleted 1"),
        "Alice's deletion survives Bob's replay"
    );
    let very_quick_pos = text.find("very quick");
    let del_alice = text.find("\\change_deleted 1");
    assert!(
        very_quick_pos.is_some()
            && del_alice.is_some()
            && very_quick_pos.unwrap() < del_alice.unwrap(),
        "'very quick' must be CURRENT text sitting before Alice's surviving deletion"
    );

    set_author(&env, "Alice");
    let step4 = env.run(&["undo", p, "layout[Standard]"]);
    assert!(code(&step4).is_empty(), "Alice's replay must succeed");
    let text = fs::read_to_string(&file).unwrap();
    let doc = parse_doc(&text);
    let layout = first_layout(&doc);
    assert_eq!(
        change_marker_keys(&doc, layout).len(),
        0,
        "no change markers remain after both replays"
    );
    assert_eq!(
        text_nodes(&doc, layout),
        vec!["The ", "very quick", "quick", " brown fox"],
        "final text-node sequence equals LyX's reject chain (Rule-0 conformance pin)"
    );
}

#[test]
fn dl120_a1_first_authors_replay_undo_on_adjacent_same_type_inserts_removes_only_their_own_region_no_data_loss()
 {
    let env = MutationSession::tracked("Alice");
    let file = env.write_lyx(
        "temp_dl120_a1.lyx",
        ADJACENT_CI_CI_BODY,
        "\\author 1 \"Alice\"\n\\author 2 \"Bob\"\n",
    );
    let result = env.run(&["undo", path_arg(&file), "layout[Standard]"]);
    assert_eq!(
        result["undone_changes"],
        json!(1),
        "only Alice's insert is undone"
    );
    let doc = parse_doc(&fs::read_to_string(&file).unwrap());
    let layout = first_layout(&doc);
    assert_eq!(
        change_marker_keys(&doc, layout),
        ["change_inserted", "change_unchanged"],
        "Bob's region intact with its own closer"
    );
    assert_eq!(
        first_opener_author(&doc, layout),
        "2",
        "surviving region is Bob's (author 2)"
    );
    assert_eq!(
        all_text(&doc, layout),
        "Bob's text",
        "Bob's inserted text is not lost"
    );
}

#[test]
fn dl120_a2_second_authors_replay_undo_on_adjacent_same_type_inserts_undoes_exactly_their_region_no_false_no_op()
 {
    let env = MutationSession::tracked("Bob");
    let file = env.write_lyx(
        "temp_dl120_a2.lyx",
        ADJACENT_CI_CI_BODY,
        "\\author 1 \"Alice\"\n\\author 2 \"Bob\"\n",
    );
    let result = env.run(&["undo", path_arg(&file), "layout[Standard]"]);
    assert_eq!(result["undone_changes"], json!(1), "Bob's insert is undone");
    let doc = parse_doc(&fs::read_to_string(&file).unwrap());
    let layout = first_layout(&doc);
    assert_eq!(
        change_marker_keys(&doc, layout),
        ["change_inserted", "change_unchanged"],
        "Alice's region survives, closed"
    );
    assert_eq!(
        first_opener_author(&doc, layout),
        "1",
        "surviving region is Alice's (author 1)"
    );
    assert_eq!(
        all_text(&doc, layout),
        "Alice's text",
        "Alice's text survives"
    );
}

#[test]
fn dl120_a3_replay_undo_on_the_dl106_spanning_shape_removes_bobs_insert_and_his_deletion_world_restored_as_plain()
 {
    let env = MutationSession::tracked("Bob");
    let file = env.write_lyx(
        "temp_dl120_a3.lyx",
        ADJACENT_CI_CD_SPAN_BODY,
        "\\author 1 \"Alice\"\n\\author 2 \"Bob\"\n",
    );
    let result = env.run(&["undo", path_arg(&file), "layout[Standard]"]);
    assert_eq!(
        result["undone_changes"],
        json!(2),
        "Bob's insert and his deletion both undone"
    );
    let text = fs::read_to_string(&file).unwrap();
    assert!(!text.contains("change_inserted"), "Bob's insert removed");
    let cd_pos = text.find("\\change_deleted");
    let world_pos = text.find(" world");
    let cu_pos = text.find("\\change_unchanged");
    assert!(
        cd_pos.is_some() && world_pos.is_some() && cu_pos.is_some(),
        "markers and world present"
    );
    assert!(
        cd_pos.unwrap() < world_pos.unwrap() && world_pos.unwrap() > cu_pos.unwrap(),
        "world must sit after the deleted region's closer (plain text)"
    );
}

#[test]
fn dl87_f5_replay_undo_names_author_mismatch_when_the_change_is_another_authors() {
    let env = MutationSession::tracked("Bob");
    let file = env.write_lyx(
        "temp_dl87_f5_authormismatch.lyx",
        "\\begin_layout Standard\n\
         The quick brown fox\n\
         \\change_inserted 1 1700000000\n\
         QUICK\n\
         LY brown\n\
         \\change_unchanged\n\
          jumps over\n\
         \\end_layout\n",
        "\\author 1 \"Alice\"\n",
    );
    let result = env.run(&["undo", path_arg(&file), "layout[Standard]", "QUICK"]);
    assert_eq!(
        result["undone_changes"],
        json!(0),
        "nothing may be undone for the wrong author"
    );
    let msg = json_warnings(&result).join(" ");
    assert!(
        msg.contains("another author"),
        "warning must name the author mismatch, not 'already been undone'"
    );
    assert!(
        !msg.contains("lq init --author-name"),
        "must not suggest changing the author config without approval (dev log 102 D4)"
    );
    assert!(
        !msg.contains("already been undone"),
        "must not claim the change is gone"
    );
    assert!(
        fs::read_to_string(&file).unwrap().contains("QUICK"),
        "file must be untouched on disk"
    );
}

#[test]
fn dl78_snapshot_undo_after_untracked_set_restores_original() {
    let env = MutationSession::new();
    let file = env.write_lyx(
        "temp_dl78_undo_set.lyx",
        "\\begin_layout Standard\nOriginal text here\n\\end_layout\n",
        "",
    );
    let p = path_arg(&file);
    let expected = fs::read_to_string(&file).unwrap();
    env.run(&["set", p, "layout[Standard]", "CHANGED"]);
    let undone = env.run(&["undo", p]);
    assert_eq!(undone["method"], "snapshot");
    assert_eq!(undone["undone_changes"], json!(1));
    assert_eq!(
        fs::read_to_string(&file).unwrap(),
        expected,
        "undo after set must restore the original content (dev log 79 N2)"
    );
}

#[test]
fn dl78_snapshot_undo_after_insert_after_prepend() {
    let env = MutationSession::new();
    let file = env.write_lyx(
        "temp_dl78_undo_insert.lyx",
        "\\begin_layout Standard\nBase layout\n\\end_layout\n",
        "",
    );
    let p = path_arg(&file);
    let expected = fs::read_to_string(&file).unwrap();

    env.run(&[
        "insert",
        p,
        "layout[Standard]",
        "after",
        "--layout",
        "Standard",
        "--text",
        "SIBLING",
    ]);
    let undone = env.run(&["undo", p]);
    assert_eq!(undone["undone_changes"], json!(1));
    assert_eq!(
        fs::read_to_string(&file).unwrap(),
        expected,
        "undo after 'insert after' must restore (dev log 79 N3)"
    );

    env.run(&[
        "insert",
        p,
        "layout[Standard]",
        "prepend",
        "--footnote",
        "FN",
    ]);
    let undone = env.run(&["undo", p]);
    assert_eq!(undone["undone_changes"], json!(1));
    assert_eq!(
        fs::read_to_string(&file).unwrap(),
        expected,
        "undo after 'insert prepend' must restore (dev log 79 N3)"
    );
}

#[test]
fn dl78_snapshot_undo_after_untracked_delete_node_restored() {
    let env = MutationSession::new();
    let file = env.write_lyx(
        "temp_dl78_undo_delete.lyx",
        "\\begin_layout Standard\nKeep me\n\\end_layout\n",
        "",
    );
    let p = path_arg(&file);
    let expected = fs::read_to_string(&file).unwrap();
    env.run(&["delete", p, "layout[Standard]"]);
    let undone = env.run(&["undo", p]);
    assert_eq!(undone["undone_changes"], json!(1));
    assert_eq!(
        fs::read_to_string(&file).unwrap(),
        expected,
        "undo after delete must bring the node back (dev log 79 N3)"
    );
}

#[test]
fn dl78_snapshot_undo_1_level_enforcement_consume() {
    let env = MutationSession::new();
    let file = env.write_lyx(
        "temp_dl78_onelevel.lyx",
        "\\begin_layout Standard\nOriginal\n\\end_layout\n",
        "",
    );
    let p = path_arg(&file);
    env.run(&["set", p, "layout[Standard]", "EDIT_A"]);
    env.run(&["set", p, "layout[Standard]", "EDIT_B"]);
    let undone = env.run(&["undo", p]);
    assert_eq!(undone["undone_changes"], json!(1));
    let text = fs::read_to_string(&file).unwrap();
    assert!(text.contains("EDIT_A"));
    assert!(!text.contains("EDIT_B"));
    let stale = env.run(&["undo", p]);
    assert_eq!(code(&stale), "UNDO_STALE");
    assert!(
        fs::read_to_string(&file).unwrap().contains("EDIT_A"),
        "stale undo must not redo or modify the file"
    );
}

#[test]
fn user_report_snapshot_undo_never_falls_back_to_replay_dl94() {
    let env = MutationSession::tracked("Alice");
    let file = env.write_lyx(
        "temp_user_report_snapshot_fallback.lyx",
        "\\begin_layout Standard\nThe quick brown fox\n\\end_layout\n",
        "",
    );
    let p = path_arg(&file);
    env.run(&["set", p, "layout[Standard]", "QUICK", "--find", "quick"]);
    let tracked = fs::read_to_string(&file).unwrap();
    fs::write(&file, format!("{tracked}\n")).unwrap();
    let before_undo = fs::read_to_string(&file).unwrap();
    let result = env.run(&["undo", p]);
    assert_eq!(code(&result), "UNDO_SNAPSHOT_UNAVAILABLE");
    assert_eq!(fs::read_to_string(&file).unwrap(), before_undo);
}

#[test]
fn dl78_replay_undo_snapshot_symmetry_replay_can_be_undone() {
    let env = MutationSession::with_config(json!({ "trackChanges": true }));
    let file = env.write_lyx(
        "temp_dl78_replay_sym.lyx",
        "\\begin_layout Standard\nThe quick brown fox\n\\end_layout\n",
        "",
    );
    let p = path_arg(&file);
    env.run(&["set", p, "layout[Standard]", "QUICK", "--find", "quick"]);
    env.run(&["undo", p, "layout[Standard]", "QUICK"]);
    let restored = env.run(&["undo", p]);
    assert_eq!(restored["method"], "snapshot");
    assert_eq!(restored["undone_changes"], json!(1));
    let text = fs::read_to_string(&file).unwrap();
    assert!(text.contains("\\change_inserted"));
    assert!(text.contains("QUICK"));
}

#[test]
fn dl78_replay_undo_substring_still_works_regression() {
    let env = MutationSession::with_config(json!({ "trackChanges": true }));
    let file = env.write_lyx(
        "temp_dl78_replay.lyx",
        "\\begin_layout Standard\nThe quick brown fox\n\\end_layout\n",
        "",
    );
    let p = path_arg(&file);
    env.run(&["set", p, "layout[Standard]", "QUICK", "--find", "quick"]);
    let undone = env.run(&["undo", p, "layout[Standard]", "QUICK"]);
    assert_eq!(undone["undone_changes"], json!(1));
    assert_eq!(undone["method"], "replay");
    let text = fs::read_to_string(&file).unwrap();
    assert!(!text.contains("QUICK"), "inserted block removed");
    assert!(
        text.contains("\\change_deleted"),
        "unrelated change_deleted block preserved"
    );
    assert!(text.contains("quick"));
}

#[test]
fn dl102_replay_all_selector_no_substring_reverts_only_the_current_author() {
    let env = MutationSession::tracked("Alice");
    let file = env.write_lyx(
        "temp_dl102_replay_all.lyx",
        "\\begin_layout Standard\n\
         \\change_inserted 1 1700000000\n\
         ALICE EDIT\n\
         \\change_unchanged\n\
          base text \
         \\change_inserted 2 1700000001\n\
         BOB EDIT\n\
         \\change_unchanged\n\
         \\change_deleted 2 1700000002\n\
         BOB GONE\n\
         \\change_unchanged\n\
         \\end_layout\n",
        "\\author 1 \"Alice\"\n\\author 2 \"Bob\"\n",
    );
    let result = env.run(&["undo", path_arg(&file), "layout[Standard]"]);
    assert_eq!(result["method"], "replay");
    assert_eq!(
        result["undone_changes"],
        json!(1),
        "only Alice's inserted region is undone"
    );
    let text = fs::read_to_string(&file).unwrap();
    assert!(
        !text.contains("ALICE EDIT"),
        "Alice's inserted region removed"
    );
    assert!(text.contains("BOB EDIT"), "Bob's inserted region untouched");
    assert!(text.contains("BOB GONE"), "Bob's deleted region untouched");
}

#[test]
fn dl102_no_substring_replay_on_nodes_with_no_tracked_changes_reports_nothing_here() {
    let env = MutationSession::tracked("Alice");
    let file = env.write_lyx(
        "temp_dl102_none_here.lyx",
        "\\begin_layout Standard\nClean paragraph\n\\end_layout\n",
        "",
    );
    let result = env.run(&["undo", path_arg(&file), "layout[Standard]"]);
    assert_eq!(result["undone_changes"], json!(0));
    assert_eq!(result["method"], "replay");
    let msg = json_warnings(&result).join(" ");
    assert!(
        msg.contains("No tracked changes found in the matched nodes."),
        "must report nothing-here, not author mismatch"
    );
}

#[test]
fn dl102_no_substring_replay_on_other_author_only_nodes_reports_nothing_of_yours() {
    let env = MutationSession::tracked("Bob");
    let file = env.write_lyx(
        "temp_dl102_none_yours.lyx",
        "\\begin_layout Standard\n\
         \\change_inserted 1 1700000000\n\
         ALICE EDIT\n\
         \\change_unchanged\n\
         \\end_layout\n",
        "\\author 1 \"Alice\"\n",
    );
    let result = env.run(&["undo", path_arg(&file), "layout[Standard]"]);
    assert_eq!(result["undone_changes"], json!(0));
    let msg = json_warnings(&result).join(" ");
    assert!(
        msg.contains("none belong to author 'Bob'"),
        "must report nothing-of-yours"
    );
    assert!(
        !msg.contains("lq init --author-name"),
        "must not suggest changing the author config (dev log 102 D4)"
    );
}

#[test]
fn dl102_replay_all_warns_on_multi_node_blast_radius_and_suggests_undo() {
    let env = MutationSession::tracked("Alice");
    let file = env.write_lyx(
        "temp_dl102_blast.lyx",
        "\\begin_layout Standard\n\
         \\change_inserted 1 1700000000\n\
         EDIT ONE\n\
         \\change_unchanged\n\
         \\end_layout\n\
         \\begin_layout Standard\n\
         \\change_inserted 1 1700000001\n\
         EDIT TWO\n\
         \\change_unchanged\n\
         \\end_layout\n",
        "\\author 1 \"Alice\"\n",
    );
    let result = env.run(&["undo", path_arg(&file), "layout[Standard]"]);
    assert_eq!(result["undone_changes"], json!(2));
    let msg = json_warnings(&result).join(" ");
    assert!(
        msg.contains("Selector matches 2 nodes"),
        "multi-node replay must warn"
    );
    assert!(
        msg.contains("To undo this undo, run 'lq undo"),
        "warning must suggest the recovery path"
    );
}

#[test]
fn dl102_snapshot_restore_reports_per_entry_changes_labels_untracked() {
    let env = MutationSession::new();
    let file = env.write_lyx(
        "temp_dl102_snap_labels.lyx",
        "\\begin_layout Standard\nOriginal text here\n\\end_layout\n",
        "",
    );
    let p = path_arg(&file);
    env.run(&["set", p, "layout[Standard]", "CHANGED"]);
    let undone = env.run(&["undo", p]);
    assert_eq!(undone["method"], "snapshot");
    assert_eq!(undone["undone_changes"], json!(1));
    let labels = labels(&undone);
    assert_eq!(
        labels.len(),
        1,
        "untracked set: only the body node is a content-changing entry"
    );
    assert!(labels[0].contains("restored"));
    assert!(labels[0].contains("Original text here"));
}

#[test]
fn dl102_tracked_snapshot_restore_labels_the_header_entry() {
    let env = MutationSession::tracked("Alice");
    let file = env.write_lyx(
        "temp_dl102_snap_header.lyx",
        "\\begin_layout Standard\nOld text\n\\end_layout\n",
        "",
    );
    let p = path_arg(&file);
    env.run(&["set", p, "layout[Standard]", "NEW"]);
    let undone = env.run(&["undo", p]);
    assert_eq!(undone["method"], "snapshot");
    let labels = labels(&undone);
    assert!(
        labels.iter().any(|l| l == "header"),
        "header restore must be labeled (dev log 102 D1b)"
    );
    assert_eq!(
        undone["undone_changes"],
        json!(labels.len()),
        "count must match label count (header kept in both)"
    );
}

#[test]
fn dl103_f1_substring_replay_blast_radius_warning_names_how_many_nodes_had_reverts() {
    let env = MutationSession::tracked("Alice");
    let file = env.write_lyx(
        "temp_dl103_f1_blast.lyx",
        "\\begin_layout Standard\n\
         \\change_inserted 1 1700000000\n\
         ALICE EDIT ONE\n\
         \\change_unchanged\n\
         \\end_layout\n\
         \\begin_layout Standard\n\
         \\change_inserted 1 1700000001\n\
         ALICE EDIT TWO\n\
         \\change_unchanged\n\
         \\end_layout\n\
         \\begin_layout Standard\n\
         \\change_inserted 1 1700000002\n\
         ALICE EDIT THREE\n\
         \\change_unchanged\n\
         \\end_layout\n",
        "\\author 1 \"Alice\"\n",
    );
    let result = env.run(&["undo", path_arg(&file), "layout[Standard]", "EDIT TWO"]);
    assert_eq!(
        result["undone_changes"],
        json!(1),
        "only the substring-matching region is undone"
    );
    let msg = json_warnings(&result).join(" ");
    assert!(
        msg.contains("Selector matches 3 nodes"),
        "multi-node selector must still warn"
    );
    assert!(
        msg.contains("reverted in 1 of them"),
        "must name the actual node count, not 'all of them' (dev log 103 F1)"
    );
    assert!(
        !msg.contains("all of them"),
        "must not overstate the blast radius"
    );
}

#[test]
fn dl103_f2_no_substring_replay_on_nested_tracked_changes_reports_refine_selector_not_author_mismatch()
 {
    let env = MutationSession::tracked("Alice");
    let file = env.write_lyx(
        "temp_dl103_f2_nested.lyx",
        "\\begin_layout Standard\n\
         Body text\n\
         \\begin_inset Foot\n\
         status open\n\
         \\begin_layout Plain Layout\n\
         \\change_inserted 1 1700000000\n\
         FOOTNOTE INSERT\n\
         \\change_unchanged\n\
         \\end_layout\n\
         \\end_inset\n\
         \\end_layout\n",
        "\\author 1 \"Alice\"\n",
    );
    let result = env.run(&["undo", path_arg(&file), "inset[Foot]"]);
    assert_eq!(result["undone_changes"], json!(0));
    let msg = json_warnings(&result).join(" ");
    assert!(
        msg.contains("nested inside an inset/layout"),
        "must identify nesting, not author mismatch"
    );
    assert!(
        msg.contains("layout[Plain Layout]"),
        "must point at the innermost-layout refinement"
    );
    assert!(
        !msg.contains("none belong to author"),
        "must not claim an author mismatch"
    );
}

#[test]
fn dl103_f3_replay_on_text_only_selector_reports_blocks_only_not_no_tracked_changes() {
    let env = MutationSession::tracked("Alice");
    let file = env.write_lyx(
        "temp_dl103_f3_text.lyx",
        "\\begin_layout Standard\n\
         \\change_inserted 1 1700000000\n\
         ALICE EDIT\n\
         \\change_unchanged\n\
         \\end_layout\n",
        "\\author 1 \"Alice\"\n",
    );
    let result = env.run(&["undo", path_arg(&file), "text:change(inserted)"]);
    assert_eq!(result["undone_changes"], json!(0));
    let msg = json_warnings(&result).join(" ");
    assert!(
        msg.contains("operates on layout/inset blocks"),
        "must explain replay only processes blocks"
    );
    assert!(
        msg.contains("layout[Standard]"),
        "must suggest a block selector"
    );
    assert!(
        !msg.contains("No tracked changes found"),
        "must not claim the matched text has no tracked changes"
    );
}

#[test]
fn dl84_f5_replay_undo_reports_separate_regions_for_the_adjacent_pair() {
    let env = MutationSession::tracked("Alice");
    let file = env.write_lyx(
        "temp_dl84_f5_replay.lyx",
        ADJACENT_PAIR_BODY,
        "\\author 1 \"Alice\"\n",
    );
    let undone = env.run(&["undo", path_arg(&file), "layout[Standard]", "edit"]);
    assert_eq!(undone["method"], "replay");
    assert_eq!(undone["undone_changes"], json!(1));
    assert_eq!(
        labels(&undone),
        vec!["change_inserted{edit}"],
        "the pair must be two regions, not change_deleted{{writeedit}}"
    );
    let doc = parse_doc(&fs::read_to_string(&file).unwrap());
    let layout = first_layout(&doc);
    assert_eq!(
        change_marker_keys(&doc, layout),
        ["change_deleted", "change_unchanged"],
        "deleted region must be closed by a synthetic closer (mirror of test_report_36 F4)"
    );
    let text = all_text(&doc, layout);
    assert!(text.contains("write"));
    assert!(
        text.contains(" something with tracked changes."),
        "trailing text must survive outside the deleted region"
    );
    assert!(!text.contains("edit"));
}

#[test]
fn dl84_f2_tracked_set_find_then_snapshot_undo_is_byte_exact_header_restored() {
    let env = MutationSession::tracked("Alice");
    let file = env.write_lyx(
        "temp_dl84_f2_undo.lyx",
        "\\begin_layout Standard\nold text here\n\\end_layout\n",
        "",
    );
    let p = path_arg(&file);
    let expected = fs::read_to_string(&file).unwrap();
    env.run(&["set", p, "layout[Standard]", "NEW", "--find", "old"]);
    assert!(fs::read_to_string(&file).unwrap().contains("\\author"));
    let undone = env.run(&["undo", p]);
    assert_eq!(undone["method"], "snapshot");
    assert_eq!(
        fs::read_to_string(&file).unwrap(),
        expected,
        "tracked mutation undo must restore the file byte-identically, header included (dev log 84 F2)"
    );
}

#[test]
fn dl84_f2_tracked_delete_then_snapshot_undo_is_byte_exact_header_restored() {
    let env = MutationSession::tracked("Alice");
    let file = env.write_lyx(
        "temp_dl84_f2_undo_delete.lyx",
        "\\begin_layout Standard\nold text here\n\\end_layout\n",
        "",
    );
    let p = path_arg(&file);
    let expected = fs::read_to_string(&file).unwrap();
    env.run(&["delete", p, "layout[Standard]"]);
    assert!(fs::read_to_string(&file).unwrap().contains("\\author"));
    let undone = env.run(&["undo", p]);
    assert_eq!(undone["method"], "snapshot");
    assert_eq!(
        fs::read_to_string(&file).unwrap(),
        expected,
        "tracked delete undo must restore the file byte-identically, header included"
    );
}

#[test]
fn dl84_f2_untracked_set_undo_stays_byte_exact_and_counts_only_the_body_node() {
    let env = MutationSession::new();
    let file = env.write_lyx(
        "temp_dl84_f2_undo_untracked.lyx",
        "\\begin_layout Standard\nold text here\n\\end_layout\n",
        "",
    );
    let p = path_arg(&file);
    let expected = fs::read_to_string(&file).unwrap();
    env.run(&["set", p, "layout[Standard]", "NEW", "--find", "old"]);
    let undone = env.run(&["undo", p]);
    assert_eq!(undone["method"], "snapshot");
    assert_eq!(
        undone["undone_changes"],
        json!(1),
        "no-op header restore must not inflate the count"
    );
    assert_eq!(fs::read_to_string(&file).unwrap(), expected);
}

#[test]
fn dl84_f2_tracked_insert_cite_then_snapshot_undo_is_byte_exact_header_restored() {
    let env = MutationSession::tracked("Alice");
    let file = env.write_lyx(
        "temp_dl84_f2_undo_cite.lyx",
        "\\begin_layout Standard\nold text here\n\\end_layout\n",
        "",
    );
    let p = path_arg(&file);
    let expected = fs::read_to_string(&file).unwrap();
    env.run(&[
        "insert",
        p,
        "layout[Standard]",
        "append",
        "--cite",
        "Mena2000",
    ]);
    assert!(fs::read_to_string(&file).unwrap().contains("\\author"));
    let undone = env.run(&["undo", p]);
    assert_eq!(undone["method"], "snapshot");
    assert_eq!(
        fs::read_to_string(&file).unwrap(),
        expected,
        "tracked insert --cite undo must restore the file byte-identically, header included (code_review_85-74 Spec-4)"
    );
}

#[test]
fn dl85_f4_replay_undo_of_deleted_text_on_the_adjacent_shape_preserves_the_shared_closer() {
    let env = MutationSession::tracked("Alice");
    let file = env.write_lyx(
        "temp_dl85_f4_undo.lyx",
        ADJACENT_INSERT_DELETE_BODY,
        "\\author 1 \"Alice\"\n",
    );
    let undone = env.run(&["undo", path_arg(&file), "layout[Standard]", "Z"]);
    assert_eq!(undone["method"], "replay");
    assert_eq!(undone["undone_changes"], json!(1));
    let doc = parse_doc(&fs::read_to_string(&file).unwrap());
    let layout = first_layout(&doc);
    assert_eq!(
        change_marker_keys(&doc, layout),
        ["change_inserted", "change_unchanged"],
        "shared closer must survive to close the inserted region (test_report_36 F4)"
    );
    let text = all_text(&doc, layout);
    assert!(text.contains("X"), "inserted region preserved");
    assert!(text.contains("Z"), "deleted text restored");
    assert!(text.contains(" tail"), "trailing text plain");
}

#[test]
fn dl85_f4_mirror_control_undo_of_inserted_text_on_the_insert_delete_shape_drops_the_closer_cleanly()
 {
    let env = MutationSession::tracked("Alice");
    let file = env.write_lyx(
        "temp_dl85_f4_undo_x.lyx",
        ADJACENT_INSERT_DELETE_BODY,
        "\\author 1 \"Alice\"\n",
    );
    let undone = env.run(&["undo", path_arg(&file), "layout[Standard]", "X"]);
    assert_eq!(undone["method"], "replay");
    assert_eq!(undone["undone_changes"], json!(1));
    let doc = parse_doc(&fs::read_to_string(&file).unwrap());
    let layout = first_layout(&doc);
    assert_eq!(
        change_marker_keys(&doc, layout),
        ["change_deleted", "change_unchanged"],
        "kept deleted region keeps its own closer; no orphan or spurious closer (DL85 F4 test 2)"
    );
    let text = all_text(&doc, layout);
    assert!(!text.contains("X"), "undone inserted text removed");
    assert!(text.contains("Z"), "deleted text preserved");
    assert!(text.contains(" tail"), "trailing text plain");
}

#[test]
fn dl85_f4_undo_of_deleted_text_on_the_change_unchanged_separated_shape_drops_the_closer_no_spurious_emission()
 {
    let env = MutationSession::tracked("Alice");
    let file = env.write_lyx(
        "temp_dl85_f4_sep.lyx",
        r"\begin_layout Standard
\change_inserted 1 1700000000
X
\change_unchanged
\change_deleted 1 1700000001
Z
\change_unchanged
 tail
\end_layout
",
        "\\author 1 \"Alice\"\n",
    );
    let undone = env.run(&["undo", path_arg(&file), "layout[Standard]", "Z"]);
    assert_eq!(undone["method"], "replay");
    assert_eq!(undone["undone_changes"], json!(1));
    let doc = parse_doc(&fs::read_to_string(&file).unwrap());
    let layout = first_layout(&doc);
    assert_eq!(
        change_marker_keys(&doc, layout),
        ["change_inserted", "change_unchanged"],
        "inserted region keeps its own closer; deleted region's closer dropped; no spurious closer (DL85 F4 test 3)"
    );
    let text = all_text(&doc, layout);
    assert!(text.contains("X"));
    assert!(text.contains("Z"), "deleted text restored");
    assert!(text.contains(" tail"));
}

#[test]
fn dl121_replay_after_a_block_split_inside_a_different_author_region_leaves_no_orphan_closer() {
    let env = MutationSession::tracked("Bob");
    let file = env.write_lyx(
        "temp_dl121_replay.lyx",
        DL121_SPLIT_BODY,
        "\\author 1 \"Alice\"\n",
    );
    let p = path_arg(&file);
    env.run(&[
        "insert",
        p,
        "layout[Standard]",
        "split-after",
        "edit",
        "--footnote",
        "FN",
    ]);
    let undone = env.run(&["undo", p, "layout[Standard]"]);
    assert_eq!(
        undone["undone_changes"],
        json!(1),
        "only Bob's block undone"
    );
    let text = fs::read_to_string(&file).unwrap();
    assert!(!text.contains("begin_inset Foot"), "footnote removed");
    let doc = parse_doc(&text);
    let layout = first_layout(&doc);
    assert_eq!(
        change_marker_keys(&doc, layout),
        [
            "change_inserted",
            "change_unchanged",
            "change_inserted",
            "change_unchanged"
        ],
        "both Alice halves closed, no orphan closer"
    );
    let joined = all_text(&doc, layout);
    assert!(joined.contains("edit"));
    assert!(joined.contains("here"));
}
