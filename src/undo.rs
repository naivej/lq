//! Pre-mutation snapshots (Deno `undo.ts`). CLI `undo` command is S10.

use crate::ast::{Document, NodeId, NodeKind};
use crate::cache::{hash_text, node_from_json, node_to_json, set_cached_ast};
use crate::paths::{StatePaths, read_text_file};
use crate::serializer::serialize;
use crate::tracked_changes::get_header;
use serde_json::{Value, json};
use std::collections::HashSet;
use std::fs;
use std::path::{Path, PathBuf};

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SnapshotEntry {
    pub path: Vec<usize>,
    pub children: Vec<NodeId>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SnapshotFile {
    pub file_path: String,
    pub entries: Vec<SnapshotEntry>,
}

/// Deno `collectSnapshots` mode (`"self"` | `"parent"`).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SnapshotMode {
    /// Deno `"self"`: snapshot the matched block's own children.
    OnNode,
    /// Deno `"parent"`: snapshot the parent container (insert/untracked delete).
    OnParent,
}

fn snapshot_path(hash: &str, state: &StatePaths) -> PathBuf {
    state.undo.join(format!("{hash}.json"))
}

fn path_key(path: &[usize]) -> String {
    path.iter()
        .map(|i| i.to_string())
        .collect::<Vec<_>>()
        .join(",")
}

fn is_block(doc: &Document, id: NodeId) -> bool {
    matches!(doc.node(id).kind, NodeKind::Block { .. })
}

pub fn find_node_path(doc: &Document, target: NodeId) -> Option<Vec<usize>> {
    fn walk(doc: &Document, list: &[NodeId], target: NodeId) -> Option<Vec<usize>> {
        for (i, &id) in list.iter().enumerate() {
            if id == target {
                return Some(vec![i]);
            }
            if is_block(doc, id) {
                let kids = doc.node(id).children.clone();
                if let Some(sub) = walk(doc, &kids, target) {
                    let mut path = vec![i];
                    path.extend(sub);
                    return Some(path);
                }
            }
        }
        None
    }
    walk(doc, &doc.node(doc.root()).children, target)
}

pub fn node_at_path(doc: &Document, path: &[usize]) -> Option<NodeId> {
    let mut current = doc.root();
    for &i in path {
        let next = *doc.node(current).children.get(i)?;
        if !is_block(doc, next) {
            return None;
        }
        current = next;
    }
    Some(current)
}

pub fn collect_snapshots(
    doc: &mut Document,
    nodes: &[NodeId],
    mode: SnapshotMode,
) -> Vec<SnapshotEntry> {
    let mut entries = Vec::new();
    let mut seen = HashSet::new();
    for &node in nodes {
        let Some(node_path) = find_node_path(doc, node) else {
            continue;
        };
        let path = if mode == SnapshotMode::OnParent || !is_block(doc, node) {
            if node_path.is_empty() {
                continue;
            }
            node_path[..node_path.len() - 1].to_vec()
        } else {
            node_path
        };
        let key = path_key(&path);
        if !seen.insert(key) {
            continue;
        }
        let Some(target) = node_at_path(doc, &path) else {
            continue;
        };
        let kids = doc.node(target).children.clone();
        let children = kids.into_iter().map(|c| doc.clone_subtree(c)).collect();
        entries.push(SnapshotEntry { path, children });
    }
    if let Some(header) = get_header(doc)
        && let Some(header_path) = find_node_path(doc, header)
    {
        let header_key = path_key(&header_path);
        if seen.insert(header_key) {
            let kids = doc.node(header).children.clone();
            let children = kids.into_iter().map(|c| doc.clone_subtree(c)).collect();
            entries.push(SnapshotEntry {
                path: header_path,
                children,
            });
        }
    }
    entries
}

fn resolve_file_path(file_path: &Path) -> String {
    std::path::absolute(file_path)
        .unwrap_or_else(|_| {
            std::env::current_dir()
                .map(|cwd| cwd.join(file_path))
                .unwrap_or_else(|_| file_path.to_path_buf())
        })
        .to_string_lossy()
        .into_owned()
}

fn entries_to_json(doc: &Document, entries: &[SnapshotEntry]) -> Value {
    Value::Array(
        entries
            .iter()
            .map(|e| {
                json!({
                    "path": e.path,
                    "children": e.children.iter().map(|&id| node_to_json(doc, id)).collect::<Vec<_>>(),
                })
            })
            .collect(),
    )
}

fn entries_from_json(doc: &mut Document, value: &Value) -> Option<Vec<SnapshotEntry>> {
    let arr = value.as_array()?;
    let mut entries = Vec::new();
    for e in arr {
        let path_val = e.get("path")?.as_array()?;
        let mut path = Vec::new();
        for p in path_val {
            path.push(p.as_u64()? as usize);
        }
        let children_val = e.get("children")?.as_array()?;
        let mut children = Vec::new();
        for c in children_val {
            children.push(node_from_json(doc, c)?);
        }
        entries.push(SnapshotEntry { path, children });
    }
    Some(entries)
}

pub fn save_snapshot(
    doc: &Document,
    file_path: &Path,
    entries: &[SnapshotEntry],
    post_hash: &str,
    state: &StatePaths,
) -> std::io::Result<()> {
    save_snapshot_inner(doc, file_path, entries, post_hash, state)
}

fn save_snapshot_inner(
    doc: &Document,
    file_path: &Path,
    entries: &[SnapshotEntry],
    post_hash: &str,
    state: &StatePaths,
) -> std::io::Result<()> {
    fs::create_dir_all(&state.undo)?;
    let resolved = resolve_file_path(file_path);
    for ent in fs::read_dir(&state.undo)? {
        let ent = ent?;
        let path = ent.path();
        if !ent.file_type()?.is_file() {
            continue;
        }
        if path.extension().and_then(|s| s.to_str()) != Some("json") {
            continue;
        }
        match read_text_file(&path) {
            Ok(json) => match serde_json::from_str::<Value>(&json) {
                Ok(existing)
                    if existing.get("filePath").and_then(|v| v.as_str())
                        == Some(resolved.as_str()) =>
                {
                    let _ = fs::remove_file(&path);
                }
                Ok(_) => {}
                Err(_) => {
                    let _ = fs::remove_file(&path);
                }
            },
            Err(_) => {
                let _ = fs::remove_file(&path);
            }
        }
    }

    let snapshot = json!({
        "filePath": resolved,
        "entries": entries_to_json(doc, entries),
    });
    let dest = snapshot_path(post_hash, state);
    let tmp = dest.with_extension("json.tmp");
    fs::write(
        &tmp,
        serde_json::to_string(&snapshot).map_err(std::io::Error::other)?,
    )?;
    if dest.exists() {
        let _ = fs::remove_file(&dest);
    }
    fs::rename(&tmp, &dest)?;
    Ok(())
}

pub fn load_snapshot(
    doc: &mut Document,
    file_hash: &str,
    state: &StatePaths,
) -> Option<SnapshotFile> {
    let snapshot_path = snapshot_path(file_hash, state);
    let json = read_text_file(&snapshot_path).ok()?;
    let value: Value = serde_json::from_str(&json).ok()?;
    let file_path = value.get("filePath")?.as_str()?.to_string();
    let entries_val = value.get("entries")?;
    if !entries_val.is_array() {
        return None;
    }
    let entries = entries_from_json(doc, entries_val)?;
    Some(SnapshotFile { file_path, entries })
}

pub fn clear_snapshot(file_hash: &str, state: &StatePaths) {
    let _ = fs::remove_file(snapshot_path(file_hash, state));
}

pub struct CommitResult {
    pub snapshot_ok: bool,
}

pub fn commit_mutation(
    doc: &Document,
    file_path: &Path,
    pre_snapshots: &[SnapshotEntry],
    state: &StatePaths,
) -> std::io::Result<CommitResult> {
    let new_file_text = serialize(doc);
    let post_hash = hash_text(&new_file_text);
    let snapshot_ok = save_snapshot(doc, file_path, pre_snapshots, &post_hash, state).is_ok();
    fs::write(file_path, new_file_text)?;
    set_cached_ast(&post_hash, doc, state);
    Ok(CommitResult { snapshot_ok })
}
