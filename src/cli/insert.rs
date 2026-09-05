//! `lq insert` (Deno `cli.ts` insert branch).

use super::common::{
    CliError, UserConfig, print_json, push_warning, read_utf8_file, resolve_document_layout_roots,
};
use super::mutate::{
    MutationEnv, OpenRegion, alloc_block, alloc_prop, alloc_text, assert_tracking_header,
    block_args, block_tag, brief_text, commit_and_refresh, find_node_context, is_invisible_block,
    match_span_in_scope, node_label, now_ts, open_region_info, phrase_only_in_invisible_content,
    set_prop_value, validate_raw_insets,
};
use crate::ast::{Document, NodeId, NodeKind};
use crate::parser::parse;
use crate::query::{build_scope_predicate, selector_note_scope};
use crate::schema::{extract_document_layout_context, get_schema_for_class};
use crate::text_utils::{
    ConcatOpts, TextRegion, advance_change_depths, concatenate_text_nodes, map_pos_to_segment,
    traversal_region,
};
use crate::tracked_changes::{
    ChangeKind, ensure_tracking_changes_in_header, is_change_closer, is_change_opener,
    resolve_author_id, wrap_in_change_markers, wrap_with_tracking,
};
use crate::undo::{SnapshotMode, collect_snapshots};
use serde_json::json;

const CITE_CMDS: &[&str] = &[
    "cite",
    "citet",
    "citep",
    "citeauthor",
    "citeyear",
    "citeyearpar",
    "citebyear",
    "footcite",
    "autocite",
    "citetitle",
    "fullcite",
    "footfullcite",
    "nocite",
    "keyonly",
];
const REF_CMDS: &[&str] = &[
    "ref",
    "eqref",
    "pageref",
    "vpageref",
    "vref",
    "nameref",
    "formatted",
    "labelonly",
];

pub fn run_insert(
    doc: &mut Document,
    nodes: &[NodeId],
    env: &MutationEnv<'_>,
    config: &UserConfig,
) -> Result<(), CliError> {
    if nodes.is_empty() {
        let selector = env.selector.unwrap_or("");
        return Err(CliError::new(
            "NO_MATCH",
            format!(
                "Selector matched no nodes to insert around. Run 'lq read {} \"{selector}\" --count' to verify or refine the selector.",
                env.file_path
            ),
        ));
    }
    let selector = env.selector.expect("invariant: insert requires a selector");

    let position = env.rest.first().map(String::as_str).unwrap_or("");
    let mut split_match: Option<String> = None;
    if position == "split-after" {
        let m = env.rest.get(1).map(String::as_str).unwrap_or("");
        if m.is_empty() {
            return Err(CliError::new(
                "MISSING_ARGS",
                "split-after requires a non-empty match string, e.g. split-after monetary policy",
            ));
        }
        split_match = Some(m.to_string());
    }
    if !matches!(
        position,
        "before" | "after" | "prepend" | "append" | "split-after"
    ) {
        return Err(CliError::new(
            "INVALID_POSITION",
            "Position must be 'before', 'after', 'prepend', 'append', or 'split-after' (followed by the match string as the next argument).",
        ));
    }
    let flags = env.flags;

    let mut flag_count = 0u32;
    if flags.str("raw-file").is_some() {
        flag_count += 1;
    }
    if flags.str("layout").is_some() {
        flag_count += 1;
    }
    if flags.str("cite").is_some() {
        flag_count += 1;
    }
    if flags.str("ref").is_some() {
        flag_count += 1;
    }
    if flags.str("label").is_some() {
        flag_count += 1;
    }
    if flags.str("footnote").is_some() {
        flag_count += 1;
    }
    if flags.str("table").is_some() {
        flag_count += 1;
    }
    if flag_count > 1 {
        return Err(CliError::new(
            "FLAG_CONFLICT",
            "You cannot mix --raw-file, --layout, --cite, --ref, --label, --footnote, or --table. Please provide exactly one generation strategy.",
        ));
    }

    if flags.str("layout").is_some() && position == "split-after" {
        return Err(CliError::new(
            "INVALID_FLAG",
            "Position cannot be 'split-after' with --layout. Use before, after, prepend, or append.",
        ));
    }
    if flags.str("table").is_some() && !matches!(position, "before" | "after") {
        return Err(CliError::new(
            "INVALID_POSITION",
            "Position must be 'before' or 'after' with --table.",
        ));
    }

    let mut templates: Vec<NodeId> = Vec::new();
    if let Some(raw_path) = flags.str("raw-file") {
        let raw = read_utf8_file(raw_path, &format!("Could not read --raw-file '{raw_path}'"))?;
        let temp = match parse(&raw, true) {
            Ok(d) => d,
            Err(e) => {
                return Err(CliError::new(
                    "PARSE_ERROR",
                    format!("Failed to parse raw LyX string: {e}"),
                ));
            }
        };
        // Merge snippet nodes into the live document via clone after copying tree...
        // Simpler: parse into `doc`? Can't. clone_subtree from another Document is impossible.
        // Alloc equivalent nodes into `doc` from the snippet.
        let valid = snippet_blocks(&temp);
        if valid.is_empty() {
            return Err(CliError::new(
                "INVALID_RAW",
                "The --raw-file content did not parse into any valid LyX blocks or properties. Expected content like: \\begin_layout Standard\nYour text\n\\end_layout",
            ));
        }
        for w in validate_raw_insets(&temp) {
            push_warning(w);
        }
        for &n in &valid {
            templates.push(copy_subtree(doc, &temp, n));
        }
    } else if let Some(layout) = flags.str("layout") {
        let roots = resolve_document_layout_roots(config);
        let layout_ctx = extract_document_layout_context(doc);
        if let Some(ref textclass) = layout_ctx.textclass {
            let modules: Vec<&str> = layout_ctx.modules.iter().map(String::as_str).collect();
            if let Ok(schema) = get_schema_for_class(
                textclass,
                &roots.search_paths,
                &modules,
                Some(&layout_ctx.local),
            ) && !schema.document_layouts.iter().any(|s| s == layout)
                && !schema.inset_layouts.iter().any(|s| s == layout)
            {
                return Err(CliError::new(
                    "INVALID_LAYOUT",
                    format!(
                        "The layout '{layout}' is not permitted in textclass '{textclass}'. Allowed document layouts: {}",
                        schema.document_layouts.join(", ")
                    ),
                ));
            }
        }
        let text = flags.str("text").unwrap_or("");
        if text.trim().is_empty() {
            return Err(CliError::new(
                "MISSING_ARGS",
                "A non-empty --text argument is required when inserting a new --layout to prevent empty blocks.",
            ));
        }
        let block = alloc_block(doc, "layout", Some(layout));
        let t = alloc_text(doc, text);
        doc.set_children(block, vec![t]);
        templates.push(block);
    } else if let Some(cite) = flags.str("cite") {
        let cite_cmd = flags.str("cite-cmd").unwrap_or("citet");
        if !CITE_CMDS.contains(&cite_cmd) {
            return Err(CliError::new(
                "INVALID_FLAG",
                format!(
                    "Invalid --cite-cmd '{cite_cmd}'. Valid values: {}",
                    CITE_CMDS.join(", ")
                ),
            ));
        }
        templates.push(build_citation(doc, cite_cmd, cite));
    } else if let Some(r) = flags.str("ref") {
        let ref_cmd = flags.str("ref-cmd").unwrap_or("ref");
        if !REF_CMDS.contains(&ref_cmd) {
            return Err(CliError::new(
                "INVALID_FLAG",
                format!(
                    "Invalid --ref-cmd '{ref_cmd}'. Valid values: {}",
                    REF_CMDS.join(", ")
                ),
            ));
        }
        templates.push(build_ref(doc, ref_cmd, r));
    } else if let Some(label) = flags.str("label") {
        templates.push(build_label(doc, label));
    } else if let Some(fn_text) = flags.str("footnote") {
        templates.push(build_footnote(doc, fn_text));
    } else if let Some(table_text) = flags.str("table") {
        let rect =
            crate::table::parse_rect(table_text).map_err(|e| CliError::new(e.code, e.message))?;
        templates.push(crate::table::build_create_layout(doc, &rect));
    } else if let Some(text) = flags.str("text") {
        if position == "split-after" {
            templates.push(alloc_text(doc, text));
        } else {
            return Err(CliError::new(
                "TEXT_ONLY_INSERT",
                "Cannot insert bare text. You must wrap text in a layout using the --layout flag (e.g., --layout 'Standard' --text 'foo').",
            ));
        }
    }
    if templates.is_empty() {
        return Err(CliError::new(
            "MISSING_CONTENT",
            "You must provide --layout, --raw-file, --cite, --ref, --label, --footnote, or --table to insert.",
        ));
    }
    if flags.str("table").is_some() {
        for &target in nodes {
            if !crate::table::is_document_layout_target(doc, target) {
                return Err(CliError::new(
                    "INVALID_CONTEXT",
                    "A table must be inserted as a sibling of a body paragraph (before or after a document layout). It cannot go inside a note, cell, or caption.",
                ));
            }
        }
    }

    let mut schema = None;
    let mut textclass_value: Option<String> = None;
    {
        let roots = resolve_document_layout_roots(config);
        let layout_ctx = extract_document_layout_context(doc);
        if let Some(ref tc) = layout_ctx.textclass {
            textclass_value = Some(tc.clone());
            let modules: Vec<&str> = layout_ctx.modules.iter().map(String::as_str).collect();
            if let Ok(s) =
                get_schema_for_class(tc, &roots.search_paths, &modules, Some(&layout_ctx.local))
            {
                schema = Some(s);
            }
        }
    }

    let snap_mode = if position == "before" || position == "after" {
        SnapshotMode::OnParent
    } else {
        SnapshotMode::OnNode
    };
    let pre = collect_snapshots(doc, nodes, snap_mode);
    assert_tracking_header(doc, env.track_changes)?;
    let insert_aid = if env.track_changes {
        resolve_author_id(doc, env.author_name)
    } else {
        0
    };
    let insert_ts = if env.track_changes {
        now_ts()
    } else {
        String::new()
    };
    if env.track_changes {
        ensure_tracking_changes_in_header(doc);
    }

    if position == "split-after"
        && nodes.len() > 1
        && nodes
            .iter()
            .all(|&n| matches!(doc.node(n).kind, NodeKind::Block { .. }))
    {
        pre_scan_split(
            doc,
            nodes,
            env,
            split_match
                .as_deref()
                .expect("invariant: split-after match string is set"),
        )?;
    }

    let mut inserted_count = 0usize;
    let mut inserted_blocks = 0usize;
    let split_scope = build_scope_predicate(selector).unwrap_or(None);

    for &target in nodes {
        let (target_parent, ctx) = if position == "prepend"
            || position == "append"
            || position == "split-after"
        {
            if !matches!(doc.node(target).kind, NodeKind::Block { .. }) {
                if position == "split-after" {
                    return Err(CliError::new(
                        "INVALID_TARGET",
                        "Cannot split-after to a non-block node. Select a layout or inset block and apply :change(...) or :property(...) to that block; text selectors cannot be split directly.",
                    ));
                } else {
                    return Err(CliError::new(
                        "INVALID_TARGET",
                        format!("Cannot use position '{position}' on a non-block node."),
                    ));
                }
            }
            (Some(target), find_node_context(doc, target))
        } else {
            let found = find_node_context(doc, target);
            if found.is_none() {
                continue;
            }
            (found.as_ref().map(|c| c.parent), found)
        };

        let mut inserted_so_far = 0usize;
        let mut split_parent: Option<NodeId> = None;
        let mut split_text_idx = usize::MAX;
        let mut split_insert_offset = 0usize;
        let mut split_region = TextRegion::Current;
        let mut split_region_info: Option<OpenRegion> = None;
        let mut split_region_continues = false;

        if position == "split-after"
            && let Some(target_block) = target_parent
        {
            let split_note_scope = selector_note_scope(selector).unwrap_or(false)
                || is_invisible_block(doc, target_block)
                || ctx
                    .as_ref()
                    .is_some_and(|c| c.ancestors.iter().any(|&a| is_invisible_block(doc, a)));
            let top_is_layout = block_tag(doc, target_block) != Some("inset");
            let inherited = env.traversal.get(&target_block).cloned();
            let opts = ConcatOpts {
                recurse_layouts: true,
                top_level_is_layout: top_is_layout,
                include_deleted: true,
                inherited_state: inherited,
                skip_invisible_notes: !split_note_scope,
            };
            let (segments, full_text) = concatenate_text_nodes(doc, target_block, &opts);
            let needle = split_match
                .as_deref()
                .expect("invariant: split-after match string is set");
            let mut total_matches = 0usize;
            let mut match_start = usize::MAX;
            let mut pos = 0;
            while let Some(found) = full_text[pos..].find(needle) {
                let abs = pos + found;
                let me = abs + needle.len();
                if split_scope
                    .as_ref()
                    .is_none_or(|s| match_span_in_scope(&segments, abs, me, s))
                {
                    total_matches += 1;
                    if match_start == usize::MAX {
                        match_start = abs;
                    }
                }
                pos = abs + needle.len();
            }
            if total_matches == 0 {
                let mut msg =
                    format!("split-after: substring '{needle}' not found in matched block.");
                if !split_note_scope && phrase_only_in_invisible_content(doc, needle) {
                    msg.push_str(
                        " It exists only inside a private note (Note/Comment) — add ':note' to the selector to target note prose.",
                    );
                }
                return Err(CliError::new("SPLIT_NO_MATCH", msg));
            }
            if total_matches > 1 {
                return Err(CliError::new(
                    "SPLIT_AMBIGUOUS",
                    format!(
                        "split-after: substring '{needle}' appears {total_matches} times in matched block (including rejected \\change_deleted text). Scope with :change(current|inserted|deleted), or use a more specific selector or a longer match string."
                    ),
                ));
            }
            let split_pos = match_start + needle.len();
            let (seg_idx, offset) =
                map_pos_to_segment(&segments, if split_pos > 0 { split_pos - 1 } else { 0 });
            let split_offset = offset + 1;
            let split_segment = &segments[seg_idx];
            let split_child_idx = split_segment.child_index;
            let owner = split_segment.owner.unwrap_or(target_block);
            let split_text = match &doc.node(doc.node(owner).children[split_child_idx]).kind {
                NodeKind::Text { text } => text.clone(),
                _ => String::new(),
            };
            let before = split_text[..split_offset.min(split_text.len())].to_string();
            let after = split_text[split_offset.min(split_text.len())..].to_string();
            let mut initial = Vec::new();
            if !before.is_empty() {
                initial.push(alloc_text(doc, &before));
            }
            if !after.is_empty() {
                initial.push(alloc_text(doc, &after));
            }
            let mut kids = doc.node(owner).children.clone();
            kids.splice(split_child_idx..split_child_idx + 1, initial);
            doc.set_children(owner, kids);
            split_parent = Some(owner);
            split_text_idx = split_child_idx;
            split_region = traversal_region(&segments[seg_idx].state);
            split_region_info = if split_region != TextRegion::Current {
                open_region_info(doc, owner, split_text_idx)
            } else {
                None
            };
            split_region_continues = !after.is_empty();
            if !split_region_continues && split_region != TextRegion::Current {
                let mut d_depth = if split_region == TextRegion::Deleted {
                    1
                } else {
                    0
                };
                let mut i_depth = if split_region == TextRegion::Inserted {
                    1
                } else {
                    0
                };
                let kids = doc.node(owner).children.clone();
                for &c in kids.iter().skip(split_text_idx + 1) {
                    match &doc.node(c).kind {
                        NodeKind::Text { .. } => {
                            split_region_continues = true;
                            break;
                        }
                        NodeKind::Property { key, .. }
                            if is_change_opener(key) || is_change_closer(key) =>
                        {
                            let d = advance_change_depths(key, d_depth, i_depth);
                            d_depth = d.0;
                            i_depth = d.1;
                            if d_depth == 0 && i_depth == 0 {
                                break;
                            }
                        }
                        _ => {}
                    }
                }
            }
        }

        let payload: Vec<NodeId> = templates.iter().map(|&n| doc.clone_subtree(n)).collect();
        let loop_payload = if env.track_changes {
            let mut expanded = Vec::new();
            for &p in &payload {
                if matches!(&doc.node(p).kind, NodeKind::Block { tag, .. } if tag == "inset")
                    && position != "split-after"
                {
                    expanded.extend(wrap_with_tracking(
                        doc,
                        &[p],
                        ChangeKind::Inserted,
                        insert_aid,
                        Some(&insert_ts),
                    ));
                } else {
                    expanded.push(p);
                }
            }
            expanded
        } else {
            payload.clone()
        };

        for &node_to_insert in &loop_payload {
            if env.track_changes {
                match &doc.node(node_to_insert).kind {
                    NodeKind::Block { tag, .. } if tag != "inset" => {
                        let inner = doc.node(node_to_insert).children.clone();
                        let wrapped = wrap_with_tracking(
                            doc,
                            &inner,
                            ChangeKind::Inserted,
                            insert_aid,
                            Some(&insert_ts),
                        );
                        doc.set_children(node_to_insert, wrapped);
                    }
                    NodeKind::Text { .. } if position == "split-after" => {}
                    NodeKind::Property { .. } => {}
                    NodeKind::Block { tag, .. } if tag == "inset" => {}
                    _ if !matches!(doc.node(node_to_insert).kind, NodeKind::Property { .. }) => {
                        return Err(CliError::new(
                            "TRACKING_ERROR",
                            "Cannot track bare text nodes. Wrap in a layout block.",
                        ));
                    }
                    _ => {}
                }
            }

            if let Some(ref schema) = schema
                && let NodeKind::Block { tag, args, .. } = &doc.node(node_to_insert).kind
                && tag == "layout"
                && let Some(layout_name) = args.clone()
            {
                let mut is_inset_context =
                    target_parent.is_some_and(|p| block_tag(doc, p) == Some("inset"));
                if ctx.as_ref().is_some_and(|c| {
                    c.ancestors
                        .iter()
                        .any(|&a| block_tag(doc, a) == Some("inset"))
                }) {
                    is_inset_context = true;
                }
                if is_inset_context {
                    if !schema.inset_layouts.iter().any(|s| s == &layout_name) {
                        return Err(CliError::new(
                            "INVALID_CONTEXT",
                            format!(
                                "Cannot insert document layout '{layout_name}' inside an Inset. Valid inset layouts are: {}",
                                schema.inset_layouts.join(", ")
                            ),
                        ));
                    }
                } else {
                    if schema.inset_layouts.iter().any(|s| s == &layout_name)
                        && !schema.document_layouts.iter().any(|s| s == &layout_name)
                    {
                        let context_name = target_parent
                            .and_then(|p| {
                                Some(format!(
                                    "{}[{}]",
                                    block_tag(doc, p)?,
                                    block_args(doc, p).unwrap_or("")
                                ))
                            })
                            .unwrap_or_else(|| "document body".into());
                        return Err(CliError::new(
                            "INVALID_CONTEXT",
                            format!(
                                "Cannot insert inset layout '{layout_name}' into {context_name}."
                            ),
                        ));
                    }
                    if !schema.document_layouts.iter().any(|s| s == &layout_name) {
                        return Err(CliError::new(
                            "INVALID_LAYOUT",
                            format!(
                                "The layout '{layout_name}' is not recognized in textclass '{}'. Valid layouts: {}",
                                textclass_value.as_deref().unwrap_or(""),
                                schema.document_layouts.join(", ")
                            ),
                        ));
                    }
                }
            } else if let Some(ref schema) = schema
                && let NodeKind::Property { key, .. } = &doc.node(node_to_insert).kind
                && !schema.inline_properties.iter().any(|s| s == key)
            {
                return Err(CliError::new(
                    "INVALID_PROPERTY",
                    format!(
                        "Property '{key}' is not permitted. Valid inline properties are: {}",
                        schema.inline_properties.join(", ")
                    ),
                ));
            }

            if let NodeKind::Block { tag, args, .. } = &doc.node(node_to_insert).kind {
                let tag = tag.clone();
                let args = args.clone();
                if tag == "layout"
                    && args.is_some()
                    && matches!(position, "prepend" | "append" | "split-after")
                    && target_parent.is_some_and(|p| block_tag(doc, p) == Some("layout"))
                {
                    return Err(CliError::new(
                        "INVALID_CONTEXT",
                        format!(
                            "Cannot insert layout '{}' inside another layout. Use 'before' or 'after' to insert as a sibling.",
                            args.unwrap_or_default()
                        ),
                    ));
                }
                if tag == "inset"
                    && args.is_some()
                    && target_parent.is_some_and(|p| block_tag(doc, p) == Some("body"))
                {
                    return Err(CliError::new(
                        "INVALID_CONTEXT",
                        "Cannot insert inset directly into the document body. Insets must be inside a layout (e.g. Standard).",
                    ));
                }
            }

            let is_layout_block = matches!(&doc.node(node_to_insert).kind, NodeKind::Block { tag, .. } if tag == "layout");
            let copy = doc.clone_subtree(node_to_insert);

            if position == "split-after" {
                let Some(owner) = split_parent else {
                    continue;
                };
                let insert_idx = split_text_idx + 1 + split_insert_offset;
                if env.track_changes
                    && matches!(
                        doc.node(node_to_insert).kind,
                        NodeKind::Text { .. } | NodeKind::Block { .. }
                    )
                {
                    if split_region == TextRegion::Inserted
                        && let Some(ref info) = split_region_info
                        && info.author == insert_aid
                    {
                        let mut kids = doc.node(owner).children.clone();
                        kids.splice(insert_idx..insert_idx, [copy]);
                        doc.set_children(owner, kids);
                        split_insert_offset += 1;
                        let new_ts: i64 = insert_ts.parse().unwrap_or(0);
                        let old_ts: i64 = info.ts.parse().unwrap_or(0);
                        if new_ts > old_ts {
                            set_prop_value(
                                doc,
                                info.opener,
                                &info.key,
                                Some(&format!("{insert_aid} {insert_ts}")),
                            );
                        }
                    } else if split_region != TextRegion::Current
                        && let Some(ref info) = split_region_info
                    {
                        let marker = alloc_prop(
                            doc,
                            "change_inserted",
                            Some(&format!("{insert_aid} {insert_ts}")),
                        );
                        let trailing = if split_region_continues {
                            Some(alloc_prop(
                                doc,
                                &info.key,
                                Some(&format!("{} {}", info.author, info.ts)),
                            ))
                        } else {
                            let kids = doc.node(owner).children.clone();
                            let next = kids.get(insert_idx).copied();
                            let share = next.is_some_and(|n| {
                                matches!(&doc.node(n).kind, NodeKind::Property { key, .. } if key == "change_unchanged")
                            });
                            if share {
                                None
                            } else {
                                Some(alloc_prop(doc, "change_unchanged", None))
                            }
                        };
                        let mut insert_nodes = vec![marker, copy];
                        if let Some(t) = trailing {
                            insert_nodes.push(t);
                        }
                        let n = insert_nodes.len();
                        let mut kids = doc.node(owner).children.clone();
                        kids.splice(insert_idx..insert_idx, insert_nodes);
                        doc.set_children(owner, kids);
                        split_insert_offset += n;
                    } else {
                        let wrapped = wrap_in_change_markers(
                            doc,
                            &[copy],
                            ChangeKind::Inserted,
                            insert_aid,
                            &insert_ts,
                        );
                        let n = wrapped.len();
                        let mut kids = doc.node(owner).children.clone();
                        kids.splice(insert_idx..insert_idx, wrapped);
                        doc.set_children(owner, kids);
                        split_insert_offset += n;
                    }
                } else {
                    let mut kids = doc.node(owner).children.clone();
                    kids.splice(insert_idx..insert_idx, [copy]);
                    doc.set_children(owner, kids);
                    split_insert_offset += 1;
                }
            } else if position == "prepend" || position == "append" {
                let Some(parent) = target_parent else {
                    continue;
                };
                let spacer = alloc_text(doc, "");
                let mut kids = doc.node(parent).children.clone();
                if position == "prepend" {
                    if is_layout_block {
                        kids.splice(inserted_so_far..inserted_so_far, [copy, spacer]);
                    } else {
                        kids.splice(inserted_so_far..inserted_so_far, [copy]);
                    }
                } else if is_layout_block {
                    kids.push(spacer);
                    kids.push(copy);
                } else {
                    kids.push(copy);
                }
                doc.set_children(parent, kids);
            } else if let Some(ref c) = ctx {
                let spacer = alloc_text(doc, "");
                let mut kids = doc.node(c.parent).children.clone();
                if position == "before" {
                    let insert_idx = c.index + inserted_so_far;
                    if is_layout_block {
                        kids.splice(insert_idx..insert_idx, [copy, spacer]);
                    } else {
                        kids.splice(insert_idx..insert_idx, [copy]);
                    }
                } else {
                    let insert_idx = c.index + 1 + inserted_so_far;
                    if is_layout_block {
                        kids.splice(insert_idx..insert_idx, [spacer, copy]);
                    } else {
                        kids.splice(insert_idx..insert_idx, [copy]);
                    }
                }
                doc.set_children(c.parent, kids);
            }
            if position != "split-after" && position != "append" {
                inserted_so_far += if is_layout_block { 2 } else { 1 };
            }
        }
        inserted_blocks += templates.len();
        inserted_count += 1;
    }

    commit_and_refresh(doc, env.file_path, &pre, env.state, env.refresh)?;
    let changes: Vec<_> = nodes
        .iter()
        .map(|&n| {
            json!({
                "position": position,
                "label": node_label(doc, n),
                "text": brief_text(doc, n, 80),
            })
        })
        .collect();
    print_json(json!({
        "matched_nodes": inserted_count,
        "inserted_blocks": inserted_blocks,
        "changes": changes,
    }));
    Ok(())
}

fn pre_scan_split(
    doc: &Document,
    nodes: &[NodeId],
    env: &MutationEnv<'_>,
    needle: &str,
) -> Result<(), CliError> {
    let selector = env.selector.unwrap_or("");
    let split_scope = build_scope_predicate(selector).unwrap_or(None);
    let mut k = 0usize;
    let mut m = 0usize;
    let mut z = 0usize;
    let mut any_note_scope = false;
    for &target in nodes {
        let ctx = find_node_context(doc, target);
        let note_scope = selector_note_scope(selector).unwrap_or(false)
            || is_invisible_block(doc, target)
            || ctx
                .as_ref()
                .is_some_and(|c| c.ancestors.iter().any(|&a| is_invisible_block(doc, a)));
        any_note_scope = any_note_scope || note_scope;
        let top_is_layout = block_tag(doc, target) != Some("inset");
        let inherited = env.traversal.get(&target).cloned();
        let opts = ConcatOpts {
            recurse_layouts: true,
            top_level_is_layout: top_is_layout,
            include_deleted: true,
            inherited_state: inherited,
            skip_invisible_notes: !note_scope,
        };
        let (segments, full_text) = concatenate_text_nodes(doc, target, &opts);
        let mut total = 0usize;
        let mut pos = 0;
        while let Some(found) = full_text[pos..].find(needle) {
            let abs = pos + found;
            let me = abs + needle.len();
            if split_scope
                .as_ref()
                .is_none_or(|s| match_span_in_scope(&segments, abs, me, s))
            {
                total += 1;
            }
            pos = abs + needle.len();
        }
        if total == 0 {
            z += 1;
        } else if total == 1 {
            k += 1;
        } else {
            m += 1;
        }
    }
    if z == 0 && m == 0 {
        return Ok(());
    }
    let occurrence = if k == 0 && m == 0 {
        "appears in none of them".to_string()
    } else {
        let mut parts = Vec::new();
        if k > 0 {
            parts.push(format!("appears exactly once in {k} of them"));
        }
        if m > 0 {
            parts.push(format!("multiple times in {m}"));
        }
        if z > 0 {
            parts.push("in none of the others".into());
        }
        parts.join(" and ")
    };
    let mut msg = format!(
        "split-after: the selector matched {} blocks; the substring '{needle}' {occurrence} (tracked changes included). split-after only proceeds when the substring appears exactly once in every matched block.",
        nodes.len()
    );
    if z > 0 && !any_note_scope && phrase_only_in_invisible_content(doc, needle) {
        msg.push_str(
            " It exists only inside a private note (Note/Comment) — add ':note' to the selector to target note prose.",
        );
    }
    Err(CliError::new(
        if z > 0 {
            "SPLIT_NO_MATCH"
        } else {
            "SPLIT_AMBIGUOUS"
        },
        msg,
    ))
}

fn snippet_blocks(snippet: &Document) -> Vec<NodeId> {
    snippet
        .node(snippet.root())
        .children
        .iter()
        .copied()
        .filter(|&id| {
            matches!(
                snippet.node(id).kind,
                NodeKind::Block { .. } | NodeKind::Property { .. }
            )
        })
        .collect()
}

fn copy_subtree(dest: &mut Document, src: &Document, id: NodeId) -> NodeId {
    let kind = src.node(id).kind.clone();
    let new_id = dest.alloc(kind);
    let kids = src.node(id).children.clone();
    for k in kids {
        let c = copy_subtree(dest, src, k);
        dest.push_child(new_id, c);
    }
    new_id
}

fn build_citation(doc: &mut Document, cmd: &str, key: &str) -> NodeId {
    let inset = alloc_block(doc, "inset", Some("CommandInset citation"));
    let kids = vec![
        alloc_text(doc, &format!("LatexCommand {cmd}")),
        alloc_text(doc, &format!("key \"{key}\"")),
        alloc_text(doc, "literal \"false\""),
        alloc_text(doc, ""),
    ];
    doc.set_children(inset, kids);
    inset
}

fn build_ref(doc: &mut Document, cmd: &str, reference: &str) -> NodeId {
    let inset = alloc_block(doc, "inset", Some("CommandInset ref"));
    let kids = vec![
        alloc_text(doc, &format!("LatexCommand {cmd}")),
        alloc_text(doc, &format!("reference \"{reference}\"")),
        alloc_text(doc, "plural \"false\""),
        alloc_text(doc, "caps \"false\""),
        alloc_text(doc, "noprefix \"false\""),
        alloc_text(doc, "nolink \"false\""),
        alloc_text(doc, "tuple \"list\""),
        alloc_text(doc, ""),
    ];
    doc.set_children(inset, kids);
    inset
}

fn build_label(doc: &mut Document, name: &str) -> NodeId {
    let inset = alloc_block(doc, "inset", Some("CommandInset label"));
    let kids = vec![
        alloc_text(doc, "LatexCommand label"),
        alloc_text(doc, &format!("name \"{name}\"")),
        alloc_text(doc, ""),
    ];
    doc.set_children(inset, kids);
    inset
}

fn build_footnote(doc: &mut Document, text: &str) -> NodeId {
    let inset = alloc_block(doc, "inset", Some("Foot"));
    let layout = alloc_block(doc, "layout", Some("Plain Layout"));
    let t = alloc_text(doc, text);
    doc.set_children(layout, vec![t]);
    let kids = vec![
        alloc_text(doc, "status collapsed"),
        alloc_text(doc, ""),
        layout,
        alloc_text(doc, ""),
    ];
    doc.set_children(inset, kids);
    inset
}
