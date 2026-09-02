//! `lq delete` (Deno `cli.ts` delete branch).

use super::common::{CliError, print_json};
use super::mutate::{
    MutationEnv, assert_tracking_header, brief_text, commit_and_refresh, node_label, now_ts,
};
use crate::ast::{Document, NodeId, NodeKind};
use crate::tracked_changes::{
    ChangeKind, apply_tracked_delete_to_children, ensure_tracking_changes_in_header,
    resolve_author_id, wrap_with_tracking,
};
use crate::undo::{SnapshotMode, collect_snapshots};
use serde_json::json;
use std::collections::HashSet;

pub fn run_delete(
    doc: &mut Document,
    nodes: &[NodeId],
    env: &MutationEnv<'_>,
) -> Result<(), CliError> {
    if nodes.is_empty() {
        let selector = env.selector.unwrap_or("");
        return Err(CliError::new(
            "NO_MATCH",
            format!(
                "Selector matched no nodes to delete. Run 'lq read {} \"{selector}\" --count' to verify or refine the selector.",
                env.file_path
            ),
        ));
    }

    let pre = collect_snapshots(doc, nodes, SnapshotMode::OnParent);
    assert_tracking_header(doc, env.track_changes)?;

    if env.track_changes {
        let author_id = resolve_author_id(doc, env.author_name);
        let delete_ts = now_ts();
        ensure_tracking_changes_in_header(doc);
        let mark: HashSet<NodeId> = nodes.iter().copied().collect();
        let root_kids = doc.node(doc.root()).children.clone();
        let new_root = mark_as_deleted(doc, &root_kids, true, &mark, author_id, &delete_ts, env)?;
        doc.set_children(doc.root(), new_root);
        commit_and_refresh(doc, env.file_path, &pre, env.state, env.refresh)?;
        let changes: Vec<_> = nodes
            .iter()
            .map(|&n| {
                json!({
                    "label": node_label(doc, n),
                    "text": brief_text(doc, n, 80),
                })
            })
            .collect();
        print_json(json!({
            "tracked_deleted_nodes": nodes.len(),
            "changes": changes,
        }));
        return Ok(());
    }

    let to_delete: HashSet<NodeId> = nodes.iter().copied().collect();
    let root_kids = doc.node(doc.root()).children.clone();
    let new_root = filter_deleted(doc, &root_kids, &to_delete);
    doc.set_children(doc.root(), new_root);
    commit_and_refresh(doc, env.file_path, &pre, env.state, env.refresh)?;
    let changes: Vec<_> = nodes
        .iter()
        .map(|&n| {
            json!({
                "label": node_label(doc, n),
                "text": brief_text(doc, n, 80),
            })
        })
        .collect();
    print_json(json!({
        "deleted_nodes": nodes.len(),
        "changes": changes,
    }));
    Ok(())
}

fn filter_deleted(
    doc: &mut Document,
    children: &[NodeId],
    to_delete: &HashSet<NodeId>,
) -> Vec<NodeId> {
    let mut out = Vec::new();
    for &child in children {
        if to_delete.contains(&child) {
            continue;
        }
        if matches!(doc.node(child).kind, NodeKind::Block { .. }) {
            let kids = doc.node(child).children.clone();
            let filtered = filter_deleted(doc, &kids, to_delete);
            doc.set_children(child, filtered);
        }
        out.push(child);
    }
    out
}

fn mark_as_deleted(
    doc: &mut Document,
    children: &[NodeId],
    in_paragraph: bool,
    mark: &HashSet<NodeId>,
    author_id: i32,
    ts: &str,
    env: &MutationEnv<'_>,
) -> Result<Vec<NodeId>, CliError> {
    let mut children = if in_paragraph {
        apply_tracked_delete_to_children(
            doc,
            children,
            |_, n| mark.contains(&n),
            author_id,
            ts,
            false,
        )
    } else {
        children.to_vec()
    };
    let mut i = children.len();
    while i > 0 {
        i -= 1;
        let child = children[i];
        if mark.contains(&child) {
            if let NodeKind::Block { tag, .. } = &doc.node(child).kind {
                let tag = tag.clone();
                if tag == "inset" {
                    if !in_paragraph {
                        return Err(CliError::new(
                            "TRACKING_ERROR",
                            format!(
                                "Cannot track-delete an inset nested inside another inset.\n\
Use 'lq set' on the enclosing inset's text content to mark changes,\n\
or delete the enclosing structure.\n\
Run 'lq read {} \"{}\" --count' to verify the target.",
                                env.file_path,
                                env.selector.unwrap_or("")
                            ),
                        ));
                    }
                } else {
                    let inner = doc.node(child).children.clone();
                    let folded = apply_tracked_delete_to_children(
                        doc,
                        &inner,
                        |_, _| true,
                        author_id,
                        ts,
                        true,
                    );
                    doc.set_children(child, folded);
                }
            } else if matches!(doc.node(child).kind, NodeKind::Text { .. }) && !in_paragraph {
                let wrapped =
                    wrap_with_tracking(doc, &[child], ChangeKind::Deleted, author_id, Some(ts));
                children.splice(i..i + 1, wrapped);
            }
        } else if matches!(doc.node(child).kind, NodeKind::Block { .. }) {
            let tag = match &doc.node(child).kind {
                NodeKind::Block { tag, .. } => tag.clone(),
                _ => unreachable!("invariant: block"),
            };
            let inner = doc.node(child).children.clone();
            let next = mark_as_deleted(doc, &inner, tag == "layout", mark, author_id, ts, env)?;
            doc.set_children(child, next);
        }
    }
    Ok(children)
}
