//! Undo snapshots (Deno `undo.ts` library seam).

use lq::{
    ChangeKind, Document, NodeId, NodeKind, SnapshotMode, StatePaths, StateScope, clear_snapshot,
    collect_snapshots, commit_mutation, find_node_path, hash_text, load_snapshot, node_at_path,
    parse, save_snapshot, serialize, wrap_with_tracking,
};
use std::fs;
use std::path::PathBuf;

fn temp_state() -> (PathBuf, StatePaths) {
    let root = std::env::temp_dir().join(format!(
        "lq_undo_{}_{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    fs::create_dir_all(&root).unwrap();
    let state = StatePaths {
        scope: StateScope::Local,
        config: root.join("config.json"),
        cache: root.join("cache"),
        undo: root.join("undo"),
        root: root.clone(),
    };
    (root, state)
}

fn sample_doc() -> Document {
    parse(
        "#LyX 2.5 created this file.\n\
\\begin_document\n\
\\begin_header\n\
\\author 1 \"Alice\"\n\
\\end_header\n\
\\begin_body\n\
\\begin_layout Standard\nHello\n\\end_layout\n\
\\begin_layout Standard\nWorld\n\\end_layout\n\
\\end_body\n\
\\end_document\n",
        false,
    )
    .unwrap()
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
    doc.node(body).children[0]
}

fn restore(doc: &mut Document, entries: &[lq::SnapshotEntry]) {
    for e in entries {
        let target = node_at_path(doc, &e.path).expect("path");
        doc.set_children(target, e.children.clone());
    }
}

#[test]
fn find_node_path_and_node_at_path() {
    let doc = sample_doc();
    let layout = first_layout(&doc);
    let path = find_node_path(&doc, layout).expect("path");
    assert_eq!(node_at_path(&doc, &path), Some(layout));
    assert_eq!(node_at_path(&doc, &[]), Some(doc.root()));
    assert!(node_at_path(&doc, &[99]).is_none());
}

#[test]
fn collect_snapshots_self_includes_header() {
    let mut doc = sample_doc();
    let layout = first_layout(&doc);
    let original = serialize(&doc);
    let snaps = collect_snapshots(&mut doc, &[layout], SnapshotMode::OnNode);
    assert!(
        snaps
            .iter()
            .any(|e| node_at_path(&doc, &e.path) == Some(layout)),
        "layout is snapshotted in OnNode mode"
    );
    assert!(
        snaps.iter().any(|e| {
            node_at_path(&doc, &e.path).is_some_and(
                |id| matches!(&doc.node(id).kind, NodeKind::Block { tag, .. } if tag == "header"),
            )
        }),
        "header always snapshotted"
    );

    let kids = doc.node(layout).children.clone();
    let wrapped = wrap_with_tracking(&mut doc, &kids, ChangeKind::Deleted, 1, Some("9"));
    doc.set_children(layout, wrapped);
    assert_ne!(serialize(&doc), original);

    restore(&mut doc, &snaps);
    assert_eq!(serialize(&doc), original, "restore is byte-exact");
}

#[test]
fn collect_snapshots_parent_for_text_node() {
    let mut doc = sample_doc();
    let layout = first_layout(&doc);
    let text = *doc
        .node(layout)
        .children
        .iter()
        .find(|&&id| matches!(doc.node(id).kind, NodeKind::Text { .. }))
        .unwrap();
    let snaps = collect_snapshots(&mut doc, &[text], SnapshotMode::OnNode);
    let layout_entry = snaps
        .iter()
        .find(|e| node_at_path(&doc, &e.path) == Some(layout))
        .expect("text falls back to parent layout");
    assert_eq!(node_at_path(&doc, &layout_entry.path), Some(layout));
}

#[test]
fn snapshot_clone_is_independent_of_later_mutation() {
    let mut doc = sample_doc();
    let layout = first_layout(&doc);
    let snaps = collect_snapshots(&mut doc, &[layout], SnapshotMode::OnNode);
    let entry = snaps
        .iter()
        .find(|e| node_at_path(&doc, &e.path) == Some(layout))
        .unwrap();
    let snap_text = match &doc.node(entry.children[0]).kind {
        NodeKind::Text { text } => text.clone(),
        _ => panic!("expected text"),
    };
    if let NodeKind::Text { text } = &mut doc.node_mut(doc.node(layout).children[0]).kind {
        *text = "MUTATED".into();
    }
    assert_eq!(snap_text, "Hello");
    assert!(
        matches!(&doc.node(doc.node(layout).children[0]).kind, NodeKind::Text { text } if text == "MUTATED")
    );
}

#[test]
fn save_load_round_trip_and_one_level_prune() {
    let (root, state) = temp_state();
    let mut doc = sample_doc();
    let layout = first_layout(&doc);
    let snaps = collect_snapshots(&mut doc, &[layout], SnapshotMode::OnNode);
    let file = root.join("doc.lyx");
    fs::write(&file, "v1").unwrap();

    save_snapshot(&doc, &file, &snaps, "hash1", &state).unwrap();
    assert!(state.undo.join("hash1.json").is_file());

    let mut loaded_doc = sample_doc();
    let loaded = load_snapshot(&mut loaded_doc, "hash1", &state).expect("load");
    assert_eq!(loaded.entries.len(), snaps.len());

    save_snapshot(&doc, &file, &snaps, "hash2", &state).unwrap();
    assert!(
        !state.undo.join("hash1.json").is_file(),
        "1-level prune drops the previous hash for the same filePath"
    );
    assert!(state.undo.join("hash2.json").is_file());

    let _ = fs::remove_dir_all(root);
}

#[test]
fn load_missing_or_corrupt_fails_closed() {
    let (root, state) = temp_state();
    fs::create_dir_all(&state.undo).unwrap();
    let mut doc = sample_doc();
    assert!(
        load_snapshot(&mut doc, "no-such", &state).is_none(),
        "DL94: missing snapshot is None"
    );
    fs::write(state.undo.join("bad.json"), "{not json").unwrap();
    fs::write(state.undo.join("nopath.json"), "{\"entries\":[]}").unwrap();
    assert!(load_snapshot(&mut doc, "bad", &state).is_none());
    assert!(
        load_snapshot(&mut doc, "nopath", &state).is_none(),
        "missing filePath fails closed"
    );
    fs::write(
        state.undo.join("noentries.json"),
        "{\"filePath\":\"x\",\"entries\":\"nope\"}",
    )
    .unwrap();
    assert!(load_snapshot(&mut doc, "noentries", &state).is_none());
    let _ = fs::remove_dir_all(root);
}

#[test]
fn commit_mutation_keys_snapshot_by_post_hash() {
    let (root, state) = temp_state();
    let mut doc = sample_doc();
    let layout = first_layout(&doc);
    let original = serialize(&doc);
    let snaps = collect_snapshots(&mut doc, &[layout], SnapshotMode::OnNode);

    let kids = doc.node(layout).children.clone();
    let wrapped = wrap_with_tracking(&mut doc, &kids, ChangeKind::Inserted, 1, Some("9"));
    doc.set_children(layout, wrapped);

    let file = root.join("doc.lyx");
    let committed = commit_mutation(&doc, &file, &snaps, &state).unwrap();
    assert!(committed.snapshot_ok);
    let written = fs::read_to_string(&file).unwrap();
    assert_eq!(written, serialize(&doc));
    let post = hash_text(&written);
    assert!(state.undo.join(format!("{post}.json")).is_file());
    assert_ne!(written, original);

    let mut restored = parse(&written, false).unwrap();
    let loaded = load_snapshot(&mut restored, &post, &state).expect("snapshot");
    restore(&mut restored, &loaded.entries);
    assert_eq!(serialize(&restored), original);

    clear_snapshot(&post, &state);
    assert!(!state.undo.join(format!("{post}.json")).is_file());
    let _ = fs::remove_dir_all(root);
}
