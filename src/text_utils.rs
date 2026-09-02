//! Flat-model text walkers (Deno `text_utils.ts`).

use crate::ast::{Document, NodeId, NodeKind};
use std::collections::HashMap;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum TextRegion {
    Deleted,
    Inserted,
    Current,
}

pub fn invisible_inset_type(tag: &str, args: Option<&str>) -> Option<&'static str> {
    if tag != "inset" {
        return None;
    }
    match args.unwrap_or("").trim() {
        "Note Note" => Some("Note"),
        "Note Comment" => Some("Comment"),
        _ => None,
    }
}

pub fn is_invisible_inset(tag: &str, args: Option<&str>) -> bool {
    invisible_inset_type(tag, args).is_some()
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct TraversalState {
    pub deleted_depth: i32,
    pub inserted_depth: i32,
    pub deleted_author: i32,
    pub deleted_ts: String,
    pub inserted_author: i32,
    pub inserted_ts: String,
    pub outer_deleted_depth: i32,
    pub outer_inserted_depth: i32,
    pub outer_deleted_author: i32,
    pub outer_deleted_ts: String,
    pub outer_inserted_author: i32,
    pub outer_inserted_ts: String,
    pub properties: HashMap<String, Option<String>>,
}

pub(crate) fn create_traversal_state() -> TraversalState {
    TraversalState {
        deleted_depth: 0,
        inserted_depth: 0,
        deleted_author: 0,
        deleted_ts: String::new(),
        inserted_author: 0,
        inserted_ts: String::new(),
        outer_deleted_depth: 0,
        outer_inserted_depth: 0,
        outer_deleted_author: 0,
        outer_deleted_ts: String::new(),
        outer_inserted_author: 0,
        outer_inserted_ts: String::new(),
        properties: HashMap::new(),
    }
}

pub(crate) fn clone_traversal_state(state: &TraversalState) -> TraversalState {
    state.clone()
}

pub(crate) fn traversal_region(state: &TraversalState) -> TextRegion {
    if state.deleted_depth > 0 {
        TextRegion::Deleted
    } else if state.inserted_depth > 0 {
        TextRegion::Inserted
    } else if state.outer_deleted_depth > 0 {
        TextRegion::Deleted
    } else if state.outer_inserted_depth > 0 {
        TextRegion::Inserted
    } else {
        TextRegion::Current
    }
}

pub(crate) fn traversal_change(state: &TraversalState) -> (i32, String) {
    if state.deleted_depth > 0 {
        (state.deleted_author, state.deleted_ts.clone())
    } else if state.inserted_depth > 0 {
        (state.inserted_author, state.inserted_ts.clone())
    } else if state.outer_deleted_depth > 0 {
        (state.outer_deleted_author, state.outer_deleted_ts.clone())
    } else if state.outer_inserted_depth > 0 {
        (state.outer_inserted_author, state.outer_inserted_ts.clone())
    } else {
        (0, String::new())
    }
}

pub(crate) fn enter_traversal_state(parent: &TraversalState) -> TraversalState {
    let mut child = create_traversal_state();
    let region = traversal_region(parent);
    let (author, ts) = traversal_change(parent);
    match region {
        TextRegion::Deleted => {
            child.outer_deleted_depth = 1;
            child.outer_deleted_author = author;
            child.outer_deleted_ts = ts;
        }
        TextRegion::Inserted => {
            child.outer_inserted_depth = 1;
            child.outer_inserted_author = author;
            child.outer_inserted_ts = ts;
        }
        TextRegion::Current => {}
    }
    child.properties = parent.properties.clone();
    child
}

fn parse_author_id(s: &str) -> i32 {
    s.parse::<i32>().unwrap_or(0)
}

pub(crate) fn advance_traversal_state(state: &mut TraversalState, key: &str, value: Option<&str>) {
    if key == "change_deleted" || key == "change_inserted" || key == "change_unchanged" {
        let previous_deleted_depth = state.deleted_depth;
        let previous_inserted_depth = state.inserted_depth;
        let (deleted_depth, inserted_depth) =
            advance_change_depths(key, previous_deleted_depth, previous_inserted_depth);
        state.deleted_depth = deleted_depth;
        state.inserted_depth = inserted_depth;

        if key == "change_deleted" {
            let parts: Vec<&str> = value.unwrap_or("").split_whitespace().collect();
            state.deleted_author = parse_author_id(parts.first().copied().unwrap_or(""));
            state.deleted_ts = parts.get(1).unwrap_or(&"0").to_string();
            state.inserted_author = 0;
            state.inserted_ts.clear();
        } else if key == "change_inserted" {
            let parts: Vec<&str> = value.unwrap_or("").split_whitespace().collect();
            state.inserted_author = parse_author_id(parts.first().copied().unwrap_or(""));
            state.inserted_ts = parts.get(1).unwrap_or(&"0").to_string();
            state.deleted_author = 0;
            state.deleted_ts.clear();
        } else {
            if previous_deleted_depth > 0 && state.deleted_depth == 0 {
                state.deleted_author = 0;
                state.deleted_ts.clear();
            }
            if previous_inserted_depth > 0 && state.inserted_depth == 0 {
                state.inserted_author = 0;
                state.inserted_ts.clear();
            }
        }
        return;
    }

    state
        .properties
        .insert(key.to_string(), value.map(str::to_string));
}

#[derive(Clone, Debug)]
pub struct TextSegment {
    pub child_index: usize,
    pub text: String,
    pub owner: Option<NodeId>,
    pub state: TraversalState,
}

pub fn advance_change_depths(key: &str, deleted_depth: i32, inserted_depth: i32) -> (i32, i32) {
    if key == "change_deleted" {
        return (deleted_depth + 1, 0);
    }
    if key == "change_inserted" {
        return (0, inserted_depth + 1);
    }
    if inserted_depth > 0 {
        return (deleted_depth, inserted_depth - 1);
    }
    if deleted_depth > 0 {
        return (deleted_depth - 1, inserted_depth);
    }
    (deleted_depth, inserted_depth)
}

fn is_change_marker_key(key: &str) -> bool {
    key == "change_deleted" || key == "change_inserted" || key == "change_unchanged"
}

/// Region of `parent`'s child at `index` from sibling change markers only.
pub(crate) fn region_at(doc: &Document, parent: NodeId, index: usize) -> TextRegion {
    let mut deleted_depth = 0i32;
    let mut inserted_depth = 0i32;
    for &id in doc.node(parent).children.iter().take(index) {
        if let NodeKind::Property { key, .. } = &doc.node(id).kind
            && is_change_marker_key(key)
        {
            let (d, ins) = advance_change_depths(key, deleted_depth, inserted_depth);
            deleted_depth = d;
            inserted_depth = ins;
        }
    }
    if deleted_depth > 0 {
        TextRegion::Deleted
    } else if inserted_depth > 0 {
        TextRegion::Inserted
    } else {
        TextRegion::Current
    }
}

#[derive(Clone, Debug)]
pub struct ConcatOpts {
    pub recurse_layouts: bool,
    pub top_level_is_layout: bool,
    pub include_deleted: bool,
    pub inherited_state: Option<TraversalState>,
    pub skip_invisible_notes: bool,
}

impl Default for ConcatOpts {
    fn default() -> Self {
        Self {
            recurse_layouts: false,
            top_level_is_layout: true,
            include_deleted: false,
            inherited_state: None,
            skip_invisible_notes: false,
        }
    }
}

pub fn concatenate_text_nodes(
    doc: &Document,
    parent: NodeId,
    opts: &ConcatOpts,
) -> (Vec<TextSegment>, String) {
    let mut segments = Vec::new();
    let inherited = opts
        .inherited_state
        .clone()
        .unwrap_or_else(create_traversal_state);
    walk(
        doc,
        parent,
        opts.top_level_is_layout,
        &inherited,
        opts,
        &mut segments,
    );
    let full_text = segments.iter().map(|s| s.text.as_str()).collect::<String>();
    (segments, full_text)
}

fn walk(
    doc: &Document,
    list_owner: NodeId,
    collect_text: bool,
    inherited_state: &TraversalState,
    opts: &ConcatOpts,
    segments: &mut Vec<TextSegment>,
) {
    let ids = doc.node(list_owner).children.clone();
    let mut state = enter_traversal_state(inherited_state);
    for (i, &id) in ids.iter().enumerate() {
        match &doc.node(id).kind {
            NodeKind::Property { key, value } => {
                advance_traversal_state(&mut state, key, value.as_deref());
            }
            NodeKind::Text { text } => {
                if collect_text
                    && (opts.include_deleted || traversal_region(&state) != TextRegion::Deleted)
                {
                    let segment_state = clone_traversal_state(&state);
                    segments.push(TextSegment {
                        child_index: i,
                        text: text.clone(),
                        owner: if opts.recurse_layouts {
                            Some(list_owner)
                        } else {
                            None
                        },
                        state: segment_state,
                    });
                }
            }
            NodeKind::Block { tag, args, .. } if opts.recurse_layouts => {
                if tag == "layout" {
                    walk(doc, id, true, &state, opts, segments);
                } else if tag == "inset" {
                    if opts.skip_invisible_notes && is_invisible_inset(tag, args.as_deref()) {
                        continue;
                    }
                    walk(doc, id, false, &state, opts, segments);
                }
            }
            _ => {}
        }
    }
}

pub fn map_pos_to_segment(segments: &[TextSegment], pos: usize) -> (usize, usize) {
    let mut remaining = pos;
    for (i, seg) in segments.iter().enumerate() {
        if remaining < seg.text.len() {
            return (i, remaining);
        }
        remaining -= seg.text.len();
    }
    let last = segments
        .last()
        .expect("invariant: map_pos_to_segment on non-empty segments");
    (segments.len() - 1, last.text.len())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::parse;

    #[test]
    fn change_depths_zero_opposite() {
        assert_eq!(advance_change_depths("change_deleted", 0, 3), (1, 0));
        assert_eq!(advance_change_depths("change_inserted", 2, 0), (0, 1));
        assert_eq!(advance_change_depths("change_unchanged", 0, 1), (0, 0));
        assert_eq!(advance_change_depths("change_unchanged", 1, 0), (0, 0));
    }

    #[test]
    fn private_notes_only() {
        assert_eq!(
            invisible_inset_type("inset", Some("Note Note")),
            Some("Note")
        );
        assert_eq!(
            invisible_inset_type("inset", Some("Note Comment")),
            Some("Comment")
        );
        assert!(!is_invisible_inset("inset", Some("Note Greyedout")));
        assert!(!is_invisible_inset("layout", Some("Note Note")));
    }

    #[test]
    fn concatenate_skips_deleted_by_default() {
        let src = "\\begin_layout Standard\nkeep\n\\change_deleted 1 1\ngone\n\\change_unchanged\nmore\n\\end_layout";
        let doc = parse(src, true).unwrap();
        let layout = doc.node(doc.root()).children[0];
        let (_segs, full) = concatenate_text_nodes(&doc, layout, &ConcatOpts::default());
        assert_eq!(full, "keepmore");
        let (_segs, all) = concatenate_text_nodes(
            &doc,
            layout,
            &ConcatOpts {
                include_deleted: true,
                ..ConcatOpts::default()
            },
        );
        assert_eq!(all, "keepgonemore");
    }
}
