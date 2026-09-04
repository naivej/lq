//! Inset dispatch (Deno `renderInset`) and inline children.

use super::flow::{self, flatten_flow};
use super::graphics;
use super::mapping::{
    self, AUTHOR_COLOR_COUNT, SKIP_LAYOUT_PROPS, TITLE_MARKS, argument_text, collect_blocks,
    emit_token, find_property, flex_native_class, inset_kind, inset_owner_selector, layout_slug,
    mapping_attrs, take_owner_id, with_caption_layout, with_cell_layout, with_flex_layout,
    with_layout, xml_id,
};
use super::{
    FloatListEntry, LabelKind, LiveChangeEntry, LiveChangeType, LiveNavEntry, LiveTokenVia,
    NomenclEntry, RenderCtx, SubeqState, escape_live_html, find_body, flow as flow_mod,
};
use crate::ast::{Document, NodeId, NodeKind};
use crate::bib::format_bibliography_entry;
use crate::bind::lookup_shortcut;
use crate::cache::hash_text;
use crate::latex_math::{plan_formula_lines, render_formula_html};
use crate::parser::parse;
use crate::paths::{TextReadError, read_text_file};
use crate::schema::LayoutHtml;
use crate::text_utils::{
    TextRegion, TraversalState, advance_traversal_state, create_traversal_state,
    enter_traversal_state, is_invisible_inset, traversal_region,
};
use std::collections::HashMap;
use std::path::{Path, PathBuf};

struct ChangeWrapper {
    type_: LiveChangeType,
    ordinal: u32,
    author: String,
    author_id: i32,
    ts: String,
    snippet: String,
}

pub(crate) fn render_layout_inline(
    layout: NodeId,
    ctx: &mut RenderCtx<'_>,
    in_title: bool,
    outer_state: Option<&TraversalState>,
) -> String {
    let prev = ctx.in_title;
    if in_title {
        ctx.in_title = true;
    }
    let children = ctx.doc().node(layout).children.clone();
    let mut state = outer_state
        .map(enter_traversal_state)
        .unwrap_or_else(create_traversal_state);
    let html = render_children(&children, &mut state, ctx);
    ctx.in_title = prev;
    html
}

pub(crate) fn render_initial(node: NodeId, ctx: &mut RenderCtx<'_>) -> String {
    let letter = argument_text(ctx.doc(), node, "2");
    let rest = argument_text(ctx.doc(), node, "3");
    let body = render_layout_inline(node, ctx, false, None);
    let cap = if letter.is_empty() {
        String::new()
    } else {
        format!(
            "<span class=\"dropcap\">{}</span><span class=\"dropcap-rest\">{}</span>",
            escape_live_html(&letter),
            escape_live_html(&rest)
        )
    };
    format!(r#"<div class="initial">{cap}{body}</div>"#)
}

pub(crate) fn render_children(
    children: &[NodeId],
    state: &mut TraversalState,
    ctx: &mut RenderCtx<'_>,
) -> String {
    let mut html = String::new();
    let mut open: Vec<String> = Vec::new();

    let inline_open = |key: &str| -> &'static str {
        match key {
            "em" => "<em>",
            "strong" => "<strong>",
            "u" => "<u>",
            "dline" => r#"<u class="dline">"#,
            "wline" => r#"<u class="wline">"#,
            "s" => "<s>",
            "typewriter" => r#"<span class="typewriter">"#,
            "sans" => r#"<span class="sans">"#,
            "noun" => r#"<span class="noun">"#,
            _ => "",
        }
    };
    let inline_close = |key: &str| -> String {
        match key {
            "em" => "</em>".into(),
            "strong" => "</strong>".into(),
            "u" | "dline" | "wline" => "</u>".into(),
            "s" => "</s>".into(),
            _ => "</span>".into(),
        }
    };

    let close_all = |html: &mut String, open: &mut Vec<String>| {
        while let Some(k) = open.pop() {
            html.push_str(&inline_close(&k));
        }
    };

    let mut wrapper: Option<ChangeWrapper> = None;

    for &child in children {
        let kind_owned = ctx.doc().node(child).kind.clone();
        match kind_owned {
            NodeKind::Property { key, value } => {
                if SKIP_LAYOUT_PROPS.contains(&key.as_str()) {
                    continue;
                }
                if key == "SpecialChar" {
                    sync_change(
                        state,
                        ctx,
                        &mut html,
                        &mut open,
                        &mut wrapper,
                        close_all,
                        inline_open,
                        &inline_close,
                    );
                    let name = value.as_deref().unwrap_or("");
                    html.push_str(&mapping::special_char_html(name));
                    if let Some(w) = wrapper.as_mut() {
                        w.snippet.push_str(&mapping::special_char(name));
                    }
                    continue;
                }
                if key == "backslash" {
                    sync_change(
                        state,
                        ctx,
                        &mut html,
                        &mut open,
                        &mut wrapper,
                        close_all,
                        inline_open,
                        &inline_close,
                    );
                    html.push('\\');
                    if let Some(w) = wrapper.as_mut() {
                        w.snippet.push('\\');
                    }
                    continue;
                }
                advance_traversal_state(state, &key, value.as_deref());
                if key == "change_deleted" || key == "change_inserted" || key == "change_unchanged"
                {
                    sync_change(
                        state,
                        ctx,
                        &mut html,
                        &mut open,
                        &mut wrapper,
                        close_all,
                        inline_open,
                        &inline_close,
                    );
                } else if matches!(
                    key.as_str(),
                    "emph"
                        | "series"
                        | "shape"
                        | "bar"
                        | "strikeout"
                        | "xout"
                        | "uuline"
                        | "uwave"
                        | "noun"
                        | "family"
                        | "color"
                        | "size"
                        | "lang"
                ) {
                    sync_font(state, &mut html, &mut open, inline_open, &inline_close);
                }
            }
            NodeKind::Text { text } => {
                sync_change(
                    state,
                    ctx,
                    &mut html,
                    &mut open,
                    &mut wrapper,
                    close_all,
                    inline_open,
                    &inline_close,
                );
                html.push_str(&mapping::text_node_to_live_html(&text));
                if let Some(w) = wrapper.as_mut() {
                    w.snippet.push_str(&mapping::expand_special_in_text(&text));
                }
            }
            NodeKind::Block { tag, args, .. } => {
                sync_change(
                    state,
                    ctx,
                    &mut html,
                    &mut open,
                    &mut wrapper,
                    close_all,
                    inline_open,
                    &inline_close,
                );
                html.push_str(&render_inset(child, state, ctx));
                if let Some(w) = wrapper.as_mut()
                    && tag == "inset"
                {
                    w.snippet
                        .push_str(&format!("[{}]", args.as_deref().unwrap_or("").trim()));
                }
            }
            _ => {}
        }
    }
    close_wrapper(ctx, &mut html, &mut open, &mut wrapper, close_all);
    close_all(&mut html, &mut open);
    html
}

fn prop<'a>(state: &'a TraversalState, key: &str) -> Option<&'a str> {
    state.properties.get(key).and_then(|v| v.as_deref())
}

fn sync_font(
    state: &TraversalState,
    html: &mut String,
    open: &mut Vec<String>,
    inline_open: impl Fn(&str) -> &'static str,
    inline_close: &impl Fn(&str) -> String,
) {
    let set_inline = |html: &mut String, open: &mut Vec<String>, key: &str, want: bool| {
        let spec = inline_open(key);
        if spec.is_empty() {
            return;
        }
        let idx = open.iter().rposition(|k| k == key);
        if want && idx.is_none() {
            html.push_str(spec);
            open.push(key.to_string());
        } else if !want && let Some(idx) = idx {
            while open.len() > idx {
                let k = open.pop().expect("invariant: open stack");
                html.push_str(&inline_close(&k));
            }
        }
    };
    set_inline(
        html,
        open,
        "em",
        prop(state, "emph") == Some("on") || prop(state, "shape") == Some("italic"),
    );
    set_inline(html, open, "strong", prop(state, "series") == Some("bold"));
    set_inline(html, open, "u", prop(state, "bar") == Some("under"));
    set_inline(html, open, "dline", prop(state, "uuline") == Some("on"));
    set_inline(html, open, "wline", prop(state, "uwave") == Some("on"));
    set_inline(
        html,
        open,
        "s",
        prop(state, "strikeout") == Some("on") || prop(state, "xout") == Some("on"),
    );
    set_inline(
        html,
        open,
        "typewriter",
        prop(state, "family") == Some("typewriter"),
    );
    set_inline(html, open, "sans", prop(state, "family") == Some("sans"));
    set_inline(html, open, "noun", prop(state, "noun") == Some("on"));

    let lang_raw = prop(state, "lang").unwrap_or("").trim();
    let lang_code = if lang_raw.is_empty() {
        String::new()
    } else {
        mapping::html_lang_from_lyx(lang_raw)
    };
    let lang_key = if lang_code.is_empty() {
        String::new()
    } else {
        format!("lang:{lang_code}")
    };
    if let Some(lang_idx) = open.iter().position(|k| k.starts_with("lang:"))
        && open[lang_idx] != lang_key
    {
        while open.len() > lang_idx {
            let k = open.pop().expect("invariant: open stack");
            html.push_str(&inline_close(&k));
        }
    }
    if !lang_code.is_empty() && !open.iter().any(|k| k == &lang_key) {
        html.push_str(&format!(
            r#"<span lang="{}">"#,
            escape_live_html(&lang_code)
        ));
        open.push(lang_key);
    }

    let raw = prop(state, "color").unwrap_or("").to_ascii_lowercase();
    let want_color =
        !raw.is_empty() && raw != "none" && raw != "inherit" && raw != "default" && raw != "ignore";
    let color_key = if want_color {
        format!("color:{raw}")
    } else {
        String::new()
    };
    if let Some(color_idx) = open.iter().position(|k| k.starts_with("color:"))
        && open[color_idx] != color_key
    {
        while open.len() > color_idx {
            let k = open.pop().expect("invariant: open stack");
            html.push_str(&inline_close(&k));
        }
    }
    if want_color && !open.iter().any(|k| k == &color_key) {
        html.push_str(&format!(
            r#"<span style="color: {}">"#,
            escape_live_html(&mapping::css_lyx_color(&raw))
        ));
        open.push(color_key);
    }

    let size = prop(state, "size").unwrap_or("").to_ascii_lowercase();
    let size_css = mapping::font_size_css(&size);
    let size_key = if size_css.is_some() {
        format!("size:{size}")
    } else {
        String::new()
    };
    if let Some(size_idx) = open.iter().position(|k| k.starts_with("size:"))
        && open[size_idx] != size_key
    {
        while open.len() > size_idx {
            let k = open.pop().expect("invariant: open stack");
            html.push_str(&inline_close(&k));
        }
    }
    if let Some(css) = size_css
        && !open.iter().any(|k| k == &size_key)
    {
        html.push_str(&format!(r#"<span style="font-size: {css}">"#));
        open.push(size_key);
    }

    let shape = prop(state, "shape").unwrap_or("").to_ascii_lowercase();
    let shape_css = match shape.as_str() {
        "slanted" => Some("font-style: oblique"),
        "smallcaps" => Some("font-variant: small-caps"),
        _ => None,
    };
    let shape_key = if shape_css.is_some() {
        format!("shape:{shape}")
    } else {
        String::new()
    };
    if let Some(shape_idx) = open.iter().position(|k| k.starts_with("shape:"))
        && open[shape_idx] != shape_key
    {
        while open.len() > shape_idx {
            let k = open.pop().expect("invariant: open stack");
            html.push_str(&inline_close(&k));
        }
    }
    if let Some(css) = shape_css
        && !open.iter().any(|k| k == &shape_key)
    {
        html.push_str(&format!(r#"<span style="{css}">"#));
        open.push(shape_key);
    }
}

fn own_region(state: &TraversalState) -> &'static str {
    if state.deleted_depth > 0 {
        "deleted"
    } else if state.inserted_depth > 0 {
        "inserted"
    } else {
        "current"
    }
}

fn close_wrapper(
    ctx: &mut RenderCtx<'_>,
    html: &mut String,
    open: &mut Vec<String>,
    wrapper: &mut Option<ChangeWrapper>,
    close_all: impl Fn(&mut String, &mut Vec<String>),
) {
    let Some(w) = wrapper.take() else {
        return;
    };
    close_all(html, open);
    html.push_str(match w.type_ {
        LiveChangeType::Inserted => "</ins>",
        LiveChangeType::Deleted => "</del>",
    });
    let snippet = w.snippet.split_whitespace().collect::<Vec<_>>().join(" ");
    let snippet: String = snippet.chars().take(80).collect();
    ctx.changes.push(LiveChangeEntry {
        ordinal: w.ordinal,
        type_: w.type_,
        author: w.author,
        ts: w.ts,
        anchor_id: format!("change-{}", w.ordinal),
        snippet,
    });
}

#[allow(clippy::too_many_arguments)] // Deno syncChange closes over INLINE + wrapper
fn sync_change(
    state: &TraversalState,
    ctx: &mut RenderCtx<'_>,
    html: &mut String,
    open: &mut Vec<String>,
    wrapper: &mut Option<ChangeWrapper>,
    close_all: impl Fn(&mut String, &mut Vec<String>) + Copy,
    inline_open: impl Fn(&str) -> &'static str + Copy,
    inline_close: &impl Fn(&str) -> String,
) {
    let region = own_region(state);
    if region != "current"
        && wrapper.as_ref().is_some_and(|w| match w.type_ {
            LiveChangeType::Inserted => region == "inserted",
            LiveChangeType::Deleted => region == "deleted",
        })
    {
        let author_id = if region == "inserted" {
            state.inserted_author
        } else {
            state.deleted_author
        };
        if wrapper.as_ref().is_some_and(|w| w.author_id == author_id) {
            return;
        }
    } else if wrapper.as_ref().is_some_and(|w| match w.type_ {
        LiveChangeType::Inserted => region == "inserted",
        LiveChangeType::Deleted => region == "deleted",
    }) {
        return;
    }
    close_wrapper(ctx, html, open, wrapper, close_all);
    if region == "current" {
        sync_font(state, html, open, inline_open, inline_close);
        return;
    }
    let author_id = if region == "inserted" {
        state.inserted_author
    } else {
        state.deleted_author
    };
    let ts = if region == "inserted" {
        state.inserted_ts.clone()
    } else {
        state.deleted_ts.clone()
    };
    let author_slot = if let Some(&slot) = ctx.author_slots.get(&author_id) {
        slot
    } else {
        let slot = (ctx.author_slots.len() as u32) % AUTHOR_COLOR_COUNT;
        ctx.author_slots.insert(author_id, slot);
        slot
    };
    ctx.change_seq += 1;
    let ordinal = ctx.change_seq;
    let author = ctx
        .authors
        .get(&author_id)
        .cloned()
        .unwrap_or_else(|| format!("Author {author_id}"));
    let type_ = if region == "inserted" {
        LiveChangeType::Inserted
    } else {
        LiveChangeType::Deleted
    };
    *wrapper = Some(ChangeWrapper {
        type_,
        ordinal,
        author,
        author_id,
        ts: if ts.is_empty() { "0".into() } else { ts },
        snippet: String::new(),
    });
    close_all(html, open);
    let cls = if region == "inserted" {
        "change-inserted"
    } else {
        "change-deleted"
    };
    html.push_str(&format!(
        r#"<{} class="{cls} change-author-{author_slot}"{}>"#,
        if region == "inserted" { "ins" } else { "del" },
        mapping_attrs(&format!("change-{ordinal}"))
    ));
    let owner_sel = ctx
        .current_layout_selector
        .clone()
        .or_else(|| ctx.current_inset_selector.clone())
        .unwrap_or_else(|| "layout:nth-match(1)".into());
    emit_token(ctx, &format!("change-{ordinal}"), &owner_sel);
    sync_font(state, html, open, inline_open, inline_close);
}

pub(crate) fn render_inset(
    block: NodeId,
    parent_state: &TraversalState,
    ctx: &mut RenderCtx<'_>,
) -> String {
    let (tag, args) = match &ctx.doc().node(block).kind {
        NodeKind::Block { tag, args, .. } => (tag.clone(), args.clone()),
        _ => return String::new(),
    };
    if tag != "inset" {
        let children = ctx.doc().node(block).children.clone();
        let mut state = enter_traversal_state(parent_state);
        return render_children(&children, &mut state, ctx);
    }
    let kind = args.as_deref().unwrap_or("").trim().to_string();
    let prev_inset = ctx.current_inset_selector.take();
    let prev_node = ctx.current_inset_node;
    ctx.current_inset_node = Some(block);
    ctx.current_inset_selector = Some(inset_owner_selector(ctx, block));
    let html = render_inset_body(block, &kind, parent_state, ctx, prev_node);
    ctx.current_inset_selector = prev_inset;
    ctx.current_inset_node = prev_node;
    html
}

fn is_caption_owner_inset(kind: &str) -> bool {
    kind == "Tabular"
        || kind.starts_with("Tabular ")
        || kind.starts_with("Float ")
        || kind.starts_with("Wrap ")
        || kind == "listings"
        || kind.starts_with("listings ")
}

fn render_inset_body(
    block: NodeId,
    kind: &str,
    parent_state: &TraversalState,
    ctx: &mut RenderCtx<'_>,
    owner_parent: Option<NodeId>,
) -> String {
    if kind == "ERT" {
        return wrap_plain_text_marker(ctx, "ert", "ERT", &ert_plain_text(ctx.doc(), block));
    }
    if kind == "Note Note" || kind == "Note Comment" {
        let label = if kind == "Note Comment" {
            "Comment"
        } else {
            "Note"
        };
        let cls = if kind == "Note Comment" {
            "note note-comment"
        } else {
            "note note-note"
        };
        let inner = render_inset_layouts(block, parent_state, ctx);
        return wrap_disclosure(ctx, cls, label, &inner, None);
    }
    if is_invisible_inset("inset", Some(kind)) {
        return String::new();
    }
    if kind == "Note Greyedout" || kind.starts_with("Note Greyedout") {
        let inner = render_inset_layouts(block, parent_state, ctx);
        return wrap_disclosure(
            ctx,
            "note note-greyedout",
            "Greyedout",
            &format!(r#"<span class="note_greyedout" style="color:#A0A0A0">{inner}</span>"#),
            None,
        );
    }
    if kind == "Foot" || kind.starts_with("Foot ") {
        if ctx.in_title {
            let mark = TITLE_MARKS
                .get(ctx.title_foot as usize)
                .copied()
                .map(str::to_string)
                .unwrap_or_else(|| "*".repeat(ctx.title_foot as usize + 1));
            ctx.title_foot += 1;
            let inner = render_foot_inner(block, parent_state, ctx);
            return wrap_disclosure(
                ctx,
                "foot foot_intitle",
                &mark,
                &inner,
                Some(("foot_intitle_label", "foot_intitle_inner")),
            );
        }
        let deleted = parent_state.deleted_depth > 0 || parent_state.outer_deleted_depth > 0;
        let n = if deleted {
            ctx.footnote + 1
        } else {
            ctx.footnote += 1;
            ctx.footnote
        };
        let inner = render_inset_layouts(block, parent_state, ctx);
        return wrap_disclosure(
            ctx,
            "foot",
            &n.to_string(),
            &inner,
            Some(("foot_label", "foot_inner")),
        );
    }
    if kind == "FormulaMacro" || kind.starts_with("FormulaMacro") {
        return String::new();
    }
    if kind == "Formula" || kind.starts_with("Formula ") || kind.starts_with("Formula") {
        return render_formula_navigate(block, ctx, parent_state.deleted_depth > 0);
    }
    if kind == "Newpage" || kind.starts_with("Newpage ") {
        return r#"<div class="lyx-pagebreak" role="separator" aria-label="New page"><span class="lyx-break-label">New page</span></div>"#.into();
    }
    if kind == "Separator" || kind.starts_with("Separator ") {
        let detail = kind["Separator".len()..].trim();
        let detail = if detail.is_empty() {
            "separator"
        } else {
            detail
        };
        return format!(
            r#"<div class="lyx-separator" role="separator" aria-label="{}"></div>"#,
            escape_live_html(detail)
        );
    }
    if kind == "VSpace" || kind.starts_with("VSpace ") {
        return vspace_html(kind);
    }
    if kind == "Argument 1" || kind == "Argument" || kind.starts_with("Argument ") {
        if ctx.in_nomencl {
            return render_nomencl_argument(block, kind, parent_state, ctx, owner_parent);
        }
        if let Some(label) = graphicbox_argument_label(ctx, owner_parent, kind) {
            let inner = render_inset_layouts(block, parent_state, ctx);
            return wrap_disclosure(ctx, "argument", label, &inner, None);
        }
        if kind == "Argument 1" {
            let text = {
                let ast = ctx.doc();
                let n = mapping::nomencl_text(ast, block);
                if n.is_empty() {
                    collect_visible_text(ast, block)
                } else {
                    n
                }
            };
            return wrap_plain_text_marker(ctx, "argument short-title", "Short Title", &text);
        }
        return String::new();
    }
    if kind == "Phantom" || kind.starts_with("Phantom ") {
        let text = collect_visible_text(ctx.doc(), block);
        return wrap_plain_text_marker(ctx, "phantom", &phantom_summary_label(kind), &text);
    }
    if kind == "Info" || kind.starts_with("Info ") {
        return render_info(block, ctx);
    }
    if kind == "Tabular" {
        return render_tabular(block, parent_state, ctx);
    }
    if kind.starts_with("Float ") {
        return render_float(block, kind, parent_state, ctx);
    }
    if kind == "Marginal" || kind.starts_with("Marginal ") {
        let inner = render_inset_layouts(block, parent_state, ctx);
        return wrap_disclosure(ctx, "marginal", "Margin", &inner, None);
    }
    if kind.starts_with("Wrap ") {
        return render_wrap(block, parent_state, ctx);
    }
    if kind == "listings" || kind.starts_with("listings ") {
        return render_listings(block, parent_state, ctx);
    }
    if kind == "External" || kind.starts_with("External ") || kind == "Graphics" {
        return render_graphics(block, ctx, owner_parent);
    }
    if kind == "Caption" || kind.starts_with("Caption ") {
        let type_ = caption_type_from_kind(kind);
        let nested = flatten_flow(ctx.doc(), &ctx.doc().node(block).children, 0);
        let inner = if owner_parent
            .is_some_and(|p| is_caption_owner_inset(&inset_kind(ctx.doc(), p)))
            && !nested.is_empty()
        {
            let owner = owner_parent.expect("invariant: caption owner");
            nested
                .iter()
                .map(|item| {
                    with_caption_layout(ctx, owner, block, item, |ctx, selector| {
                        let id = take_owner_id(ctx, None);
                        emit_token(ctx, &id, selector);
                        let body = render_layout_inline(item.node, ctx, false, Some(parent_state));
                        format!(
                            r#"<span class="{}"{}>{body}</span>"#,
                            layout_slug(&item.layout),
                            mapping_attrs(&id)
                        )
                    })
                })
                .collect::<String>()
        } else {
            render_inset_layouts(block, parent_state, ctx)
        };
        let prefix = longtable_caption_prefix_html(ctx, &type_);
        return format!(
            r#"<span class="float-caption-{}">{prefix}{inner}</span>"#,
            escape_live_html(&type_)
        );
    }
    if kind.starts_with("CommandInset include") || kind.starts_with("CommandInset input") {
        return render_include(block, ctx);
    }
    if kind.starts_with("CommandInset ") {
        return render_command_inset(block, kind, ctx);
    }
    if kind == "Newline" || kind.starts_with("Newline ") {
        return newline_html(kind);
    }
    if kind.starts_with("Quotes ") {
        return escape_live_html(&quote_char(kind));
    }
    if kind.starts_with("space ") || kind == "space" {
        return space_html(ctx.doc(), block, kind);
    }
    if kind.starts_with("Index ") || kind == "Index" {
        let entry = collect_index_entry(block, ctx);
        let inner = render_inset_layouts(block, parent_state, ctx);
        return format!(
            r#"<a id="{}"></a>{}"#,
            escape_live_html(&entry.id),
            wrap_disclosure(ctx, "index-marker", "Idx", &inner, None)
        );
    }
    if kind.starts_with("IndexMacro ") || kind == "IndexMacro" {
        let inner = render_inset_layouts(block, parent_state, ctx);
        return wrap_disclosure(
            ctx,
            "index-macro",
            index_macro_summary_label(kind),
            &inner,
            None,
        );
    }
    if kind == "Nomenclature" || kind.starts_with("Nomenclature ") {
        let entry = collect_nomencl_entry(block, ctx);
        ctx.nomencl.push(entry.clone());
        let prev = ctx.in_nomencl;
        ctx.in_nomencl = true;
        let inner = render_inset_layouts(block, parent_state, ctx);
        ctx.in_nomencl = prev;
        return format!(
            r#"<a id="{}"></a>{}"#,
            escape_live_html(&entry.id),
            wrap_disclosure(ctx, "nomencl", "Nom", &inner, None)
        );
    }
    if kind == "Preview" || kind.starts_with("Preview ") {
        return format!(
            r#"<div class="preview">{}</div>"#,
            render_inset_layouts(block, parent_state, ctx)
        );
    }
    if kind.starts_with("script ") {
        let tag = if kind.contains("superscript") {
            "sup"
        } else if kind.contains("subscript") {
            "sub"
        } else {
            ""
        };
        if !tag.is_empty() {
            return format!("<{tag}>{}</{tag}>", render_flex_inline(block, ctx));
        }
    }
    if kind == "Text" {
        return render_inset_layouts(block, parent_state, ctx);
    }
    if kind == "Flex Noun" || kind.starts_with("Flex Noun") {
        return format!(
            r#"<span class="noun">{}</span>"#,
            render_flex_inline(block, ctx)
        );
    }
    if kind == "Flex Code" || kind.starts_with("Flex Code") {
        return format!(
            r#"<code class="{}">{}</code>"#,
            flex_native_class(kind),
            render_flex_inline(block, ctx)
        );
    }
    if kind == "Flex Emph" || kind.starts_with("Flex Emph") {
        return format!(
            r#"<em class="{}">{}</em>"#,
            flex_native_class(kind),
            render_flex_inline(block, ctx)
        );
    }
    if kind == "Flex Strong" || kind.starts_with("Flex Strong") {
        return format!(
            r#"<strong class="{}">{}</strong>"#,
            flex_native_class(kind),
            render_flex_inline(block, ctx)
        );
    }
    if kind.starts_with("Flex Multiple") {
        let cols = argument_text(ctx.doc(), block, "1");
        let n = if cols.trim().chars().all(|c| c.is_ascii_digit()) && !cols.trim().is_empty() {
            cols.trim().to_string()
        } else {
            "2".into()
        };
        let preface = argument_text(ctx.doc(), block, "2");
        let body = render_inset_layouts(block, parent_state, ctx);
        let head = if preface.is_empty() {
            String::new()
        } else {
            format!(
                r#"<div class="multicol-preface">{}</div>"#,
                escape_live_html(&preface)
            )
        };
        let box_html = format!(
            r#"{head}<div class="{}" style="column-count: {}">{body}</div>"#,
            flex_native_class(kind),
            escape_live_html(&n)
        );
        return wrap_disclosure(ctx, "flex-container multicol", "Columns", &box_html, None);
    }
    if let Some(label) = graphicbox_label(kind) {
        let inner = format!(
            r#"<span class="{}">{}</span>"#,
            flex_native_class(kind),
            render_flex_inline(block, ctx)
        );
        return wrap_disclosure(
            ctx,
            &format!("flex-container {}", label.to_ascii_lowercase()),
            label,
            &inner,
            None,
        );
    }
    if kind.starts_with("Flex Minipage") {
        let max_w = argument_text(ctx.doc(), block, "2");
        let max_w = max_w.trim();
        let css = if !max_w.is_empty() && !max_w.starts_with('\\') {
            width_to_css(Some(max_w))
        } else {
            String::new()
        };
        let style = if css.is_empty() {
            String::new()
        } else {
            format!(r#" style="max-width: {}""#, escape_live_html(&css))
        };
        let box_html = format!(
            r#"<div class="{}"{style}>{}</div>"#,
            flex_native_class(kind),
            render_inset_layouts(block, parent_state, ctx)
        );
        return wrap_disclosure(ctx, "flex-container minipage", "Minipage", &box_html, None);
    }
    if kind == "Flex Only" || kind.starts_with("Flex Only ") {
        return format!(
            r#"<span class="only">{}</span>"#,
            render_flex_inline(block, ctx)
        );
    }
    if kind.starts_with("Flex H-P number") {
        return format!(
            r#"<span class="hp-number">{}</span>"#,
            render_flex_inline(block, ctx)
        );
    }
    if kind.starts_with("Flex H-P statement") {
        return format!(
            r#"<span class="hp-statement">{}</span>"#,
            render_inset_layouts(block, parent_state, ctx)
        );
    }
    if kind.starts_with("Flex tablenotemark") {
        return format!(
            r#"<sup class="tablenotemark">{}</sup>"#,
            render_flex_inline(block, ctx)
        );
    }
    if kind.starts_with("Flex PDF-Annotation")
        || kind.starts_with("Flex PDF-Markup")
        || kind.starts_with("Flex PDF-Comment")
        || kind.starts_with("Flex PDF-Margin")
    {
        let cls = layout_slug(&kind["Flex ".len()..]);
        let aside = format!(
            r#"<aside class="pdf-comment {cls}">{}</aside>"#,
            render_inset_layouts(block, parent_state, ctx)
        );
        return wrap_disclosure(
            ctx,
            &format!("flex-container pdf-comment {cls}"),
            "PDF comment",
            &aside,
            None,
        );
    }
    if kind.starts_with("Flex PDFAction")
        || kind.starts_with("Flex TextField")
        || kind.starts_with("Flex ChoiceMenu")
        || kind.starts_with("Flex PushButton")
        || kind.starts_with("Flex CheckBox")
        || kind.starts_with("Flex SubmitButton")
        || kind.starts_with("Flex ResetButton")
    {
        let cls = layout_slug(&kind["Flex ".len()..]);
        return format!(
            r#"<span class="pdf-form {cls}">{}</span>"#,
            render_inset_layouts(block, parent_state, ctx)
        );
    }
    if kind.starts_with("Box ") {
        return render_box(block, kind, parent_state, ctx);
    }
    if kind.starts_with("Flex Subequations") {
        enter_subequations(ctx);
        let box_html = format!(
            r#"<div class="subequations">{}</div>"#,
            render_inset_layouts(block, parent_state, ctx)
        );
        ctx.subeq = None;
        return wrap_disclosure(
            ctx,
            "flex-container subequations",
            "Subequations",
            &box_html,
            None,
        );
    }
    if kind == "IPA" || kind.starts_with("IPA ") {
        return format!(
            r#"<span class="ipa">{}</span>"#,
            render_inset_layouts(block, parent_state, ctx)
        );
    }
    if kind.starts_with("IPADeco") {
        return render_ipa_deco(block, parent_state, ctx);
    }
    if kind == "FloatList" || kind.starts_with("FloatList ") {
        return render_float_list(kind, ctx);
    }
    if let Some(name) = kind.strip_prefix("Branch ") {
        if !branch_produces_output(block, ctx) {
            return String::new();
        }
        let name = name.trim();
        let name = if name.is_empty() { "Branch" } else { name };
        let inner = render_inset_layouts(block, parent_state, ctx);
        return wrap_disclosure(ctx, "branch", &format!("Branch: {name}"), &inner, None);
    }
    if kind.starts_with("Flex ") {
        return render_flex_default(kind, block, parent_state, ctx);
    }
    mapping::warn_once(
        ctx,
        &format!("Unknown inset '{kind}' rendered as an escaped fallback."),
    );
    mapping::diagnostic(
        ctx,
        "UNKNOWN_INSET",
        &format!("Unknown inset '{kind}' rendered as an escaped fallback."),
    );
    let fallback = collect_visible_text(ctx.doc(), block);
    format!(
        r#"<span class="unknown-inset">{}</span>"#,
        escape_live_html(&fallback)
    )
}

fn render_foot_inner(
    block: NodeId,
    parent_state: &TraversalState,
    ctx: &mut RenderCtx<'_>,
) -> String {
    let nested = flatten_flow(ctx.doc(), &ctx.doc().node(block).children, 0);
    if nested.is_empty() {
        let children = ctx.doc().node(block).children.clone();
        let mut state = enter_traversal_state(parent_state);
        return render_children(&children, &mut state, ctx);
    }
    let in_title = ctx.in_title;
    nested
        .iter()
        .map(|item| {
            with_layout(ctx, item, |ctx, selector| {
                let id = take_owner_id(ctx, None);
                emit_token(ctx, &id, selector);
                let inner = render_layout_inline(item.node, ctx, in_title, Some(parent_state));
                format!(
                    r#"<div class="{}"{}>{inner}</div>"#,
                    layout_slug(&item.layout),
                    mapping_attrs(&id)
                )
            })
        })
        .collect()
}

fn render_inset_layouts(
    block: NodeId,
    parent_state: &TraversalState,
    ctx: &mut RenderCtx<'_>,
) -> String {
    let nested = flatten_flow(ctx.doc(), &ctx.doc().node(block).children, 0);
    if !nested.is_empty() {
        return flow::render_flow_items(&nested, ctx, Some(parent_state));
    }
    let children = ctx.doc().node(block).children.clone();
    let mut state = enter_traversal_state(parent_state);
    render_children(&children, &mut state, ctx)
}

pub(crate) fn enter_subequations(ctx: &mut RenderCtx<'_>) {
    ctx.equation += 1;
    ctx.subeq = Some(SubeqState {
        parent: ctx.equation as i32,
        child: 0,
    });
}

fn take_equation_number(ctx: &mut RenderCtx<'_>, deleted: bool) -> String {
    if deleted {
        return "#".into();
    }
    if let Some(subeq) = ctx.subeq.as_mut() {
        subeq.child += 1;
        let letter = char::from(b'a' + (subeq.child as u8).saturating_sub(1));
        return format!("{}{letter}", subeq.parent);
    }
    ctx.equation += 1;
    ctx.equation.to_string()
}

pub(crate) fn formula_source(ast: &Document, block: NodeId) -> String {
    let args = inset_kind(ast, block);
    let from_args = if args.starts_with("Formula") && args.len() > "Formula".len() {
        args["Formula".len()..].trim().to_string()
    } else {
        String::new()
    };
    let mut parts = Vec::new();
    for &c in &ast.node(block).children {
        match &ast.node(c).kind {
            NodeKind::Text { text } => parts.push(text.clone()),
            NodeKind::Property { key, value } => {
                if let Some(v) = value {
                    parts.push(format!("\\{key} {v}"));
                } else {
                    parts.push(format!("\\{key}"));
                }
            }
            _ => {}
        }
    }
    let from_children = parts.join("\n").trim().to_string();
    if !from_args.is_empty() && !from_children.is_empty() {
        format!("{from_args}\n{from_children}")
    } else if !from_args.is_empty() {
        from_args
    } else {
        from_children
    }
}

pub(crate) fn take_formula_numbers(
    src: &str,
    ctx: &mut RenderCtx<'_>,
    deleted: bool,
) -> Vec<Option<String>> {
    let plan = plan_formula_lines(src);
    let mut nos = Vec::new();
    for line in &plan.lines {
        if line.consumes_number {
            let num = take_equation_number(ctx, deleted);
            if !deleted {
                for lab in &line.labels {
                    ctx.labels.insert(lab.clone(), num.clone());
                    ctx.label_kinds.insert(lab.clone(), LabelKind::Equation);
                }
            }
            nos.push(Some(num));
        } else {
            nos.push(None);
        }
    }
    nos
}

pub(crate) fn walk_subequation_labels(nodes: &[NodeId], ctx: &mut RenderCtx<'_>) {
    let parent = ctx
        .subeq
        .as_ref()
        .map(|s| s.parent.to_string())
        .unwrap_or_else(|| ctx.equation.to_string());
    for &id in nodes {
        let children = ctx.doc().node(id).children.clone();
        let is_inset = matches!(
            &ctx.doc().node(id).kind,
            NodeKind::Block { tag, .. } if tag == "inset"
        );
        let is_block = matches!(&ctx.doc().node(id).kind, NodeKind::Block { .. });
        if is_inset {
            let kind = inset_kind(ctx.doc(), id);
            if kind.starts_with("CommandInset label") {
                if let Some(name) = find_property(ctx.doc(), id, "name") {
                    ctx.labels.insert(name.clone(), parent.clone());
                    ctx.label_kinds.insert(name, LabelKind::Equation);
                }
                continue;
            }
            if kind == "Formula" || kind.starts_with("Formula") {
                let src = formula_source(ctx.doc(), id);
                take_formula_numbers(&src, ctx, false);
                continue;
            }
            walk_subequation_labels(&children, ctx);
        } else if is_block {
            walk_subequation_labels(&children, ctx);
        }
    }
}

fn render_formula_navigate(block: NodeId, ctx: &mut RenderCtx<'_>, deleted: bool) -> String {
    let source = formula_source(ctx.doc(), block);
    let plan = plan_formula_lines(&source);
    let nos = take_formula_numbers(&source, ctx, deleted);
    let no_refs: Vec<Option<&str>> = nos.iter().map(|n| n.as_deref()).collect();
    let mut html = render_formula_html(&source, &no_refs, ctx.math_macros.as_ref());
    let mut ids = Vec::new();
    if !deleted {
        for (i, line) in plan.lines.iter().enumerate() {
            let Some(no) = nos.get(i).and_then(|n| n.as_deref()) else {
                continue;
            };
            if no.is_empty() {
                continue;
            }
            let lab = line.labels.first();
            let id = lab
                .map(|l| xml_id(l))
                .unwrap_or_else(|| format!("eq-{}", no.replace('.', "-")));
            ids.push(id.clone());
            let snippet: String = line
                .tex
                .replace("\\label{", "")
                .split_whitespace()
                .collect::<Vec<_>>()
                .join(" ")
                .chars()
                .take(60)
                .collect();
            ctx.nav_equations.push(LiveNavEntry {
                kind: "equation".into(),
                number: no.to_string(),
                text: snippet,
                id,
                name: lab.cloned(),
                line: None,
                children: None,
            });
        }
    }
    let map_id = if ctx.current_inset_selector.is_some() {
        let sel = ctx
            .current_inset_selector
            .clone()
            .expect("invariant: selector");
        let id = if let Some(first) = ids.first() {
            take_owner_id(ctx, Some(first))
        } else {
            take_owner_id(ctx, None)
        };
        emit_token(ctx, &id, &sel);
        Some(id)
    } else {
        None
    };
    if ids.len() == 1 {
        let id = map_id.clone().unwrap_or_else(|| ids[0].clone());
        let ref_attr = if map_id.is_some() {
            mapping_attrs(&id)
        } else {
            format!(r#" id="{}""#, escape_live_html(&id))
        };
        html = html.replacen(
            r#"<span class="formula""#,
            &format!(r#"<span class="formula"{ref_attr}"#),
            1,
        );
    } else if ids.len() > 1 {
        let mut n = 0usize;
        let mut out = String::new();
        let mut rest = html.as_str();
        let needle = r#"<span class="formula-row""#;
        while let Some(pos) = rest.find(needle) {
            out.push_str(&rest[..pos]);
            n += 1;
            let id = ids.get(n - 1);
            if n == 1 && map_id.is_some() {
                out.push_str(&format!(
                    r#"<span class="formula-row"{}"#,
                    mapping_attrs(map_id.as_deref().expect("invariant: map_id"))
                ));
            } else if let Some(id) = id {
                out.push_str(&format!(
                    r#"<span class="formula-row" id="{}""#,
                    escape_live_html(id)
                ));
            } else {
                out.push_str(needle);
            }
            rest = &rest[pos + needle.len()..];
        }
        out.push_str(rest);
        html = out;
    } else if let Some(map_id) = &map_id {
        html = html.replacen(
            r#"<span class="formula""#,
            &format!(r#"<span class="formula"{}"#, mapping_attrs(map_id)),
            1,
        );
    }
    html
}

fn wrap_disclosure(
    ctx: &mut RenderCtx<'_>,
    class_name: &str,
    summary_label: &str,
    body_html: &str,
    opts: Option<(&str, &str)>,
) -> String {
    wrap_disclosure_attrs(ctx, class_name, summary_label, body_html, opts, "")
}

fn wrap_disclosure_attrs(
    ctx: &mut RenderCtx<'_>,
    class_name: &str,
    summary_label: &str,
    body_html: &str,
    opts: Option<(&str, &str)>,
    extra_attrs: &str,
) -> String {
    let (sum_cls, body_cls) = opts.unwrap_or(("disclose-summary", "disclose-body"));
    let mut id_attr = String::new();
    if ctx.current_inset_selector.is_some() {
        let sel = ctx
            .current_inset_selector
            .clone()
            .expect("invariant: inset selector");
        let id = take_owner_id(ctx, None);
        emit_token(ctx, &id, &sel);
        id_attr = mapping_attrs(&id);
    }
    format!(
        r#"<details class="disclose {}"{id_attr}{extra_attrs}><summary class="{}">{}</summary><span class="{}">{body_html}</span></details>"#,
        escape_live_html(class_name),
        escape_live_html(sum_cls),
        escape_live_html(summary_label),
        escape_live_html(body_cls)
    )
}

fn wrap_plain_text_marker(
    ctx: &mut RenderCtx<'_>,
    class_name: &str,
    summary_label: &str,
    raw_text: &str,
) -> String {
    let text = raw_text.split_whitespace().collect::<Vec<_>>().join(" ");
    let body = format!(
        r#"<code class="marker-body">{}</code>"#,
        escape_live_html(
            if text.is_empty() {
                format!("(empty {summary_label})")
            } else {
                text
            }
            .as_str()
        )
    );
    wrap_disclosure(ctx, class_name, summary_label, &body, None)
}

fn phantom_summary_label(kind: &str) -> String {
    let rest = kind["Phantom".len()..].trim();
    if rest.to_ascii_lowercase().starts_with("hphantom") {
        "HPhantom".into()
    } else if rest.to_ascii_lowercase().starts_with("vphantom") {
        "VPhantom".into()
    } else {
        "Phantom".into()
    }
}

fn render_nomencl_argument(
    block: NodeId,
    kind: &str,
    parent_state: &TraversalState,
    ctx: &mut RenderCtx<'_>,
    owner_parent: Option<NodeId>,
) -> String {
    let nested = flatten_flow(ctx.doc(), &ctx.doc().node(block).children, 0);
    let owner_ok = owner_parent.is_some_and(|p| {
        let k = inset_kind(ctx.doc(), p);
        k == "Nomenclature" || k.starts_with("Nomenclature ")
    });
    let inner = if owner_ok && !nested.is_empty() {
        let owner = owner_parent.expect("invariant: owner_ok");
        nested
            .iter()
            .map(|item| {
                with_caption_layout(ctx, owner, block, item, |ctx, selector| {
                    let id = take_owner_id(ctx, None);
                    emit_token(ctx, &id, selector);
                    let body = render_layout_inline(item.node, ctx, false, Some(parent_state));
                    format!(
                        r#"<div class="{}"{}>{body}</div>"#,
                        layout_slug(&item.layout),
                        mapping_attrs(&id)
                    )
                })
            })
            .collect::<String>()
    } else {
        render_inset_layouts(block, parent_state, ctx)
    };
    wrap_disclosure(
        ctx,
        "argument",
        nomencl_argument_summary_label(kind),
        &inner,
        None,
    )
}

fn nomencl_argument_summary_label(kind: &str) -> &'static str {
    let slot = kind
        .strip_prefix("Argument")
        .unwrap_or(kind)
        .trim()
        .to_ascii_lowercase();
    match slot.as_str() {
        "1" => "Sort as",
        "post:1" => "Description",
        "post:2" => "Unit",
        "post:3" => "Note",
        _ => "Argument",
    }
}

fn index_macro_summary_label(kind: &str) -> &'static str {
    let rest = kind
        .strip_prefix("IndexMacro")
        .unwrap_or(kind)
        .trim()
        .to_ascii_lowercase();
    match rest.as_str() {
        "subentry" => "Subentry",
        "see" => "See",
        "seealso" => "See also",
        "sortkey" => "Sort as",
        _ => "Index",
    }
}

fn ert_plain_text(ast: &Document, block: NodeId) -> String {
    let mut out = String::new();
    for &c in &ast.node(block).children {
        let NodeKind::Text { text } = &ast.node(c).kind else {
            continue;
        };
        if text.is_empty() || mapping::is_status_line(text) {
            continue;
        }
        if text.starts_with("\\begin_layout") || text.starts_with("\\end_layout") {
            continue;
        }
        if text == "\\backslash" {
            out.push('\\');
            continue;
        }
        out.push_str(text);
    }
    out.split_whitespace().collect::<Vec<_>>().join(" ")
}

pub(crate) fn collect_visible_text(ast: &Document, block: NodeId) -> String {
    let mut out = String::new();
    walk_visible(ast, block, &mut create_traversal_state(), &mut out);
    out
}

fn walk_visible(ast: &Document, id: NodeId, state: &mut TraversalState, out: &mut String) {
    for &c in &ast.node(id).children {
        match &ast.node(c).kind {
            NodeKind::Property { key, value } => {
                advance_traversal_state(state, key, value.as_deref());
            }
            NodeKind::Text { text } => {
                if traversal_region(state) == TextRegion::Deleted {
                    continue;
                }
                if !mapping::is_status_line(text) {
                    out.push_str(text);
                }
            }
            NodeKind::Block { tag, args, .. } => {
                if traversal_region(state) == TextRegion::Deleted {
                    continue;
                }
                if tag == "inset" {
                    let kind = args.as_deref().unwrap_or("").trim();
                    if kind == "ERT"
                        || is_invisible_inset(tag, args.as_deref())
                        || kind == "Index"
                        || kind.starts_with("Index ")
                        || kind.starts_with("IndexMacro")
                        || kind == "Nomenclature"
                        || kind.starts_with("Nomenclature ")
                    {
                        continue;
                    }
                }
                let mut child = enter_traversal_state(state);
                walk_visible(ast, c, &mut child, out);
            }
            _ => {}
        }
    }
}

fn parse_xml_attrs(raw: &str) -> HashMap<String, String> {
    let mut attrs = HashMap::new();
    let mut rest = raw;
    while let Some(eq) = rest.find("=\"") {
        let key_area = &rest[..eq];
        let key = key_area
            .rsplit(|c: char| !(c.is_ascii_alphanumeric() || c == '_' || c == ':' || c == '-'))
            .next()
            .unwrap_or("")
            .to_string();
        let after = &rest[eq + 2..];
        if let Some(end) = after.find('"') {
            if !key.is_empty() {
                attrs.insert(key, after[..end].to_string());
            }
            rest = &after[end + 1..];
        } else {
            break;
        }
    }
    attrs
}

fn width_to_css(width: Option<&str>) -> String {
    let Some(width) = width else {
        return String::new();
    };
    if width == "none" {
        return String::new();
    }
    let w = width.trim_matches(|c| c == '"' || c == '\'').trim();
    if is_zero_length(w) {
        return String::new();
    }
    let lower = w.to_ascii_lowercase();
    if let Some(stripped) = lower
        .strip_suffix("col%")
        .or_else(|| lower.strip_suffix("text%"))
    {
        return format!("{stripped}%");
    }
    w.to_string()
}

fn is_zero_length(w: &str) -> bool {
    let s = w.trim();
    if s.is_empty() {
        return true;
    }
    let num: String = s
        .chars()
        .take_while(|c| c.is_ascii_digit() || *c == '.' || *c == '-' || *c == '+')
        .collect();
    if num.is_empty() {
        return false;
    }
    num.parse::<f64>().ok() == Some(0.0)
}

fn attr_true(attr: &HashMap<String, String>, key: &str) -> bool {
    attr.get(key).map(String::as_str) == Some("true")
}

fn cell_at(
    cell_attrs: &[HashMap<String, String>],
    used_cols: usize,
    row: usize,
    col: usize,
) -> Option<&HashMap<String, String>> {
    if used_cols == 0 || col >= used_cols {
        return None;
    }
    cell_attrs.get(row.saturating_mul(used_cols).saturating_add(col))
}

/// Adjacent column already paints this same horizontal edge (this row, or the
/// cell across the row boundary). Used so meeting short rules join.
fn col_has_h_edge(
    cell_attrs: &[HashMap<String, String>],
    used_cols: usize,
    row: usize,
    col: usize,
    at_top: bool,
    other_row: usize,
) -> bool {
    let Some(here) = cell_at(cell_attrs, used_cols, row, col) else {
        return false;
    };
    if at_top {
        if attr_true(here, "topline") {
            return true;
        }
        return row
            .checked_sub(1)
            .and_then(|r| cell_at(cell_attrs, used_cols, r, col))
            .is_some_and(|a| attr_true(a, "bottomline"));
    }
    if attr_true(here, "bottomline") {
        return true;
    }
    cell_at(cell_attrs, used_cols, other_row, col).is_some_and(|a| attr_true(a, "topline"))
}

/// LyX only opens a horizontal double line when every cell in the upper row
/// has a bottom line and every cell in the lower row has a top line
/// (`rowBottomLine` && `rowTopLine`, then `WIDTH_OF_LINE` gap).
fn row_line_all(
    cell_attrs: &[HashMap<String, String>],
    row: usize,
    used_cols: usize,
    key: &str,
) -> bool {
    if used_cols == 0 {
        return false;
    }
    let start = row.saturating_mul(used_cols);
    let end = start.saturating_add(used_cols);
    if end > cell_attrs.len() || start >= cell_attrs.len() {
        return false;
    }
    cell_attrs[start..end].iter().all(|a| attr_true(a, key))
}

fn lyx_paint_color(name: &str) -> Option<String> {
    let n = name.trim();
    if n.is_empty() || n.eq_ignore_ascii_case("default") || n.eq_ignore_ascii_case("none") {
        return None;
    }
    Some(mapping::css_lyx_color(n))
}

fn row_space_css(value: Option<&str>) -> Option<String> {
    let v = value.map(str::trim).filter(|s| !s.is_empty())?;
    if v.eq_ignore_ascii_case("default") {
        return Some("10px".into());
    }
    if is_zero_length(v) {
        return None;
    }
    Some(v.to_string())
}

fn newline_html(kind: &str) -> String {
    let cls = if kind.contains("linebreak") {
        "newline linebreak"
    } else {
        "newline"
    };
    format!(r#"<span class="{cls}" aria-hidden="true"></span><br>"#)
}

fn graphicbox_label(kind: &str) -> Option<&'static str> {
    if kind.starts_with("Flex Rotatebox") {
        Some("Rotatebox")
    } else if kind.starts_with("Flex Scalebox") {
        Some("Scalebox")
    } else if kind.starts_with("Flex Resizebox") {
        Some("Resizebox")
    } else if kind.starts_with("Flex Reflectbox") {
        Some("Reflectbox")
    } else {
        None
    }
}

fn graphicbox_argument_label(
    ctx: &RenderCtx<'_>,
    owner_parent: Option<NodeId>,
    arg_kind: &str,
) -> Option<&'static str> {
    let owner = owner_parent?;
    let parent = inset_kind(ctx.doc(), owner);
    let slot = arg_kind.strip_prefix("Argument").unwrap_or(arg_kind).trim();
    if parent.starts_with("Flex Rotatebox") {
        match slot {
            "1" => Some("Origin"),
            "2" => Some("Angle"),
            _ => None,
        }
    } else if parent.starts_with("Flex Scalebox") {
        match slot {
            "1" => Some("H-Factor"),
            "2" => Some("V-Factor"),
            _ => None,
        }
    } else if parent.starts_with("Flex Resizebox") {
        match slot {
            "1" => Some("Width"),
            "2" => Some("Height"),
            _ => None,
        }
    } else {
        None
    }
}

/// LyX `InsetVSpace::label`: `"Vertical Space (" + VSpace::asGUIName() + ")"`.
fn vspace_gui_label(amount: &str) -> String {
    let keep = amount.ends_with('*');
    let core = amount.trim_end_matches('*').trim();
    let name = match core {
        "" | "vspace" => None,
        "defskip" => Some("Default skip"),
        "smallskip" => Some("Small skip"),
        "medskip" => Some("Medium skip"),
        "bigskip" => Some("Big skip"),
        "halfline" => Some("Half line height"),
        "fullline" => Some("Line height"),
        "vfill" => Some("Vertical fill"),
        other => Some(other),
    };
    match name {
        None => "Vertical Space".into(),
        Some(name) if keep => format!("Vertical Space ({name}, protected)"),
        Some(name) => format!("Vertical Space ({name})"),
    }
}

fn vspace_html(kind: &str) -> String {
    let amount = kind["VSpace".len()..].trim();
    let amount = if amount.is_empty() { "vspace" } else { amount };
    let label = vspace_gui_label(amount);
    let core = amount.trim_end_matches('*').trim();
    let variant = if core == "vfill" {
        "vfill"
    } else if core.starts_with('-') {
        "removed"
    } else {
        "added"
    };
    let height = match core {
        "smallskip" => Some("1.4em"),
        "defskip" | "medskip" | "halfline" => Some("1.7em"),
        "bigskip" | "fullline" => Some("2.2em"),
        "vfill" => Some("3.6em"),
        "" | "vspace" => None,
        other if !other.starts_with('-') => Some(other),
        _ => None,
    };
    let height_attr = height
        .map(|h| format!(r#" style="min-height: {}""#, escape_live_html(h)))
        .unwrap_or_default();
    format!(
        r#"<div class="lyx-vspace {variant}" data-vspace="{a}" aria-label="{label}"{height_attr}><span class="lyx-vspace-mark" aria-hidden="true"></span><span class="lyx-vspace-label">{label}</span></div>"#,
        a = escape_live_html(amount),
        label = escape_live_html(&label),
    )
}

fn space_html(ast: &Document, block: NodeId, kind: &str) -> String {
    let arg = kind.strip_prefix("space ").map(str::trim).unwrap_or("");
    if let Some(cls) = fill_class(arg) {
        return format!(r#"<span class="{cls}" aria-hidden="true"></span>"#);
    }
    if arg.contains("hspace") {
        return custom_space_html(arg, find_property(ast, block, "length").as_deref());
    }
    format!(
        r#"<span class="space-mark {}" aria-hidden="true"></span>"#,
        named_space_mark_classes(arg)
    )
}

fn custom_space_html(arg: &str, length: Option<&str>) -> String {
    let color = if arg.contains("hspace*") {
        "latex"
    } else {
        "special"
    };
    let raw = length.unwrap_or("0pt").trim();
    let abs = raw.trim_start_matches('-');
    let abs = if abs.is_empty() { "0pt" } else { abs };
    let shape = if raw.starts_with('-') {
        "arrow"
    } else {
        "deep"
    };
    format!(
        r#"<span class="space-mark custom {color} {shape}" style="width: {}" aria-hidden="true"></span>"#,
        escape_live_html(abs)
    )
}

/// Class tokens for LyX's non-fill InsetSpace U mark (kind, colour, depth).
fn named_space_mark_classes(arg: &str) -> &'static str {
    if arg.contains("textvisiblespace") {
        "visible foreground baseline"
    } else if arg.contains("negthinspace") || arg.contains("thinspace") {
        "thin latex deep"
    } else if arg.contains("negmedspace") || arg.contains("medspace") {
        "med latex deep"
    } else if arg.contains("negthickspace") || arg.contains("thickspace") {
        "thick latex deep"
    } else if arg.contains("qquad") {
        "qquad special deep"
    } else if arg.contains("quad") {
        "quad special deep"
    } else if arg.contains("enskip") {
        "enskip special deep"
    } else if arg.contains("enspace") {
        "enspace latex deep"
    } else if arg.contains("\\space") {
        "normal special baseline"
    } else {
        "protected latex baseline"
    }
}

fn fill_class(arg: &str) -> Option<&'static str> {
    if arg.contains("dotfill") {
        return Some("hfill dotfill");
    }
    if arg.contains("hrulefill") {
        return Some("hfill hrulefill");
    }
    if arg.contains("leftarrowfill") {
        return Some("hfill leftarrowfill");
    }
    if arg.contains("rightarrowfill") {
        return Some("hfill rightarrowfill");
    }
    if arg.contains("hfill") || arg.contains("upbracefill") || arg.contains("downbracefill") {
        return Some("hfill");
    }
    if arg.contains("hspace*") && arg.contains("fill") {
        return Some("hfill hfill-protected");
    }
    None
}

fn tabular_xml_meta(ast: &Document, block: NodeId) -> String {
    let mut meta = String::new();
    for &c in &ast.node(block).children {
        if let NodeKind::Text { text } = &ast.node(c).kind {
            meta.push_str(text);
        }
    }
    meta
}

pub(crate) fn tabular_is_longtable(ast: &Document, block: NodeId) -> bool {
    tabular_xml_meta(ast, block).contains("islongtable=\"true\"")
}

fn render_tabular(block: NodeId, parent_state: &TraversalState, ctx: &mut RenderCtx<'_>) -> String {
    let meta = tabular_xml_meta(ctx.doc(), block);
    let cols = attr_after(&meta, "columns=\"")
        .and_then(|s| s.parse::<usize>().ok())
        .unwrap_or(0);
    let features = find_tags(&meta, "features")
        .into_iter()
        .next()
        .map(|raw| parse_xml_attrs(&raw))
        .unwrap_or_default();
    let col_attrs: Vec<HashMap<String, String>> = find_tags(&meta, "column")
        .into_iter()
        .map(|raw| parse_xml_attrs(&raw))
        .collect();
    let row_attrs: Vec<HashMap<String, String>> = find_tags(&meta, "row")
        .into_iter()
        .map(|raw| parse_xml_attrs(&raw))
        .collect();
    let cell_attrs: Vec<HashMap<String, String>> = find_tags(&meta, "cell")
        .into_iter()
        .map(|raw| parse_xml_attrs(&raw))
        .collect();
    let cells = collect_blocks(
        ctx.doc(),
        block,
        |ast, id| {
            matches!(&ast.node(id).kind, NodeKind::Block { tag, .. } if tag == "inset")
                && inset_kind(ast, id) == "Text"
        },
        None,
    );
    let used_cols = if cols > 0 { cols } else { cells.len().max(1) };
    let nrows = if used_cols > 0 {
        cell_attrs.len().div_ceil(used_cols)
    } else {
        0
    };
    let is_long = meta.contains("islongtable=\"true\"");
    let booktabs = features.get("booktabs").map(String::as_str) == Some("true");
    let line_color = features
        .get("borderColor")
        .and_then(|n| lyx_paint_color(n))
        .unwrap_or_else(|| "black".into());
    let table_valign = match features
        .get("tabularvalignment")
        .map(String::as_str)
        .unwrap_or("middle")
    {
        "top" => "top",
        "bottom" => "bottom",
        _ => "middle",
    };
    let odd_row_color = features
        .get("oddRowsColor")
        .map(String::as_str)
        .unwrap_or("");
    let even_row_color = features
        .get("evenRowsColor")
        .map(String::as_str)
        .unwrap_or("");
    let alt_start = features
        .get("startAltRowColors")
        .and_then(|s| s.parse::<i32>().ok())
        .unwrap_or(0);
    let table_class = if is_long {
        match attr_after(&meta, "longtabularalignment=\"") {
            Some("left") => r#" class="longtable longtable-left""#,
            Some("right") => r#" class="longtable longtable-right""#,
            _ => r#" class="longtable""#,
        }
    } else {
        ""
    };
    let prev_lt = ctx.longtable_number.take();
    if is_long {
        ctx.longtable_number = take_float_number(ctx, "table", false);
    }
    let id_attr = ctx
        .longtable_number
        .as_deref()
        .map(|n| format!(r#" id="float-table-{}""#, n.replace('.', "-")))
        .unwrap_or_default();
    let decimal_point_of = |col: usize| -> String {
        col_attrs
            .get(col)
            .and_then(|a| a.get("decimal_point"))
            .cloned()
            .filter(|s| !s.is_empty())
            .unwrap_or_else(|| ".".into())
    };
    let is_decimal_col = |col: usize| -> bool {
        col_attrs
            .get(col)
            .and_then(|a| a.get("alignment"))
            .map(String::as_str)
            == Some("decimal")
    };
    let mut decimal_widths: Vec<(usize, usize)> = vec![(0, 0); used_cols];
    for (col, widths) in decimal_widths.iter_mut().enumerate() {
        if !is_decimal_col(col) {
            continue;
        }
        let point = decimal_point_of(col);
        let mut left = 0usize;
        let mut right = 0usize;
        for row in 0..nrows {
            let i = row * used_cols + col;
            let Some(id) = cells.get(i).copied() else {
                continue;
            };
            let plain = collect_visible_text(ctx.doc(), id);
            if let Some(pos) = plain.find(&point) {
                left = left.max(plain[..pos].chars().count());
                right = right.max(plain[pos..].chars().count());
            }
        }
        *widths = (left, right);
    }
    let mut colgroup = String::new();
    if col_attrs
        .iter()
        .any(|a| !width_to_css(a.get("width").map(String::as_str)).is_empty())
    {
        colgroup.push_str("<colgroup>");
        for col in 0..used_cols {
            let w = width_to_css(
                col_attrs
                    .get(col)
                    .and_then(|a| a.get("width"))
                    .map(String::as_str),
            );
            if w.is_empty() {
                colgroup.push_str("<col>");
            } else {
                colgroup.push_str(&format!(r#"<col style="width: {}">"#, escape_live_html(&w)));
            }
        }
        colgroup.push_str("</colgroup>");
    }
    let mut html = format!("<table{table_class}{id_attr}>{colgroup}<tbody>");
    let mut c = 0usize;
    for i in 0..cell_attrs.len() {
        let attr = &cell_attrs[i];
        if attr.get("multicolumn").map(String::as_str) == Some("2") {
            continue;
        }
        if attr.get("multirow").map(String::as_str) == Some("4") {
            c += 1;
            if c >= used_cols {
                html.push_str("</tr>");
                c = 0;
            }
            continue;
        }
        if c == 0 {
            html.push_str("<tr>");
        }
        let row = i.checked_div(used_cols).unwrap_or(0);
        let mut span = 1usize;
        if attr.get("multicolumn").map(String::as_str) == Some("1") {
            let mut j = i + 1;
            while j < cell_attrs.len()
                && cell_attrs[j].get("multicolumn").map(String::as_str) == Some("2")
            {
                span += 1;
                j += 1;
            }
        }
        let mut rowspan = 1usize;
        if attr.get("multirow").map(String::as_str) == Some("3") {
            let mut j = i + used_cols;
            while j < cell_attrs.len() {
                if cell_attrs
                    .get(j)
                    .and_then(|a| a.get("multirow"))
                    .map(String::as_str)
                    == Some("4")
                {
                    rowspan += 1;
                    j += used_cols;
                } else {
                    break;
                }
            }
        }
        let mut styles = Vec::new();
        let mut classes = Vec::new();
        let decimal_col = is_decimal_col(c);
        let point = decimal_point_of(c);
        let cell = cells.get(i).copied();
        let plain = cell
            .map(|id| collect_visible_text(ctx.doc(), id))
            .unwrap_or_default();
        let has_decimal = decimal_col && plain.contains(&point);
        let align = if has_decimal {
            None
        } else {
            attr.get("alignment")
                .cloned()
                .or_else(|| col_attrs.get(c).and_then(|a| a.get("alignment").cloned()))
        };
        let valign = attr
            .get("valignment")
            .cloned()
            .or_else(|| col_attrs.get(c).and_then(|a| a.get("valignment").cloned()));
        let width = width_to_css(attr.get("width").map(String::as_str).or_else(|| {
            col_attrs
                .get(c)
                .and_then(|a| a.get("width"))
                .map(String::as_str)
        }));
        if let Some(a) = align.filter(|a| a != "decimal") {
            styles.push(format!("text-align: {a}"));
        } else if decimal_col && !has_decimal {
            styles.push("text-align: center".into());
        }
        if let Some(v) = valign {
            styles.push(format!("vertical-align: {v}"));
        }
        if !width.is_empty() {
            let w = escape_live_html(&width);
            styles.push(format!("width: {w}"));
            styles.push(format!("max-width: {w}"));
            styles.push("overflow-wrap: anywhere".into());
        }
        if let Some(pad) = row_space_css(
            row_attrs
                .get(row)
                .and_then(|a| a.get("topspace"))
                .map(String::as_str),
        ) {
            styles.push(format!("padding-top: {pad}"));
        }
        if let Some(pad) = row_space_css(
            row_attrs
                .get(row)
                .and_then(|a| a.get("bottomspace"))
                .map(String::as_str),
        ) {
            styles.push(format!("padding-bottom: {pad}"));
        }
        let bg = resolve_cell_bg(
            attr,
            row_attrs.get(row),
            col_attrs.get(c),
            row,
            odd_row_color,
            even_row_color,
            alt_start,
        );
        if let Some(bg) = bg {
            styles.push(format!("background-color: {}", escape_live_html(&bg)));
        }
        let color = escape_live_html(&line_color);
        let below = cell_attrs.get(i + rowspan * used_cols);
        let right = if c + span < used_cols {
            cell_attrs.get(i + span)
        } else {
            None
        };
        let above = if row > 0 {
            cell_attrs.get(i.saturating_sub(used_cols))
        } else {
            None
        };
        let left = if c > 0 { cell_attrs.get(i - 1) } else { None };
        let last_row = row + rowspan >= nrows;
        let heavy_top = booktabs && row == 0 && attr_true(attr, "topline");
        let heavy_bottom = booktabs && last_row && attr_true(attr, "bottomline");
        // LyX ignores vertical lines on booktabs tables (Tabular::leftLine/rightLine).
        let vline = |has: bool| !booktabs && has;
        let h_double = |upper: usize, lower: usize| {
            row_line_all(&cell_attrs, upper, used_cols, "bottomline")
                && row_line_all(&cell_attrs, lower, used_cols, "topline")
        };
        let top_on = attr_true(attr, "topline");
        let top_nb = above.is_some_and(|a| attr_true(a, "bottomline"));
        // Meeting short rules are one line, including when one trim is this
        // row's bottom and the next is the cell below-right's top (Table 2.15).
        let top_trim_l = attr_true(attr, "toplineltrim")
            && !(c > 0 && col_has_h_edge(&cell_attrs, used_cols, row, c - 1, true, row));
        let top_trim_r = attr_true(attr, "toplinertrim")
            && !(c + span < used_cols
                && col_has_h_edge(&cell_attrs, used_cols, row, c + span, true, row));
        push_box_edge(
            &mut styles,
            &mut classes,
            "top",
            top_on,
            top_nb,
            heavy_top,
            top_trim_l,
            top_trim_r,
            &color,
            top_on && top_nb && row > 0 && h_double(row - 1, row),
        );
        let bot_on = attr_true(attr, "bottomline");
        let bot_nb = below.is_some_and(|a| attr_true(a, "topline"));
        let below_row = row + rowspan;
        let bot_trim_l = attr_true(attr, "bottomlineltrim")
            && !(c > 0 && col_has_h_edge(&cell_attrs, used_cols, row, c - 1, false, below_row));
        let bot_trim_r = attr_true(attr, "bottomlinertrim")
            && !(c + span < used_cols
                && col_has_h_edge(&cell_attrs, used_cols, row, c + span, false, below_row));
        push_box_edge(
            &mut styles,
            &mut classes,
            "bottom",
            bot_on,
            bot_nb,
            heavy_bottom,
            bot_trim_l,
            bot_trim_r,
            &color,
            bot_on && bot_nb && h_double(row + rowspan - 1, row + rowspan),
        );
        let left_on = vline(attr_true(attr, "leftline"));
        let left_nb = left.is_some_and(|a| vline(attr_true(a, "rightline")));
        // A multicolumn dummy stores the span's right line. That is this
        // cell's left edge, not a second parallel line (LyX
        // Tabular::interColumnSpace uses the visible cell's rightLine).
        let left_double = left_on
            && left_nb
            && left.is_some_and(|a| a.get("multicolumn").map(String::as_str) != Some("2"));
        push_box_edge(
            &mut styles,
            &mut classes,
            "left",
            left_on,
            left_nb,
            false,
            false,
            false,
            &color,
            left_double,
        );
        let right_on = vline(attr_true(attr, "rightline"));
        let right_nb = right.is_some_and(|a| vline(attr_true(a, "leftline")));
        push_box_edge(
            &mut styles,
            &mut classes,
            "right",
            right_on,
            right_nb,
            false,
            false,
            false,
            &color,
            right_on && right_nb,
        );
        let style = if styles.is_empty() {
            String::new()
        } else {
            format!(r#" style="{}""#, styles.join("; "))
        };
        let class_attr = if classes.is_empty() {
            String::new()
        } else {
            format!(r#" class="{}""#, classes.join(" "))
        };
        let span_attr = if span > 1 {
            format!(r#" colspan="{span}""#)
        } else {
            String::new()
        };
        let row_attr = if rowspan > 1 {
            format!(r#" rowspan="{rowspan}""#)
        } else {
            String::new()
        };
        let nested = cell
            .map(|id| flatten_flow(ctx.doc(), &ctx.doc().node(id).children, 0))
            .unwrap_or_default();
        let first = nested.first();
        let td_selector = if let (Some(first), Some(cell)) = (first, cell) {
            mapping::cell_layout_selector(ctx, block, cell, first.node, &first.layout)
        } else if let Some(cell) = cell {
            format!(
                "{} {} layout[Plain Layout]",
                inset_owner_selector(ctx, block),
                mapping::scoped_nth_match(
                    "inset",
                    "Text",
                    cell,
                    &mapping::descendant_insets_named(ctx.doc(), block, "Text")
                )
            )
        } else {
            ctx.current_inset_selector
                .clone()
                .unwrap_or_else(|| "inset[Tabular]".into())
        };
        let id = take_owner_id(ctx, None);
        emit_token(ctx, &id, &td_selector);
        let mut inner = cell
            .map(|cell| render_cell(cell, parent_state, ctx, block))
            .unwrap_or_default();
        if has_decimal {
            let (left_ch, right_ch) = decimal_widths[c];
            inner = wrap_decimal_inner(&inner, &plain, &point, left_ch, right_ch);
        }
        html.push_str(&format!(
            "<td{span_attr}{row_attr}{class_attr}{style}{}>{inner}</td>",
            mapping_attrs(&id)
        ));
        c += span;
        if c >= used_cols {
            html.push_str("</tr>");
            c = 0;
        }
    }
    if c > 0 {
        html.push_str("</tr>");
    }
    html.push_str("</tbody></table>");
    if !is_long {
        // LyX pins the first/last table line to the surrounding text baseline
        // (Tabular::offsetVAlignment). CSS top/middle/bottom on <table> does
        // nothing when the tables are the same height. The wrapper is the
        // inline box; CSS pins its baseline. Top needs a 0-height strut so
        // that baseline sits at the top of the table, not the bottom.
        let strut = if table_valign == "top" {
            r#"<span class="lyx-tabular-strut"></span>"#
        } else {
            ""
        };
        html =
            format!(r#"<span class="lyx-tabular lyx-tabular-{table_valign}">{strut}{html}</span>"#);
    }
    ctx.longtable_number = prev_lt;
    html
}

fn resolve_cell_bg(
    cell: &HashMap<String, String>,
    row: Option<&HashMap<String, String>>,
    col: Option<&HashMap<String, String>>,
    row_idx: usize,
    odd_row_color: &str,
    even_row_color: &str,
    alt_start: i32,
) -> Option<String> {
    if let Some(c) = cell.get("color").and_then(|n| lyx_paint_color(n)) {
        return Some(c);
    }
    if let Some(c) = row
        .and_then(|r| r.get("color"))
        .and_then(|n| lyx_paint_color(n))
    {
        return Some(c);
    }
    if let Some(c) = col
        .and_then(|r| r.get("color"))
        .and_then(|n| lyx_paint_color(n))
    {
        return Some(c);
    }
    let real = (row_idx as i32) + 1;
    if alt_start <= real {
        let name = if real % 2 == 0 {
            even_row_color
        } else {
            odd_row_color
        };
        return lyx_paint_color(name);
    }
    None
}

#[allow(clippy::too_many_arguments)]
fn push_box_edge(
    styles: &mut Vec<String>,
    classes: &mut Vec<String>,
    side: &str,
    on: bool,
    neighbor_on: bool,
    heavy: bool,
    trim_l: bool,
    trim_r: bool,
    color: &str,
    double: bool,
) {
    if (trim_l || trim_r) && on && (side == "top" || side == "bottom") {
        // Real border so the line shares the collapsed edge; CSS covers 10px.
        let thick = if heavy { "2px" } else { "1px" };
        styles.push(format!("border-{side}: {thick} solid {color}"));
        classes.push(format!("lyx-trim-{side}"));
        if trim_l {
            classes.push("lyx-trim-l".into());
        }
        if trim_r {
            classes.push("lyx-trim-r".into());
        }
        return;
    }
    if double {
        styles.push(format!("border-{side}: 3px double {color}"));
    } else if on && heavy {
        styles.push(format!("border-{side}: 2px solid {color}"));
    } else if on {
        styles.push(format!("border-{side}: 1px solid {color}"));
    } else if neighbor_on {
        styles.push(format!("border-{side}: none"));
    } else {
        styles.push(format!("border-{side}: 1px dashed #b0c4de"));
    }
}

fn wrap_decimal_inner(
    inner: &str,
    plain: &str,
    point: &str,
    left_ch: usize,
    right_ch: usize,
) -> String {
    let Some(pos) = plain.find(point) else {
        return inner.to_string();
    };
    let Some(at) = inner.find(plain) else {
        return inner.to_string();
    };
    format!(
        r#"{}<span class="decimal-int" style="min-width: {left_ch}ch">{}</span><span class="decimal-frac" style="min-width: {right_ch}ch">{}</span>{}"#,
        &inner[..at],
        escape_live_html(&plain[..pos]),
        escape_live_html(&plain[pos..]),
        &inner[at + plain.len()..]
    )
}

fn attr_after<'a>(meta: &'a str, key: &str) -> Option<&'a str> {
    let start = meta.find(key)? + key.len();
    let rest = &meta[start..];
    rest.split('"').next()
}

fn find_tags(meta: &str, tag: &str) -> Vec<String> {
    let mut out = Vec::new();
    let open = format!("<{tag}");
    let mut rest = meta;
    while let Some(pos) = rest.find(&open) {
        let after = &rest[pos + open.len()..];
        if let Some(end) = after.find('>') {
            out.push(after[..end].to_string());
            rest = &after[end + 1..];
        } else {
            break;
        }
    }
    out
}

fn render_cell(
    block: NodeId,
    parent_state: &TraversalState,
    ctx: &mut RenderCtx<'_>,
    tabular: NodeId,
) -> String {
    let nested = flatten_flow(ctx.doc(), &ctx.doc().node(block).children, 0);
    if nested.is_empty() {
        let children = ctx.doc().node(block).children.clone();
        let mut state = enter_traversal_state(parent_state);
        return render_children(&children, &mut state, ctx);
    }
    // Several layouts in one cell stack as in the LyX window, not as inline spans.
    let stack = nested.len() > 1;
    nested
        .iter()
        .map(|item| {
            with_cell_layout(ctx, tabular, block, item, |ctx, selector| {
                let id = take_owner_id(ctx, None);
                emit_token(ctx, &id, selector);
                let inner = render_layout_inline(item.node, ctx, false, Some(parent_state));
                let extra = if stack {
                    r#" style="display:block""#
                } else {
                    ""
                };
                format!("<span{extra}{}>{inner}</span>", mapping_attrs(&id))
            })
        })
        .collect()
}

fn render_flex_inline(block: NodeId, ctx: &mut RenderCtx<'_>) -> String {
    let nested = flatten_flow(ctx.doc(), &ctx.doc().node(block).children, 0);
    if nested.is_empty() {
        return escape_live_html(&collect_visible_text(ctx.doc(), block));
    }
    nested
        .iter()
        .map(|item| {
            with_flex_layout(ctx, block, item, |ctx, selector| {
                let id = take_owner_id(ctx, None);
                emit_token(ctx, &id, selector);
                format!(
                    "<span{}>{}</span>",
                    mapping_attrs(&id),
                    render_layout_inline(item.node, ctx, false, None)
                )
            })
        })
        .collect()
}

fn render_box(
    block: NodeId,
    kind: &str,
    parent_state: &TraversalState,
    ctx: &mut RenderCtx<'_>,
) -> String {
    let variant = kind["Box ".len()..].trim();
    let variant = if variant.is_empty() { "Boxed" } else { variant };
    let width = width_to_css(find_property(ctx.doc(), block, "width").as_deref());
    let style = if width.is_empty() {
        String::new()
    } else {
        format!(r#" style="width: {}""#, escape_live_html(&width))
    };
    let full = if width == "100%" { " box-full" } else { "" };
    let inner = render_inset_layouts(block, parent_state, ctx);
    let box_html = format!(
        r#"<div class="{}"{style}>{inner}</div>"#,
        escape_live_html(variant)
    );
    wrap_disclosure(
        ctx,
        &format!("box {}{full}", layout_slug(variant)),
        "Box",
        &box_html,
        None,
    )
}

fn render_info(block: NodeId, ctx: &mut RenderCtx<'_>) -> String {
    let type_ = find_property(ctx.doc(), block, "type")
        .unwrap_or_default()
        .to_ascii_lowercase();
    let arg = find_property(ctx.doc(), block, "arg")
        .unwrap_or_else(|| collect_visible_text(ctx.doc(), block));
    if type_ == "icon" {
        if arg.is_empty() {
            return String::new();
        }
        if ctx.icon_aliases.is_none() {
            ctx.icon_aliases = Some(match ctx.system_images_dir.as_deref() {
                Some(dir) => graphics::load_icon_aliases(dir, Some(&mut ctx.warnings)),
                None => Vec::new(),
            });
        }
        let aliases = ctx.icon_aliases.as_deref().unwrap_or(&[]);
        let src = graphics::resolve_info_icon_data_uri(
            &arg,
            ctx.system_images_dir.as_deref(),
            ctx.magick_path.as_deref(),
            aliases,
            &mut ctx.icon_uri_memo,
        );
        let file_name = graphics::resolved_info_icon_name(
            &arg,
            ctx.system_images_dir.as_deref(),
            Some(&mut ctx.warnings),
        );
        let a = escape_live_html(&arg);
        let file = escape_live_html(&file_name);
        if let Some(src) = src {
            return format!(
                r#"<img class="info-icon" src="{src}" alt="{a}" title="{a}" aria-label="{a}" data-info-icon="{a}" data-info-file="{file}"/>"#
            );
        }
        return format!(
            r#"<span class="info-icon" title="{a}" role="img" aria-label="{a}" data-info-file="{file}">▣</span>"#
        );
    }
    if type_ == "shortcut" || type_ == "shortcuts" {
        if arg.is_empty() {
            return String::new();
        }
        let resolved = lookup_shortcut(ctx.shortcuts.as_ref(), &arg, type_ == "shortcuts");
        let body = resolved.as_deref().unwrap_or(&arg);
        let title = if resolved.is_some() {
            arg.as_str()
        } else {
            "LFUN"
        };
        let cls = if type_ == "shortcuts" {
            "shortcuts"
        } else {
            "shortcut"
        };
        return format!(
            r#"<kbd class="{cls}" title="{}">{}</kbd>"#,
            escape_live_html(title),
            escape_live_html(body)
        );
    }
    if arg.is_empty() {
        String::new()
    } else {
        format!(r#"<span class="info">{}</span>"#, escape_live_html(&arg))
    }
}

fn caption_type_from_kind(kind: &str) -> String {
    if !kind.starts_with("Caption") {
        return "Standard".into();
    }
    let rest = kind["Caption".len()..].trim();
    if rest.is_empty() {
        "Standard".into()
    } else {
        rest.to_string()
    }
}

pub(crate) fn caption_blocks(ast: &Document, root: NodeId) -> Vec<NodeId> {
    collect_blocks(
        ast,
        root,
        |ast, id| {
            matches!(&ast.node(id).kind, NodeKind::Block { tag, .. } if tag == "inset")
                && inset_kind(ast, id).starts_with("Caption")
        },
        None,
    )
}

fn is_nested_captionable(ast: &Document, id: NodeId) -> bool {
    matches!(&ast.node(id).kind, NodeKind::Block { tag, .. } if tag == "inset") && {
        let k = inset_kind(ast, id);
        k.starts_with("Float ") || k.starts_with("Wrap ")
    }
}

pub(crate) fn float_own_captions(ast: &Document, root: NodeId) -> Vec<NodeId> {
    collect_blocks(
        ast,
        root,
        |ast, id| {
            matches!(&ast.node(id).kind, NodeKind::Block { tag, .. } if tag == "inset")
                && inset_kind(ast, id).starts_with("Caption")
        },
        Some(&is_nested_captionable),
    )
}

pub(crate) fn captions_are_unnumbered(ast: &Document, captions: &[NodeId]) -> bool {
    !captions.is_empty()
        && captions
            .iter()
            .all(|&c| caption_type_from_kind(&inset_kind(ast, c)) == "Unnumbered")
}

fn caption_class_attr(ast: &Document, captions: &[NodeId]) -> String {
    let Some(&first) = captions.first() else {
        return String::new();
    };
    let type_ = caption_type_from_kind(&inset_kind(ast, first));
    format!(r#" class="float-caption-{}""#, escape_live_html(&type_))
}

pub(crate) fn float_nameref_prefix(variant: &str) -> String {
    let v = variant.to_ascii_lowercase();
    match v.as_str() {
        "table" => "Table".into(),
        "algorithm" => "Algorithm".into(),
        "listing" => "Listing".into(),
        "figure" | "" => "Figure".into(),
        _ => {
            let mut c = variant.chars();
            match c.next() {
                Some(f) => format!("{}{}", f.to_uppercase(), c.as_str()),
                None => "Figure".into(),
            }
        }
    }
}

pub(crate) fn subfloat_nameref_prefix(variant: &str) -> String {
    let v = variant.to_ascii_lowercase();
    match v.as_str() {
        "table" => "Subtable".into(),
        "figure" | "" => "Subfigure".into(),
        "algorithm" => "Sub-Algorithm".into(),
        _ => format!("Sub-{}", float_nameref_prefix(variant)),
    }
}

fn float_caption_prefix(variant: &str, num: Option<&str>) -> String {
    let Some(num) = num else {
        return String::new();
    };
    format!("{} {num}: ", float_nameref_prefix(variant))
}

fn longtable_caption_prefix_html(ctx: &RenderCtx<'_>, caption_type: &str) -> String {
    if caption_type == "Unnumbered" {
        return String::new();
    }
    let prefix = float_caption_prefix("table", ctx.longtable_number.as_deref());
    if prefix.is_empty() {
        return String::new();
    }
    format!(
        r#"<span class="float-caption-prefix">{}</span>"#,
        escape_live_html(&prefix)
    )
}

fn subfloat_caption_prefix(variant: &str, num: Option<&str>) -> String {
    let Some(num) = num else {
        return String::new();
    };
    format!("{} {num}: ", subfloat_nameref_prefix(variant))
}

pub(crate) fn take_float_number(
    ctx: &mut RenderCtx<'_>,
    variant: &str,
    deleted: bool,
) -> Option<String> {
    let n = match variant {
        "figure" => {
            let n = ctx.figure + 1;
            if !deleted {
                ctx.figure = n;
            }
            n
        }
        "table" => {
            let n = ctx.table + 1;
            if !deleted {
                ctx.table = n;
            }
            n
        }
        "algorithm" => {
            let n = ctx.algorithm + 1;
            if !deleted {
                ctx.algorithm = n;
            }
            n
        }
        "listing" => {
            let n = ctx.listing + 1;
            if !deleted {
                ctx.listing = n;
            }
            n
        }
        _ => return None,
    };
    Some(if ctx.chapter_label.is_empty() {
        n.to_string()
    } else {
        format!("{}.{}", ctx.chapter_label, n)
    })
}

pub(crate) fn take_generic_float_number(
    ctx: &mut RenderCtx<'_>,
    variant: &str,
    deleted: bool,
) -> String {
    let n = ctx.float_type_counts.get(variant).copied().unwrap_or(0) + 1;
    if !deleted {
        ctx.float_type_counts.insert(variant.to_string(), n);
    }
    if ctx.chapter_label.is_empty() {
        n.to_string()
    } else {
        format!("{}.{}", ctx.chapter_label, n)
    }
}

pub(crate) fn take_sub_float_number(
    ctx: &mut RenderCtx<'_>,
    variant: &str,
    deleted: bool,
) -> String {
    let n = ctx.sub_float_counts.get(variant).copied().unwrap_or(0) + 1;
    if !deleted {
        ctx.sub_float_counts.insert(variant.to_string(), n);
    }
    flow_mod::alphabetic_lower(n)
}

pub(crate) fn listing_takes_number(ast: &Document, block: NodeId) -> bool {
    if find_property(ast, block, "inline")
        .unwrap_or_default()
        .eq_ignore_ascii_case("true")
    {
        return false;
    }
    let captions = caption_blocks(ast, block);
    if captions.is_empty() {
        return false;
    }
    !captions_are_unnumbered(ast, &captions)
}

pub(crate) fn include_is_listings(ast: &Document, block: NodeId) -> bool {
    let command = find_property(ast, block, "LatexCommand")
        .unwrap_or_default()
        .to_ascii_lowercase();
    command.contains("lstinput") || command.contains("inputminted")
}

pub(crate) fn note_float_list_entry(
    ctx: &mut RenderCtx<'_>,
    float_block: NodeId,
    variant: &str,
    number: Option<&str>,
    nested: bool,
) -> bool {
    let Some(number) = number else {
        return false;
    };
    let captions = float_own_captions(ctx.doc(), float_block);
    if captions_are_unnumbered(ctx.doc(), &captions) {
        return false;
    }
    let text = captions
        .iter()
        .map(|&c| collect_visible_text(ctx.doc(), c))
        .collect::<Vec<_>>()
        .join(" ");
    let text = text.split_whitespace().collect::<Vec<_>>().join(" ");
    let parent = ctx.float_number_stack.last().cloned();
    let id = if nested {
        if let Some(p) = parent {
            format!(
                "float-{}-{}-{}",
                layout_slug(variant),
                p.replace('.', "-"),
                number.replace('.', "-")
            )
        } else {
            format!(
                "float-{}-{}",
                layout_slug(variant),
                number.replace('.', "-")
            )
        }
    } else {
        format!(
            "float-{}-{}",
            layout_slug(variant),
            number.replace('.', "-")
        )
    };
    let entry = FloatListEntry {
        type_: variant.to_string(),
        number: number.to_string(),
        text,
        id,
        children: None,
    };
    if nested {
        if let Some(owner) = ctx.float_stack.last_mut() {
            owner
                .children
                .get_or_insert_with(Vec::new)
                .push(entry.clone());
        }
    } else {
        ctx.float_list_entries.push(entry.clone());
    }
    ctx.float_stack.push(entry);
    true
}

pub(crate) fn pop_float_list_entry(ctx: &mut RenderCtx<'_>, nested: bool) {
    let Some(done) = ctx.float_stack.pop() else {
        return;
    };
    if nested {
        if let Some(parent) = ctx.float_stack.last_mut()
            && let Some(kids) = parent.children.as_mut()
            && let Some(last) = kids.last_mut()
        {
            last.children = done.children;
        }
    } else if let Some(last) = ctx.float_list_entries.last_mut() {
        last.children = done.children;
    }
}

fn render_caption_inline(
    block: NodeId,
    ctx: &mut RenderCtx<'_>,
    parent_state: Option<&TraversalState>,
) -> String {
    let owner = ctx.current_inset_node;
    let nested = flatten_flow(ctx.doc(), &ctx.doc().node(block).children, 0);
    if nested.is_empty() {
        let children = ctx.doc().node(block).children.clone();
        let mut state = parent_state
            .map(enter_traversal_state)
            .unwrap_or_else(create_traversal_state);
        return render_children(&children, &mut state, ctx);
    }
    let Some(owner) = owner else {
        return nested
            .iter()
            .map(|item| render_layout_inline(item.node, ctx, false, parent_state))
            .collect();
    };
    nested
        .iter()
        .map(|item| {
            with_caption_layout(ctx, owner, block, item, |ctx, selector| {
                let id = take_owner_id(ctx, None);
                emit_token(ctx, &id, selector);
                let inner = render_layout_inline(item.node, ctx, false, parent_state);
                format!("<span{}>{inner}</span>", mapping_attrs(&id))
            })
        })
        .collect()
}

fn render_captioned_float(
    block: NodeId,
    variant: &str,
    ctx: &mut RenderCtx<'_>,
    parent_state: Option<&TraversalState>,
    nested: bool,
) -> String {
    let all_captions = float_own_captions(ctx.doc(), block);
    let numbered = !captions_are_unnumbered(ctx.doc(), &all_captions);
    let deleted = parent_state
        .map(|s| s.deleted_depth > 0 || s.outer_deleted_depth > 0)
        .unwrap_or(false);
    if !nested {
        ctx.sub_float_counts.insert(variant.to_string(), 0);
    }
    let num = if numbered {
        Some(if nested {
            take_sub_float_number(ctx, variant, deleted)
        } else {
            take_float_number(ctx, variant, deleted)
                .unwrap_or_else(|| take_generic_float_number(ctx, variant, deleted))
        })
    } else {
        None
    };
    let prefix = if numbered {
        if nested {
            subfloat_caption_prefix(variant, num.as_deref())
        } else {
            float_caption_prefix(variant, num.as_deref())
        }
    } else {
        String::new()
    };
    let parent = ctx.float_number_stack.last().cloned();
    let id_core = if nested {
        match (parent, num.as_deref()) {
            (Some(p), Some(n)) => Some(format!("{p}-{n}")),
            _ => None,
        }
    } else {
        num.clone()
    };
    let id_attr = id_core
        .as_ref()
        .map(|id| {
            format!(
                r#" id="float-{}-{}""#,
                layout_slug(variant),
                id.replace('.', "-")
            )
        })
        .unwrap_or_default();
    let cls = if nested {
        format!("float-{} subfloat", layout_slug(variant))
    } else {
        format!("float-{}", layout_slug(variant))
    };
    if let Some(core) = &id_core {
        ctx.float_number_stack.push(core.replace('.', "-"));
    }
    let mut html = format!(r#"<figure class="{cls}"{id_attr}>"#);
    let items = flatten_flow(ctx.doc(), &ctx.doc().node(block).children, 0);
    for item in &items {
        let captions = float_own_captions(ctx.doc(), item.node);
        if !captions.is_empty() {
            let cap = captions
                .iter()
                .map(|&c| render_caption_inline(c, ctx, parent_state))
                .collect::<String>();
            let use_prefix = if !prefix.is_empty() && !html.contains("<figcaption") {
                format!(
                    r#"<span class="float-caption-prefix">{}</span>"#,
                    escape_live_html(&prefix)
                )
            } else {
                String::new()
            };
            html.push_str(&format!(
                "<figcaption{}>{use_prefix}{cap}</figcaption>",
                caption_class_attr(ctx.doc(), &captions)
            ));
            continue;
        }
        html.push_str(&with_layout(ctx, item, |ctx, selector| {
            let body_id = take_owner_id(ctx, None);
            emit_token(ctx, &body_id, selector);
            let inner = render_layout_inline(item.node, ctx, false, parent_state);
            format!(
                r#"<div class="float-body"{}>{inner}</div>"#,
                mapping_attrs(&body_id)
            )
        }));
    }
    if id_core.is_some() {
        ctx.float_number_stack.pop();
    }
    html.push_str("</figure>");
    html
}

fn float_type_label(kind: &str, variant: &str) -> String {
    let v = variant.trim();
    let v = if v.is_empty() { "figure" } else { v };
    let mut chars = v.chars();
    let pretty = match chars.next() {
        Some(f) => format!("{}{}", f.to_uppercase(), chars.as_str()),
        None => "Figure".into(),
    };
    format!("{kind}: {pretty}")
}

fn render_float(
    block: NodeId,
    kind: &str,
    parent_state: &TraversalState,
    ctx: &mut RenderCtx<'_>,
) -> String {
    let variant = kind["Float ".len()..].trim();
    let variant = if variant.is_empty() {
        "figure"
    } else {
        variant
    };
    let nested = ctx.in_float;
    let prev = ctx.in_float;
    ctx.in_float = true;
    let figure = render_captioned_float(block, variant, ctx, Some(parent_state), nested);
    ctx.in_float = prev;
    let pretty = float_nameref_prefix(variant);
    let label = if nested {
        format!("Subfloat: {pretty}")
    } else {
        float_type_label("Float", variant)
    };
    let cls = if nested {
        format!("float float-{} subfloat", layout_slug(variant))
    } else {
        format!("float float-{}", layout_slug(variant))
    };
    wrap_disclosure(ctx, &cls, &label, &figure, None)
}

fn render_wrap(block: NodeId, parent_state: &TraversalState, ctx: &mut RenderCtx<'_>) -> String {
    let width = {
        let w = width_to_css(find_property(ctx.doc(), block, "width").as_deref());
        if w.is_empty() { "50%".into() } else { w }
    };
    let placement = find_property(ctx.doc(), block, "placement")
        .unwrap_or_default()
        .to_ascii_lowercase();
    let side = if placement == "l" || placement == "i" {
        "left"
    } else {
        "right"
    };
    let variant = {
        let k = inset_kind(ctx.doc(), block);
        let v = k["Wrap ".len()..].trim();
        if v.is_empty() {
            "figure".into()
        } else {
            v.to_string()
        }
    };
    let nested = ctx.in_float;
    let prev_wrap = ctx.in_wrap;
    let prev_float = ctx.in_float;
    ctx.in_wrap = true;
    ctx.in_float = true;
    let inner = render_captioned_float(block, &variant, ctx, Some(parent_state), nested);
    ctx.in_wrap = prev_wrap;
    ctx.in_float = prev_float;
    let wrap = format!(
        r#"<div class="wrap wrap-{side}" style="width: {}">{inner}</div>"#,
        escape_live_html(&width)
    );
    let style = format!(r#" style="--wrap-width: {}""#, escape_live_html(&width));
    wrap_disclosure_attrs(
        ctx,
        &format!("wrap wrap-{side} wrap-{}", layout_slug(&variant)),
        &float_type_label("Wrap", &variant),
        &wrap,
        None,
        &style,
    )
}

pub(crate) fn listing_param(params: &str, key: &str) -> String {
    let lower = params.to_ascii_lowercase();
    let key_l = key.to_ascii_lowercase();
    let Some(pos) = lower.find(&key_l) else {
        return String::new();
    };
    let after = &params[pos + key.len()..];
    let after = after.trim_start_matches(|c: char| c.is_whitespace() || c == '=');
    if let Some(rest) = after.strip_prefix('{') {
        return rest.split('}').next().unwrap_or("").trim().to_string();
    }
    after.split(',').next().unwrap_or("").trim().to_string()
}

fn listing_language(params: &str) -> String {
    let raw = listing_param(params, "language");
    if let Some(inner) = raw.strip_prefix('[')
        && let Some(end) = inner.find(']')
    {
        let dialect = &inner[end + 1..];
        let first = &inner[..end];
        return if dialect.is_empty() {
            first.trim().to_string()
        } else {
            dialect.trim().to_string()
        };
    }
    raw.trim().to_string()
}

fn listing_line_text(ast: &Document, layout: NodeId) -> String {
    let mut line = String::new();
    listing_line_walk(ast, layout, &mut line);
    line.trim_end().to_string()
}

fn listing_line_walk(ast: &Document, id: NodeId, line: &mut String) {
    for &c in &ast.node(id).children {
        match &ast.node(c).kind {
            NodeKind::Text { text } => line.push_str(text),
            NodeKind::Property { key, .. } if key == "backslash" => line.push('\\'),
            NodeKind::Block { tag, args, .. } => {
                if tag == "inset" && args.as_deref().unwrap_or("").trim().starts_with("Caption") {
                    continue;
                }
                listing_line_walk(ast, c, line);
            }
            _ => {}
        }
    }
}

fn render_listings(
    block: NodeId,
    parent_state: &TraversalState,
    ctx: &mut RenderCtx<'_>,
) -> String {
    let params = find_property(ctx.doc(), block, "lstparams").unwrap_or_default();
    let lang = listing_language(&params);
    let inline = find_property(ctx.doc(), block, "inline")
        .unwrap_or_default()
        .eq_ignore_ascii_case("true");
    let captions = caption_blocks(ctx.doc(), block);
    let caption_html = captions
        .iter()
        .map(|&c| render_caption_inline(c, ctx, Some(parent_state)))
        .collect::<String>();
    let cls = if lang.is_empty() {
        "listings".into()
    } else {
        format!("listings {}", escape_live_html(&lang))
    };
    let mut lines = Vec::new();
    let items = flatten_flow(ctx.doc(), &ctx.doc().node(block).children, 0);
    for item in &items {
        let only_caption = !collect_blocks(
            ctx.doc(),
            item.node,
            |ast, id| {
                matches!(&ast.node(id).kind, NodeKind::Block { tag, .. } if tag == "inset")
                    && inset_kind(ast, id).starts_with("Caption")
            },
            None,
        )
        .is_empty()
            && listing_line_text(ctx.doc(), item.node).trim().is_empty();
        if only_caption {
            continue;
        }
        lines.push(with_layout(ctx, item, |ctx, selector| {
            let id = take_owner_id(ctx, None);
            emit_token(ctx, &id, selector);
            format!(
                "<span{}>{}</span>",
                mapping_attrs(&id),
                escape_live_html(&listing_line_text(ctx.doc(), item.node))
            )
        }));
    }
    let code = format!(r#"<code class="{cls}">{}</code>"#, lines.join("\n"));
    if inline {
        return code;
    }
    let mut html = String::from(r#"<div class="float-listings">"#);
    if !caption_html.is_empty() {
        let deleted = parent_state.deleted_depth > 0 || parent_state.outer_deleted_depth > 0;
        let takes_number = {
            let inline_flag = find_property(ctx.doc(), block, "inline")
                .unwrap_or_default()
                .eq_ignore_ascii_case("true");
            let caps = caption_blocks(ctx.doc(), block);
            !inline_flag && !caps.is_empty() && !captions_are_unnumbered(ctx.doc(), &caps)
        };
        let prefix_raw = if takes_number {
            float_caption_prefix(
                "listing",
                take_float_number(ctx, "listing", deleted).as_deref(),
            )
        } else {
            String::new()
        };
        let prefix = if prefix_raw.is_empty() {
            String::new()
        } else {
            format!(
                r#"<span class="float-caption-prefix">{}</span>"#,
                escape_live_html(&prefix_raw)
            )
        };
        html.push_str(&format!(
            r#"<div class="listings-caption"{}>{prefix}{caption_html}</div>"#,
            caption_class_attr(ctx.doc(), &captions)
        ));
    }
    html.push_str(&format!("{code}</div>"));
    html
}

fn read_include_child(resolved: &Path, filename: &str, ctx: &mut RenderCtx<'_>) -> Option<String> {
    match read_text_file(resolved) {
        Ok(text) => Some(text),
        Err(TextReadError::NotUtf8) => {
            mapping::warn_once(
                ctx,
                &format!("Included file '{filename}' exists but is not valid UTF-8."),
            );
            None
        }
        Err(_) => {
            mapping::warn_once(ctx, &format!("Could not read included file '{filename}'."));
            None
        }
    }
}

fn render_include(block: NodeId, ctx: &mut RenderCtx<'_>) -> String {
    let filename = find_property(ctx.doc(), block, "filename").unwrap_or_default();
    if filename.is_empty() {
        return String::new();
    }
    let command = find_property(ctx.doc(), block, "LatexCommand")
        .unwrap_or_default()
        .to_ascii_lowercase();
    let listing = command.contains("verbatim") || command.contains("lstinput");
    let resolved = resolve_graphic_path(&filename, ctx);
    if listing {
        let Some(raw) = read_include_child(&resolved, &filename, ctx) else {
            return String::new();
        };
        let params = find_property(ctx.doc(), block, "lstparams").unwrap_or_default();
        let first: usize = listing_param(&params, "firstline").parse().unwrap_or(1);
        let last: usize = listing_param(&params, "lastline").parse().unwrap_or(0);
        let lines: Vec<&str> = raw.split('\n').map(|l| l.trim_end_matches('\r')).collect();
        let from = first.max(1) - 1;
        let to = if last > 0 {
            last.min(lines.len())
        } else {
            lines.len()
        };
        let slice = if from < to && from < lines.len() {
            &lines[from..to.min(lines.len())]
        } else {
            &[][..]
        };
        let body = escape_live_html(&slice.join("\n"));
        if !include_is_listings(ctx.doc(), block) {
            return format!(r#"<pre class="include">{body}</pre>"#);
        }
        let num = take_float_number(ctx, "listing", false);
        let caption = listing_param(&params, "caption");
        let label = listing_param(&params, "label");
        let lang = listing_language(&params);
        let cls = if lang.is_empty() {
            "listings".to_string()
        } else {
            format!("listings {}", escape_live_html(&lang))
        };
        let id = if label.is_empty() {
            String::new()
        } else {
            format!(r#" id="{}""#, escape_live_html(&xml_id(&label)))
        };
        let prefix_raw = float_caption_prefix("listing", num.as_deref());
        let prefix = if prefix_raw.is_empty() {
            String::new()
        } else {
            format!(
                r#"<span class="float-caption-prefix">{}</span>"#,
                escape_live_html(&prefix_raw)
            )
        };
        let mut html = format!(r#"<div class="float-listings"{id}>"#);
        if !prefix.is_empty() || !caption.is_empty() {
            html.push_str(&format!(
                r#"<div class="listings-caption">{prefix}{}</div>"#,
                escape_live_html(&caption)
            ));
        }
        html.push_str(&format!(
            r#"<pre class="include"><code class="{cls}">{body}</code></pre></div>"#
        ));
        return html;
    }
    let base = Path::new(&filename)
        .file_name()
        .and_then(|s| s.to_str())
        .unwrap_or(&filename);
    if !base.to_ascii_lowercase().ends_with(".lyx") {
        return String::new();
    }
    let resolved_s = resolved.to_string_lossy().into_owned();
    if ctx.include_stack.iter().any(|p| p == &resolved_s) {
        return String::new();
    }
    let Some(child_text) = read_include_child(&resolved, &filename, ctx) else {
        return String::new();
    };
    let Ok(child_ast) = parse(&child_text, false) else {
        mapping::warn_once(ctx, &format!("Could not parse included file '{filename}'."));
        return String::new();
    };
    let include_selector = ctx
        .current_inset_selector
        .clone()
        .unwrap_or_else(|| inset_owner_selector(ctx, block));
    let parent_file = ctx.foreign.as_ref().map(|f| f.file.clone()).or_else(|| {
        ctx.file_path
            .as_ref()
            .map(|p| p.to_string_lossy().into_owned())
    });
    let Some(parent_file) = parent_file else {
        return String::new();
    };
    let via = LiveTokenVia {
        file: parent_file,
        selector: include_selector,
    };
    let child_file = std::path::absolute(&resolved).unwrap_or(resolved.clone());
    let child_hash = hash_text(&child_text);
    let child_index = mapping::build_query_index(&child_ast, child_ast.root());
    ctx.include_stack.push(resolved_s);
    let prev_foreign = ctx.foreign.take();
    let prev_inset = ctx.current_inset_selector.take();
    let prev_inset_node = ctx.current_inset_node;
    let prev_layout = ctx.current_layout_selector.take();
    ctx.current_inset_node = None;
    ctx.foreign = Some(super::ForeignInclude {
        file: child_file.to_string_lossy().into_owned(),
        disk_hash: child_hash,
        via,
        query_index: child_index,
        ast: child_ast,
    });
    let body = find_body(ctx.doc());
    let items = flatten_flow(ctx.doc(), &body, 0);
    let html = flow::render_flow_items(&items, ctx, None);
    ctx.foreign = prev_foreign;
    ctx.current_inset_selector = prev_inset;
    ctx.current_inset_node = prev_inset_node;
    ctx.current_layout_selector = prev_layout;
    ctx.include_stack.pop();
    html
}

fn resolve_graphic_path(filename: &str, ctx: &RenderCtx<'_>) -> PathBuf {
    let mut tries = Vec::new();
    if let Some(f) = ctx.foreign.as_ref()
        && let Some(parent) = Path::new(&f.file).parent()
    {
        tries.push(join_resolved(parent, filename));
    }
    if let Some(p) = ctx.file_path.as_ref()
        && let Some(parent) = p.parent()
    {
        tries.push(join_resolved(parent, filename));
    }
    if let Some(dir) = ctx.system_doc_dir.as_ref() {
        tries.push(join_resolved(dir, filename));
    }
    for p in &tries {
        if p.is_file() {
            return p.clone();
        }
    }
    tries
        .into_iter()
        .next()
        .unwrap_or_else(|| PathBuf::from(filename))
}

/// Deno `path.resolve(dir, filename)`: split on `/` and `\` so Windows display
/// uses native separators (gold `data-filepath`).
fn join_resolved(dir: &Path, filename: &str) -> PathBuf {
    let rel = Path::new(filename);
    if rel.is_absolute() {
        return std::path::absolute(rel).unwrap_or_else(|_| rel.to_path_buf());
    }
    let mut p = dir.to_path_buf();
    for part in filename.split(['/', '\\']) {
        if part.is_empty() || part == "." {
            continue;
        }
        if part == ".." {
            p.pop();
        } else {
            p.push(part);
        }
    }
    std::path::absolute(&p).unwrap_or(p)
}

fn path_to_file_url(p: &Path) -> String {
    let s = encode_uri_path(&p.to_string_lossy().replace('\\', "/"));
    if s.starts_with('/') {
        format!("file://{s}")
    } else {
        format!("file:///{s}")
    }
}

/// Deno `@std/path` `toFileUrl`: `%` → `%25`, then `encodeURI`.
fn encode_uri_path(s: &str) -> String {
    let s = s.replace('%', "%25");
    let mut out = String::with_capacity(s.len());
    for ch in s.chars() {
        if matches!(
            ch,
            'A'..='Z'
                | 'a'..='z'
                | '0'..='9'
                | '-'
                | '_'
                | '.'
                | '!'
                | '~'
                | '*'
                | '\''
                | '('
                | ')'
                | ';'
                | '/'
                | '?'
                | ':'
                | '@'
                | '&'
                | '='
                | '+'
                | '$'
                | ','
                | '#'
        ) {
            out.push(ch);
        } else {
            let mut buf = [0u8; 4];
            let encoded = ch.encode_utf8(&mut buf);
            for b in encoded.as_bytes() {
                out.push_str(&format!("%{b:02X}"));
            }
        }
    }
    out
}

const WEB_IMAGE_EXTS: &[&str] = &["png", "jpg", "jpeg", "gif", "webp", "svg", "bmp"];

fn is_web_image(path: &Path) -> bool {
    path.extension()
        .and_then(|e| e.to_str())
        .is_some_and(|e| WEB_IMAGE_EXTS.iter().any(|x| x.eq_ignore_ascii_case(e)))
}

fn graphic_lyxscale(ast: &Document, block: NodeId) -> u32 {
    find_property(ast, block, "lyxscale")
        .and_then(|v| v.trim().parse::<u32>().ok())
        .filter(|&n| n > 0)
        .unwrap_or(100)
}

fn graphic_box_style(
    block: NodeId,
    ctx: &RenderCtx<'_>,
    displayed: Option<&Path>,
    rasterized: bool,
) -> String {
    if ctx.in_wrap {
        return r#" style="width: 100%""#.into();
    }
    let lyxscale = graphic_lyxscale(ctx.doc(), block);
    let Some(path) = displayed else {
        return String::new();
    };
    let Some(pixel_w) = graphics::png_pixel_width(path) else {
        return String::new();
    };
    let css_w = graphics::graphic_display_width_px(pixel_w, lyxscale, rasterized);
    format!(r#" style="width: {css_w}px""#)
}

fn graphics_owner_selector(
    ctx: &RenderCtx<'_>,
    block: NodeId,
    owner_parent: Option<NodeId>,
) -> String {
    let kind = inset_kind(ctx.doc(), block);
    if let Some(owner) = owner_parent {
        let ok = inset_kind(ctx.doc(), owner);
        if ok.starts_with("Float ") || ok.starts_with("Wrap ") {
            let pool = mapping::descendant_insets_named(ctx.doc(), owner, &kind);
            let part = mapping::scoped_nth_match("inset", &kind, block, &pool);
            return format!("{} {part}", inset_owner_selector(ctx, owner));
        }
    }
    inset_owner_selector(ctx, block)
}

fn render_graphics(block: NodeId, ctx: &mut RenderCtx<'_>, owner_parent: Option<NodeId>) -> String {
    let filename = find_property(ctx.doc(), block, "filename").unwrap_or_default();
    let base = Path::new(&filename)
        .file_name()
        .and_then(|s| s.to_str())
        .unwrap_or(&filename)
        .to_string();
    let mut src = String::new();
    let mut filepath = String::new();
    let mut rasterized = false;
    let mut displayed: Option<PathBuf> = None;
    if !filename.is_empty() {
        let path = resolve_graphic_path(&filename, ctx);
        filepath = path.to_string_lossy().into_owned();
        if path.is_file() && is_web_image(&path) {
            displayed = Some(path.clone());
        }
        if path.is_file() && !is_web_image(&path) {
            let key = path.to_string_lossy().into_owned();
            if let Some(hit) = ctx.preview_uri_memo.get(&key) {
                src = hit.clone();
                if let Some(p) = ctx.preview_path_memo.get(&key) {
                    filepath = p.clone();
                    displayed = Some(PathBuf::from(p));
                    rasterized = true;
                }
            } else if let Some(png) = graphics::ensure_raster_png(
                &path,
                ctx.magick_path.as_deref(),
                ctx.raster_dir.as_deref(),
            ) {
                src = path_to_file_url(&png);
                filepath = png.to_string_lossy().into_owned();
                displayed = Some(png.clone());
                rasterized = true;
                ctx.preview_uri_memo.insert(key.clone(), src.clone());
                ctx.preview_path_memo.insert(key, filepath.clone());
            }
        }
        if src.is_empty() {
            src = path_to_file_url(&path);
        }
    }
    let src_attr = if src.is_empty() {
        String::new()
    } else {
        format!(r#" src="{}""#, escape_live_html(&src))
    };
    let fp_attr = if !filepath.is_empty() && !src.starts_with("data:") {
        format!(r#" data-filepath="{}""#, escape_live_html(&filepath))
    } else {
        String::new()
    };
    let sel = graphics_owner_selector(ctx, block, owner_parent);
    let id = take_owner_id(ctx, None);
    emit_token(ctx, &id, &sel);
    format!(
        r#"<img{src_attr}{fp_attr}{}{} data-filename="{}" alt="{}">"#,
        graphic_box_style(block, ctx, displayed.as_deref(), rasterized),
        mapping_attrs(&id),
        escape_live_html(&base),
        escape_live_html(&base)
    )
}

fn last_name(part: &str) -> String {
    if part.contains(',') {
        return part.split(',').next().unwrap_or(part).trim().to_string();
    }
    part.split_whitespace().last().unwrap_or(part).to_string()
}

fn short_author(author: Option<&str>) -> String {
    let Some(author) = author else {
        return "Unknown".into();
    };
    let people: Vec<&str> = author.split(" and ").collect();
    let last = last_name(people.first().copied().unwrap_or(author));
    if people.len() > 1 {
        format!("{last} et al.")
    } else {
        last
    }
}

fn format_inline_cite(
    command: &str,
    keys: &[String],
    bib: &HashMap<String, crate::bib::Citation>,
) -> String {
    enum Part {
        Raw(String),
        Named { who: String, year: String },
    }
    let parts: Vec<Part> = keys
        .iter()
        .map(|key| {
            let Some(c) = bib.get(key) else {
                return Part::Raw(key.clone());
            };
            Part::Named {
                who: short_author(c.author.as_deref()),
                year: c.year.clone().unwrap_or_default(),
            }
        })
        .collect();
    let parenthetical = command == "citep" || command == "parencite" || command == "cite";
    if parenthetical {
        format!(
            "({})",
            parts
                .iter()
                .map(|p| match p {
                    Part::Raw(s) => s.clone(),
                    Part::Named { who, year } => format!("{who} {year}").trim().to_string(),
                })
                .collect::<Vec<_>>()
                .join("; ")
        )
    } else {
        parts
            .iter()
            .map(|p| match p {
                Part::Raw(s) => s.clone(),
                Part::Named { who, year } => format!("{who} ({year})"),
            })
            .collect::<Vec<_>>()
            .join("; ")
    }
}

fn render_toc(ctx: &RenderCtx<'_>) -> String {
    if ctx.outline.is_empty() {
        return String::new();
    }
    let items = &ctx.outline;
    let mut html = String::from(r#"<nav class="toc"><h2 class="toc">Contents</h2><ol>"#);
    let mut prev = items[0].level;
    for (i, e) in items.iter().enumerate() {
        if i > 0 {
            if e.level > prev {
                html.push_str("<ol>");
            } else if e.level == prev {
                html.push_str("</li>");
            } else {
                html.push_str("</li>");
                let mut l = prev;
                while l > e.level {
                    html.push_str("</ol></li>");
                    l -= 1;
                }
            }
        }
        let label = if e.number.is_empty() {
            e.text.clone()
        } else {
            format!("{} {}", e.number, e.text)
        };
        html.push_str(&format!(
            r##"<li><a href="#{}">{}</a>"##,
            escape_live_html(&e.id),
            escape_live_html(&label)
        ));
        prev = e.level;
    }
    html.push_str("</li>");
    let first = items[0].level;
    let last = items.last().expect("invariant: outline nonempty").level;
    let mut l = last;
    while l > first {
        html.push_str("</ol></li>");
        l -= 1;
    }
    html.push_str("</ol></nav>");
    html
}

fn render_bibliography(ctx: &RenderCtx<'_>) -> String {
    let cited_only = ctx.btprint == "btPrintCited";
    let raw: Vec<String> = if cited_only {
        ctx.cited_keys.iter().cloned().collect()
    } else {
        ctx.bib.keys().cloned().collect()
    };
    let items: Vec<String> = raw
        .into_iter()
        .filter(|k| ctx.bib.contains_key(k))
        .collect();
    if items.is_empty() {
        return String::new();
    }
    let title = ctx
        .layout_html
        .as_ref()
        .and_then(|h| h.get("Bibliography"))
        .and_then(|s| s.label_string.as_deref())
        .unwrap_or("References");
    let mut html = format!(
        r#"<div class="bibtex"><h2 class="bibtex">{}</h2>"#,
        escape_live_html(title)
    );
    for (i, key) in items.iter().enumerate() {
        let c = ctx.bib.get(key).expect("invariant: filtered");
        let body = format_bibliography_entry(c);
        let label = (i + 1).to_string();
        html.push_str(&format!(
            r##"<div class="bibtexentry" id="LyXCite-{}"><span class="bibtexlabel">{}</span><span class="bibtexinfo">{body}</span></div>"##,
            escape_live_html(&xml_id(key)),
            escape_live_html(&label)
        ));
    }
    html.push_str("</div>");
    html
}

fn render_command_inset(block: NodeId, kind: &str, ctx: &mut RenderCtx<'_>) -> String {
    let subtype = kind["CommandInset ".len()..].trim();
    let name = find_property(ctx.doc(), block, "name").unwrap_or_default();
    let key = find_property(ctx.doc(), block, "key").unwrap_or_default();
    let command =
        find_property(ctx.doc(), block, "LatexCommand").unwrap_or_else(|| subtype.to_string());
    let map_cmd = |ctx: &mut RenderCtx<'_>| -> String {
        let Some(sel) = ctx.current_inset_selector.clone() else {
            return String::new();
        };
        let id = take_owner_id(ctx, None);
        emit_token(ctx, &id, &sel);
        mapping_attrs(&id)
    };
    if subtype == "citation" {
        let keys: Vec<String> = (if key.is_empty() { &name } else { &key })
            .split(',')
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty())
            .collect();
        let map = map_cmd(ctx);
        return keys
            .iter()
            .enumerate()
            .map(|(i, k)| {
                let text = format_inline_cite(&command, std::slice::from_ref(k), &ctx.bib);
                let attrs = if i == 0 { map.as_str() } else { "" };
                format!(
                    r##"<a class="citation"{attrs} href="#LyXCite-{}">{}</a>"##,
                    escape_live_html(&xml_id(k)),
                    escape_live_html(&text)
                )
            })
            .collect::<Vec<_>>()
            .join("; ");
    }
    if matches!(
        subtype,
        "ref" | "pageref" | "formatted" | "eqref" | "nameref" | "vref" | "vpageref" | "labelonly"
    ) {
        let target = find_property(ctx.doc(), block, "reference").unwrap_or(name.clone());
        let id = xml_id(&target);
        let resolved = ctx.labels.get(&target).cloned();
        let named = ctx.label_titles.get(&target).cloned();
        let mut text = resolved.clone().unwrap_or_else(|| target.clone());
        if command == "eqref" || subtype == "eqref" {
            text = format!("({text})");
        } else if matches!(command.as_str(), "pageref" | "vpageref")
            || matches!(subtype, "pageref" | "vpageref")
        {
            text = resolved.unwrap_or(target.clone());
        } else if command == "nameref" || subtype == "nameref" {
            text = named.or(resolved).unwrap_or(target.clone());
        }
        let title = if matches!(command.as_str(), "pageref" | "vpageref")
            || matches!(subtype, "pageref" | "vpageref")
        {
            r#" title="page reference (Live shows target number/name, not a page)""#
        } else {
            ""
        };
        return format!(
            r##"<a class="ref"{} href="#{}"{title}>{}</a>"##,
            map_cmd(ctx),
            escape_live_html(&id),
            escape_live_html(&text)
        );
    }
    if subtype == "bibtex" {
        return render_bibliography(ctx);
    }
    if subtype == "toc" {
        return render_toc(ctx);
    }
    if subtype == "label" {
        if name.is_empty() {
            return String::new();
        }
        let preferred = xml_id(&name);
        if ctx.current_inset_selector.is_some() {
            let sel = ctx
                .current_inset_selector
                .clone()
                .expect("invariant: selector");
            let id = take_owner_id(ctx, Some(&preferred));
            emit_token(ctx, &id, &sel);
            return format!("<a{}></a>", mapping_attrs(&id));
        }
        return format!(r#"<a id="{}"></a>"#, escape_live_html(&preferred));
    }
    if subtype == "nomenclature_print" {
        return String::new();
    }
    if subtype == "index_print" {
        let title = find_property(ctx.doc(), block, "name").unwrap_or_else(|| "Index".into());
        return render_index(ctx, &title);
    }
    if subtype == "nomencl_print" {
        return render_nomenclature(ctx);
    }
    if subtype == "line" {
        return "<hr>".into();
    }
    if subtype == "href" {
        let target = find_property(ctx.doc(), block, "target").unwrap_or(name.clone());
        let label = if name.is_empty() { &target } else { &name };
        return format!(
            r#"<a class="href"{} href="{}">{}</a>"#,
            map_cmd(ctx),
            escape_live_html(&target),
            escape_live_html(label)
        );
    }
    if subtype == "include" {
        return render_include(block, ctx);
    }
    if subtype == "bibitem" {
        let label = find_property(ctx.doc(), block, "label").unwrap_or_default();
        let shown = if label.is_empty() {
            ctx.bibitem += 1;
            ctx.bibitem.to_string()
        } else {
            label
        };
        let id = xml_id(&key);
        let id_attr = if id.is_empty() {
            String::new()
        } else {
            format!(r##" id="LyXCite-{}""##, escape_live_html(&id))
        };
        return format!(
            r#"<a{id_attr}></a><span class="bibitemlabel">{}</span>"#,
            escape_live_html(&shown)
        );
    }
    let visible = if key.is_empty() { name } else { key };
    if visible.is_empty() {
        String::new()
    } else {
        format!(
            r#"<span class="command-inset">{}</span>"#,
            escape_live_html(&visible)
        )
    }
}

pub(crate) fn collect_nomencl_entry(block: NodeId, ctx: &mut RenderCtx<'_>) -> NomenclEntry {
    ctx.nomencl_seq += 1;
    let id = format!("nomencl-{}", ctx.nomencl_seq);
    let mut symbol = String::new();
    let mut desc = String::new();
    let mut prefix = String::new();
    collect_nomencl_walk(ctx.doc(), block, &mut symbol, &mut desc, &mut prefix);
    symbol = symbol.split_whitespace().collect::<Vec<_>>().join(" ");
    NomenclEntry {
        symbol,
        desc,
        sort: if prefix.is_empty() {
            String::new()
        } else {
            prefix
        },
        id,
    }
}

fn collect_nomencl_walk(
    ast: &Document,
    id: NodeId,
    symbol: &mut String,
    desc: &mut String,
    prefix: &mut String,
) {
    for &c in &ast.node(id).children {
        match &ast.node(c).kind {
            NodeKind::Text { text } => {
                if !mapping::is_status_line(text) {
                    symbol.push_str(text);
                }
            }
            NodeKind::Block { tag, args, .. } if tag == "inset" => {
                let kind = args.as_deref().unwrap_or("").trim();
                if let Some(name) = kind.strip_prefix("Argument ") {
                    let name = name.trim();
                    let text = mapping::nomencl_text(ast, c);
                    if name == "1" {
                        *prefix = text;
                    } else if name.starts_with("post:") {
                        *desc = text;
                    }
                    continue;
                }
                if kind == "ERT"
                    || is_invisible_inset(tag, args.as_deref())
                    || kind == "Index"
                    || kind.starts_with("Index ")
                    || kind.starts_with("IndexMacro")
                {
                    continue;
                }
                collect_nomencl_walk(ast, c, symbol, desc, prefix);
            }
            NodeKind::Block { .. } => collect_nomencl_walk(ast, c, symbol, desc, prefix),
            _ => {}
        }
    }
}

pub(crate) fn collect_index_entry(block: NodeId, ctx: &mut RenderCtx<'_>) -> super::IndexEntry {
    ctx.index_seq += 1;
    let id = format!("idx-{}", ctx.index_seq);
    let mut term = String::new();
    let mut terms = Vec::new();
    let mut see = String::new();
    let mut sort = String::new();
    collect_index_walk(ctx.doc(), block, &mut term, &mut terms, &mut see, &mut sort);
    let t = term.split_whitespace().collect::<Vec<_>>().join(" ");
    if !t.is_empty() {
        terms.push(t);
    }
    let sort = if sort.is_empty() {
        terms.join(", ")
    } else {
        sort
    };
    super::IndexEntry {
        terms,
        see,
        sort,
        id,
    }
}

fn collect_index_walk(
    ast: &Document,
    id: NodeId,
    term: &mut String,
    terms: &mut Vec<String>,
    see: &mut String,
    sort: &mut String,
) {
    let flush = |term: &mut String, terms: &mut Vec<String>| {
        let t = term.split_whitespace().collect::<Vec<_>>().join(" ");
        if !t.is_empty() {
            terms.push(t);
        }
        term.clear();
    };
    for &c in &ast.node(id).children {
        match &ast.node(c).kind {
            NodeKind::Property { key, value } if key == "SpecialChar" => {
                term.push_str(&mapping::special_char(value.as_deref().unwrap_or("")));
            }
            NodeKind::Text { text } => {
                if !mapping::is_status_line(text) {
                    term.push_str(&mapping::expand_special_in_text(text));
                }
            }
            NodeKind::Block { tag, args, .. } if tag == "inset" => {
                let kind = args.as_deref().unwrap_or("").trim();
                if kind.starts_with("IndexMacro") {
                    let text = mapping::nomencl_text(ast, c);
                    if kind.contains("subentry") {
                        flush(term, terms);
                        *term = text;
                        flush(term, terms);
                    } else if kind.contains("see") {
                        *see = text;
                    } else if kind.contains("sortkey") {
                        *sort = text;
                    }
                    continue;
                }
                if kind == "ERT"
                    || is_invisible_inset(tag, args.as_deref())
                    || mapping::is_omitted_inset_kind(kind)
                {
                    continue;
                }
                collect_index_walk(ast, c, term, terms, see, sort);
            }
            NodeKind::Block { .. } => collect_index_walk(ast, c, term, terms, see, sort),
            _ => {}
        }
    }
}

fn render_nomenclature(ctx: &RenderCtx<'_>) -> String {
    if ctx.nomencl.is_empty() {
        return String::new();
    }
    let mut items = ctx.nomencl.clone();
    items.sort_by(|a, b| a.sort.cmp(&b.sort));
    let mut html =
        String::from(r#"<div class="nomencl"><h2 class="nomencl">Nomenclature</h2><dl>"#);
    for e in &items {
        html.push_str(&format!(
            r##"<dt><a class="nomencl" href="#{}">{}</a></dt><dd>{}</dd>"##,
            escape_live_html(&e.id),
            escape_live_html(&e.symbol),
            escape_live_html(&e.desc)
        ));
    }
    html.push_str("</dl></div>");
    html
}

fn render_index(ctx: &RenderCtx<'_>, title: &str) -> String {
    if ctx.index.is_empty() {
        return String::new();
    }
    let mut items = ctx.index.clone();
    items.sort_by_key(|a| a.sort.to_lowercase());
    let mut groups: Vec<(String, Vec<&super::IndexEntry>)> = Vec::new();
    for e in &items {
        let label = e.terms.join(", ");
        let key = if e.see.is_empty() {
            label.clone()
        } else {
            format!("{}::see::{}", label, e.see)
        };
        if key.is_empty() {
            continue;
        }
        if let Some(g) = groups.iter_mut().find(|(k, _)| k == &key) {
            g.1.push(e);
        } else {
            groups.push((key, vec![e]));
        }
    }
    let t = if title.is_empty() { "Index" } else { title };
    let mut html = format!(
        r#"<div class="index"><h2 class="index">{}</h2><ul class="index">"#,
        escape_live_html(t)
    );
    for (_, group) in groups {
        let first = group[0];
        let label = first.terms.join(", ");
        if !first.see.is_empty() {
            html.push_str(&format!(
                "<li>{}, see {}</li>",
                escape_live_html(&label),
                escape_live_html(&first.see)
            ));
            continue;
        }
        let links = group
            .iter()
            .enumerate()
            .map(|(i, e)| format!(r##"<a href="#{}">{}</a>"##, escape_live_html(&e.id), i + 1))
            .collect::<Vec<_>>()
            .join(", ");
        html.push_str(&format!(
            "<li>{} \u{2014} {links}</li>",
            escape_live_html(&label)
        ));
    }
    html.push_str("</ul></div>");
    html
}

fn render_float_list(kind: &str, ctx: &RenderCtx<'_>) -> String {
    let type_ = kind.strip_prefix("FloatList ").map(str::trim).unwrap_or("");
    let entries: Vec<&FloatListEntry> = ctx
        .float_list_entries
        .iter()
        .filter(|e| e.type_ == type_)
        .collect();
    if entries.is_empty() {
        return String::new();
    }
    let title = match type_ {
        "figure" => "List of Figures".to_string(),
        "table" => "List of Tables".to_string(),
        "" => "List of Floats".to_string(),
        t => format!("List of {}", float_nameref_prefix(t)),
    };
    format_float_list_titled(&title, type_, &entries)
}

fn format_float_list_titled(title: &str, type_: &str, entries: &[&FloatListEntry]) -> String {
    fn items(list: &[FloatListEntry]) -> String {
        let mut out = String::new();
        for e in list {
            let label = if e.text.is_empty() {
                e.number.clone()
            } else {
                format!("{} {}", e.number, e.text)
            };
            out.push_str(&format!(
                r##"<li><a href="#{}">{}</a>"##,
                escape_live_html(&e.id),
                escape_live_html(label.trim())
            ));
            if let Some(ch) = &e.children
                && !ch.is_empty()
            {
                out.push_str(&format!("<ol>{}</ol>", items(ch)));
            }
            out.push_str("</li>");
        }
        out
    }
    let owned: Vec<FloatListEntry> = entries.iter().map(|e| (*e).clone()).collect();
    format!(
        r#"<nav class="toc toc-floats"><h2 class="tochead toc-{}">{}</h2><ol>{}</ol></nav>"#,
        escape_live_html(&{
            let s = layout_slug(type_);
            if s.is_empty() { "float".into() } else { s }
        }),
        escape_live_html(title),
        items(&owned)
    )
}

fn render_ipa_deco(
    block: NodeId,
    parent_state: &TraversalState,
    ctx: &mut RenderCtx<'_>,
) -> String {
    let deco = inset_kind(ctx.doc(), block)["IPADeco ".len()..]
        .trim()
        .to_ascii_lowercase();
    let mark = if deco == "toptiebar" {
        "\u{0361}"
    } else if deco == "bottomtiebar" {
        "\u{035c}"
    } else {
        ""
    };
    let inner = render_inset_layouts(block, parent_state, ctx);
    if mark.is_empty() {
        return format!(r#"<span class="ipa-deco">{inner}</span>"#);
    }
    let plain: String = collect_visible_text(ctx.doc(), block)
        .chars()
        .filter(|c| !c.is_whitespace())
        .collect();
    if plain.chars().count() >= 2 && !inner.contains('<') {
        let mid = plain.chars().count() / 2;
        let a: String = plain.chars().take(mid).collect();
        let b: String = plain.chars().skip(mid).collect();
        return format!(
            r#"<span class="ipa-deco">{}{mark}{}</span>"#,
            escape_live_html(&a),
            escape_live_html(&b)
        );
    }
    format!(r#"<span class="ipa-deco">{inner}{mark}</span>"#)
}

pub(crate) fn branch_produces_output(block: NodeId, ctx: &RenderCtx<'_>) -> bool {
    let kind = inset_kind(ctx.doc(), block);
    let name = kind.strip_prefix("Branch ").map(str::trim).unwrap_or("");
    let selected = if name.is_empty() {
        false
    } else {
        ctx.branches.get(name).copied().unwrap_or(false)
    };
    let inverted_raw = find_property(ctx.doc(), block, "inverted").unwrap_or_else(|| "0".into());
    let inverted = inverted_raw.trim() == "1" || inverted_raw.eq_ignore_ascii_case("true");
    selected != inverted
}

fn is_overlay_flex(name: &str) -> bool {
    const EXACT: &[&str] = &[
        "Alternative",
        "Uncover",
        "Visible",
        "Invisible",
        "Onslide+",
        "Onslide*",
        "ArticleMode",
        "PresentationMode",
    ];
    if EXACT.iter().any(|e| name.eq_ignore_ascii_case(e)) {
        return true;
    }
    name.len() >= 7 && name[..7].eq_ignore_ascii_case("Onslide")
}

fn is_field_flex(name: &str) -> bool {
    const NAMES: &[&str] = &[
        "First Name",
        "Surname",
        "Department",
        "Organization",
        "Org. Address",
        "Street",
        "City",
        "Post Code",
        "State",
        "Country",
        "ItemInset",
    ];
    NAMES.iter().any(|n| name.eq_ignore_ascii_case(n))
}

fn is_gloss_flex(name: &str) -> bool {
    const PREFIXES: &[&str] = &[
        "GroupGlossedWords",
        "Interlinear Gloss",
        "Concepts",
        "Expression",
        "Meaning",
        "IfThen-DRS",
        "Cond-DRS",
        "QDRS",
        "NegDRS",
        "SDRS",
        "DRS",
    ];
    PREFIXES
        .iter()
        .any(|p| name.len() >= p.len() && name[..p.len()].eq_ignore_ascii_case(p))
}

fn render_flex_default(
    kind: &str,
    block: NodeId,
    parent_state: &TraversalState,
    ctx: &mut RenderCtx<'_>,
) -> String {
    let name = kind["Flex ".len()..].trim();
    let slug = {
        let s = layout_slug(name);
        if s.is_empty() { "flex".into() } else { s }
    };
    let multipar = ctx.doc().node(block).children.iter().any(
        |&c| matches!(&ctx.doc().node(c).kind, NodeKind::Block { tag, .. } if tag == "layout"),
    );
    if is_overlay_flex(name) {
        let style = if name.eq_ignore_ascii_case("Invisible") {
            r#" style="opacity:0.35""#
        } else {
            ""
        };
        return format!(
            r#"<span class="flex {slug} overlay"{style}>{}</span>"#,
            render_flex_inline(block, ctx)
        );
    }
    if name.eq_ignore_ascii_case("institutemark")
        || name.eq_ignore_ascii_case("Bibnote")
        || name.eq_ignore_ascii_case("Table footnotemark")
    {
        return format!(
            r#"<sup class="flex {slug}">{}</sup>"#,
            render_flex_inline(block, ctx)
        );
    }
    if name.eq_ignore_ascii_case("VerticalSpace") {
        return r#"<div class="flex vertical-space" style="height:1em" aria-hidden="true"></div>"#
            .into();
    }
    if name.eq_ignore_ascii_case("Ruby") {
        return format!(
            r#"<ruby class="flex ruby">{}</ruby>"#,
            render_inset_layouts(block, parent_state, ctx)
        );
    }
    if name.eq_ignore_ascii_case("Bold") {
        return format!(
            r#"<strong class="flex bold">{}</strong>"#,
            render_flex_inline(block, ctx)
        );
    }
    if name.eq_ignore_ascii_case("Highlight") {
        return format!(
            r#"<mark class="flex highlight">{}</mark>"#,
            render_flex_inline(block, ctx)
        );
    }
    if name.eq_ignore_ascii_case("Latin") {
        return format!(
            r#"<span class="flex latin" lang="la">{}</span>"#,
            render_flex_inline(block, ctx)
        );
    }
    if name.eq_ignore_ascii_case("Chemistry") {
        return format!(
            r#"<span class="flex chemistry">{}</span>"#,
            render_flex_inline(block, ctx)
        );
    }
    if name.eq_ignore_ascii_case("Braillebox") {
        return format!(
            r#"<span class="flex braillebox">{}</span>"#,
            render_inset_layouts(block, parent_state, ctx)
        );
    }
    if name.eq_ignore_ascii_case("Column") {
        return format!(
            r#"<div class="flex column">{}</div>"#,
            render_inset_layouts(block, parent_state, ctx)
        );
    }
    if name.eq_ignore_ascii_case("Subtitle") {
        return format!(
            r#"<div class="flex subtitle">{}</div>"#,
            render_inset_layouts(block, parent_state, ctx)
        );
    }
    if name.eq_ignore_ascii_case("Variation") || name.eq_ignore_ascii_case("SetChessBoard") {
        return format!(
            r#"<div class="flex {slug} chess-meta">{}</div>"#,
            render_inset_layouts(block, parent_state, ctx)
        );
    }
    if name.eq_ignore_ascii_case("S/R expression") || name.eq_ignore_ascii_case("Sweave Options") {
        return format!(
            r#"<code class="flex {slug}">{}</code>"#,
            escape_live_html(&collect_visible_text(ctx.doc(), block))
        );
    }
    if is_field_flex(name) {
        return format!(
            r#"<span class="flex field {slug}" data-field="{}">{}</span>"#,
            escape_live_html(name),
            render_inset_layouts(block, parent_state, ctx)
        );
    }
    if is_gloss_flex(name) {
        return format!(
            r#"<div class="flex gloss {slug}">{}</div>"#,
            render_inset_layouts(block, parent_state, ctx)
        );
    }
    if name == "Email" {
        let text = collect_visible_text(ctx.doc(), block).trim().to_string();
        let href = if text.contains('@') {
            format!("mailto:{text}")
        } else {
            text.clone()
        };
        return format!(
            r#"<a class="flex email" href="{}">{}</a>"#,
            escape_live_html(&href),
            escape_live_html(&text)
        );
    }
    if matches!(name, "Flex Alert" | "Alert") || kind.starts_with("Flex Alert ") {
        return format!(
            r#"<span class="alert" style="color: #cc0000">{}</span>"#,
            render_flex_inline(block, ctx)
        );
    }
    if kind == "Flex Alert" || kind.starts_with("Flex Alert ") {
        return format!(
            r#"<span class="alert" style="color: #cc0000">{}</span>"#,
            render_flex_inline(block, ctx)
        );
    }
    if kind == "Flex Structure"
        || (kind.starts_with("Flex Structure ") && !kind.starts_with("Flex Structure Tree"))
    {
        return format!(
            r#"<span class="structure" style="color: #0000aa">{}</span>"#,
            render_flex_inline(block, ctx)
        );
    }
    if kind.starts_with("Flex NewThought") || kind.starts_with("Flex SmallCaps") {
        return format!(
            r#"<span class="smallcaps" style="font-variant: small-caps">{}</span>"#,
            render_flex_inline(block, ctx)
        );
    }
    if kind.starts_with("Flex AllCaps") {
        return format!(
            r#"<span class="noun allcaps" style="text-transform: uppercase">{}</span>"#,
            render_flex_inline(block, ctx)
        );
    }
    if kind.contains("Color Box") {
        let box_html = format!(
            r#"<div class="color-box">{}</div>"#,
            render_inset_layouts(block, parent_state, ctx)
        );
        return wrap_disclosure(
            ctx,
            "flex-container color-box",
            "Color Box",
            &box_html,
            None,
        );
    }
    if kind.starts_with("Flex Chunk") {
        let title = argument_text(ctx.doc(), block, "1").trim().to_string();
        let head = if title.is_empty() {
            String::new()
        } else {
            format!(
                r#"<div class="chunk-title">{}</div>"#,
                escape_live_html(&title)
            )
        };
        let box_html = format!(
            r#"<div class="chunk">{head}<pre class="chunk-body">{}</pre></div>"#,
            render_inset_layouts(block, parent_state, ctx)
        );
        return wrap_disclosure(
            ctx,
            "flex-container chunk",
            if title.is_empty() { "Chunk" } else { &title },
            &box_html,
            None,
        );
    }
    if kind.starts_with("Flex Structure Tree") {
        return format!(
            r#"<pre class="structure-tree">{}</pre>"#,
            escape_live_html(&collect_visible_text(ctx.doc(), block))
        );
    }
    if kind.starts_with("Flex LilyPond") {
        return format!(
            r#"<pre class="lilypond">{}</pre>"#,
            escape_live_html(&collect_visible_text(ctx.doc(), block))
        );
    }
    if kind.starts_with("Flex ChessBoard") {
        let box_html = format!(
            r#"<div class="chessboard">{}</div>"#,
            render_inset_layouts(block, parent_state, ctx)
        );
        return wrap_disclosure(
            ctx,
            "flex-container chessboard",
            "Chess board",
            &box_html,
            None,
        );
    }
    if kind.starts_with("Flex URL") || kind == "Flex URL" {
        let url = flatten_flow(ctx.doc(), &ctx.doc().node(block).children, 0)
            .iter()
            .map(|item| collect_visible_text(ctx.doc(), item.node))
            .collect::<String>()
            .trim()
            .to_string();
        return format!(
            r#"<span class="flex_url"><a href="{u}">{u}</a></span>"#,
            u = escape_live_html(&url)
        );
    }
    if kind.starts_with("Flex Sidenote") || kind.starts_with("Flex Marginnote") {
        let cls = if kind.contains("Marginnote") {
            "marginnote"
        } else {
            "sidenote"
        };
        let label = if kind.contains("Marginnote") {
            "Margin note"
        } else {
            "Sidenote"
        };
        let aside = format!(
            r#"<aside class="{cls} marginal">{}</aside>"#,
            render_inset_layouts(block, parent_state, ctx)
        );
        return wrap_disclosure(ctx, &format!("flex-container {cls}"), label, &aside, None);
    }
    let from_layout = render_flex_from_layout(kind, name, multipar, block, parent_state, ctx);
    if let Some(from) = from_layout {
        return if multipar {
            wrap_disclosure(
                ctx,
                &format!("flex-container {slug}"),
                if name.is_empty() { "Flex" } else { name },
                &from,
                None,
            )
        } else {
            from
        };
    }
    if multipar {
        let box_html = format!(
            r#"<div class="flex {slug}">{}</div>"#,
            render_inset_layouts(block, parent_state, ctx)
        );
        return wrap_disclosure(
            ctx,
            &format!("flex-container {slug}"),
            if name.is_empty() { "Flex" } else { name },
            &box_html,
            None,
        );
    }
    format!(
        r#"<span class="flex {slug}">{}</span>"#,
        render_flex_inline(block, ctx)
    )
}

const SAFE_FLEX_TAGS: &[&str] = &[
    "a",
    "abbr",
    "b",
    "blockquote",
    "br",
    "cite",
    "code",
    "dd",
    "del",
    "details",
    "div",
    "dl",
    "dt",
    "em",
    "figcaption",
    "figure",
    "h1",
    "h2",
    "h3",
    "h4",
    "h5",
    "h6",
    "i",
    "ins",
    "kbd",
    "li",
    "mark",
    "ol",
    "p",
    "pre",
    "q",
    "s",
    "samp",
    "small",
    "span",
    "strong",
    "sub",
    "summary",
    "sup",
    "time",
    "u",
    "ul",
    "var",
];

fn flex_layout_spec<'a>(
    kind: &str,
    name: &str,
    html: Option<&'a HashMap<String, LayoutHtml>>,
) -> Option<&'a LayoutHtml> {
    let html = html?;
    let underscored = name.replace(' ', "_");
    let spaced = name.replace('_', " ");
    let keys = [
        format!("Flex:{name}"),
        format!("Flex:{underscored}"),
        format!("Flex:{spaced}"),
        kind.to_string(),
        name.to_string(),
        underscored,
        spaced,
    ];
    for k in keys {
        if let Some(spec) = html.get(&k)
            && (spec.html_tag.is_some() || spec.html_class.is_some() || spec.font.is_some())
        {
            return Some(spec);
        }
    }
    None
}

fn layout_font_style(font: Option<&crate::schema::LayoutFont>) -> String {
    let Some(font) = font else {
        return String::new();
    };
    let mut parts = Vec::new();
    if let Some(color) = &font.color {
        parts.push(format!("color:{}", mapping::css_lyx_color(color)));
    }
    let shape = font.shape.as_deref().unwrap_or("").to_ascii_lowercase();
    if shape == "italic" {
        parts.push("font-style:italic".into());
    } else if shape == "slanted" {
        parts.push("font-style:oblique".into());
    } else if shape == "smallcaps" {
        parts.push("font-variant:small-caps".into());
    }
    if font
        .series
        .as_deref()
        .unwrap_or("")
        .eq_ignore_ascii_case("bold")
    {
        parts.push("font-weight:bold".into());
    }
    let family = font.family.as_deref().unwrap_or("").to_ascii_lowercase();
    if family == "typewriter" {
        parts.push("font-family:monospace".into());
    } else if family == "sans" {
        parts.push("font-family:sans-serif".into());
    }
    if let Some(css) =
        mapping::font_size_css(&font.size.as_deref().unwrap_or("").to_ascii_lowercase())
    {
        parts.push(format!("font-size:{css}"));
    }
    if parts.is_empty() {
        String::new()
    } else {
        format!(r#" style="{}""#, escape_live_html(&parts.join(";")))
    }
}

fn render_flex_from_layout(
    kind: &str,
    name: &str,
    multipar: bool,
    block: NodeId,
    parent_state: &TraversalState,
    ctx: &mut RenderCtx<'_>,
) -> Option<String> {
    let spec = flex_layout_spec(kind, name, ctx.layout_html.as_ref())?;
    let raw_tag = spec
        .html_tag
        .as_deref()
        .unwrap_or(if multipar { "div" } else { "span" })
        .to_ascii_lowercase();
    if !SAFE_FLEX_TAGS.contains(&raw_tag.as_str()) {
        return None;
    }
    let cls = spec
        .html_class
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_string)
        .unwrap_or_else(|| flex_native_class(name));
    let style = layout_font_style(spec.font.as_ref());
    let inner = if multipar {
        render_inset_layouts(block, parent_state, ctx)
    } else {
        render_flex_inline(block, ctx)
    };
    Some(format!(
        r#"<{raw_tag} class="{}"{style}>{inner}</{raw_tag}>"#,
        escape_live_html(&cls)
    ))
}

fn quote_char(kind: &str) -> String {
    let code = kind.strip_prefix("Quotes ").map(str::trim).unwrap_or("");
    if code.len() != 3 {
        return "\"".into();
    }
    let chars: Vec<char> = code.chars().collect();
    let marks: [&str; 4] = match chars[0] {
        'e' => ["\u{201c}", "\u{201d}", "\u{2018}", "\u{2019}"],
        's' => ["\u{201d}", "\u{201d}", "\u{2019}", "\u{2019}"],
        'g' => ["\u{201e}", "\u{201c}", "\u{201a}", "\u{2018}"],
        'p' => ["\u{201e}", "\u{201d}", "\u{201a}", "\u{2019}"],
        'c' => ["\u{00ab}", "\u{00bb}", "\u{2039}", "\u{203a}"],
        'a' => ["\u{00bb}", "\u{00ab}", "\u{203a}", "\u{2039}"],
        'q' => ["\u{0022}", "\u{0022}", "\u{0027}", "\u{0027}"],
        'b' => ["\u{2018}", "\u{2019}", "\u{201c}", "\u{201d}"],
        'w' => ["\u{00bb}", "\u{00bb}", "\u{2019}", "\u{2019}"],
        'f' => ["\u{00ab}", "\u{00bb}", "\u{201c}", "\u{201d}"],
        'i' => ["\u{00ab}", "\u{00bb}", "\u{00ab}", "\u{00bb}"],
        'r' => ["\u{00ab}", "\u{00bb}", "\u{201e}", "\u{201c}"],
        'j' => ["\u{300c}", "\u{300d}", "\u{300e}", "\u{300f}"],
        'k' => ["\u{300a}", "\u{300b}", "\u{3008}", "\u{3009}"],
        'h' => ["\u{201e}", "\u{201d}", "\u{00bb}", "\u{00ab}"],
        'd' => ["\u{201d}", "\u{201e}", "\u{2019}", "\u{201a}"],
        'x' => ["\u{201c}", "\u{201d}", "\u{2018}", "\u{2019}"],
        _ => ["\u{201c}", "\u{201d}", "\u{2018}", "\u{2019}"],
    };
    let secondary = chars[2] == 's';
    let closing = chars[1] == 'r';
    marks[(if secondary { 2 } else { 0 }) + (if closing { 1 } else { 0 })].into()
}

#[cfg(test)]
mod vspace_label_tests {
    use super::vspace_gui_label;

    #[test]
    fn lyx_gui_names_for_every_vspace_kind() {
        let cases = [
            ("defskip", "Vertical Space (Default skip)"),
            ("smallskip", "Vertical Space (Small skip)"),
            ("medskip", "Vertical Space (Medium skip)"),
            ("bigskip", "Vertical Space (Big skip)"),
            ("halfline", "Vertical Space (Half line height)"),
            ("fullline", "Vertical Space (Line height)"),
            ("vfill", "Vertical Space (Vertical fill)"),
            ("0.3cm", "Vertical Space (0.3cm)"),
            ("-10mm", "Vertical Space (-10mm)"),
            ("smallskip*", "Vertical Space (Small skip, protected)"),
            ("bigskip*", "Vertical Space (Big skip, protected)"),
            ("1cm*", "Vertical Space (1cm, protected)"),
        ];
        for (amount, want) in cases {
            assert_eq!(vspace_gui_label(amount), want, "{amount}");
        }
    }
}
