//! `lq undo` (Deno `cli.ts` undo branch).

use super::common::{CliError, print_json, push_warning};
use super::mutate::{
    MutationEnv, alloc_prop, brief_children_text, commit_and_refresh, warn_refresh_post,
};
use crate::ast::{Document, NodeId, NodeKind};
use crate::cache::{hash_file, hash_text, node_to_json, set_cached_ast};
use crate::serializer::serialize;
use crate::tracked_changes::{
    get_header, has_direct_tracked_changes, has_tracked_changes, is_change_opener,
    parse_change_marker, resolve_author_id, scan_region_end,
};
use crate::undo::{
    SnapshotMode, clear_snapshot, collect_snapshots, find_node_path, load_snapshot, node_at_path,
};
use serde_json::json;
use std::path::Path;

pub fn run_undo(
    doc: &mut Document,
    nodes: &[NodeId],
    env: &MutationEnv<'_>,
) -> Result<(), CliError> {
    let substring = if env.rest.is_empty() {
        None
    } else {
        Some(env.rest.join(" "))
    };

    if env.selector.is_none() {
        return snapshot_undo(doc, env);
    }

    if nodes.is_empty() {
        let selector = env.selector.unwrap_or("");
        return Err(CliError::new(
            "NO_MATCH",
            format!(
                "Selector matched no nodes to undo. Run 'lq read {} \"{selector}\" --count' to verify or refine the selector.",
                env.file_path
            ),
        ));
    }

    let pre = collect_snapshots(doc, nodes, SnapshotMode::OnNode);
    let undo_author_id = resolve_author_id(doc, env.author_name);
    let mut undone_count = 0usize;
    let mut any_contains_other = false;
    let mut undone_labels: Vec<String> = Vec::new();
    let mut nodes_with_reverts = 0usize;

    for &node in nodes {
        if !matches!(doc.node(node).kind, NodeKind::Block { .. }) {
            continue;
        }
        let mut node_undone = 0usize;
        let mut new_children: Vec<NodeId> = Vec::new();
        let children = doc.node(node).children.clone();
        let mut i = 0;
        let mut open_inserted = false;
        let mut open_deleted = false;
        while i < children.len() {
            let child = children[i];
            if let NodeKind::Property { key, value } = &doc.node(child).kind
                && is_change_opener(key)
            {
                let marker_type = key.clone();
                let change_author = parse_change_marker(value.as_deref()).author_id;
                let scanned = scan_region_end(doc, &children, i + 1, &marker_type, true);
                if scanned.closer.is_none() && scanned.next_opener.is_none() {
                    new_children.push(child);
                    i += 1;
                    continue;
                }
                let region_end = scanned
                    .closer
                    .or(scanned.next_opener)
                    .unwrap_or(children.len());
                let next_start = scanned
                    .closer
                    .map(|c| c + 1)
                    .or(scanned.next_opener)
                    .unwrap_or(i + 1);
                let mut text_parts = String::new();
                for &n in &children[i + 1..region_end] {
                    if let NodeKind::Text { text } = &doc.node(n).kind {
                        text_parts.push_str(text);
                    }
                }
                let should_undo = substring.as_ref().is_none_or(|s| text_parts.contains(s));
                let will_undo = change_author == undo_author_id && should_undo;
                if substring.is_some() && should_undo && !will_undo {
                    any_contains_other = true;
                }
                if will_undo {
                    if marker_type == "change_deleted" {
                        if open_inserted {
                            new_children.push(alloc_prop(doc, "change_unchanged", None));
                            open_inserted = false;
                        }
                        if open_deleted {
                            new_children.push(alloc_prop(doc, "change_unchanged", None));
                            open_deleted = false;
                        }
                        new_children.extend_from_slice(&children[i + 1..region_end]);
                    }
                    if marker_type == "change_inserted" {
                        if open_deleted {
                            new_children.push(alloc_prop(doc, "change_unchanged", None));
                            open_deleted = false;
                        }
                        if open_inserted {
                            new_children.push(alloc_prop(doc, "change_unchanged", None));
                            open_inserted = false;
                        }
                    }
                    i = next_start;
                    undone_count += 1;
                    node_undone += 1;
                    let label_text = if text_parts.len() > 60 {
                        format!("{}...", &text_parts[..60])
                    } else {
                        text_parts
                    };
                    undone_labels.push(format!("{marker_type}{{{label_text}}}"));
                } else {
                    new_children.extend_from_slice(&children[i..next_start]);
                    i = next_start;
                    if marker_type == "change_inserted" {
                        open_deleted = false;
                        if scanned.closer.is_none() {
                            open_inserted = true;
                        }
                    } else if marker_type == "change_deleted" {
                        open_inserted = false;
                        open_deleted = scanned.closer.is_none();
                    }
                }
            } else {
                new_children.push(child);
                i += 1;
            }
        }
        doc.set_children(node, new_children);
        if node_undone > 0 {
            nodes_with_reverts += 1;
        }
    }

    let changes: Vec<_> = undone_labels
        .iter()
        .map(|l| json!({ "label": l }))
        .collect();
    if let Some(ref sub) = substring
        && undone_count == 0
    {
        if any_contains_other {
            push_warning(format!(
                "A tracked change matching '{sub}' exists but belongs to another author. Undo only reverts author '{}'.",
                env.author_name
            ));
        } else {
            push_warning(format!(
                "No tracked change matching '{sub}' found. It may have already been undone. To revert the last undo, run 'lq undo {}'.",
                env.file_path
            ));
        }
    }
    if substring.is_none() && undone_count == 0 {
        let has_block = nodes
            .iter()
            .any(|&n| matches!(doc.node(n).kind, NodeKind::Block { .. }));
        if !has_block {
            push_warning(
                "Replay undo operates on layout/inset blocks; the selector matched only text/property nodes. Use a block selector such as 'layout[Standard]'.",
            );
        } else {
            let has_any = nodes.iter().any(|&n| {
                matches!(doc.node(n).kind, NodeKind::Block { .. })
                    && has_tracked_changes(doc, &doc.node(n).children)
            });
            if !has_any {
                push_warning("No tracked changes found in the matched nodes.");
            } else {
                let has_direct = nodes.iter().any(|&n| {
                    matches!(doc.node(n).kind, NodeKind::Block { .. })
                        && has_direct_tracked_changes(doc, &doc.node(n).children)
                });
                if !has_direct {
                    push_warning(
                        "Tracked changes exist in the matched nodes but nested inside an inset/layout. Refine the selector to the innermost layout (e.g. 'layout[Plain Layout]').",
                    );
                } else {
                    push_warning(format!(
                        "Tracked changes exist in the matched nodes but none belong to author '{}'.",
                        env.author_name
                    ));
                }
            }
        }
    }
    if undone_count > 0 && nodes.len() > 1 {
        push_warning(format!(
            "Selector matches {} nodes; the current author's changes were reverted in {nodes_with_reverts} of them. To undo this undo, run 'lq undo {}'.",
            nodes.len(),
            env.file_path
        ));
    }
    if undone_count > 0 {
        commit_and_refresh(doc, env.file_path, &pre, env.state, env.refresh)?;
    }
    print_json(json!({
        "undone_changes": undone_count,
        "changes": changes,
        "method": "replay",
    }));
    Ok(())
}

fn snapshot_undo(doc: &mut Document, env: &MutationEnv<'_>) -> Result<(), CliError> {
    let mut snapshot_failure = "No snapshot found for the current file content.".to_string();
    let current_hash = match hash_file(Path::new(env.file_path)) {
        Ok(h) => h,
        Err(_) => {
            return Err(CliError::new(
                "FILE_NOT_FOUND",
                format!("Could not read file: {}", env.file_path),
            ));
        }
    };
    if let Some(snapshot) = load_snapshot(doc, &current_hash, env.state) {
        let mut restored_count = 0usize;
        let mut missing_count = 0usize;
        let mut restored_labels: Vec<String> = Vec::new();
        let header_path = get_header(doc).and_then(|h| find_node_path(doc, h));
        let mut sorted = snapshot.entries;
        let entries_len = sorted.len();
        sorted.sort_by_key(|e| e.path.len());
        for entry in &sorted {
            let Some(target) = node_at_path(doc, &entry.path) else {
                missing_count += 1;
                continue;
            };
            let before: Vec<_> = doc
                .node(target)
                .children
                .iter()
                .map(|&id| node_to_json(doc, id))
                .collect();
            let after: Vec<_> = entry
                .children
                .iter()
                .map(|&id| node_to_json(doc, id))
                .collect();
            doc.set_children(target, entry.children.clone());
            if before != after {
                restored_count += 1;
                let is_header = header_path.as_ref().is_some_and(|hp| hp == &entry.path);
                restored_labels.push(if is_header {
                    "header".into()
                } else {
                    format!(
                        "restored [{}] \"{}\"",
                        entry
                            .path
                            .iter()
                            .map(|i| i.to_string())
                            .collect::<Vec<_>>()
                            .join("."),
                        brief_children_text(doc, &entry.children, 60)
                    )
                });
            }
        }
        if restored_count > 0 {
            if missing_count > 0 {
                push_warning(format!(
                    "Restored {restored_count} of {entries_len} snapshot entries — the document structure changed since the snapshot. Verify with 'lq read {}'.",
                    env.file_path
                ));
            }
            let new_text = serialize(doc);
            if let Err(e) = std::fs::write(env.file_path, &new_text) {
                return Err(CliError::new(
                    "WRITE_ERROR",
                    format!("Failed to write file: {e}"),
                ));
            }
            let post_hash = hash_text(&new_text);
            set_cached_ast(&post_hash, doc, env.state);
            clear_snapshot(&current_hash, env.state);
            warn_refresh_post(env.file_path, env.refresh);
            let changes: Vec<_> = restored_labels
                .iter()
                .map(|l| json!({ "label": l }))
                .collect();
            print_json(json!({
                "undone_changes": restored_count,
                "changes": changes,
                "method": "snapshot",
            }));
            return Ok(());
        }
        snapshot_failure =
            "A snapshot was found, but the document structure changed before it could be restored."
                .into();
    }

    if !has_tracked_changes(doc, &doc.node(doc.root()).children) {
        return Err(CliError::new(
            "UNDO_STALE",
            "Nothing to undo. No snapshot found and no tracked changes to revert.",
        ));
    }
    Err(CliError::new(
        "UNDO_SNAPSHOT_UNAVAILABLE",
        format!(
            "{snapshot_failure} Possibly because a previous 'undo' already consumed the snapshot \
(snapshot restore is 1-level) or because the file was changed externally. \
To replay tracked changes, provide a selector: \
'lq undo <file> <selector> [<substring>]'. Replay does not restore a paired set edit as one unit."
        ),
    ))
}
