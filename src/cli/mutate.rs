//! Shared mutation CLI helpers (Deno `cli.ts` mutation preamble).

use super::common::{CliError, ParsedArgs, push_warning};
use crate::ast::{Document, NodeId, NodeKind};
use crate::lyxserver::{RefreshMode, RefreshPreStep, refresh_post_step};
use crate::paths::StatePaths;
use crate::query::{ScopePredicate, ScopeState};
use crate::registry::validate_inset_type;
use crate::text_utils::{TextRegion, TextSegment, is_invisible_inset, traversal_region};
use crate::tracked_changes::{extract_all_text, get_header};
use crate::undo::{SnapshotEntry, commit_mutation};
use std::collections::HashMap;
use std::path::Path;
use std::time::{SystemTime, UNIX_EPOCH};

pub struct MutationEnv<'a> {
    pub file_path: &'a str,
    pub selector: Option<&'a str>,
    pub rest: &'a [String],
    pub flags: &'a ParsedArgs,
    pub state: &'a StatePaths,
    pub track_changes: bool,
    pub author_name: &'a str,
    pub refresh: RefreshMode,
    pub traversal: &'a HashMap<NodeId, crate::text_utils::TraversalState>,
}

pub fn parse_refresh_mode(value: Option<&str>) -> RefreshMode {
    match value {
        Some("save-reload") => RefreshMode::SaveReload,
        Some("reload") => RefreshMode::Reload,
        Some("none") | None => RefreshMode::None,
        Some(_) => RefreshMode::Reload,
    }
}

pub fn now_ts() -> String {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs().to_string())
        .unwrap_or_else(|_| "0".into())
}

pub fn node_label(doc: &Document, node: NodeId) -> String {
    match &doc.node(node).kind {
        NodeKind::Block { tag, args, .. } => {
            format!("{tag}[{}]", args.as_deref().unwrap_or("").trim())
        }
        NodeKind::Property { key, .. } => format!("property[{key}]"),
        NodeKind::Text { .. } => "text".into(),
        NodeKind::Document => "document".into(),
    }
}

pub fn brief_text(doc: &Document, node: NodeId, max_len: usize) -> String {
    let raw = extract_all_text(doc, node, max_len + 1, false);
    let text = raw.trim();
    if text.len() <= max_len {
        text.to_string()
    } else {
        let mut end = max_len;
        while end > 0 && !text.is_char_boundary(end) {
            end -= 1;
        }
        format!("{}...", &text[..end])
    }
}

pub fn brief_children_text(doc: &Document, children: &[NodeId], max_len: usize) -> String {
    let mut raw = String::new();
    for &c in children {
        if raw.len() > max_len {
            break;
        }
        raw.push_str(&extract_all_text(doc, c, max_len + 1 - raw.len(), false));
    }
    let text = raw.trim();
    if text.len() <= max_len {
        text.to_string()
    } else {
        let mut end = max_len;
        while end > 0 && !text.is_char_boundary(end) {
            end -= 1;
        }
        format!("{}...", &text[..end])
    }
}

pub fn assert_tracking_header(doc: &Document, track_changes: bool) -> Result<(), CliError> {
    if !track_changes {
        return Ok(());
    }
    if get_header(doc).is_some() {
        return Ok(());
    }
    Err(CliError::new(
        "TRACKING_HEADER_MISSING",
        "This document has no '\\begin_header' block, so tracked changes cannot be written — LyX would reject the \\change_* markers (no matching \\author entry).\n\
Fix the file (restore its header) or disable tracking first ('lq init --track-changes off') to mutate without tracking.",
    ))
}

pub fn validate_raw_insets(doc: &Document) -> Vec<String> {
    let mut warnings = Vec::new();
    fn walk(doc: &Document, nodes: &[NodeId], warnings: &mut Vec<String>) {
        for &id in nodes {
            if let NodeKind::Block {
                tag,
                args,
                is_begin_variant,
            } = &doc.node(id).kind
                && tag == "inset"
                && *is_begin_variant
                && let Some(w) = validate_inset_type(args.as_deref())
            {
                warnings.push(w);
            }
            if matches!(doc.node(id).kind, NodeKind::Block { .. }) {
                walk(doc, &doc.node(id).children.clone(), warnings);
            }
        }
    }
    walk(doc, &doc.node(doc.root()).children.clone(), &mut warnings);
    warnings
}

pub fn phrase_only_in_invisible_content(doc: &Document, phrase: &str) -> bool {
    let mut found_invisible = false;
    let mut found_visible = false;
    fn walk(
        doc: &Document,
        children: &[NodeId],
        in_note: bool,
        phrase: &str,
        found_invisible: &mut bool,
        found_visible: &mut bool,
    ) {
        if *found_invisible && *found_visible {
            return;
        }
        for &c in children {
            if *found_invisible && *found_visible {
                return;
            }
            match &doc.node(c).kind {
                NodeKind::Text { text } if text.contains(phrase) => {
                    if in_note {
                        *found_invisible = true;
                    } else {
                        *found_visible = true;
                    }
                }
                NodeKind::Block { tag, args, .. } => {
                    let next = in_note || is_invisible_inset(tag, args.as_deref());
                    walk(
                        doc,
                        &doc.node(c).children.clone(),
                        next,
                        phrase,
                        found_invisible,
                        found_visible,
                    );
                }
                _ => {}
            }
        }
    }
    walk(
        doc,
        &doc.node(doc.root()).children.clone(),
        false,
        phrase,
        &mut found_invisible,
        &mut found_visible,
    );
    found_invisible && !found_visible
}

pub fn count_occurrences(text: &str, find_str: &str) -> usize {
    if find_str.is_empty() {
        return 0;
    }
    let mut count = 0;
    let mut pos = 0;
    while let Some(found) = text[pos..].find(find_str) {
        count += 1;
        pos += found + find_str.len();
    }
    count
}

pub fn region_to_scope(region: TextRegion) -> ScopeState {
    match region {
        TextRegion::Deleted => ScopeState::Deleted,
        TextRegion::Inserted => ScopeState::Inserted,
        TextRegion::Current => ScopeState::Current,
    }
}

pub fn match_span_in_scope(
    segments: &[TextSegment],
    ms: usize,
    me: usize,
    scope: &ScopePredicate,
) -> bool {
    let mut offset = 0;
    for seg in segments {
        let seg_start = offset;
        let seg_end = offset + seg.text.len();
        if seg_end > ms && seg_start < me {
            let region = region_to_scope(traversal_region(&seg.state));
            if !scope.matches(region, &seg.state.properties) {
                return false;
            }
        }
        offset = seg_end;
    }
    true
}

pub fn is_core_node(doc: &Document, node: NodeId) -> bool {
    matches!(
        &doc.node(node).kind,
        NodeKind::Block { tag, .. } if tag == "body" || tag == "header" || tag == "document"
    )
}

pub fn blast_radius_warning(file_path: &str, selector: &str, n: usize) {
    if n > 1 {
        push_warning(format!(
            "Selector matches {n} nodes. If this is not intended, run 'lq read {file_path} \"{selector}\"' to inspect them, or 'lq undo {file_path}' to revert the last mutation."
        ));
    }
}

pub fn commit_and_refresh(
    doc: &Document,
    file_path: &str,
    snaps: &[SnapshotEntry],
    state: &StatePaths,
    refresh: RefreshMode,
) -> Result<(), CliError> {
    match commit_mutation(doc, Path::new(file_path), snaps, state) {
        Err(e) => {
            return Err(CliError::new(
                "WRITE_ERROR",
                format!("Failed to write file: {e}"),
            ));
        }
        Ok(result) => {
            if !result.snapshot_ok {
                push_warning(format!(
                    "Undo snapshot could not be saved. The file was written. Later 'lq undo {file_path}' will report UNDO_SNAPSHOT_UNAVAILABLE until a later mutation saves a snapshot."
                ));
            }
        }
    }
    warn_refresh_post(file_path, refresh);
    Ok(())
}

pub fn warn_refresh_post(file_path: &str, mode: RefreshMode) {
    let Some(result) = refresh_post_step(file_path, mode) else {
        return;
    };
    if !result.confirmed || result.errored {
        push_warning(
            "LyX buffer was not reloaded — LyX may be closed, busy, or the server \
connection timed out. The file was written successfully. \
Run 'buffer-reload' in LyX or reopen the file to see the changes.",
        );
    }
}

pub fn handle_refresh_pre(file_path: &str, mode: RefreshMode) -> Result<(), CliError> {
    if mode == RefreshMode::None {
        return Ok(());
    }
    let pre = crate::lyxserver::refresh_pre_step(file_path, mode);
    match pre {
        RefreshPreStep::Ok => Ok(()),
        RefreshPreStep::Disconnect => Err(CliError::new(
            "REFRESH_PRE_ERROR",
            "save-reload: Cannot connect to LyX to save unsaved edits.\n\
Writing the file now would permanently destroy unsaved changes.\n\
Start LyX with LyXServer enabled (see 'lq init --refresh' help) and retry.",
        )),
        RefreshPreStep::Error => Err(CliError::new(
            "REFRESH_PRE_ERROR",
            "save-reload: LyX reported an error saving the buffer, so unsaved edits may not be on disk.\n\
Writing the file now would permanently destroy unsaved changes.\n\
Resolve the save error in LyX, then retry this command.",
        )),
        RefreshPreStep::Unconfirmed => {
            push_warning(
                "save-reload: the save command was sent to LyX but the confirmation was \
lost (a known Windows LyXServer race). Proceeding — the save was almost \
certainly applied. If this repeats, restart LyX.",
            );
            Ok(())
        }
    }
}

pub struct NodeContext {
    pub parent: NodeId,
    pub index: usize,
    pub ancestors: Vec<NodeId>,
}

pub fn find_node_context(doc: &Document, target: NodeId) -> Option<NodeContext> {
    fn walk(
        doc: &Document,
        owner: NodeId,
        ancestors: &[NodeId],
        target: NodeId,
    ) -> Option<NodeContext> {
        let kids = doc.node(owner).children.clone();
        for (i, &id) in kids.iter().enumerate() {
            if id == target {
                return Some(NodeContext {
                    parent: owner,
                    index: i,
                    ancestors: ancestors.to_vec(),
                });
            }
            if matches!(doc.node(id).kind, NodeKind::Block { .. }) {
                let mut next = ancestors.to_vec();
                next.push(id);
                if let Some(found) = walk(doc, id, &next, target) {
                    return Some(found);
                }
            }
        }
        None
    }
    walk(doc, doc.root(), &[], target)
}

pub fn block_tag(doc: &Document, id: NodeId) -> Option<&str> {
    match &doc.node(id).kind {
        NodeKind::Block { tag, .. } => Some(tag.as_str()),
        _ => None,
    }
}

pub fn block_args(doc: &Document, id: NodeId) -> Option<&str> {
    match &doc.node(id).kind {
        NodeKind::Block { args, .. } => args.as_deref(),
        _ => None,
    }
}

pub fn is_invisible_block(doc: &Document, id: NodeId) -> bool {
    match &doc.node(id).kind {
        NodeKind::Block { tag, args, .. } => is_invisible_inset(tag, args.as_deref()),
        _ => false,
    }
}

pub struct OpenRegion {
    pub key: String,
    pub author: i32,
    pub ts: String,
    pub opener: NodeId,
}

pub fn open_region_info(doc: &Document, parent: NodeId, index: usize) -> Option<OpenRegion> {
    let kids = &doc.node(parent).children;
    let mut deleted_depth = 0i32;
    let mut inserted_depth = 0i32;
    let mut deleted_info: Option<OpenRegion> = None;
    let mut inserted_info: Option<OpenRegion> = None;
    for &c in kids.iter().take(index) {
        let NodeKind::Property { key, value } = &doc.node(c).kind else {
            continue;
        };
        if !(crate::tracked_changes::is_change_opener(key)
            || crate::tracked_changes::is_change_closer(key))
        {
            continue;
        }
        let d = crate::text_utils::advance_change_depths(key, deleted_depth, inserted_depth);
        deleted_depth = d.0;
        inserted_depth = d.1;
        if key == "change_deleted" || key == "change_inserted" {
            let m = crate::tracked_changes::parse_change_marker(value.as_deref());
            let info = OpenRegion {
                key: key.clone(),
                author: m.author_id,
                ts: m.ts,
                opener: c,
            };
            if key == "change_deleted" {
                deleted_info = Some(info);
            } else {
                inserted_info = Some(info);
            }
        } else if key == "change_unchanged" {
            if inserted_depth == 0 {
                deleted_info = None;
            }
            if deleted_depth == 0 {
                inserted_info = None;
            }
        }
    }
    if deleted_depth > 0 {
        deleted_info
    } else if inserted_depth > 0 {
        inserted_info
    } else {
        None
    }
}

pub fn collect_text_parents(doc: &Document) -> HashMap<NodeId, (NodeId, usize)> {
    let mut map = HashMap::new();
    fn walk(doc: &Document, owner: NodeId, map: &mut HashMap<NodeId, (NodeId, usize)>) {
        let kids = doc.node(owner).children.clone();
        for (i, &id) in kids.iter().enumerate() {
            match &doc.node(id).kind {
                NodeKind::Text { .. } => {
                    map.insert(id, (owner, i));
                }
                NodeKind::Block { .. } => walk(doc, id, map),
                _ => {}
            }
        }
    }
    walk(doc, doc.root(), &mut map);
    map
}

pub fn alloc_text(doc: &mut Document, text: &str) -> NodeId {
    doc.alloc(NodeKind::Text {
        text: text.to_string(),
    })
}

pub fn alloc_prop(doc: &mut Document, key: &str, value: Option<&str>) -> NodeId {
    doc.alloc(NodeKind::Property {
        key: key.to_string(),
        value: value.map(str::to_string),
    })
}

pub fn alloc_block(doc: &mut Document, tag: &str, args: Option<&str>) -> NodeId {
    doc.alloc(NodeKind::Block {
        tag: tag.to_string(),
        args: args.map(str::to_string),
        is_begin_variant: true,
    })
}

pub fn set_text(doc: &mut Document, id: NodeId, text: &str) {
    doc.set_kind(
        id,
        NodeKind::Text {
            text: text.to_string(),
        },
    );
}

pub fn set_prop_value(doc: &mut Document, id: NodeId, key: &str, value: Option<&str>) {
    doc.set_kind(
        id,
        NodeKind::Property {
            key: key.to_string(),
            value: value.map(str::to_string),
        },
    );
}
