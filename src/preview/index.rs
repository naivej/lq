//! Document index, authors, branches, bibliography (Deno `indexDocument` cluster).

use super::flow::{self, HeadingState, LayoutRole};
use super::insets;
use super::mapping::{self, find_property, inset_kind, xml_id};
use super::{FloatListEntry, LabelKind, LiveNavEntry, LiveNavigate, LiveOutlineEntry, RenderCtx};
use crate::ast::{Document, NodeId, NodeKind};
use crate::bib::parse_bibtex;
use crate::latex_math::{MathMacroMap, parse_newcommands};
use crate::paths::{TextReadError, read_text_file};
use crate::text_utils::{
    TraversalState, advance_traversal_state, create_traversal_state, enter_traversal_state,
    is_invisible_inset,
};
use std::collections::HashMap;
use std::path::Path;

pub(crate) fn extract_math_macros(ast: &Document) -> Option<MathMacroMap> {
    let preamble = find_named_block(ast, ast.root(), "preamble")?;
    let mut text = String::new();
    collect_text(ast, preamble, &mut text);
    let map = parse_newcommands(&text);
    if map.is_empty() { None } else { Some(map) }
}

pub(crate) fn document_authors(ast: &Document) -> HashMap<i32, String> {
    let mut out = HashMap::new();
    walk_authors(ast, ast.root(), &mut out);
    out
}

fn walk_authors(ast: &Document, id: NodeId, out: &mut HashMap<i32, String>) {
    for &c in &ast.node(id).children {
        if let NodeKind::Property { key, value } = &ast.node(c).kind
            && key == "author"
            && let Some(v) = value
        {
            // `\author <id> "<name>"` — id may be negative (DL124).
            let rest = v.trim();
            if let Some((id_s, name_part)) = rest.split_once(' ')
                && let Ok(id) = id_s.parse::<i32>()
            {
                let name = name_part
                    .trim()
                    .trim_start_matches('"')
                    .split('"')
                    .next()
                    .unwrap_or("")
                    .to_string();
                out.insert(id, name);
            }
        }
        walk_authors(ast, c, out);
    }
}

pub(crate) fn document_branches(ast: &Document) -> HashMap<String, bool> {
    let mut out = HashMap::new();
    walk_branches(ast, ast.root(), &mut out);
    out
}

fn walk_branches(ast: &Document, id: NodeId, out: &mut HashMap<String, bool>) {
    for &c in &ast.node(id).children {
        if let NodeKind::Block { tag, args, .. } = &ast.node(c).kind
            && tag == "branch"
        {
            let name = args.as_deref().unwrap_or("").trim().to_string();
            let mut selected = false;
            for &p in &ast.node(c).children {
                if let NodeKind::Property { key, value } = &ast.node(p).kind
                    && key == "selected"
                    && value.as_deref() == Some("1")
                {
                    selected = true;
                }
            }
            if !name.is_empty() {
                out.insert(name, selected);
            }
        }
        walk_branches(ast, c, out);
    }
}

pub(crate) fn index_document(nodes: &[NodeId], ctx: &mut RenderCtx<'_>) {
    let mut headings = HeadingState::new();
    let mut current_heading = String::new();
    let mut current_heading_title = String::new();
    let mut current_float_caption = String::new();
    walk_index(
        nodes,
        ctx,
        &mut headings,
        None,
        true,
        false,
        &create_traversal_state(),
        false,
        &mut current_heading,
        &mut current_heading_title,
        &mut current_float_caption,
    );
    ctx.figure = 0;
    ctx.table = 0;
    ctx.algorithm = 0;
    ctx.listing = 0;
    ctx.equation = 0;
    ctx.chapter_label.clear();
    ctx.float_type_counts.clear();
    ctx.sub_float_counts.clear();
    ctx.float_number_stack.clear();
    ctx.float_stack.clear();
    ctx.in_float = false;
    ctx.longtable_number = None;
    ctx.nomencl_seq = 0;
    ctx.index_seq = 0;
    ctx.subeq = None;
}

#[allow(clippy::too_many_arguments)] // Deno indexDocument extras (headings + float + inherited)
fn walk_index(
    nodes: &[NodeId],
    ctx: &mut RenderCtx<'_>,
    headings: &mut HeadingState,
    float_no: Option<String>,
    at_body: bool,
    in_heading_layout: bool,
    inherited: &TraversalState,
    in_float: bool,
    current_heading: &mut String,
    current_heading_title: &mut String,
    current_float_caption: &mut String,
) {
    let mut state = enter_traversal_state(inherited);
    for &id in nodes {
        let kind_tag = match &ctx.doc().node(id).kind {
            NodeKind::Property { key, value } => {
                if key == "change_deleted" || key == "change_inserted" || key == "change_unchanged"
                {
                    advance_traversal_state(&mut state, key, value.as_deref());
                }
                continue;
            }
            NodeKind::Block { tag, args, .. } => (tag.clone(), args.clone()),
            _ => continue,
        };
        let (tag, args) = kind_tag;
        let children = ctx.doc().node(id).children.clone();
        if tag == "deeper" {
            walk_index(
                &children,
                ctx,
                headings,
                float_no.clone(),
                at_body,
                in_heading_layout,
                &state,
                in_float,
                current_heading,
                current_heading_title,
                current_float_caption,
            );
            continue;
        }
        if tag == "layout" {
            let layout = args.as_deref().unwrap_or("").trim().to_string();
            if flow::has_start_of_appendix(ctx.doc(), id) {
                headings.enter_appendix();
            }
            match flow::role(&layout, ctx) {
                LayoutRole::Omit => {}
                LayoutRole::Heading { level, .. } => {
                    let start = flow::has_start_of_appendix(ctx.doc(), id);
                    let current = headings.next(&layout, level, start);
                    flow::note_chapter_heading(ctx, level, &current);
                    *current_heading = current.trim().to_string();
                    *current_heading_title = flow::heading_plain_text(ctx.doc(), id);
                    if at_body {
                        let text = current_heading_title.clone();
                        let sid = flow::section_id(current_heading, &text);
                        ctx.outline.push(LiveOutlineEntry {
                            level,
                            number: current_heading.clone(),
                            text,
                            id: sid,
                        });
                    }
                    walk_index(
                        &children,
                        ctx,
                        headings,
                        float_no.clone(),
                        false,
                        true,
                        &state,
                        in_float,
                        current_heading,
                        current_heading_title,
                        current_float_caption,
                    );
                }
                _ => {
                    walk_index(
                        &children,
                        ctx,
                        headings,
                        float_no.clone(),
                        false,
                        false,
                        &state,
                        in_float,
                        current_heading,
                        current_heading_title,
                        current_float_caption,
                    );
                }
            }
            continue;
        }
        if tag != "inset" {
            walk_index(
                &children,
                ctx,
                headings,
                float_no.clone(),
                at_body,
                in_heading_layout,
                &state,
                in_float,
                current_heading,
                current_heading_title,
                current_float_caption,
            );
            continue;
        }
        let kind = inset_kind(ctx.doc(), id);
        if is_invisible_inset(&tag, args.as_deref()) || kind == "ERT" {
            continue;
        }
        if kind.starts_with("Branch ") && !insets::branch_produces_output(id, ctx) {
            continue;
        }
        if kind.starts_with("Float ") || kind.starts_with("Wrap ") {
            let variant = if let Some(v) = kind.strip_prefix("Float ") {
                v.trim().to_string()
            } else {
                kind.strip_prefix("Wrap ").unwrap_or("").trim().to_string()
            };
            let deleted = state.deleted_depth > 0 || state.outer_deleted_depth > 0;
            let nested = in_float;
            if !nested {
                ctx.sub_float_counts.insert(variant.clone(), 0);
            }
            let taken = if deleted {
                None
            } else if nested {
                Some(insets::take_sub_float_number(ctx, &variant, false))
            } else {
                Some(
                    insets::take_float_number(ctx, &variant, false)
                        .unwrap_or_else(|| insets::take_generic_float_number(ctx, &variant, false)),
                )
            };
            let listed = !deleted
                && insets::note_float_list_entry(ctx, id, &variant, taken.as_deref(), nested);
            let prev_cap = current_float_caption.clone();
            let caps = insets::float_own_captions(ctx.doc(), id);
            *current_float_caption = if let Some(ref taken) = taken {
                let prefix = if nested {
                    insets::subfloat_nameref_prefix(&variant)
                } else {
                    insets::float_nameref_prefix(&variant)
                };
                format!("{prefix} {taken}")
            } else {
                caps.iter()
                    .map(|&c| insets::collect_visible_text(ctx.doc(), c))
                    .collect::<Vec<_>>()
                    .join(" ")
                    .split_whitespace()
                    .collect::<Vec<_>>()
                    .join(" ")
            };
            let parent_num = ctx.float_number_stack.last().cloned();
            let id_num = if nested {
                match (parent_num, taken.as_deref()) {
                    (Some(p), Some(n)) => Some(format!("{p}-{n}")),
                    _ => None,
                }
            } else {
                taken.clone()
            };
            if let Some(ref id_num) = id_num {
                ctx.float_number_stack.push(id_num.clone());
            }
            walk_index(
                &children,
                ctx,
                headings,
                taken.clone().or_else(|| float_no.clone()),
                false,
                false,
                &enter_traversal_state(&state),
                true,
                current_heading,
                current_heading_title,
                current_float_caption,
            );
            if id_num.is_some() {
                ctx.float_number_stack.pop();
            }
            if listed {
                insets::pop_float_list_entry(ctx, nested);
            }
            *current_float_caption = prev_cap;
            continue;
        }
        if (kind == "Tabular" || kind.starts_with("Tabular "))
            && insets::tabular_is_longtable(ctx.doc(), id)
        {
            let deleted = state.deleted_depth > 0 || state.outer_deleted_depth > 0;
            // LyX steps once per longtable, including tracked-deleted ones.
            let taken = insets::take_float_number(ctx, "table", false);
            let caps = insets::float_own_captions(ctx.doc(), id);
            let listed = !deleted
                && !caps.is_empty()
                && insets::note_float_list_entry(ctx, id, "table", taken.as_deref(), false);
            let prev_cap = current_float_caption.clone();
            if let Some(ref taken) = taken {
                *current_float_caption =
                    format!("{} {taken}", insets::float_nameref_prefix("table"));
            }
            walk_index(
                &children,
                ctx,
                headings,
                taken.or_else(|| float_no.clone()),
                false,
                false,
                &enter_traversal_state(&state),
                in_float,
                current_heading,
                current_heading_title,
                current_float_caption,
            );
            if listed {
                insets::pop_float_list_entry(ctx, false);
            }
            *current_float_caption = prev_cap;
            continue;
        }
        if kind == "listings" || kind.starts_with("listings ") {
            let deleted = state.deleted_depth > 0 || state.outer_deleted_depth > 0;
            let taken = if !deleted && insets::listing_takes_number(ctx.doc(), id) {
                insets::take_float_number(ctx, "listing", false)
            } else {
                None
            };
            walk_index(
                &children,
                ctx,
                headings,
                taken.or_else(|| float_no.clone()),
                false,
                false,
                &enter_traversal_state(&state),
                in_float,
                current_heading,
                current_heading_title,
                current_float_caption,
            );
            continue;
        }
        if kind.starts_with("CommandInset include") && insets::include_is_listings(ctx.doc(), id) {
            let deleted = state.deleted_depth > 0 || state.outer_deleted_depth > 0;
            let taken = insets::take_float_number(ctx, "listing", false);
            let params = find_property(ctx.doc(), id, "lstparams").unwrap_or_default();
            let label = insets::listing_param(&params, "label");
            if !deleted
                && !label.is_empty()
                && let Some(ref taken) = taken
            {
                ctx.labels.insert(label.clone(), taken.clone());
                ctx.label_kinds.insert(label, LabelKind::Float);
            }
            walk_index(
                &children,
                ctx,
                headings,
                taken.or_else(|| float_no.clone()),
                false,
                false,
                &enter_traversal_state(&state),
                in_float,
                current_heading,
                current_heading_title,
                current_float_caption,
            );
            continue;
        }
        if kind.starts_with("CommandInset label") {
            let deleted = state.deleted_depth > 0 || state.outer_deleted_depth > 0;
            if !deleted && let Some(name) = find_property(ctx.doc(), id, "name") {
                let value = float_no.clone().unwrap_or_else(|| current_heading.clone());
                ctx.labels.insert(name.clone(), value);
                let kind_hint = if float_no.is_some() {
                    LabelKind::Float
                } else if in_heading_layout {
                    LabelKind::Heading
                } else {
                    LabelKind::Other
                };
                ctx.label_kinds.insert(name.clone(), kind_hint);
                let title = if !current_float_caption.is_empty() {
                    current_float_caption.trim().to_string()
                } else {
                    current_heading_title.trim().to_string()
                };
                if !title.is_empty() {
                    ctx.label_titles.insert(name, title);
                }
            }
            continue;
        }
        if kind == "FormulaMacro" || kind.starts_with("FormulaMacro") {
            continue;
        }
        if kind.starts_with("Flex Subequations") {
            insets::enter_subequations(ctx);
            insets::walk_subequation_labels(&children, ctx);
            ctx.subeq = None;
            continue;
        }
        if kind == "Formula" || kind.starts_with("Formula") {
            let src = insets::formula_source(ctx.doc(), id);
            insets::take_formula_numbers(&src, ctx, state.deleted_depth > 0);
            continue;
        }
        if kind.starts_with("CommandInset citation") {
            let key = find_property(ctx.doc(), id, "key").unwrap_or_default();
            for k in key.split(',').map(str::trim).filter(|s| !s.is_empty()) {
                ctx.cited_keys.insert(k.to_string());
            }
        }
        if kind.starts_with("CommandInset bibtex") {
            if let Some(v) = find_property(ctx.doc(), id, "bibfiles") {
                ctx.bibfiles = v;
            }
            if let Some(v) = find_property(ctx.doc(), id, "btprint") {
                ctx.btprint = v;
            }
            if let Some(v) = find_property(ctx.doc(), id, "options") {
                ctx.biboptions = v;
            }
        }
        if kind == "Nomenclature" || kind.starts_with("Nomenclature ") {
            let entry = insets::collect_nomencl_entry(id, ctx);
            if !entry.symbol.is_empty() || !entry.desc.is_empty() {
                ctx.nomencl.push(entry);
            }
            continue;
        }
        if kind == "Index" || kind.starts_with("Index ") {
            let entry = insets::collect_index_entry(id, ctx);
            if !entry.terms.is_empty() || !entry.see.is_empty() {
                ctx.index.push(entry);
            }
            continue;
        }
        walk_index(
            &children,
            ctx,
            headings,
            float_no.clone(),
            false,
            in_heading_layout,
            &enter_traversal_state(&state),
            in_float,
            current_heading,
            current_heading_title,
            current_float_caption,
        );
    }
}

pub(crate) fn load_bibliography(ctx: &mut RenderCtx<'_>) {
    let Some(file_path) = ctx.file_path.clone() else {
        return;
    };
    if ctx.bibfiles.is_empty() {
        return;
    }
    let dir = file_path.parent().unwrap_or_else(|| Path::new("."));
    let names: Vec<String> = ctx
        .bibfiles
        .split_whitespace()
        .filter(|s| !s.is_empty())
        .map(|raw| {
            if raw.to_ascii_lowercase().ends_with(".bib") {
                raw.to_string()
            } else {
                format!("{raw}.bib")
            }
        })
        .collect();
    for name in names {
        let mut tries = vec![dir.join(&name)];
        if let Some(doc) = &ctx.system_doc_dir {
            tries.push(doc.join(&name));
        }
        let mut loaded = false;
        for full in tries {
            match read_text_file(&full) {
                Ok(text) => {
                    for c in parse_bibtex(&text) {
                        ctx.bib.insert(c.key.clone(), c);
                    }
                    loaded = true;
                    break;
                }
                Err(TextReadError::NotUtf8) => {
                    mapping::warn_once(
                        ctx,
                        &format!("Bibliography file '{name}' exists but is not valid UTF-8."),
                    );
                    loaded = true;
                    break;
                }
                Err(_) => {}
            }
        }
        if !loaded {
            mapping::warn_once(ctx, &format!("Could not read bibliography file '{name}'."));
        }
    }
}

pub(crate) fn build_navigate(ctx: &RenderCtx<'_>) -> LiveNavigate {
    fn to_nav(e: &FloatListEntry) -> LiveNavEntry {
        LiveNavEntry {
            kind: float_nav_kind(&e.type_),
            number: e.number.clone(),
            text: e.text.clone(),
            id: e.id.clone(),
            name: None,
            line: None,
            children: e
                .children
                .as_ref()
                .map(|ch| ch.iter().map(to_nav).collect()),
        }
    }
    let mut figures = Vec::new();
    let mut tables = Vec::new();
    let mut listings = Vec::new();
    let mut algorithms = Vec::new();
    for e in &ctx.float_list_entries {
        match e.type_.as_str() {
            "figure" => figures.push(to_nav(e)),
            "table" => tables.push(to_nav(e)),
            "listing" => listings.push(to_nav(e)),
            "algorithm" => algorithms.push(to_nav(e)),
            _ => {}
        }
    }
    let mut labels: Vec<LiveNavEntry> = ctx
        .labels
        .keys()
        .filter(|name| {
            matches!(
                ctx.label_kinds
                    .get(*name)
                    .copied()
                    .unwrap_or(LabelKind::Other),
                LabelKind::Other
            )
        })
        .map(|name| LiveNavEntry {
            kind: "label".into(),
            number: String::new(),
            text: String::new(),
            id: xml_id(name),
            name: Some(name.clone()),
            line: None,
            children: None,
        })
        .collect();
    labels.sort_by(|a, b| {
        a.name
            .as_deref()
            .unwrap_or("")
            .to_lowercase()
            .cmp(&b.name.as_deref().unwrap_or("").to_lowercase())
    });
    LiveNavigate {
        figures,
        tables,
        equations: ctx.nav_equations.clone(),
        labels,
        listings,
        algorithms,
    }
}

fn float_nav_kind(type_: &str) -> String {
    match type_ {
        "figure" | "table" | "listing" | "algorithm" => type_.to_string(),
        _ => {
            if type_.is_empty() {
                "float".into()
            } else {
                type_.to_string()
            }
        }
    }
}

fn find_named_block(ast: &Document, id: NodeId, tag: &str) -> Option<NodeId> {
    for &c in &ast.node(id).children {
        if let NodeKind::Block { tag: t, .. } = &ast.node(c).kind
            && t == tag
        {
            return Some(c);
        }
        if let Some(found) = find_named_block(ast, c, tag) {
            return Some(found);
        }
    }
    None
}

fn collect_text(ast: &Document, id: NodeId, out: &mut String) {
    match &ast.node(id).kind {
        NodeKind::Text { text } => out.push_str(text),
        _ => {
            for &c in &ast.node(id).children {
                collect_text(ast, c, out);
            }
        }
    }
}
