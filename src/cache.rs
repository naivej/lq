//! Parse cache (Deno `cache.ts`). CST JSON is rust-owned; not a user-visible surface.

use crate::ast::{Document, NodeId, NodeKind};
use crate::paths::StatePaths;
use serde_json::{Map, Value, json};
use sha2::{Digest, Sha256};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::time::SystemTime;

static MAX_CACHE_ENTRIES: AtomicUsize = AtomicUsize::new(50);

pub fn set_max_cache_entries(n: usize) {
    MAX_CACHE_ENTRIES.store(n, Ordering::Relaxed);
}

pub(crate) fn max_cache_entries() -> usize {
    MAX_CACHE_ENTRIES.load(Ordering::Relaxed)
}

pub(crate) fn hash_bytes(data: &[u8]) -> String {
    let digest = Sha256::digest(data);
    digest.iter().map(|b| format!("{b:02x}")).collect()
}

pub fn hash_text(text: &str) -> String {
    hash_bytes(text.as_bytes())
}

pub(crate) fn hash_file(path: &Path) -> std::io::Result<String> {
    let data = fs::read(path)?;
    Ok(hash_bytes(&data))
}

fn cache_path(hash: &str, state: &StatePaths) -> PathBuf {
    state.cache.join(format!("{hash}.cst"))
}

pub(crate) fn get_cached_ast(
    file_path: &Path,
    state: &StatePaths,
    content_hash: Option<&str>,
) -> Option<Document> {
    if max_cache_entries() == 0 {
        return None;
    }
    let hash = match content_hash {
        Some(h) => h.to_string(),
        None => hash_file(file_path).ok()?,
    };
    let json = crate::paths::read_text_file(&cache_path(&hash, state)).ok()?;
    let value: Value = serde_json::from_str(&json).ok()?;
    document_from_json(&value)
}

pub(crate) fn set_cached_ast(hash: &str, ast: &Document, state: &StatePaths) {
    if max_cache_entries() == 0 {
        return;
    }
    let _ = set_cached_ast_inner(hash, ast, state);
}

fn set_cached_ast_inner(hash: &str, ast: &Document, state: &StatePaths) -> std::io::Result<()> {
    fs::create_dir_all(&state.cache)?;
    let dest = cache_path(hash, state);
    let tmp = dest.with_extension("cst.tmp");
    let json = serde_json::to_string(&document_to_json(ast)).map_err(std::io::Error::other)?;
    fs::write(&tmp, json)?;
    if dest.exists() {
        let _ = fs::remove_file(&dest);
    }
    fs::rename(&tmp, &dest)?;
    prune_cache(&state.cache);
    Ok(())
}

fn prune_cache(dir: &Path) {
    prune_dir_by_ext(dir, "cst");
}

/// Prune `cache/raster/*.png` to `max_cache_entries` (031, independent of `.cst`).
pub(crate) fn prune_raster_dir(dir: &Path) {
    prune_dir_by_ext(dir, "png");
}

fn prune_dir_by_ext(dir: &Path, ext: &str) {
    let max = max_cache_entries();
    let Ok(rd) = fs::read_dir(dir) else {
        return;
    };
    let mut entries: Vec<(PathBuf, Option<SystemTime>)> = Vec::new();
    for ent in rd.flatten() {
        let path = ent.path();
        if path.extension().and_then(|s| s.to_str()) != Some(ext) {
            continue;
        }
        if !path.is_file() {
            continue;
        }
        let atime = fs::metadata(&path).ok().and_then(|m| m.accessed().ok());
        entries.push((path, atime));
    }
    if entries.len() <= max {
        return;
    }
    entries.sort_by_key(|(_, t)| t.unwrap_or(SystemTime::UNIX_EPOCH));
    let excess = entries.len() - max;
    for (path, _) in entries.into_iter().take(excess) {
        let _ = fs::remove_file(path);
    }
}

fn document_to_json(doc: &Document) -> Value {
    json!({
        "type": "document",
        "children": doc.node(doc.root()).children.iter().map(|&id| node_to_json(doc, id)).collect::<Vec<_>>(),
    })
}

pub(crate) fn node_to_json(doc: &Document, id: NodeId) -> Value {
    match &doc.node(id).kind {
        NodeKind::Document => document_to_json_at(doc, id),
        NodeKind::Block {
            tag,
            args,
            is_begin_variant,
        } => {
            let mut m = Map::new();
            m.insert("type".into(), json!("block"));
            m.insert("tag".into(), json!(tag));
            if let Some(a) = args {
                m.insert("args".into(), json!(a));
            }
            m.insert("isBeginVariant".into(), json!(is_begin_variant));
            m.insert(
                "children".into(),
                Value::Array(
                    doc.node(id)
                        .children
                        .iter()
                        .map(|&c| node_to_json(doc, c))
                        .collect(),
                ),
            );
            Value::Object(m)
        }
        NodeKind::Property { key, value } => {
            let mut m = Map::new();
            m.insert("type".into(), json!("property"));
            m.insert("key".into(), json!(key));
            if let Some(v) = value {
                m.insert("value".into(), json!(v));
            }
            Value::Object(m)
        }
        NodeKind::Text { text } => json!({ "type": "text", "text": text }),
    }
}

fn document_to_json_at(doc: &Document, id: NodeId) -> Value {
    json!({
        "type": "document",
        "children": doc.node(id).children.iter().map(|&c| node_to_json(doc, c)).collect::<Vec<_>>(),
    })
}

fn document_from_json(value: &Value) -> Option<Document> {
    if value.get("type")?.as_str()? != "document" {
        return None;
    }
    let children = value.get("children")?.as_array()?;
    let mut doc = Document::new();
    let root = doc.root();
    for child in children {
        let id = node_from_json(&mut doc, child)?;
        doc.push_child(root, id);
    }
    Some(doc)
}

pub(crate) fn node_from_json(doc: &mut Document, value: &Value) -> Option<NodeId> {
    match value.get("type")?.as_str()? {
        "document" => {
            let id = doc.alloc(NodeKind::Document);
            for child in value.get("children")?.as_array()? {
                let c = node_from_json(doc, child)?;
                doc.push_child(id, c);
            }
            Some(id)
        }
        "block" => {
            let tag = value.get("tag")?.as_str()?.to_string();
            let args = value
                .get("args")
                .and_then(|v| v.as_str())
                .map(str::to_string);
            let is_begin_variant = value.get("isBeginVariant")?.as_bool()?;
            let id = doc.alloc(NodeKind::Block {
                tag,
                args,
                is_begin_variant,
            });
            if let Some(children) = value.get("children").and_then(|v| v.as_array()) {
                for child in children {
                    let c = node_from_json(doc, child)?;
                    doc.push_child(id, c);
                }
            }
            Some(id)
        }
        "property" => {
            let key = value.get("key")?.as_str()?.to_string();
            let val = value
                .get("value")
                .and_then(|v| v.as_str())
                .map(str::to_string);
            Some(doc.alloc(NodeKind::Property { key, value: val }))
        }
        "text" => {
            let text = value.get("text")?.as_str()?.to_string();
            Some(doc.alloc(NodeKind::Text { text }))
        }
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::StateScope;
    use crate::parse;
    use crate::paths::StatePaths;
    use crate::serialize;
    use std::path::PathBuf;
    use std::sync::Mutex;

    static TEST_LOCK: Mutex<()> = Mutex::new(());

    fn temp_state() -> (PathBuf, StatePaths) {
        let root = std::env::temp_dir().join(format!(
            "lq_cache_{}_{}",
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

    #[test]
    fn hash_text_sha256_abc() {
        assert_eq!(
            hash_text("abc"),
            "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
        );
    }

    #[test]
    fn cache_round_trip_serialize() {
        let _guard = TEST_LOCK.lock().unwrap();
        let src = "\\begin_layout Standard\nHello\n\\end_layout";
        let doc = parse(src, true).unwrap();
        let json = serde_json::to_string(&document_to_json(&doc)).unwrap();
        let value: Value = serde_json::from_str(&json).unwrap();
        let rebuilt = document_from_json(&value).unwrap_or_else(|| {
            panic!("rebuild failed for {json}");
        });
        assert_eq!(serialize(&rebuilt), serialize(&doc), "in-memory json");
        let (root, state) = temp_state();
        let h = hash_text(src);
        set_cached_ast_inner(&h, &doc, &state).unwrap();
        let loaded = get_cached_ast(Path::new("unused.lyx"), &state, Some(&h)).unwrap();
        assert_eq!(serialize(&loaded), serialize(&doc));
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn cache_disabled_is_miss() {
        let _guard = TEST_LOCK.lock().unwrap();
        let prev = max_cache_entries();
        set_max_cache_entries(0);
        let src = "\\begin_layout Standard\nx\n\\end_layout";
        let doc = parse(src, true).unwrap();
        let (root, state) = temp_state();
        let h = hash_text(src);
        set_cached_ast(&h, &doc, &state);
        assert!(get_cached_ast(Path::new("x.lyx"), &state, Some(&h)).is_none());
        set_max_cache_entries(prev);
        let _ = fs::remove_dir_all(root);
    }
}
