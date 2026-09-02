//! Query-order mapping tokens (DL135).

use super::{
    FlowItem, ForeignInclude, LiveDiagnostic, LiveToken, LiveTokenBundle, QueryIndex,
    QueryIndexEntry, QueryTag, RenderCtx, escape_live_html,
};
use crate::ast::{Document, NodeId, NodeKind};
use std::collections::HashMap;

pub(crate) fn args_match_selector(node_args: Option<&str>, arg_exact: &str) -> bool {
    let Some(node_args) = node_args else {
        return false;
    };
    let trimmed = node_args.trim();
    let first = trimmed.split_whitespace().next().unwrap_or("");
    trimmed == arg_exact || first == arg_exact
}

pub(crate) fn build_query_index(ast: &Document, root: NodeId) -> QueryIndex {
    let mut order = Vec::new();
    collect_query_blocks(ast, root, &mut order);
    let mut by_id = HashMap::new();
    for &node in &order {
        let (tag_s, name) = match &ast.node(node).kind {
            NodeKind::Block { tag, args, .. } => {
                (tag.as_str(), args.as_deref().unwrap_or("").trim())
            }
            _ => continue,
        };
        let tag = match tag_s {
            "layout" => QueryTag::Layout,
            "inset" => QueryTag::Inset,
            _ => continue,
        };
        let mut n = 0usize;
        for &other in &order {
            let NodeKind::Block {
                tag: ot, args: oa, ..
            } = &ast.node(other).kind
            else {
                continue;
            };
            if ot != tag_s {
                continue;
            }
            if !args_match_selector(oa.as_deref(), name) {
                continue;
            }
            n += 1;
            if other == node {
                break;
            }
        }
        by_id.insert(
            node,
            QueryIndexEntry {
                tag,
                name: name.to_string(),
                global_n: n,
            },
        );
    }
    QueryIndex { by_id, order }
}

fn collect_query_blocks(ast: &Document, id: NodeId, out: &mut Vec<NodeId>) {
    for &c in &ast.node(id).children {
        if let NodeKind::Block { tag, .. } = &ast.node(c).kind
            && (tag == "layout" || tag == "inset")
        {
            out.push(c);
        }
        collect_query_blocks(ast, c, out);
    }
}

pub(crate) fn inset_kind(ast: &Document, block: NodeId) -> String {
    match &ast.node(block).kind {
        NodeKind::Block { args, .. } => args.as_deref().unwrap_or("").trim().to_string(),
        _ => String::new(),
    }
}

pub(crate) fn inset_selector_kind(ast: &Document, block: NodeId) -> String {
    let kind = inset_kind(ast, block);
    if kind == "Formula" || kind.starts_with("Formula") {
        "Formula".into()
    } else {
        kind
    }
}

pub(crate) fn is_path_prefix_inset(kind: &str) -> bool {
    kind != "Tabular" && !kind.starts_with("Tabular ")
}

pub(crate) fn descendant_layouts_named(ast: &Document, inset: NodeId, name: &str) -> Vec<NodeId> {
    let mut out = Vec::new();
    walk_named(ast, inset, "layout", name, &mut out);
    out
}

pub(crate) fn descendant_insets_named(ast: &Document, inset: NodeId, name: &str) -> Vec<NodeId> {
    let mut out = Vec::new();
    walk_named(ast, inset, "inset", name, &mut out);
    out
}

fn walk_named(ast: &Document, id: NodeId, tag: &str, name: &str, out: &mut Vec<NodeId>) {
    for &c in &ast.node(id).children {
        if let NodeKind::Block {
            tag: t, args: a, ..
        } = &ast.node(c).kind
            && t == tag
            && args_match_selector(a.as_deref(), name)
        {
            out.push(c);
        }
        walk_named(ast, c, tag, name, out);
    }
}

pub(crate) fn scoped_nth_match(tag: &str, name: &str, node: NodeId, siblings: &[NodeId]) -> String {
    let n = siblings
        .iter()
        .position(|&id| id == node)
        .map(|i| i + 1)
        .unwrap_or(0);
    if siblings.len() > 1 && n > 0 {
        format!("{tag}[{name}]:nth-match({n})")
    } else {
        format!("{tag}[{name}]")
    }
}

pub(crate) fn cell_layout_selector(
    ctx: &RenderCtx<'_>,
    tabular: NodeId,
    text_inset: NodeId,
    layout_node: NodeId,
    name: &str,
) -> String {
    let ast = ctx.doc();
    let table_sel = inset_owner_selector(ctx, tabular);
    let texts = descendant_insets_named(ast, tabular, "Text");
    let text_part = scoped_nth_match("inset", "Text", text_inset, &texts);
    let same = descendant_layouts_named(ast, text_inset, name);
    let layout_part = scoped_nth_match("layout", name, layout_node, &same);
    format!("{table_sel} {text_part} {layout_part}")
}

pub(crate) fn caption_layout_selector(
    ctx: &RenderCtx<'_>,
    owner: NodeId,
    caption_inset: NodeId,
    layout_node: NodeId,
    name: &str,
) -> String {
    let ast = ctx.doc();
    let owner_sel = inset_owner_selector(ctx, owner);
    let cap_kind = inset_kind(ast, caption_inset);
    let captions = descendant_insets_named(ast, owner, &cap_kind);
    let cap_part = scoped_nth_match("inset", &cap_kind, caption_inset, &captions);
    let same = descendant_layouts_named(ast, caption_inset, name);
    let layout_part = scoped_nth_match("layout", name, layout_node, &same);
    format!("{owner_sel} {cap_part} {layout_part}")
}

pub(crate) fn flex_layout_selector(
    ctx: &RenderCtx<'_>,
    flex_inset: NodeId,
    layout_node: NodeId,
    name: &str,
) -> String {
    let ast = ctx.doc();
    let flex_kind = inset_kind(ast, flex_inset);
    let same = descendant_layouts_named(ast, flex_inset, name);
    let layout_part = scoped_nth_match("layout", name, layout_node, &same);
    let parent_sel = ctx.current_layout_selector.as_deref();
    let parent_node = ctx.current_layout_node;
    if let (Some(parent_sel), Some(parent_node)) = (parent_sel, parent_node)
        && !parent_sel.contains("inset[Flex")
    {
        let flexes = descendant_insets_named(ast, parent_node, &flex_kind);
        let flex_part = scoped_nth_match("inset", &flex_kind, flex_inset, &flexes);
        return format!("{parent_sel} {flex_part} {layout_part}");
    }
    let flex_sel = inset_owner_selector(ctx, flex_inset);
    format!("{flex_sel} {layout_part}")
}

fn active_query_index<'a>(ctx: &'a RenderCtx<'_>) -> &'a QueryIndex {
    match &ctx.foreign {
        Some(ForeignInclude { query_index, .. }) => query_index,
        None => &ctx.query_index,
    }
}

pub(crate) fn inset_owner_selector(ctx: &RenderCtx<'_>, block: NodeId) -> String {
    let ast = ctx.doc();
    let kind = inset_selector_kind(ast, block);
    let index = active_query_index(ctx);
    if kind == "Formula" {
        let mut n = 0usize;
        for &node in &index.order {
            let Some(rec) = index.by_id.get(&node) else {
                continue;
            };
            if rec.tag != QueryTag::Inset {
                continue;
            }
            let args = match &ast.node(node).kind {
                NodeKind::Block { args, .. } => args.as_deref(),
                _ => continue,
            };
            if !args_match_selector(args, "Formula") {
                continue;
            }
            n += 1;
            if node == block {
                break;
            }
        }
        return format!("inset[Formula]:nth-match({})", if n == 0 { 1 } else { n });
    }
    let rec = index.by_id.get(&block);
    let name = rec.map(|r| r.name.as_str()).unwrap_or(kind.as_str());
    let n = rec.map(|r| r.global_n).unwrap_or(1);
    format!("inset[{name}]:nth-match({n})")
}

pub(crate) fn layout_owner_selector(ctx: &RenderCtx<'_>, node: NodeId, name: &str) -> String {
    let ast = ctx.doc();
    let rec = active_query_index(ctx).by_id.get(&node);
    let global_n = rec.map(|r| r.global_n).unwrap_or(1);
    let inset = ctx.current_inset_node;
    let kind = inset.map(|id| inset_kind(ast, id)).unwrap_or_default();
    if let Some(inset) = inset
        && is_path_prefix_inset(&kind)
    {
        let prefix = inset_owner_selector(ctx, inset);
        let same = descendant_layouts_named(ast, inset, name);
        let inner_n = same
            .iter()
            .position(|&id| id == node)
            .map(|i| i + 1)
            .unwrap_or(0);
        let layout_part = if same.len() > 1 && inner_n > 0 {
            format!("layout[{name}]:nth-match({inner_n})")
        } else {
            format!("layout[{name}]")
        };
        return format!("{prefix} {layout_part}");
    }
    format!("layout[{name}]:nth-match({global_n})")
}

pub(crate) fn emit_token(ctx: &mut RenderCtx<'_>, id: &str, selector: &str) {
    ctx.used_token_ids.insert(id.to_string());
    let mut bundle = LiveTokenBundle {
        selector: selector.to_string(),
        file: None,
        disk_hash: None,
        via: None,
    };
    if let Some(foreign) = &ctx.foreign {
        bundle.file = Some(foreign.file.clone());
        bundle.disk_hash = Some(foreign.disk_hash.clone());
        bundle.via = Some(foreign.via.clone());
    }
    ctx.tokens.push(LiveToken {
        id: id.to_string(),
        bundle,
    });
}

pub(crate) fn take_owner_id(ctx: &mut RenderCtx<'_>, existing: Option<&str>) -> String {
    if let Some(existing) = existing
        && !ctx.used_token_ids.contains(existing)
    {
        ctx.used_token_ids.insert(existing.to_string());
        return existing.to_string();
    }
    ctx.tok_seq += 1;
    let mut id = format!("tok-{}", ctx.tok_seq);
    while ctx.used_token_ids.contains(&id) {
        ctx.tok_seq += 1;
        id = format!("tok-{}", ctx.tok_seq);
    }
    ctx.used_token_ids.insert(id.clone());
    id
}

pub(crate) fn mapping_attrs(id: &str) -> String {
    format!(
        " id=\"{}\" data-ref=\"{}\"",
        escape_live_html(id),
        escape_live_html(id)
    )
}

pub(crate) fn with_layout(
    ctx: &mut RenderCtx<'_>,
    item: &FlowItem,
    f: impl FnOnce(&mut RenderCtx<'_>, &str) -> String,
) -> String {
    let selector = layout_owner_selector(ctx, item.node, &item.layout);
    let prev_sel = ctx.current_layout_selector.take();
    let prev_node = ctx.current_layout_node;
    ctx.current_layout_selector = Some(selector.clone());
    ctx.current_layout_node = Some(item.node);
    let out = f(ctx, &selector);
    ctx.current_layout_selector = prev_sel;
    ctx.current_layout_node = prev_node;
    out
}

pub(crate) fn with_cell_layout(
    ctx: &mut RenderCtx<'_>,
    tabular: NodeId,
    text_inset: NodeId,
    item: &FlowItem,
    f: impl FnOnce(&mut RenderCtx<'_>, &str) -> String,
) -> String {
    let selector = cell_layout_selector(ctx, tabular, text_inset, item.node, &item.layout);
    let prev_sel = ctx.current_layout_selector.take();
    let prev_node = ctx.current_layout_node;
    ctx.current_layout_selector = Some(selector.clone());
    ctx.current_layout_node = Some(item.node);
    let out = f(ctx, &selector);
    ctx.current_layout_selector = prev_sel;
    ctx.current_layout_node = prev_node;
    out
}

pub(crate) fn with_caption_layout(
    ctx: &mut RenderCtx<'_>,
    owner: NodeId,
    caption_inset: NodeId,
    item: &FlowItem,
    f: impl FnOnce(&mut RenderCtx<'_>, &str) -> String,
) -> String {
    let selector = caption_layout_selector(ctx, owner, caption_inset, item.node, &item.layout);
    let prev_sel = ctx.current_layout_selector.take();
    let prev_node = ctx.current_layout_node;
    ctx.current_layout_selector = Some(selector.clone());
    ctx.current_layout_node = Some(item.node);
    let out = f(ctx, &selector);
    ctx.current_layout_selector = prev_sel;
    ctx.current_layout_node = prev_node;
    out
}

pub(crate) fn with_flex_layout(
    ctx: &mut RenderCtx<'_>,
    flex_inset: NodeId,
    item: &FlowItem,
    f: impl FnOnce(&mut RenderCtx<'_>, &str) -> String,
) -> String {
    let selector = flex_layout_selector(ctx, flex_inset, item.node, &item.layout);
    let prev_sel = ctx.current_layout_selector.take();
    let prev_node = ctx.current_layout_node;
    ctx.current_layout_selector = Some(selector.clone());
    ctx.current_layout_node = Some(item.node);
    let out = f(ctx, &selector);
    ctx.current_layout_selector = prev_sel;
    ctx.current_layout_node = prev_node;
    out
}

pub(crate) fn warn_once(ctx: &mut RenderCtx<'_>, message: &str) {
    if !ctx.warnings.iter().any(|w| w == message) {
        ctx.warnings.push(message.to_string());
    }
}

pub(crate) fn diagnostic(ctx: &mut RenderCtx<'_>, code: &str, message: &str) {
    if !ctx
        .diagnostics
        .iter()
        .any(|d| d.code == code && d.message == message)
    {
        ctx.diagnostics.push(LiveDiagnostic {
            code: code.to_string(),
            message: message.to_string(),
        });
    }
}

pub(crate) fn layout_slug(name: &str) -> String {
    let slug: String = name
        .to_lowercase()
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() { c } else { '_' })
        .collect();
    let slug = slug.trim_matches('_').to_string();
    if slug.is_empty() {
        "standard".into()
    } else {
        slug
    }
}

pub(crate) fn flex_native_class(kind_or_name: &str) -> String {
    let name = if let Some(rest) = kind_or_name.strip_prefix("Flex ") {
        rest.trim()
    } else if let Some(rest) = kind_or_name.strip_prefix("Flex:") {
        rest.trim()
    } else {
        kind_or_name
    };
    let mut slug = name
        .replace(['(', ')'], "_")
        .replace('.', "_")
        .split_whitespace()
        .collect::<Vec<_>>()
        .join("_");
    while slug.contains("__") {
        slug = slug.replace("__", "_");
    }
    let slug = slug.trim_matches('_').to_lowercase();
    format!("flex_{slug}")
}

pub(crate) fn xml_id(name: &str) -> String {
    name.chars()
        .map(|c| if c.is_ascii_alphanumeric() { c } else { '_' })
        .collect()
}

pub(crate) fn is_status_line(text: &str) -> bool {
    const PREFIXES: &[&str] = &[
        "status",
        "name",
        "LatexCommand",
        "LatexName",
        "labelwidthstring",
        "range",
        "pageformat",
        "type",
        "literal",
    ];
    for p in PREFIXES {
        if let Some(rest) = text.strip_prefix(p)
            && rest.starts_with(|c: char| c.is_whitespace())
        {
            return true;
        }
    }
    false
}

const SPECIAL_CHAR: &[(&str, &str)] = &[
    ("LyX", "LyX"),
    ("TeX", "TeX"),
    ("LaTeX", "LaTeX"),
    ("LaTeX2e", "LaTeX2ε"),
    ("lyx", "lyx"),
    ("tex", "tex"),
    ("latex", "latex"),
    ("ldots", "…"),
    ("dots", "…"),
    ("endash", "–"),
    ("emdash", "—"),
    ("slash", "/"),
    ("breakableslash", "\u{2044}"),
    ("hyphenation", "\u{00ad}"),
    ("softhyphen", "\u{00ad}"),
    ("noboundry", ""),
    ("noboundary", ""),
    ("allowbreak", "\u{200b}"),
    ("ligaturebreak", "\u{200c}"),
    ("endofsentence", "."),
    ("menuseparator", "\u{21d2}"),
    ("menu-separator", "\u{21d2}"),
    ("nobreakdash", "\u{2011}"),
];

pub(crate) fn special_char(name: &str) -> String {
    SPECIAL_CHAR
        .iter()
        .find(|(k, _)| *k == name)
        .map(|(_, v)| (*v).to_string())
        .unwrap_or_else(|| name.to_string())
}

pub(crate) fn expand_special_in_text(text: &str) -> String {
    let mut out = String::new();
    let mut last = 0;
    for (start, end, name) in special_char_spans(text) {
        out.push_str(&text[last..start]);
        out.push_str(&special_char(&name));
        last = end;
    }
    out.push_str(&text[last..]);
    out
}

pub(crate) fn special_char_html(name: &str) -> String {
    let glyph = special_char(name);
    let cst = format!("\\SpecialChar {name}");
    format!(
        "<span class=\"specialchar\" data-lq-text=\"{}\">{}</span>",
        escape_live_html(&cst),
        escape_live_html(&glyph)
    )
}

pub(crate) fn text_node_to_live_html(text: &str) -> String {
    let mut out = String::new();
    let mut last = 0;
    for (start, end, name) in special_char_spans(text) {
        out.push_str(&escape_live_html(&text[last..start]));
        out.push_str(&special_char_html(&name));
        last = end;
    }
    out.push_str(&escape_live_html(&text[last..]));
    out
}

fn special_char_spans(text: &str) -> Vec<(usize, usize, String)> {
    let mut out = Vec::new();
    let needle = "\\SpecialChar";
    let mut i = 0;
    while let Some(rel) = text[i..].find(needle) {
        let start = i + rel;
        let after = start + needle.len();
        let Some(c) = text[after..].chars().next() else {
            break;
        };
        if !c.is_whitespace() {
            i = after;
            continue;
        }
        let rest = text[after..].trim_start();
        let name_start = text.len() - rest.len();
        let name_end = rest
            .find(|ch: char| ch.is_whitespace())
            .map(|n| name_start + n)
            .unwrap_or(text.len());
        out.push((start, name_end, text[name_start..name_end].to_string()));
        i = name_end;
    }
    out
}

pub(crate) fn is_omitted_inset_kind(kind: &str) -> bool {
    kind == "ERT"
        || kind == "Index"
        || kind.starts_with("Index ")
        || kind.starts_with("IndexMacro")
        || kind == "Nomenclature"
        || kind.starts_with("Nomenclature ")
        || kind == "Argument"
        || kind.starts_with("Argument ")
        || kind.starts_with("CommandInset label")
        || kind == "FormulaMacro"
        || kind.starts_with("FormulaMacro")
        || kind == "Phantom"
        || kind.starts_with("Phantom ")
}

pub(crate) fn css_lyx_color(name: &str) -> String {
    match name.to_ascii_lowercase().as_str() {
        "red" => "red".into(),
        "green" => "green".into(),
        "blue" => "blue".into(),
        "cyan" => "cyan".into(),
        "magenta" => "magenta".into(),
        "yellow" => "yellow".into(),
        "black" => "black".into(),
        "white" => "white".into(),
        "brown" => "brown".into(),
        "gray" | "grey" => "gray".into(),
        "darkgray" => "#404040".into(),
        "lightgray" => "#c0c0c0".into(),
        "lime" => "lime".into(),
        "olive" => "olive".into(),
        "orange" => "orange".into(),
        "pink" => "pink".into(),
        "purple" => "purple".into(),
        "teal" => "teal".into(),
        "violet" => "violet".into(),
        "darkred" => "#8b0000".into(),
        "darkgreen" => "#008000".into(),
        "darkblue" => "#00008b".into(),
        other => other.to_string(),
    }
}

pub(crate) fn html_lang_from_lyx(name: &str) -> String {
    let key = name.trim().to_ascii_lowercase();
    match key.as_str() {
        "english" => "en".into(),
        "american" => "en-US".into(),
        "british" => "en-GB".into(),
        "australian" => "en-AU".into(),
        "canadian" => "en-CA".into(),
        "german" | "ngerman" => "de".into(),
        "austrian" | "naustrian" => "de-AT".into(),
        "french" | "francais" => "fr".into(),
        "spanish" => "es".into(),
        "italian" => "it".into(),
        "dutch" => "nl".into(),
        "portuguese" => "pt".into(),
        "brazilian" => "pt-BR".into(),
        "russian" => "ru".into(),
        "polish" => "pl".into(),
        "czech" => "cs".into(),
        "slovak" => "sk".into(),
        "hungarian" => "hu".into(),
        "swedish" => "sv".into(),
        "danish" => "da".into(),
        "finnish" => "fi".into(),
        "norwegian" | "norsk" => "no".into(),
        "nynorsk" => "nn".into(),
        "greek" => "el".into(),
        "hebrew" => "he".into(),
        "arabic" => "ar".into(),
        "chinese" => "zh".into(),
        "japanese" => "ja".into(),
        "korean" => "ko".into(),
        "turkish" => "tr".into(),
        "latin" => "la".into(),
        _ => key,
    }
}

pub(crate) fn font_size_css(size: &str) -> Option<&'static str> {
    Some(match size {
        "tiny" | "scriptsize" | "footnotesize" => "x-small",
        "small" => "small",
        "large" => "large",
        "larger" | "largest" => "x-large",
        "huge" | "huger" => "xx-large",
        "increase" => "larger",
        "decrease" => "smaller",
        _ => return None,
    })
}

pub(crate) const SKIP_LAYOUT_PROPS: &[&str] = &[
    "align",
    "noindent",
    "indent",
    "start_of_appendix",
    "leftindent",
    "paragraph_spacing",
    "labelwidthstring",
    "labeling_width",
];

pub(crate) const AUTHOR_COLOR_COUNT: u32 = 8;

pub(crate) const TITLE_MARKS: &[&str] = &["*", "†", "‡", "§", "¶", "‖", "**", "††"];

pub(crate) fn find_property(ast: &Document, block: NodeId, key: &str) -> Option<String> {
    for &child in &ast.node(block).children {
        match &ast.node(child).kind {
            NodeKind::Property { key: k, value } if k == key => {
                return value.clone();
            }
            NodeKind::Text { text } => {
                if let Some(v) = property_from_text(text, key) {
                    return Some(v);
                }
            }
            NodeKind::Block { .. } => {
                if let Some(inner) = find_property(ast, child, key) {
                    return Some(inner);
                }
            }
            _ => {}
        }
    }
    None
}

fn property_from_text(text: &str, key: &str) -> Option<String> {
    for line in text.split('\n') {
        let t = line.trim_start();
        if let Some(rest) = t.strip_prefix(key)
            && rest.starts_with(|c: char| c.is_whitespace())
        {
            let mut v = rest.trim_start();
            if let Some(stripped) = v.strip_prefix('"') {
                v = stripped;
            }
            let v = v.split('\n').next().unwrap_or(v);
            let v = v.trim_end_matches('"').trim();
            if !v.is_empty() {
                return Some(v.to_string());
            }
        }
    }
    None
}

#[allow(clippy::type_complexity)] // Deno collectBlocks skip predicate
pub(crate) fn collect_blocks(
    ast: &Document,
    root: NodeId,
    pred: impl Fn(&Document, NodeId) -> bool,
    skip: Option<&dyn Fn(&Document, NodeId) -> bool>,
) -> Vec<NodeId> {
    let mut out = Vec::new();
    collect_blocks_into(ast, root, &pred, skip, &mut out);
    out
}

#[allow(clippy::type_complexity)] // Deno collectBlocks skip predicate
fn collect_blocks_into(
    ast: &Document,
    id: NodeId,
    pred: &impl Fn(&Document, NodeId) -> bool,
    skip: Option<&dyn Fn(&Document, NodeId) -> bool>,
    out: &mut Vec<NodeId>,
) {
    for &c in &ast.node(id).children {
        if !matches!(&ast.node(c).kind, NodeKind::Block { .. }) {
            continue;
        }
        if skip.is_some_and(|s| s(ast, c)) {
            continue;
        }
        if pred(ast, c) {
            out.push(c);
        } else {
            collect_blocks_into(ast, c, pred, skip, out);
        }
    }
}

pub(crate) fn nomencl_text(ast: &Document, block: NodeId) -> String {
    let mut out = String::new();
    nomencl_walk(ast, block, &mut out);
    collapse_ws(&out)
}

fn nomencl_walk(ast: &Document, id: NodeId, out: &mut String) {
    for &c in &ast.node(id).children {
        match &ast.node(c).kind {
            NodeKind::Text { text } => {
                if !is_status_line(text) {
                    out.push_str(text);
                }
            }
            NodeKind::Block { tag, .. } if tag != "inset" => nomencl_walk(ast, c, out),
            _ => {}
        }
    }
}

fn collapse_ws(s: &str) -> String {
    s.split_whitespace().collect::<Vec<_>>().join(" ")
}

pub(crate) fn argument_text(ast: &Document, block: NodeId, name: &str) -> String {
    let want = format!("Argument {name}");
    let found = collect_blocks(
        ast,
        block,
        |ast, id| {
            matches!(&ast.node(id).kind, NodeKind::Block { tag, .. } if tag == "inset")
                && inset_kind(ast, id) == want
        },
        None,
    );
    found
        .first()
        .map(|&id| nomencl_text(ast, id))
        .unwrap_or_default()
}
