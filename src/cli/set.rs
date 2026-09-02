//! `lq set` (Deno `cli.ts` set branch).

use super::common::{CliError, print_json, push_warning};
use super::mutate::{
    MutationEnv, alloc_text, assert_tracking_header, brief_text, collect_text_parents,
    commit_and_refresh, count_occurrences, node_label, now_ts, phrase_only_in_invisible_content,
    set_prop_value, set_text,
};
use crate::ast::{Document, NodeId, NodeKind};
use crate::query::build_scope_predicate;
use crate::text_utils::{TextRegion, region_at};
use crate::tracked_changes::{
    ChangeKind, apply_cross_node_replace, ensure_tracking_changes_in_header,
    flatten_nested_changes, has_tracked_changes, parse_change_marker, resolve_author_id,
    scan_region_end, wrap_in_change_markers,
};
use crate::undo::{SnapshotMode, collect_snapshots};
use serde_json::json;
use std::collections::HashSet;

pub fn run_set(
    doc: &mut Document,
    nodes: &[NodeId],
    env: &MutationEnv<'_>,
) -> Result<(), CliError> {
    let flags = env.flags;
    let replace_all = flags.bool("replace-all");
    let find_str = flags.str("find").map(str::to_string);

    if nodes.is_empty() {
        let selector = env.selector.unwrap_or("");
        return Err(CliError::new(
            "NO_MATCH",
            format!(
                "Selector matched no nodes to set. Run 'lq read {} \"{selector}\" --count' to verify or refine the selector.",
                env.file_path
            ),
        ));
    }

    if find_str.is_some() && replace_all {
        return Err(CliError::new(
            "FLAG_CONFLICT",
            "--find and --replace-all are mutually exclusive. --find does surgical substring replacement; --replace-all wipes all children.",
        ));
    }
    if let Some(ref f) = find_str
        && f.is_empty()
    {
        return Err(CliError::new(
            "INVALID_FLAG",
            "--find requires a non-empty substring to search for.",
        ));
    }
    if env.rest.is_empty() {
        return Err(CliError::new(
            "MISSING_ARGS",
            "A new text value is required for the 'set' command.",
        ));
    }
    let new_value = env.rest.join(" ");
    let selector = env.selector.expect("invariant: set requires a selector");
    let scope = build_scope_predicate(selector).unwrap_or(None);

    let mut total_find_matches = 0usize;
    let mut find_nodes_with_hits = 0usize;
    let mut total_deleted_hits = 0usize;
    let mut total_crossed_inset = 0usize;
    let mut find_per_node: Vec<(String, usize)> = Vec::new();

    let text_parents = collect_text_parents(doc);
    let mut processed_parents: HashSet<NodeId> = HashSet::new();

    let pre_snapshots = collect_snapshots(doc, nodes, SnapshotMode::OnNode);
    assert_tracking_header(doc, env.track_changes)?;

    let tc_ts = if env.track_changes {
        now_ts()
    } else {
        String::new()
    };
    let tc_aid = if env.track_changes {
        resolve_author_id(doc, env.author_name)
    } else {
        0
    };

    for &node in nodes {
        match &doc.node(node).kind.clone() {
            NodeKind::Property { value, key } => {
                let key = key.clone();
                if let Some(ref find) = find_str {
                    if let Some(val) = value.clone() {
                        let count = count_occurrences(&val, find);
                        if count > 0 {
                            let replaced = val.replace(find, &new_value);
                            set_prop_value(doc, node, &key, Some(&replaced));
                            total_find_matches += count;
                            find_nodes_with_hits += 1;
                            add_count(&mut find_per_node, "property", count);
                        }
                    }
                } else {
                    set_prop_value(doc, node, &key, Some(&new_value));
                }
            }
            NodeKind::Block { tag, .. } => {
                let tag = tag.clone();
                if tag == "inset" {
                    if env.track_changes {
                        return Err(CliError::new(
                            "TRACKING_ERROR",
                            "Cannot track changes inside inset parameters — LyX does not track them either.\n\
Alternatives:\n  - Delete the old inset + insert a new one (both operations are reviewable when tracking is on)\n  - Disable tracking first ('lq init --track-changes off'), then re-run this command\n    (untracked '--find' does surgical edits to inset metadata without corrupting it)",
                        ));
                    }
                    if find_str.is_none() && !replace_all {
                        return Err(CliError::new(
                            "INVALID_CONTEXT",
                            "Default 'set' on an inset would destroy its structure (e.g. wiping LatexCommand and name lines).\n\
Use one of:\n  --find <substring>   surgical replacement of a parameter value (stays on one line; requires tracking off)\n  --replace-all        deliberate full replacement — wipes ALL children, including LatexCommand\n  --raw-file           for complete structural rewrites via insert",
                        ));
                    }
                }
                if let Some(ref find) = find_str {
                    let inherited = env.traversal.get(&node);
                    let result = apply_cross_node_replace(
                        doc,
                        node,
                        find,
                        &new_value,
                        env.track_changes,
                        tc_aid,
                        &tc_ts,
                        scope.as_ref(),
                        inherited,
                    );
                    let new_children = if env.track_changes {
                        flatten_nested_changes(doc, &result.new_children)
                    } else {
                        result.new_children
                    };
                    total_find_matches += result.match_count;
                    total_deleted_hits += result.deleted_hit_count;
                    total_crossed_inset += result.crossed_inset_count;
                    if result.match_count > 0 {
                        find_nodes_with_hits += 1;
                        add_count(
                            &mut find_per_node,
                            &node_label(doc, node),
                            result.match_count,
                        );
                    }
                    doc.set_children(node, new_children);
                } else if env.track_changes {
                    let children = doc.node(node).children.clone();
                    if has_tracked_changes(doc, &children) || !replace_all {
                        let rebuilt =
                            build_tracked_full_replace(doc, &children, &new_value, tc_aid, &tc_ts);
                        doc.set_children(node, rebuilt);
                    } else {
                        let has_wipe = children.iter().any(|&n| match &doc.node(n).kind {
                            NodeKind::Text { text } => !text.is_empty(),
                            _ => true,
                        });
                        let wrapped_del = if has_wipe {
                            let w = wrap_in_change_markers(
                                doc,
                                &children,
                                ChangeKind::Deleted,
                                tc_aid,
                                &tc_ts,
                            );
                            w[..w.len() - 1].to_vec()
                        } else {
                            Vec::new()
                        };
                        let new_text = alloc_text(doc, &new_value);
                        let wrapped_ins = wrap_in_change_markers(
                            doc,
                            &[new_text],
                            ChangeKind::Inserted,
                            tc_aid,
                            &tc_ts,
                        );
                        let mut out = wrapped_del;
                        out.extend(wrapped_ins);
                        doc.set_children(node, out);
                    }
                } else if replace_all {
                    let t = alloc_text(doc, &new_value);
                    doc.set_children(node, vec![t]);
                } else {
                    let insets: Vec<NodeId> = doc
                        .node(node)
                        .children
                        .iter()
                        .copied()
                        .filter(|&c| matches!(doc.node(c).kind, NodeKind::Block { .. }))
                        .collect();
                    let mut kids = vec![alloc_text(doc, &new_value)];
                    kids.extend(insets);
                    doc.set_children(node, kids);
                }
            }
            NodeKind::Text { text } => {
                let text = text.clone();
                let parent_ctx = text_parents.get(&node).copied();
                let node_state = env.traversal.get(&node);
                let node_region = if let Some(state) = node_state {
                    crate::text_utils::traversal_region(state)
                } else if let Some((parent, index)) = parent_ctx {
                    region_at(doc, parent, index)
                } else {
                    TextRegion::Current
                };
                if let Some(ref find) = find_str {
                    if let Some((parent, _)) = parent_ctx
                        && node_region != TextRegion::Current
                    {
                        if processed_parents.insert(parent) {
                            let inherited = parent_ctx.and_then(|(p, _)| env.traversal.get(&p));
                            let result = apply_cross_node_replace(
                                doc,
                                parent,
                                find,
                                &new_value,
                                env.track_changes,
                                tc_aid,
                                &tc_ts,
                                scope.as_ref(),
                                inherited,
                            );
                            let new_children = if env.track_changes {
                                flatten_nested_changes(doc, &result.new_children)
                            } else {
                                result.new_children
                            };
                            total_find_matches += result.match_count;
                            total_deleted_hits += result.deleted_hit_count;
                            total_crossed_inset += result.crossed_inset_count;
                            if result.match_count > 0 {
                                find_nodes_with_hits += 1;
                                add_count(&mut find_per_node, "text", result.match_count);
                            }
                            doc.set_children(parent, new_children);
                        }
                    } else {
                        let count = count_occurrences(&text, find);
                        if count > 0 {
                            if env.track_changes
                                && let Some((parent, _)) = parent_ctx
                            {
                                let kids = doc.node(parent).children.clone();
                                if let Some(idx) = kids.iter().position(|&id| id == node) {
                                    let replacement = build_tracked_direct_text_replacement(
                                        doc,
                                        &text,
                                        Some(find),
                                        &new_value,
                                        tc_aid,
                                        &tc_ts,
                                    );
                                    let mut new_kids = kids;
                                    new_kids.splice(idx..idx + 1, replacement.nodes);
                                    total_find_matches += replacement.match_count;
                                    find_nodes_with_hits += 1;
                                    add_count(&mut find_per_node, "text", replacement.match_count);
                                    doc.set_children(parent, new_kids);
                                }
                            } else {
                                set_text(doc, node, &text.replace(find, &new_value));
                                total_find_matches += count;
                                find_nodes_with_hits += 1;
                                add_count(&mut find_per_node, "text", count);
                            }
                        }
                    }
                } else if env.track_changes
                    && let Some((parent, _)) = parent_ctx
                    && node_region == TextRegion::Current
                {
                    let kids = doc.node(parent).children.clone();
                    if let Some(idx) = kids.iter().position(|&id| id == node) {
                        let replacement = build_tracked_direct_text_replacement(
                            doc, &text, None, &new_value, tc_aid, &tc_ts,
                        );
                        let mut new_kids = kids;
                        new_kids.splice(idx..idx + 1, replacement.nodes);
                        doc.set_children(parent, new_kids);
                    }
                } else if env.track_changes
                    && let Some((parent, _)) = parent_ctx
                    && node_region != TextRegion::Current
                {
                    let kids = doc.node(parent).children.clone();
                    if let Some(idx) = kids.iter().position(|&id| id == node) {
                        if text.is_empty() {
                            let replacement = build_tracked_direct_text_replacement(
                                doc, &text, None, &new_value, tc_aid, &tc_ts,
                            );
                            let mut new_kids = kids;
                            new_kids.splice(idx..idx + 1, replacement.nodes);
                            doc.set_children(parent, new_kids);
                        } else {
                            let tmp = doc.alloc(NodeKind::Block {
                                tag: "_set_tmp".into(),
                                args: None,
                                is_begin_variant: true,
                            });
                            doc.set_children(tmp, vec![node]);
                            let result = apply_cross_node_replace(
                                doc,
                                tmp,
                                &text,
                                &new_value,
                                true,
                                tc_aid,
                                &tc_ts,
                                scope.as_ref(),
                                node_state,
                            );
                            let flat = flatten_nested_changes(doc, &result.new_children);
                            let mut new_kids = kids;
                            new_kids.splice(idx..idx + 1, flat);
                            doc.set_children(parent, new_kids);
                        }
                    }
                } else {
                    set_text(doc, node, &new_value);
                }
            }
            NodeKind::Document => {}
        }
    }

    if let Some(ref find) = find_str {
        if total_find_matches == 0 {
            let mut msg = format!(
                "--find '{find}' matched no occurrences within the targeted nodes. Run 'lq read {} \"{selector}\" --text-only' to inspect their text.",
                env.file_path
            );
            if total_crossed_inset > 0 {
                msg.push_str(
                    " The phrase spans an inset (citation/footnote) — matches cannot cross an inset; split the phrase or use full 'set' to replace the whole text.",
                );
            }
            let note_scope = crate::query::selector_note_scope(selector).unwrap_or(false);
            if !note_scope && phrase_only_in_invisible_content(doc, find) {
                msg.push_str(
                    " The phrase exists only inside a private note (Note/Comment) — add ':note' to the selector to target note prose.",
                );
            }
            return Err(CliError::new("NO_MATCH", msg));
        }
        let plural = if total_find_matches == 1 { "" } else { "s" };
        let node_list = find_per_node
            .iter()
            .map(|(k, c)| {
                let occ = if *c == 1 { "" } else { "s" };
                format!("{k} ({c} occurrence{occ})")
            })
            .collect::<Vec<_>>()
            .join(", ");
        let mut find_msg = format!(
            "--find matched {total_find_matches} occurrence{plural} of '{find}' across {find_nodes_with_hits} node(s): {node_list}. To target a specific occurrence, use a longer unique substring (include surrounding words)."
        );
        if total_deleted_hits > 0 {
            let del_plural = if total_deleted_hits == 1 { "" } else { "s" };
            find_msg.push_str(&format!(
                " {total_deleted_hits} occurrence{del_plural} matched inside \\change_deleted (rejected text) — the replacement is inserted as a new tracked change adjacent to the deletion; scope with :change(current|inserted|deleted) to target a region."
            ));
        }
        push_warning(find_msg);
    }

    if env.track_changes {
        ensure_tracking_changes_in_header(doc);
    }
    commit_and_refresh(doc, env.file_path, &pre_snapshots, env.state, env.refresh)?;
    let reported = if find_str.is_some() {
        find_nodes_with_hits
    } else {
        nodes.len()
    };
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
        "modified_nodes": reported,
        "changes": changes,
    }));
    Ok(())
}

fn add_count(find_per_node: &mut Vec<(String, usize)>, key: &str, count: usize) {
    if let Some((_, n)) = find_per_node.iter_mut().find(|(k, _)| k == key) {
        *n += count;
    } else {
        find_per_node.push((key.to_string(), count));
    }
}

fn build_tracked_full_replace(
    doc: &mut Document,
    children: &[NodeId],
    new_value: &str,
    tc_aid: i32,
    tc_ts: &str,
) -> Vec<NodeId> {
    let mut reauthor: Vec<NodeId> = Vec::new();
    let mut preserved: Vec<NodeId> = Vec::new();
    let mut insets: Vec<NodeId> = Vec::new();
    let mut i = 0;
    while i < children.len() {
        let c = children[i];
        if let NodeKind::Property { key, .. } = &doc.node(c).kind
            && crate::tracked_changes::is_change_opener(key)
        {
            let key = key.clone();
            let scanned = scan_region_end(doc, children, i + 1, &key, true);
            if scanned.closer.is_none() && scanned.next_opener.is_none() {
                reauthor.push(c);
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
            if key == "change_deleted" {
                preserved.push(c);
                preserved.extend_from_slice(&children[i + 1..region_end]);
                if let Some(closer) = scanned.closer {
                    preserved.push(children[closer]);
                } else {
                    preserved.push(alloc_unchanged(doc));
                }
                i = next_start;
            } else {
                let author = match &doc.node(c).kind {
                    NodeKind::Property { value, .. } => {
                        parse_change_marker(value.as_deref()).author_id
                    }
                    _ => 0,
                };
                if author == tc_aid {
                    i = next_start;
                } else {
                    for &k in &children[i + 1..region_end] {
                        if matches!(doc.node(k).kind, NodeKind::Block { .. }) {
                            insets.push(k);
                        } else {
                            reauthor.push(k);
                        }
                    }
                    i = next_start;
                }
            }
        } else if matches!(doc.node(c).kind, NodeKind::Block { .. }) {
            insets.push(c);
            i += 1;
        } else {
            reauthor.push(c);
            i += 1;
        }
    }
    let reauthor_wrap = if reauthor.is_empty() {
        Vec::new()
    } else {
        wrap_in_change_markers(doc, &reauthor, ChangeKind::Deleted, tc_aid, tc_ts)
    };
    let new_text = alloc_text(doc, new_value);
    let new_value_wrap =
        wrap_in_change_markers(doc, &[new_text], ChangeKind::Inserted, tc_aid, tc_ts);
    let share_closer = !reauthor.is_empty() && preserved.is_empty();
    let mut out = Vec::new();
    if share_closer && !reauthor_wrap.is_empty() {
        out.extend_from_slice(&reauthor_wrap[..reauthor_wrap.len() - 1]);
    } else {
        out.extend(reauthor_wrap);
    }
    out.extend(preserved);
    out.extend(new_value_wrap);
    out.extend(insets);
    out
}

fn alloc_unchanged(doc: &mut Document) -> NodeId {
    doc.alloc(NodeKind::Property {
        key: "change_unchanged".into(),
        value: None,
    })
}

struct DirectReplace {
    nodes: Vec<NodeId>,
    match_count: usize,
}

fn build_tracked_direct_text_replacement(
    doc: &mut Document,
    text: &str,
    find_str: Option<&str>,
    new_value: &str,
    author_id: i32,
    ts: &str,
) -> DirectReplace {
    let Some(find) = find_str else {
        let old = alloc_text(doc, text);
        let new = alloc_text(doc, new_value);
        let mut nodes = wrap_in_change_markers(doc, &[old], ChangeKind::Deleted, author_id, ts);
        nodes.extend(wrap_in_change_markers(
            doc,
            &[new],
            ChangeKind::Inserted,
            author_id,
            ts,
        ));
        return DirectReplace {
            nodes,
            match_count: 0,
        };
    };
    let mut nodes = Vec::new();
    let mut cursor = 0;
    let mut match_count = 0;
    while let Some(found) = text[cursor..].find(find) {
        let match_start = cursor + found;
        if match_start > cursor {
            nodes.push(alloc_text(doc, &text[cursor..match_start]));
        }
        let old = alloc_text(doc, &text[match_start..match_start + find.len()]);
        nodes.extend(wrap_in_change_markers(
            doc,
            &[old],
            ChangeKind::Deleted,
            author_id,
            ts,
        ));
        let new = alloc_text(doc, new_value);
        nodes.extend(wrap_in_change_markers(
            doc,
            &[new],
            ChangeKind::Inserted,
            author_id,
            ts,
        ));
        cursor = match_start + find.len();
        match_count += 1;
    }
    if match_count == 0 {
        return DirectReplace {
            nodes: vec![alloc_text(doc, text)],
            match_count: 0,
        };
    }
    if cursor < text.len() {
        nodes.push(alloc_text(doc, &text[cursor..]));
    }
    DirectReplace { nodes, match_count }
}
