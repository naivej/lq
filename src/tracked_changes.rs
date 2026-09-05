//! Tracked-change machinery for LyX's flat change model (Deno `tracked_changes.ts`).

use crate::ast::{Document, NodeId, NodeKind};
use crate::query::{ScopePredicate, ScopeState};
use crate::registry::is_inline_style_key;
use crate::text_utils::{
    ConcatOpts, TextSegment, TraversalState, advance_change_depths, advance_traversal_state,
    concatenate_text_nodes, create_traversal_state, enter_traversal_state, map_pos_to_segment,
    traversal_change, traversal_region,
};
use serde_json::{Map, Value, json};
use std::collections::HashMap;
use std::time::{SystemTime, UNIX_EPOCH};

pub fn is_change_opener(key: &str) -> bool {
    key == "change_deleted" || key == "change_inserted"
}

pub fn is_change_closer(key: &str) -> bool {
    key == "change_unchanged"
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ChangeMarker {
    pub author_id: i32,
    pub ts: String,
}

/// JS `parseInt(s, 10)` for a decimal prefix. `None` is JS `NaN`.
fn js_parse_int(s: &str) -> Option<i32> {
    let s = s.trim_start();
    if s.is_empty() {
        return None;
    }
    let bytes = s.as_bytes();
    let mut i = 0;
    let mut neg = false;
    if bytes[0] == b'+' {
        i = 1;
    } else if bytes[0] == b'-' {
        neg = true;
        i = 1;
    }
    if i >= bytes.len() || !bytes[i].is_ascii_digit() {
        return None;
    }
    let start = i;
    while i < bytes.len() && bytes[i].is_ascii_digit() {
        i += 1;
    }
    let n: i32 = s[start..i].parse().ok()?;
    Some(if neg { -n } else { n })
}

fn js_int_gt(a: &str, b: &str) -> bool {
    match (js_parse_int(a), js_parse_int(b)) {
        (Some(x), Some(y)) => x > y,
        _ => false,
    }
}

pub fn parse_change_marker(value: Option<&str>) -> ChangeMarker {
    let parts: Vec<&str> = value.unwrap_or("").split(' ').collect();
    let author_id = js_parse_int(parts.first().copied().unwrap_or("")).unwrap_or(0);
    let ts = parts
        .get(1)
        .copied()
        .filter(|s| !s.is_empty())
        .unwrap_or("0")
        .to_string();
    ChangeMarker { author_id, ts }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct RegionEnd {
    pub closer: Option<usize>,
    pub next_opener: Option<usize>,
}

pub fn scan_region_end(
    doc: &Document,
    children: &[NodeId],
    start: usize,
    marker_key: &str,
    terminate_at_different_type: bool,
) -> RegionEnd {
    if terminate_at_different_type {
        let open_id = children[start
            .checked_sub(1)
            .expect("invariant: scan_region_end start > 0 when terminate_at_different_type")];
        let open = match &doc.node(open_id).kind {
            NodeKind::Property { value, .. } => parse_change_marker(value.as_deref()),
            _ => ChangeMarker {
                author_id: 0,
                ts: "0".into(),
            },
        };
        for (j, &id) in children.iter().enumerate().skip(start) {
            let NodeKind::Property { key, value } = &doc.node(id).kind else {
                continue;
            };
            if is_change_opener(key) {
                let cand = parse_change_marker(value.as_deref());
                if key.as_str() != marker_key || cand.author_id != open.author_id {
                    return RegionEnd {
                        closer: None,
                        next_opener: Some(j),
                    };
                }
            } else if is_change_closer(key) {
                return RegionEnd {
                    closer: Some(j),
                    next_opener: None,
                };
            }
        }
        return RegionEnd {
            closer: None,
            next_opener: None,
        };
    }
    let mut depth = 1;
    for (j, &id) in children.iter().enumerate().skip(start) {
        let NodeKind::Property { key, .. } = &doc.node(id).kind else {
            continue;
        };
        if is_change_opener(key) {
            depth += 1;
        } else if is_change_closer(key) {
            depth -= 1;
            if depth == 0 {
                return RegionEnd {
                    closer: Some(j),
                    next_opener: None,
                };
            }
        }
    }
    RegionEnd {
        closer: None,
        next_opener: None,
    }
}

pub fn get_header(doc: &Document) -> Option<NodeId> {
    let document = doc.node(doc.root()).children.iter().copied().find(|&id| {
        matches!(
            &doc.node(id).kind,
            NodeKind::Block { tag, .. } if tag == "document"
        )
    })?;
    doc.node(document).children.iter().copied().find(|&id| {
        matches!(
            &doc.node(id).kind,
            NodeKind::Block { tag, .. } if tag == "header"
        )
    })
}

fn parse_author_line(value: &str) -> Option<(i32, String)> {
    let bytes = value.as_bytes();
    let mut i = 0;
    let neg = if bytes.first() == Some(&b'-') {
        i = 1;
        true
    } else {
        false
    };
    let start = i;
    while i < bytes.len() && bytes[i].is_ascii_digit() {
        i += 1;
    }
    if i == start {
        return None;
    }
    let id: i32 = value[start..i].parse().ok()?;
    let id = if neg { -id } else { id };
    if i >= bytes.len() || !bytes[i].is_ascii_whitespace() {
        return None;
    }
    while i < bytes.len() && bytes[i].is_ascii_whitespace() {
        i += 1;
    }
    if i >= bytes.len() || bytes[i] != b'"' {
        return None;
    }
    i += 1;
    let name_start = i;
    while i < bytes.len() && bytes[i] != b'"' {
        i += 1;
    }
    if i >= bytes.len() {
        return None;
    }
    let name = value[name_start..i].to_string();
    i += 1;
    if i < value.len() && !value.as_bytes()[i].is_ascii_whitespace() {
        return None;
    }
    Some((id, name))
}

pub fn resolve_author_id(doc: &mut Document, author_name: &str) -> i32 {
    let Some(header) = get_header(doc) else {
        return 0;
    };
    let children = doc.node(header).children.clone();
    let mut max_id = 0i32;
    for id in children {
        let NodeKind::Property { key, value } = &doc.node(id).kind else {
            continue;
        };
        if key != "author" {
            continue;
        }
        let Some(value) = value else {
            continue;
        };
        let Some((id_num, name)) = parse_author_line(value) else {
            continue;
        };
        if name == author_name {
            return id_num;
        }
        if id_num > max_id {
            max_id = id_num;
        }
    }
    let new_id = max_id + 1;
    let prop = doc.alloc(NodeKind::Property {
        key: "author".into(),
        value: Some(format!("{new_id} \"{author_name}\"")),
    });
    doc.push_child(header, prop);
    new_id
}

pub fn ensure_tracking_changes_in_header(doc: &mut Document) {
    let Some(header) = get_header(doc) else {
        return;
    };
    let children = doc.node(header).children.clone();
    for id in children {
        if let NodeKind::Property { key, .. } = &doc.node(id).kind
            && key == "tracking_changes"
        {
            if let NodeKind::Property { value, .. } = &mut doc.node_mut(id).kind {
                *value = Some("true".into());
            }
            return;
        }
    }
    let prop = doc.alloc(NodeKind::Property {
        key: "tracking_changes".into(),
        value: Some("true".into()),
    });
    doc.push_child(header, prop);
}

fn property_json(key: &str, value: Option<&str>) -> Value {
    let mut m = Map::new();
    m.insert("type".into(), json!("property"));
    m.insert("key".into(), json!(key));
    if let Some(v) = value {
        m.insert("value".into(), json!(v));
    }
    Value::Object(m)
}

fn annotate_walk(
    doc: &Document,
    node: NodeId,
    mut deleted_depth: i32,
    mut inserted_depth: i32,
) -> Value {
    match &doc.node(node).kind {
        NodeKind::Text { text } => {
            let mut m = Map::new();
            m.insert("type".into(), json!("text"));
            m.insert("text".into(), json!(text));
            if deleted_depth > 0 {
                m.insert("changeStatus".into(), json!("deleted"));
            } else if inserted_depth > 0 {
                m.insert("changeStatus".into(), json!("inserted"));
            }
            Value::Object(m)
        }
        NodeKind::Property { key, value } => property_json(key, value.as_deref()),
        NodeKind::Block {
            tag,
            args,
            is_begin_variant,
        } => {
            let tag = tag.clone();
            let args = args.clone();
            let is_begin_variant = *is_begin_variant;
            let children_ids = doc.node(node).children.clone();
            let mut children = Vec::new();
            for child in children_ids {
                if let NodeKind::Property { key, value } = &doc.node(child).kind
                    && (is_change_opener(key) || is_change_closer(key))
                {
                    children.push(property_json(key, value.as_deref()));
                    let depths = advance_change_depths(key, deleted_depth, inserted_depth);
                    deleted_depth = depths.0;
                    inserted_depth = depths.1;
                } else {
                    children.push(annotate_walk(doc, child, deleted_depth, inserted_depth));
                }
            }
            let mut m = Map::new();
            m.insert("type".into(), json!("block"));
            m.insert("tag".into(), json!(tag));
            if let Some(a) = args {
                m.insert("args".into(), json!(a));
            }
            m.insert("isBeginVariant".into(), json!(is_begin_variant));
            m.insert("children".into(), Value::Array(children));
            Value::Object(m)
        }
        NodeKind::Document => {
            let children_ids = doc.node(node).children.clone();
            let children: Vec<Value> = children_ids
                .into_iter()
                .map(|c| annotate_walk(doc, c, deleted_depth, inserted_depth))
                .collect();
            let mut m = Map::new();
            m.insert("type".into(), json!("document"));
            m.insert("children".into(), Value::Array(children));
            Value::Object(m)
        }
    }
}

pub fn annotate_changes(doc: &Document, root: NodeId) -> Value {
    annotate_walk(doc, root, 0, 0)
}

pub fn annotate_changes_many(doc: &Document, nodes: &[NodeId]) -> Value {
    Value::Array(nodes.iter().map(|&n| annotate_changes(doc, n)).collect())
}

pub fn annotate_changes_in_place(
    doc: &Document,
    node: NodeId,
    mut deleted_depth: i32,
    mut inserted_depth: i32,
    out: &mut HashMap<NodeId, &'static str>,
) {
    match &doc.node(node).kind {
        NodeKind::Text { .. } => {
            if deleted_depth > 0 {
                out.insert(node, "deleted");
            } else if inserted_depth > 0 {
                out.insert(node, "inserted");
            }
        }
        NodeKind::Block { .. } => {
            let children = doc.node(node).children.clone();
            for child in children {
                annotate_changes_in_place(doc, child, deleted_depth, inserted_depth, out);
                if let NodeKind::Property { key, .. } = &doc.node(child).kind
                    && (is_change_opener(key) || is_change_closer(key))
                {
                    let depths = advance_change_depths(key, deleted_depth, inserted_depth);
                    deleted_depth = depths.0;
                    inserted_depth = depths.1;
                }
            }
        }
        _ => {}
    }
}

fn take_prefix(s: &str, max_len: usize) -> String {
    if s.len() <= max_len {
        s.to_string()
    } else {
        let mut end = max_len;
        while end > 0 && !s.is_char_boundary(end) {
            end -= 1;
        }
        s[..end].to_string()
    }
}

pub fn extract_all_text(doc: &Document, node: NodeId, max_len: usize, in_marker: bool) -> String {
    if max_len == 0 {
        return String::new();
    }
    match &doc.node(node).kind {
        NodeKind::Text { text } => take_prefix(text, max_len),
        NodeKind::Property { key, .. } => {
            if is_change_opener(key) {
                let close = if in_marker { "}" } else { "" };
                let open = format!("\\{key}{{");
                take_prefix(&(close.to_string() + &open), max_len)
            } else if is_change_closer(key) {
                if in_marker {
                    take_prefix("}", max_len)
                } else {
                    String::new()
                }
            } else {
                String::new()
            }
        }
        NodeKind::Block { tag, args, .. } => {
            let tag = tag.clone();
            let args = args.clone();
            if tag == "inset" {
                let args = args.as_deref().unwrap_or("").trim().to_string();
                if args == "ERT" || args.starts_with("ERT ") {
                    let mut raw = String::new();
                    for &child in &doc.node(node).children {
                        if let NodeKind::Text { text } = &doc.node(child).kind {
                            raw.push_str(text);
                            if raw.len() >= max_len {
                                break;
                            }
                        }
                    }
                    return take_prefix(&raw, max_len);
                }
                let label = format!(" inset[{args}] ");
                return take_prefix(&label, max_len);
            }
            let children = doc.node(node).children.clone();
            let mut result = String::new();
            let mut marker_open = in_marker;
            for child in children {
                let remaining = max_len.saturating_sub(result.len());
                if remaining == 0 {
                    break;
                }
                result.push_str(&extract_all_text(doc, child, remaining, marker_open));
                if let NodeKind::Property { key, .. } = &doc.node(child).kind {
                    if is_change_opener(key) {
                        marker_open = true;
                    } else if is_change_closer(key) {
                        marker_open = false;
                    }
                }
            }
            result
        }
        NodeKind::Document => String::new(),
    }
}

/// True when a text node is a Tabular `<row>` / `<column>` line with `change=`.
pub fn is_tabular_line_change_text(text: &str) -> bool {
    text.lines().any(|line| {
        let t = line.trim_start();
        (t.starts_with("<row") || t.starts_with("<column")) && t.contains("change=\"")
    })
}

pub fn has_tracked_changes(doc: &Document, children: &[NodeId]) -> bool {
    for &c in children {
        match &doc.node(c).kind {
            NodeKind::Property { key, .. } if is_change_opener(key) => return true,
            NodeKind::Text { text } if is_tabular_line_change_text(text) => return true,
            NodeKind::Block { .. } if has_tracked_changes(doc, &doc.node(c).children) => {
                return true;
            }
            _ => {}
        }
    }
    false
}

pub fn has_direct_tracked_changes(doc: &Document, children: &[NodeId]) -> bool {
    children.iter().any(|&c| match &doc.node(c).kind {
        NodeKind::Property { key, .. } if is_change_opener(key) => true,
        NodeKind::Text { text } if is_tabular_line_change_text(text) => true,
        _ => false,
    })
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ChangeKind {
    Inserted,
    Deleted,
}

impl ChangeKind {
    fn opener_key(self) -> &'static str {
        match self {
            Self::Inserted => "change_inserted",
            Self::Deleted => "change_deleted",
        }
    }
}

pub(crate) fn wrap_in_change_markers(
    doc: &mut Document,
    content: &[NodeId],
    kind: ChangeKind,
    author_id: i32,
    ts: &str,
) -> Vec<NodeId> {
    let mut out = Vec::with_capacity(content.len() + 2);
    out.push(doc.alloc(NodeKind::Property {
        key: kind.opener_key().into(),
        value: Some(format!("{author_id} {ts}")),
    }));
    out.extend_from_slice(content);
    out.push(doc.alloc(NodeKind::Property {
        key: "change_unchanged".into(),
        value: None,
    }));
    out
}

fn now_ts() -> String {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs().to_string())
        .unwrap_or_else(|_| "0".to_string())
}

pub fn flatten_nested_changes(doc: &mut Document, children: &[NodeId]) -> Vec<NodeId> {
    let children = children.to_vec();
    let mut result = Vec::new();
    let mut i = 0;
    while i < children.len() {
        let child = children[i];
        let opener_key = match &doc.node(child).kind {
            NodeKind::Property { key, .. } => Some(key.clone()),
            _ => None,
        };

        if opener_key.as_deref() == Some("change_deleted") {
            let scanned = scan_region_end(doc, &children, i + 1, "change_deleted", true);
            let (content, closer) = collect_region(&children, i + 1, scanned);
            result.push(child);
            result.extend_from_slice(&content);
            if let Some(closer) = closer {
                result.push(children[closer]);
                i = closer + 1;
            } else {
                i = i + 1 + content.len();
            }
            continue;
        }

        if opener_key.as_deref() == Some("change_inserted") {
            let outer = match &doc.node(child).kind {
                NodeKind::Property { value, .. } => parse_change_marker(value.as_deref()),
                _ => parse_change_marker(None),
            };
            let scanned = scan_region_end(doc, &children, i + 1, "change_inserted", true);
            let (content, end, closer) = collect_region_full(&children, i + 1, scanned);

            let mut segments: Vec<(i32, String, Vec<NodeId>)> = Vec::new();
            let mut outer_run: Vec<NodeId> = Vec::new();
            let mut outer_ts = outer.ts.clone();
            let mut k = 0;
            while k < content.len() {
                let n = content[k];
                let inner_opener = match &doc.node(n).kind {
                    NodeKind::Property { key, value } if is_change_opener(key) => {
                        Some((key.clone(), parse_change_marker(value.as_deref())))
                    }
                    _ => None,
                };
                if let Some((inner_key, inner)) = inner_opener {
                    let inner_scan = scan_region_end(doc, &content, k + 1, &inner_key, false);
                    let inner_end = inner_scan.closer.unwrap_or(content.len());
                    let inner_content: Vec<NodeId> = content[k + 1..inner_end].to_vec();
                    if inner_key == "change_inserted" {
                        if inner.author_id == outer.author_id {
                            if js_int_gt(&inner.ts, &outer_ts) {
                                outer_ts = inner.ts;
                            }
                            outer_run.extend(inner_content);
                        } else {
                            if !outer_run.is_empty() {
                                segments.push((
                                    outer.author_id,
                                    outer_ts.clone(),
                                    std::mem::take(&mut outer_run),
                                ));
                            }
                            segments.push((inner.author_id, inner.ts, inner_content));
                        }
                    }
                    k = inner_scan.closer.map(|c| c + 1).unwrap_or(content.len());
                } else {
                    outer_run.push(n);
                    k += 1;
                }
            }
            if !outer_run.is_empty() {
                segments.push((outer.author_id, outer_ts, outer_run));
            }

            for (author_id, ts, nodes) in segments {
                result.push(doc.alloc(NodeKind::Property {
                    key: "change_inserted".into(),
                    value: Some(format!("{author_id} {ts}")),
                }));
                result.extend(nodes);
            }
            if closer.is_some() || end == children.len() {
                result.push(doc.alloc(NodeKind::Property {
                    key: "change_unchanged".into(),
                    value: None,
                }));
            }
            i = closer.map(|c| c + 1).unwrap_or(end);
            continue;
        }

        result.push(child);
        i += 1;
    }
    result
}

fn collect_region(
    children: &[NodeId],
    start: usize,
    scanned: RegionEnd,
) -> (Vec<NodeId>, Option<usize>) {
    let (content, _end, closer) = collect_region_full(children, start, scanned);
    (content, closer)
}

fn collect_region_full(
    children: &[NodeId],
    start: usize,
    scanned: RegionEnd,
) -> (Vec<NodeId>, usize, Option<usize>) {
    let (end, closer) = if let Some(found) = scanned.closer {
        (found, Some(found))
    } else if let Some(next) = scanned.next_opener {
        (next, None)
    } else {
        (children.len(), None)
    };
    (children[start..end].to_vec(), end, closer)
}

pub fn wrap_with_tracking(
    doc: &mut Document,
    nodes: &[NodeId],
    kind: ChangeKind,
    author_id: i32,
    ts: Option<&str>,
) -> Vec<NodeId> {
    let tracking_ts = ts.map(str::to_string).unwrap_or_else(now_ts);
    let nodes = nodes.to_vec();
    let mut result = Vec::new();
    let mut text_buffer: Vec<NodeId> = Vec::new();

    for n in nodes {
        match &doc.node(n).kind {
            NodeKind::Text { .. } => {
                text_buffer.push(n);
            }
            NodeKind::Block { tag, .. } => {
                let tag = tag.clone();
                if !text_buffer.is_empty() {
                    result.extend(wrap_in_change_markers(
                        doc,
                        &text_buffer,
                        kind,
                        author_id,
                        &tracking_ts,
                    ));
                    text_buffer.clear();
                }
                if tag == "layout" {
                    let inner = doc.node(n).children.clone();
                    let wrapped =
                        wrap_with_tracking(doc, &inner, kind, author_id, Some(&tracking_ts));
                    doc.set_children(n, wrapped);
                    result.push(n);
                } else if tag == "inset" {
                    result.extend(wrap_in_change_markers(
                        doc,
                        &[n],
                        kind,
                        author_id,
                        &tracking_ts,
                    ));
                } else {
                    result.push(n);
                }
            }
            _ => {
                if !text_buffer.is_empty() {
                    result.extend(wrap_in_change_markers(
                        doc,
                        &text_buffer,
                        kind,
                        author_id,
                        &tracking_ts,
                    ));
                    text_buffer.clear();
                }
                result.push(n);
            }
        }
    }
    if !text_buffer.is_empty() {
        result.extend(wrap_in_change_markers(
            doc,
            &text_buffer,
            kind,
            author_id,
            &tracking_ts,
        ));
    }
    result
}

pub fn is_content_node(doc: &Document, n: NodeId) -> bool {
    match &doc.node(n).kind {
        NodeKind::Text { .. } => true,
        NodeKind::Block { tag, .. } => tag == "inset",
        _ => false,
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
enum RegionState {
    Current,
    Inserted { author: i32, ts: String },
    Deleted { author: i32, ts: String },
}

fn same_region(a: &RegionState, b: &RegionState) -> bool {
    match (a, b) {
        (RegionState::Current, RegionState::Current) => true,
        (RegionState::Inserted { author: a, .. }, RegionState::Inserted { author: b, .. }) => {
            a == b
        }
        (RegionState::Deleted { author: a, .. }, RegionState::Deleted { author: b, .. }) => a == b,
        _ => false,
    }
}

pub fn apply_tracked_delete_to_children(
    doc: &mut Document,
    children: &[NodeId],
    is_matched: impl Fn(&Document, NodeId) -> bool,
    deleter_id: i32,
    ts: &str,
    fold_properties: bool,
) -> Vec<NodeId> {
    let children = children.to_vec();
    if !children
        .iter()
        .any(|&n| is_content_node(doc, n) && is_matched(doc, n))
    {
        return children;
    }

    struct Item {
        state: RegionState,
        node: NodeId,
    }
    let mut items: Vec<Item> = Vec::new();
    let mut region_state = RegionState::Current;
    let mut pending_props: Vec<NodeId> = Vec::new();
    let mut last_state = RegionState::Current;

    fn push(items: &mut Vec<Item>, last_state: &mut RegionState, state: RegionState, node: NodeId) {
        last_state.clone_from(&state);
        items.push(Item { state, node });
    }
    fn flush_pending(
        items: &mut Vec<Item>,
        last_state: &mut RegionState,
        pending: &mut Vec<NodeId>,
        state: &RegionState,
    ) {
        for p in pending.drain(..) {
            last_state.clone_from(state);
            items.push(Item {
                state: state.clone(),
                node: p,
            });
        }
    }

    for child in children {
        if let NodeKind::Property { key, value } = &doc.node(child).kind {
            if is_change_opener(key) {
                let m = parse_change_marker(value.as_deref());
                region_state = if key == "change_inserted" {
                    RegionState::Inserted {
                        author: m.author_id,
                        ts: m.ts,
                    }
                } else {
                    RegionState::Deleted {
                        author: m.author_id,
                        ts: m.ts,
                    }
                };
                continue;
            }
            if is_change_closer(key) {
                region_state = RegionState::Current;
                continue;
            }
            if fold_properties {
                pending_props.push(child);
                continue;
            }
        }
        let is_content = is_content_node(doc, child);
        if is_content && is_matched(doc, child) {
            match region_state.clone() {
                RegionState::Current => {
                    let st = RegionState::Deleted {
                        author: deleter_id,
                        ts: ts.to_string(),
                    };
                    flush_pending(&mut items, &mut last_state, &mut pending_props, &st);
                    push(&mut items, &mut last_state, st, child);
                }
                RegionState::Inserted { author, .. } if author != deleter_id => {
                    let st = RegionState::Deleted {
                        author: deleter_id,
                        ts: ts.to_string(),
                    };
                    flush_pending(&mut items, &mut last_state, &mut pending_props, &st);
                    push(&mut items, &mut last_state, st, child);
                }
                RegionState::Inserted { .. } => {
                    let st = last_state.clone();
                    flush_pending(&mut items, &mut last_state, &mut pending_props, &st);
                }
                RegionState::Deleted { .. } => {
                    flush_pending(
                        &mut items,
                        &mut last_state,
                        &mut pending_props,
                        &region_state,
                    );
                    push(&mut items, &mut last_state, region_state.clone(), child);
                }
            }
        } else {
            flush_pending(
                &mut items,
                &mut last_state,
                &mut pending_props,
                &region_state,
            );
            push(&mut items, &mut last_state, region_state.clone(), child);
        }
    }
    let trailing = last_state.clone();
    flush_pending(&mut items, &mut last_state, &mut pending_props, &trailing);

    let mut runs: Vec<(RegionState, Vec<NodeId>)> = Vec::new();
    for item in items {
        if let Some(last) = runs.last_mut()
            && same_region(&last.0, &item.state)
        {
            last.1.push(item.node);
        } else {
            runs.push((item.state, vec![item.node]));
        }
    }

    let mut out = Vec::new();
    let mut prev = RegionState::Current;
    for (state, nodes) in runs {
        match &state {
            RegionState::Inserted { author, ts } => {
                out.push(doc.alloc(NodeKind::Property {
                    key: "change_inserted".into(),
                    value: Some(format!("{author} {ts}")),
                }));
            }
            RegionState::Deleted { author, ts } => {
                out.push(doc.alloc(NodeKind::Property {
                    key: "change_deleted".into(),
                    value: Some(format!("{author} {ts}")),
                }));
            }
            RegionState::Current if !matches!(prev, RegionState::Current) => {
                out.push(doc.alloc(NodeKind::Property {
                    key: "change_unchanged".into(),
                    value: None,
                }));
            }
            RegionState::Current => {}
        }
        out.extend(nodes);
        prev = state;
    }
    if matches!(region_state, RegionState::Current) && !matches!(prev, RegionState::Current) {
        out.push(doc.alloc(NodeKind::Property {
            key: "change_unchanged".into(),
            value: None,
        }));
    }
    out
}

pub fn has_layout_ancestor(doc: &Document, node: NodeId, root: NodeId) -> bool {
    fn walk(doc: &Document, list: &[NodeId], in_layout_text: bool, node: NodeId) -> Option<bool> {
        for &child in list {
            if child == node {
                if let NodeKind::Block { tag, .. } = &doc.node(child).kind {
                    return Some(tag == "layout");
                }
                return Some(in_layout_text);
            }
            if let NodeKind::Block { tag, .. } = &doc.node(child).kind {
                let next_in_layout = tag == "layout";
                let kids = doc.node(child).children.clone();
                if let Some(r) = walk(doc, &kids, next_in_layout, node) {
                    return Some(r);
                }
            }
        }
        None
    }
    walk(doc, &doc.node(root).children, false, node).unwrap_or(false)
}

fn segments_cross_inset(
    doc: &Document,
    children: &[NodeId],
    seg_a: &TextSegment,
    seg_b: &TextSegment,
) -> bool {
    let start = seg_a.child_index + 1;
    let end = seg_b.child_index;
    if start >= end {
        return false;
    }
    children[start..end]
        .iter()
        .any(|&id| matches!(doc.node(id).kind, NodeKind::Block { .. }))
}

struct SegRegion {
    deleted: bool,
    inserted: bool,
    author: i32,
    ts: String,
    props: HashMap<String, Option<String>>,
}

fn match_in_scope(
    segments: &[TextSegment],
    seg_regions: &[SegRegion],
    ms: usize,
    me: usize,
    scope: &ScopePredicate,
) -> bool {
    let mut offset = 0;
    for (j, seg) in segments.iter().enumerate() {
        let seg_start = offset;
        let seg_end = offset + seg.text.len();
        if seg_end > ms && seg_start < me {
            let region = if seg_regions[j].deleted {
                ScopeState::Deleted
            } else if seg_regions[j].inserted {
                ScopeState::Inserted
            } else {
                ScopeState::Current
            };
            if !scope.matches(region, &seg_regions[j].props) {
                return false;
            }
        }
        offset = seg_end;
    }
    true
}

fn range_touches_deleted(
    segments: &[TextSegment],
    seg_regions: &[SegRegion],
    ms: usize,
    me: usize,
) -> bool {
    let mut offset = 0;
    for (j, seg) in segments.iter().enumerate() {
        let seg_start = offset;
        let seg_end = offset + seg.text.len();
        if seg_end > ms && seg_start < me && seg_regions[j].deleted {
            return true;
        }
        offset = seg_end;
    }
    false
}

fn property_strictly_inside_match(
    doc: &Document,
    children: &[NodeId],
    segments: &[TextSegment],
    seg_start_offsets: &[usize],
    is_matched: &[bool],
    child_index: usize,
) -> bool {
    let mut before_idx = None;
    for k in (0..child_index).rev() {
        if matches!(doc.node(children[k]).kind, NodeKind::Text { .. }) {
            before_idx = Some(k);
            break;
        }
    }
    let mut after_idx = None;
    for (k, &id) in children.iter().enumerate().skip(child_index + 1) {
        if matches!(doc.node(id).kind, NodeKind::Text { .. }) {
            after_idx = Some(k);
            break;
        }
    }
    let (Some(before_idx), Some(after_idx)) = (before_idx, after_idx) else {
        return false;
    };
    let mut seg_before = None;
    let mut seg_after = None;
    for (j, seg) in segments.iter().enumerate() {
        if seg.child_index == before_idx {
            seg_before = Some(j);
        }
        if seg.child_index == after_idx {
            seg_after = Some(j);
        }
    }
    let (Some(seg_before), Some(seg_after)) = (seg_before, seg_after) else {
        return false;
    };
    if seg_after != seg_before + 1 {
        return false;
    }
    let boundary = seg_start_offsets[seg_after];
    if boundary == 0 || boundary >= is_matched.len() {
        return false;
    }
    is_matched[boundary - 1] && is_matched[boundary]
}

#[derive(Clone, Debug)]
pub struct CrossNodeReplace {
    pub new_children: Vec<NodeId>,
    pub match_count: usize,
    pub deleted_hit_count: usize,
    pub crossed_inset_count: usize,
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum OutState {
    U,
    D,
    I,
}

enum Atom {
    Text {
        text: String,
        state: OutState,
        author: i32,
        ts: String,
    },
    Prop {
        node: NodeId,
    },
    Block {
        node: NodeId,
        state: OutState,
        author: i32,
        ts: String,
    },
}

#[allow(clippy::too_many_arguments)] // Deno applyCrossNodeReplace positional args
pub fn apply_cross_node_replace(
    doc: &mut Document,
    parent: NodeId,
    find_str: &str,
    new_value: &str,
    tracked: bool,
    author_id: i32,
    ts: &str,
    scope: Option<&ScopePredicate>,
    inherited_state: Option<&TraversalState>,
) -> CrossNodeReplace {
    let children = doc.node(parent).children.clone();
    if find_str.is_empty() {
        return CrossNodeReplace {
            new_children: children,
            match_count: 0,
            deleted_hit_count: 0,
            crossed_inset_count: 0,
        };
    }
    let opts = ConcatOpts {
        include_deleted: true,
        inherited_state: inherited_state.cloned(),
        ..ConcatOpts::default()
    };
    let (segments, full_text) = concatenate_text_nodes(doc, parent, &opts);
    if segments.is_empty() || full_text.is_empty() {
        return CrossNodeReplace {
            new_children: children,
            match_count: 0,
            deleted_hit_count: 0,
            crossed_inset_count: 0,
        };
    }

    let mut match_starts = Vec::new();
    let mut pos = 0;
    while let Some(found) = full_text[pos..].find(find_str) {
        let abs = pos + found;
        match_starts.push(abs);
        pos = abs + find_str.len();
    }
    if match_starts.is_empty() {
        return CrossNodeReplace {
            new_children: children,
            match_count: 0,
            deleted_hit_count: 0,
            crossed_inset_count: 0,
        };
    }

    let default_state = create_traversal_state();
    let inherited = inherited_state.unwrap_or(&default_state);
    let mut seg_regions = Vec::new();
    {
        let mut state = enter_traversal_state(inherited);
        let mut seg = 0;
        for (i, &c) in children.iter().enumerate() {
            match &doc.node(c).kind {
                NodeKind::Property { key, value }
                    if is_change_opener(key)
                        || is_change_closer(key)
                        || is_inline_style_key(key) =>
                {
                    advance_traversal_state(&mut state, key, value.as_deref());
                }
                NodeKind::Text { .. } if seg < segments.len() && segments[seg].child_index == i => {
                    let region = traversal_region(&state);
                    let (author, ts) = traversal_change(&state);
                    seg_regions.push(SegRegion {
                        deleted: region == crate::text_utils::TextRegion::Deleted,
                        inserted: region == crate::text_utils::TextRegion::Inserted,
                        author,
                        ts,
                        props: state.properties.clone(),
                    });
                    seg += 1;
                }
                _ => {}
            }
        }
    }

    let mut is_matched = vec![false; full_text.len()];
    let mut valid_count = 0usize;
    let mut deleted_hit_count = 0usize;
    let mut crossed_inset_count = 0usize;
    for ms in match_starts {
        let me = ms + find_str.len();
        let (s_idx, _) = map_pos_to_segment(&segments, ms);
        let (e_idx, _) = map_pos_to_segment(&segments, if me > 0 { me - 1 } else { 0 });
        if segments_cross_inset(doc, &children, &segments[s_idx], &segments[e_idx]) {
            crossed_inset_count += 1;
            continue;
        }
        if let Some(scope) = scope {
            if !match_in_scope(&segments, &seg_regions, ms, me, scope) {
                continue;
            }
        } else if range_touches_deleted(&segments, &seg_regions, ms, me) {
            deleted_hit_count += 1;
        }
        is_matched[ms..me].fill(true);
        valid_count += 1;
    }
    if valid_count == 0 {
        return CrossNodeReplace {
            new_children: children,
            match_count: 0,
            deleted_hit_count,
            crossed_inset_count,
        };
    }

    let mut seg_start_offsets = Vec::new();
    {
        let mut acc = 0;
        for s in &segments {
            seg_start_offsets.push(acc);
            acc += s.text.len();
        }
    }

    let mut atoms: Vec<Atom> = Vec::new();
    let mut concat_pos = 0;
    let mut seg_idx = 0;
    let mut in_match = false;
    let mut pending_props: Vec<NodeId> = Vec::new();
    let mut open_traversal_state = enter_traversal_state(inherited);
    let open_state = |st: &TraversalState| match traversal_region(st) {
        crate::text_utils::TextRegion::Deleted => OutState::D,
        crate::text_utils::TextRegion::Inserted => OutState::I,
        crate::text_utils::TextRegion::Current => OutState::U,
    };

    for (i, &child) in children.iter().enumerate() {
        if seg_idx < segments.len() && segments[seg_idx].child_index == i {
            let seg = &segments[seg_idx];
            let seg_start = concat_pos;
            let seg_text = &seg.text;
            let seg_region = &seg_regions[seg_idx];

            if !tracked && !seg_text.is_empty() {
                let mut in_place_text: Option<String> = None;
                let mut needs_standard_path = false;
                let mut k = 0;
                while k < seg_text.len() {
                    let gp = seg_start + k;
                    if is_matched[gp] {
                        let mut re = k;
                        while re < seg_text.len() && is_matched[seg_start + re] {
                            re += 1;
                            while re < seg_text.len() && !seg_text.is_char_boundary(re) {
                                re += 1;
                            }
                        }
                        if re - k != find_str.len() {
                            needs_standard_path = true;
                            break;
                        }
                        in_place_text = Some(match in_place_text {
                            None => format!("{}{new_value}", &seg_text[..k]),
                            Some(s) => s + new_value,
                        });
                        k = re;
                    } else {
                        let mut re = k;
                        while re < seg_text.len() && !is_matched[seg_start + re] {
                            re += 1;
                            while re < seg_text.len() && !seg_text.is_char_boundary(re) {
                                re += 1;
                            }
                        }
                        if let Some(ref mut s) = in_place_text {
                            s.push_str(&seg_text[k..re]);
                        }
                        k = re;
                    }
                }
                if !needs_standard_path && let Some(in_place_text) = in_place_text {
                    let (author, ts) = traversal_change(&open_traversal_state);
                    atoms.push(Atom::Text {
                        text: in_place_text,
                        state: open_state(&open_traversal_state),
                        author,
                        ts,
                    });
                    concat_pos += seg_text.len();
                    seg_idx += 1;
                    continue;
                }
            }

            if seg_text.is_empty() {
                if in_match {
                    in_match = false;
                    for p in pending_props.drain(..) {
                        atoms.push(Atom::Prop { node: p });
                    }
                }
                atoms.push(Atom::Text {
                    text: String::new(),
                    state: OutState::U,
                    author: 0,
                    ts: String::new(),
                });
                concat_pos += seg_text.len();
                seg_idx += 1;
                continue;
            }

            let mut char_idx = 0;
            while char_idx < seg_text.len() {
                let global_pos = seg_start + char_idx;
                if is_matched[global_pos] {
                    let mut run_end = char_idx;
                    while run_end < seg_text.len() && is_matched[seg_start + run_end] {
                        run_end += 1;
                    }
                    while run_end < seg_text.len() && !seg_text.is_char_boundary(run_end) {
                        run_end += 1;
                    }
                    let run_text = &seg_text[char_idx..run_end];
                    if !in_match {
                        in_match = true;
                        if tracked {
                            atoms.push(Atom::Text {
                                text: new_value.to_string(),
                                state: OutState::I,
                                author: author_id,
                                ts: ts.to_string(),
                            });
                        } else {
                            atoms.push(Atom::Text {
                                text: new_value.to_string(),
                                state: OutState::U,
                                author: 0,
                                ts: String::new(),
                            });
                        }
                    }
                    if tracked && !(seg_region.inserted && seg_region.author == author_id) {
                        if seg_region.deleted {
                            atoms.push(Atom::Text {
                                text: run_text.to_string(),
                                state: OutState::D,
                                author: seg_region.author,
                                ts: seg_region.ts.clone(),
                            });
                        } else {
                            atoms.push(Atom::Text {
                                text: run_text.to_string(),
                                state: OutState::D,
                                author: author_id,
                                ts: ts.to_string(),
                            });
                        }
                    }
                    char_idx = run_end;
                } else {
                    if in_match {
                        in_match = false;
                        for p in pending_props.drain(..) {
                            atoms.push(Atom::Prop { node: p });
                        }
                    }
                    let mut run_end = char_idx;
                    while run_end < seg_text.len() && !is_matched[seg_start + run_end] {
                        run_end += 1;
                    }
                    while run_end < seg_text.len() && !seg_text.is_char_boundary(run_end) {
                        run_end += 1;
                    }
                    let (author, tsv) = traversal_change(&open_traversal_state);
                    atoms.push(Atom::Text {
                        text: seg_text[char_idx..run_end].to_string(),
                        state: open_state(&open_traversal_state),
                        author,
                        ts: tsv,
                    });
                    char_idx = run_end;
                }
            }

            concat_pos += seg_text.len();
            seg_idx += 1;
        } else {
            match &doc.node(child).kind {
                NodeKind::Property { key, value }
                    if is_change_opener(key) || is_change_closer(key) =>
                {
                    advance_traversal_state(&mut open_traversal_state, key, value.as_deref());
                    continue;
                }
                NodeKind::Block { .. } if in_match => {
                    in_match = false;
                    for p in pending_props.drain(..) {
                        atoms.push(Atom::Prop { node: p });
                    }
                }
                _ => {}
            }
            if matches!(doc.node(child).kind, NodeKind::Property { .. }) {
                if property_strictly_inside_match(
                    doc,
                    &children,
                    &segments,
                    &seg_start_offsets,
                    &is_matched,
                    i,
                ) {
                    continue;
                }
                if in_match {
                    pending_props.push(child);
                    continue;
                }
            }
            if matches!(doc.node(child).kind, NodeKind::Block { .. }) {
                let (author, tsv) = traversal_change(&open_traversal_state);
                atoms.push(Atom::Block {
                    node: child,
                    state: open_state(&open_traversal_state),
                    author,
                    ts: tsv,
                });
            } else {
                atoms.push(Atom::Prop { node: child });
            }
        }
    }

    if in_match {
        for p in pending_props.drain(..) {
            atoms.push(Atom::Prop { node: p });
        }
    }

    let mut result = Vec::new();
    let mut cur_state = OutState::U;
    let mut cur_author = -1i32;

    for atom in atoms {
        match atom {
            Atom::Text {
                text,
                state,
                author,
                ts,
            } => {
                if text.is_empty() {
                    result.push(doc.alloc(NodeKind::Text { text }));
                    continue;
                }
                emit_transition(
                    doc,
                    &mut result,
                    &mut cur_state,
                    &mut cur_author,
                    state,
                    author,
                    &ts,
                );
                result.push(doc.alloc(NodeKind::Text { text }));
            }
            Atom::Block {
                node,
                state,
                author,
                ts,
            } => {
                emit_transition(
                    doc,
                    &mut result,
                    &mut cur_state,
                    &mut cur_author,
                    state,
                    author,
                    &ts,
                );
                result.push(node);
            }
            Atom::Prop { node } => result.push(node),
        }
    }
    if cur_state != OutState::U {
        result.push(doc.alloc(NodeKind::Property {
            key: "change_unchanged".into(),
            value: None,
        }));
    }

    CrossNodeReplace {
        new_children: result,
        match_count: valid_count,
        deleted_hit_count,
        crossed_inset_count,
    }
}

fn emit_transition(
    doc: &mut Document,
    result: &mut Vec<NodeId>,
    cur_state: &mut OutState,
    cur_author: &mut i32,
    state: OutState,
    author: i32,
    tsv: &str,
) {
    if state == OutState::U {
        if *cur_state != OutState::U {
            result.push(doc.alloc(NodeKind::Property {
                key: "change_unchanged".into(),
                value: None,
            }));
            *cur_state = OutState::U;
        }
    } else if !(*cur_state == state && *cur_author == author) {
        let key = if state == OutState::D {
            "change_deleted"
        } else {
            "change_inserted"
        };
        result.push(doc.alloc(NodeKind::Property {
            key: key.into(),
            value: Some(format!("{author} {tsv}")),
        }));
        *cur_state = state;
        *cur_author = author;
    }
}
