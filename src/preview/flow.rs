//! Flow flatten, lists, abstract, environments.

use super::{FlowItem, RenderCtx, insets, mapping};
use crate::ast::{Document, NodeId, NodeKind};
use crate::schema::LayoutHtml;
use crate::text_utils::{
    TextRegion, TraversalState, advance_traversal_state, create_traversal_state,
    enter_traversal_state, is_invisible_inset, traversal_region,
};
use std::collections::HashMap;

#[derive(Clone, Debug)]
pub(crate) enum LayoutRole {
    Heading { tag: String, level: i32 },
    List { tag: String, item: String },
    Env { tag: String, item: String },
    Title,
    Front,
    Abstract,
    Omit,
    Flow,
}

const PAGE_CHROME: &[&str] = &[
    "Left Header",
    "Center Header",
    "Right Header",
    "Left Footer",
    "Center Footer",
    "Right Footer",
];

fn heading_table(name: &str) -> Option<(&'static str, i32)> {
    Some(match name {
        "Part" => ("h1", -1),
        "Chapter" => ("h1", 0),
        "Section" | "Section*" => ("h2", 1),
        "Subsection" | "Subsection*" => ("h3", 2),
        "Subsubsection" | "Subsubsection*" => ("h4", 3),
        "Paragraph" => ("h5", 4),
        "Subparagraph" => ("h6", 5),
        _ => return None,
    })
}

fn heading_level_from_tag(tag: &str, name: &str) -> i32 {
    match tag {
        "h1" => {
            if name == "Part" || name == "Part*" {
                -1
            } else {
                0
            }
        }
        "h2" => 1,
        "h3" => 2,
        "h4" => 3,
        "h5" => 4,
        "h6" => 5,
        _ => 1,
    }
}

fn role_from_html(name: &str, spec: Option<&LayoutHtml>) -> Option<LayoutRole> {
    if name == "Abstract" {
        return Some(LayoutRole::Abstract);
    }
    if name == "Title" || spec.and_then(|s| s.html_title) == Some(true) {
        return Some(LayoutRole::Title);
    }
    if PAGE_CHROME.contains(&name)
        || spec.and_then(|s| s.category.as_deref()) == Some("Header/Footer")
    {
        return Some(LayoutRole::Omit);
    }
    if spec.and_then(|s| s.category.as_deref()) == Some("FrontMatter") {
        return Some(LayoutRole::Front);
    }
    let tag = spec
        .and_then(|s| s.html_tag.as_deref())
        .map(|t| t.to_ascii_lowercase());
    if let Some(ref tag) = tag
        && matches!(tag.as_str(), "h1" | "h2" | "h3" | "h4" | "h5" | "h6")
    {
        let level = spec
            .and_then(|s| s.toc_level)
            .unwrap_or_else(|| heading_level_from_tag(tag, name));
        return Some(LayoutRole::Heading {
            tag: tag.clone(),
            level,
        });
    }
    if let Some(ref tag) = tag
        && matches!(tag.as_str(), "ul" | "ol" | "dl")
    {
        let item = spec
            .and_then(|s| s.html_item.as_deref())
            .unwrap_or(if tag == "dl" { "dd" } else { "li" })
            .to_ascii_lowercase();
        return Some(LayoutRole::List {
            tag: tag.clone(),
            item,
        });
    }
    if let Some(ref tag) = tag
        && (tag == "blockquote" || tag == "pre")
    {
        let item = spec.and_then(|s| s.html_item.clone()).unwrap_or_else(|| {
            if tag == "pre" {
                "NONE".into()
            } else {
                "div".into()
            }
        });
        return Some(LayoutRole::Env {
            tag: tag.clone(),
            item,
        });
    }
    None
}

fn fallback_role(name: &str) -> LayoutRole {
    if name == "Title" {
        return LayoutRole::Title;
    }
    if name == "Abstract" {
        return LayoutRole::Abstract;
    }
    if PAGE_CHROME.contains(&name) {
        return LayoutRole::Omit;
    }
    if name == "Author" || name == "Date" || name == "Subtitle" {
        return LayoutRole::Front;
    }
    if let Some((tag, level)) = heading_table(name) {
        return LayoutRole::Heading {
            tag: tag.into(),
            level,
        };
    }
    match name {
        "Itemize" => LayoutRole::List {
            tag: "ul".into(),
            item: "li".into(),
        },
        "Enumerate" | "Enumerate-Resume" => LayoutRole::List {
            tag: "ol".into(),
            item: "li".into(),
        },
        "Description" => LayoutRole::List {
            tag: "dl".into(),
            item: "dd".into(),
        },
        "Quote" | "Quotation" => LayoutRole::Env {
            tag: "blockquote".into(),
            item: "div".into(),
        },
        "Verse" => LayoutRole::Env {
            tag: "blockquote".into(),
            item: "p".into(),
        },
        "Verbatim" | "Verbatim*" | "LyX-Code" => LayoutRole::Env {
            tag: "pre".into(),
            item: "NONE".into(),
        },
        _ => LayoutRole::Flow,
    }
}

pub(crate) fn layout_html_spec<'a>(
    name: &str,
    html: Option<&'a HashMap<String, LayoutHtml>>,
) -> Option<&'a LayoutHtml> {
    let html = html?;
    html.get(name)
        .or_else(|| html.get(&name.replace(' ', "_")))
        .or_else(|| html.get(&name.replace('_', " ")))
}

pub(crate) fn role(name: &str, ctx: &RenderCtx<'_>) -> LayoutRole {
    role_from_html(name, layout_html_spec(name, ctx.layout_html.as_ref()))
        .unwrap_or_else(|| fallback_role(name))
}

pub(crate) struct HeadingState {
    counts: HashMap<i32, u32>,
    appendix: bool,
    letter_level: Option<i32>,
}

impl HeadingState {
    pub(crate) fn new() -> Self {
        Self {
            counts: HashMap::new(),
            appendix: false,
            letter_level: None,
        }
    }

    pub(crate) fn enter_appendix(&mut self) {
        if self.appendix {
            return;
        }
        self.appendix = true;
        self.letter_level = None;
    }

    pub(crate) fn next(&mut self, layout: &str, level: i32, start_appendix: bool) -> String {
        if layout.ends_with('*') || level > 3 {
            return String::new();
        }
        if start_appendix {
            self.enter_appendix();
        }
        if self.appendix && self.letter_level.is_none() {
            self.letter_level = Some(level);
            self.counts.retain(|&key, _| key < level);
        }
        *self.counts.entry(level).or_insert(0) += 1;
        self.counts.retain(|&key, _| key <= level);
        let start = if self.counts.contains_key(&0) {
            0
        } else if self.counts.contains_key(&-1) {
            -1
        } else {
            1
        };
        let mut parts = Vec::new();
        let mut l = start;
        while l <= level {
            if let Some(&n) = self.counts.get(&l) {
                if self.appendix && Some(l) == self.letter_level {
                    parts.push(alphabetic(n));
                } else {
                    parts.push(n.to_string());
                }
            }
            l += 1;
        }
        if parts.is_empty() {
            String::new()
        } else {
            format!("{} ", parts.join("."))
        }
    }
}

pub(crate) fn alphabetic(n: u32) -> String {
    let mut s = String::new();
    let mut x = n;
    while x > 0 {
        x -= 1;
        s.insert(0, char::from(b'A' + (x % 26) as u8));
        x /= 26;
    }
    if s.is_empty() { "A".into() } else { s }
}

pub(crate) fn alphabetic_lower(n: u32) -> String {
    alphabetic(n).to_lowercase()
}

pub(crate) fn section_id(number: &str, text: &str) -> String {
    let n = number.trim();
    if !n.is_empty() {
        return format!("sec-{}", n.replace('.', "-"));
    }
    let mut slug = String::new();
    let mut pending_dash = false;
    for c in text.to_lowercase().chars() {
        if c.is_ascii_alphanumeric() {
            if pending_dash && !slug.is_empty() {
                slug.push('-');
            }
            slug.push(c);
            pending_dash = false;
        } else {
            pending_dash = true;
        }
    }
    let slug: String = slug.chars().take(40).collect();
    format!("sec-{}", if slug.is_empty() { "x" } else { &slug })
}

pub(crate) fn has_start_of_appendix(ast: &Document, node: NodeId) -> bool {
    ast.node(node).children.iter().any(|&c| {
        matches!(
            &ast.node(c).kind,
            NodeKind::Property { key, .. } if key == "start_of_appendix"
        )
    })
}

pub(crate) fn heading_plain_text(ast: &Document, layout: NodeId) -> String {
    let short = mapping::argument_text(ast, layout, "1");
    if !short.is_empty() {
        return collapse_ws(&short);
    }
    let mut out = String::new();
    walk_heading_text(ast, layout, &mut out);
    collapse_ws(&out)
}

fn walk_heading_text(ast: &Document, id: NodeId, out: &mut String) {
    for &c in &ast.node(id).children {
        match &ast.node(c).kind {
            NodeKind::Text { text } => {
                if !mapping::is_status_line(text) {
                    out.push_str(&mapping::expand_special_in_text(text));
                }
            }
            NodeKind::Property { key, value } if key == "SpecialChar" => {
                out.push_str(&mapping::special_char(value.as_deref().unwrap_or("")));
            }
            NodeKind::Block { tag, args, .. } => {
                if tag == "inset" {
                    let kind = args.as_deref().unwrap_or("").trim();
                    if mapping::is_omitted_inset_kind(kind) {
                        continue;
                    }
                }
                walk_heading_text(ast, c, out);
            }
            _ => {}
        }
    }
}

fn collapse_ws(s: &str) -> String {
    s.split_whitespace().collect::<Vec<_>>().join(" ")
}

pub(crate) fn note_chapter_heading(ctx: &mut RenderCtx<'_>, level: i32, number: &str) {
    if level != 0 {
        return;
    }
    let label = number.trim();
    if label.is_empty() {
        return;
    }
    ctx.chapter_label = label.to_string();
    ctx.figure = 0;
    ctx.table = 0;
    ctx.algorithm = 0;
    ctx.listing = 0;
    ctx.float_type_counts.clear();
    ctx.sub_float_counts.clear();
}

pub(crate) fn flatten_flow(ast: &Document, nodes: &[NodeId], depth: i32) -> Vec<FlowItem> {
    let mut out = Vec::new();
    flatten_into(ast, nodes, depth, &mut out);
    out
}

fn flatten_into(ast: &Document, nodes: &[NodeId], depth: i32, out: &mut Vec<FlowItem>) {
    for &id in nodes {
        let NodeKind::Block { tag, args, .. } = &ast.node(id).kind else {
            continue;
        };
        if tag == "layout" {
            out.push(FlowItem {
                layout: args.as_deref().unwrap_or("").trim().to_string(),
                depth,
                node: id,
            });
        } else if tag == "deeper" {
            flatten_into(ast, &ast.node(id).children, depth + 1, out);
        }
    }
}

pub(crate) fn render_flow_items(
    items: &[FlowItem],
    ctx: &mut RenderCtx<'_>,
    outer_state: Option<&TraversalState>,
) -> String {
    let mut i = 0;
    let mut html = String::new();
    let mut open_levels: Vec<i32> = Vec::new();
    let mut headings = HeadingState::new();
    let mut appendix_open = false;

    // Intended deviation #2: emit `</section>` on heading transitions.
    // Deno drops those writes (`html += withLayout` evaluation order).
    let close_sections = |html: &mut String, open_levels: &mut Vec<i32>, level: i32| {
        while open_levels.last().is_some_and(|&l| l >= level) {
            html.push_str("</section>");
            open_levels.pop();
        }
    };

    while i < items.len() {
        let item = &items[i];
        if has_start_of_appendix(ctx.doc(), item.node) {
            headings.enter_appendix();
            if !appendix_open {
                close_sections(&mut html, &mut open_levels, -999);
                html.push_str(
                    r#"<div class="appendix-frame"><span class="appendix-label">Appendix</span>"#,
                );
                appendix_open = true;
            }
        }
        let layout = role(&item.layout, ctx);
        match layout {
            LayoutRole::Omit => {
                i += 1;
                continue;
            }
            LayoutRole::Title => {
                html.push_str(&mapping::with_layout(ctx, item, |ctx, selector| {
                    let id = mapping::take_owner_id(ctx, None);
                    mapping::emit_token(ctx, &id, selector);
                    format!(
                        "<h1 class=\"title\"{}>{}</h1>",
                        mapping::mapping_attrs(&id),
                        insets::render_layout_inline(item.node, ctx, true, outer_state)
                    )
                }));
                i += 1;
                continue;
            }
            LayoutRole::Front => {
                html.push_str(&mapping::with_layout(ctx, item, |ctx, selector| {
                    let id = mapping::take_owner_id(ctx, None);
                    mapping::emit_token(ctx, &id, selector);
                    format!(
                        "<div class=\"{}\"{}>{}</div>",
                        mapping::layout_slug(&item.layout),
                        mapping::mapping_attrs(&id),
                        insets::render_layout_inline(item.node, ctx, true, outer_state)
                    )
                }));
                i += 1;
                continue;
            }
            LayoutRole::Abstract => {
                let (chunk, next) = render_abstract(items, i, ctx);
                html.push_str(&chunk);
                i = next;
                continue;
            }
            LayoutRole::Heading { tag, level } => {
                close_sections(&mut html, &mut open_levels, level);
                let chunk = mapping::with_layout(ctx, item, |ctx, selector| {
                    let number = headings.next(
                        &item.layout,
                        level,
                        has_start_of_appendix(ctx.doc(), item.node),
                    );
                    note_chapter_heading(ctx, level, &number);
                    let text = heading_plain_text(ctx.doc(), item.node);
                    let id = mapping::take_owner_id(ctx, Some(&section_id(&number, &text)));
                    mapping::emit_token(ctx, &id, selector);
                    let num_html = if number.is_empty() {
                        String::new()
                    } else {
                        format!(
                            "<span class=\"heading-number\">{}</span>",
                            super::escape_live_html(&number)
                        )
                    };
                    format!(
                        "<section><{tag}{}{}>{num_html}{}</{tag}>",
                        mapping::mapping_attrs(&id),
                        paragraph_style_attr(ctx.doc(), item.node, ctx.par_indent),
                        insets::render_layout_inline(item.node, ctx, false, outer_state)
                    )
                });
                html.push_str(&chunk);
                open_levels.push(level);
                i += 1;
                continue;
            }
            LayoutRole::List { .. } => {
                let (chunk, next) = render_list(items, i, ctx, 0);
                html.push_str(&chunk);
                i = next;
                continue;
            }
            LayoutRole::Env { .. } => {
                let (chunk, next) = render_env(items, i, ctx);
                html.push_str(&chunk);
                i = next;
                continue;
            }
            LayoutRole::Flow => {}
        }
        if item.layout == "Bibliography" {
            let (chunk, next) = render_bib_env(items, i, ctx);
            html.push_str(&chunk);
            i = next;
            continue;
        }
        if item.layout == "Initial" {
            html.push_str(&mapping::with_layout(ctx, item, |ctx, selector| {
                let id = mapping::take_owner_id(ctx, None);
                mapping::emit_token(ctx, &id, selector);
                let inner = insets::render_initial(item.node, ctx);
                if inner.is_empty() {
                    return inner;
                }
                inject_mapping_after_tag(&inner, &mapping::mapping_attrs(&id))
            }));
            i += 1;
            continue;
        }
        html.push_str(&mapping::with_layout(ctx, item, |ctx, selector| {
            let inner = insets::render_layout_inline(item.node, ctx, false, outer_state);
            if inner.trim().is_empty() {
                return String::new();
            }
            let trimmed = inner.trim();
            if is_bare_figure(trimmed) {
                return inner;
            }
            let first_of_run =
                i == 0 || items[i - 1].layout != item.layout || items[i - 1].depth != item.depth;
            let label = if first_of_run {
                static_layout_label(&item.layout, ctx)
            } else {
                String::new()
            };
            let deleted_only = inner.contains(r#"class="change-deleted"#)
                && !layout_content_kinds(ctx.doc(), item.node).non_deleted;
            let deleted_class = if deleted_only { " change-deleted" } else { "" };
            let id = mapping::take_owner_id(ctx, None);
            mapping::emit_token(ctx, &id, selector);
            format!(
                "<div class=\"{}{}\"{}{}>{label}{inner}</div>",
                mapping::layout_slug(&item.layout),
                deleted_class,
                mapping::mapping_attrs(&id),
                paragraph_style_attr(ctx.doc(), item.node, ctx.par_indent)
            )
        }));
        i += 1;
    }
    close_sections(&mut html, &mut open_levels, -999);
    if appendix_open {
        html.push_str("</div>");
    }
    html
}

fn inject_mapping_after_tag(inner: &str, attrs: &str) -> String {
    let bytes = inner.as_bytes();
    if bytes.first() != Some(&b'<') {
        return inner.to_string();
    }
    let mut i = 1;
    while i < bytes.len() && (bytes[i].is_ascii_alphanumeric() || bytes[i] == b'-') {
        i += 1;
    }
    format!("{}{attrs}{}", &inner[..i], &inner[i..])
}

fn is_bare_figure(trimmed: &str) -> bool {
    (trimmed.starts_with("<figure") && trimmed.ends_with("</figure>"))
        || (trimmed.starts_with("<details")
            && trimmed.contains(" wrap")
            && trimmed.ends_with("</details>"))
}

fn is_list_layout(name: &str, ctx: &RenderCtx<'_>) -> bool {
    matches!(role(name, ctx), LayoutRole::List { .. })
}

const ENUM_CLASS: [&str; 4] = ["enumi", "enumii", "enumiii", "enumiv"];

struct CounterSnap {
    footnote: u32,
    title_foot: u32,
    figure: u32,
    table: u32,
    algorithm: u32,
    listing: u32,
    equation: u32,
    nomencl_seq: u32,
    index_seq: u32,
    bibitem: u32,
    layout_counters: std::collections::HashMap<String, u32>,
    float_type_counts: std::collections::HashMap<String, u32>,
    sub_float_counts: std::collections::HashMap<String, u32>,
    in_float: bool,
    longtable_number: Option<String>,
    float_number_stack: Vec<String>,
    subeq: Option<super::SubeqState>,
    tokens: Vec<super::LiveToken>,
    tok_seq: u32,
    current_layout_selector: Option<String>,
    current_layout_node: Option<NodeId>,
    current_inset_selector: Option<String>,
    current_inset_node: Option<NodeId>,
    used_token_ids: std::collections::HashSet<String>,
}

fn snapshot_counters(ctx: &RenderCtx<'_>) -> CounterSnap {
    CounterSnap {
        footnote: ctx.footnote,
        title_foot: ctx.title_foot,
        figure: ctx.figure,
        table: ctx.table,
        algorithm: ctx.algorithm,
        listing: ctx.listing,
        equation: ctx.equation,
        nomencl_seq: ctx.nomencl_seq,
        index_seq: ctx.index_seq,
        bibitem: ctx.bibitem,
        layout_counters: ctx.layout_counters.clone(),
        float_type_counts: ctx.float_type_counts.clone(),
        sub_float_counts: ctx.sub_float_counts.clone(),
        in_float: ctx.in_float,
        longtable_number: ctx.longtable_number.clone(),
        float_number_stack: ctx.float_number_stack.clone(),
        subeq: ctx.subeq.as_ref().map(|s| super::SubeqState {
            parent: s.parent,
            child: s.child,
        }),
        tokens: ctx.tokens.clone(),
        tok_seq: ctx.tok_seq,
        current_layout_selector: ctx.current_layout_selector.clone(),
        current_layout_node: ctx.current_layout_node,
        current_inset_selector: ctx.current_inset_selector.clone(),
        current_inset_node: ctx.current_inset_node,
        used_token_ids: ctx.used_token_ids.clone(),
    }
}

fn restore_counters(ctx: &mut RenderCtx<'_>, snap: CounterSnap) {
    ctx.footnote = snap.footnote;
    ctx.title_foot = snap.title_foot;
    ctx.figure = snap.figure;
    ctx.table = snap.table;
    ctx.algorithm = snap.algorithm;
    ctx.listing = snap.listing;
    ctx.equation = snap.equation;
    ctx.nomencl_seq = snap.nomencl_seq;
    ctx.index_seq = snap.index_seq;
    ctx.bibitem = snap.bibitem;
    ctx.layout_counters = snap.layout_counters;
    ctx.float_type_counts = snap.float_type_counts;
    ctx.sub_float_counts = snap.sub_float_counts;
    ctx.in_float = snap.in_float;
    ctx.longtable_number = snap.longtable_number;
    ctx.float_number_stack = snap.float_number_stack;
    ctx.subeq = snap.subeq;
    ctx.tokens = snap.tokens;
    ctx.tok_seq = snap.tok_seq;
    ctx.current_layout_selector = snap.current_layout_selector;
    ctx.current_layout_node = snap.current_layout_node;
    ctx.current_inset_selector = snap.current_inset_selector;
    ctx.current_inset_node = snap.current_inset_node;
    ctx.used_token_ids = snap.used_token_ids;
}

fn is_break_chrome_only(html: &str) -> bool {
    let trimmed = html.trim();
    if trimmed.is_empty() {
        return false;
    }
    if !trimmed.contains(r#"class="lyx-pagebreak"#)
        && !trimmed.contains(r#"class="lyx-separator"#)
        && !trimmed.contains(r#"class="lyx-vspace"#)
    {
        return false;
    }
    let mut stripped = trimmed.to_string();
    stripped = strip_div_class(&stripped, "lyx-pagebreak");
    stripped = strip_div_class(&stripped, "lyx-separator");
    stripped = strip_div_class(&stripped, "lyx-vspace");
    stripped.trim().is_empty()
}

fn strip_div_class(html: &str, class: &str) -> String {
    let mut out = String::new();
    let mut rest = html;
    let open = format!(r#"<div class="{class}"#);
    while let Some(start) = rest.find(&open) {
        out.push_str(&rest[..start]);
        let after = &rest[start..];
        if let Some(end) = after.find("</div>") {
            rest = &after[end + 6..];
        } else {
            rest = "";
            break;
        }
    }
    out.push_str(rest);
    out
}

fn is_skippable_flow(item: &FlowItem, ctx: &mut RenderCtx<'_>) -> bool {
    if !matches!(role(&item.layout, ctx), LayoutRole::Flow) {
        return false;
    }
    let snap = snapshot_counters(ctx);
    let html = insets::render_layout_inline(item.node, ctx, false, None);
    let html = html.trim();
    let skip = html.is_empty() || is_break_chrome_only(html);
    restore_counters(ctx, snap);
    skip
}

struct ContentKinds {
    non_deleted: bool,
    deleted: bool,
}

fn layout_content_kinds(ast: &Document, block: NodeId) -> ContentKinds {
    let mut kinds = ContentKinds {
        non_deleted: false,
        deleted: false,
    };
    walk_content_kinds(ast, block, &mut create_traversal_state(), &mut kinds);
    kinds
}

fn walk_content_kinds(
    ast: &Document,
    id: NodeId,
    state: &mut TraversalState,
    kinds: &mut ContentKinds,
) {
    if kinds.non_deleted && kinds.deleted {
        return;
    }
    for &c in &ast.node(id).children {
        if kinds.non_deleted && kinds.deleted {
            return;
        }
        match &ast.node(c).kind {
            NodeKind::Property { key, value } => {
                if key == "SpecialChar" || key == "backslash" {
                    if traversal_region(state) == TextRegion::Deleted {
                        kinds.deleted = true;
                    } else {
                        kinds.non_deleted = true;
                    }
                    continue;
                }
                advance_traversal_state(state, key, value.as_deref());
            }
            NodeKind::Text { text } => {
                if mapping::is_status_line(text) || text.trim().is_empty() {
                    continue;
                }
                if traversal_region(state) == TextRegion::Deleted {
                    kinds.deleted = true;
                } else {
                    kinds.non_deleted = true;
                }
            }
            NodeKind::Block { tag, args, .. } => {
                if tag == "inset" {
                    let kind = args.as_deref().unwrap_or("").trim();
                    if kind == "ERT"
                        || is_invisible_inset(tag, args.as_deref())
                        || mapping::is_omitted_inset_kind(kind)
                    {
                        continue;
                    }
                }
                let mut child = enter_traversal_state(state);
                walk_content_kinds(ast, c, &mut child, kinds);
            }
            _ => {}
        }
    }
}

fn list_open_tag(tag: &str, layout: &str, enum_depth: usize) -> String {
    if layout == "Description" || tag == "dl" {
        return r#"<dl class="description">"#.into();
    }
    if tag == "ol" {
        let cls = ENUM_CLASS[enum_depth.min(ENUM_CLASS.len() - 1)];
        return format!(r#"<ol class="{cls}">"#);
    }
    format!("<{tag}>")
}

fn render_list(
    items: &[FlowItem],
    start: usize,
    ctx: &mut RenderCtx<'_>,
    enum_depth: usize,
) -> (String, usize) {
    let first = &items[start];
    let spec = role(&first.layout, ctx);
    let LayoutRole::List {
        tag,
        item: item_tag,
    } = spec
    else {
        return (String::new(), start);
    };
    let depth = first.depth;
    let child_enum = if tag == "ol" {
        enum_depth + 1
    } else {
        enum_depth
    };
    let mut i = start;
    let mut html = list_open_tag(&tag, &first.layout, enum_depth);
    while i < items.len() {
        let item = &items[i];
        if item.depth < depth {
            break;
        }
        if item.depth == depth {
            if item.layout != first.layout {
                if is_skippable_flow(item, ctx) {
                    i += 1;
                    continue;
                }
                break;
            }
            if first.layout == "Description" || tag == "dl" {
                html.push_str(&mapping::with_layout(ctx, item, |ctx, selector| {
                    let (label, rest) = split_description(item.node, ctx);
                    let dt_id = mapping::take_owner_id(ctx, None);
                    mapping::emit_token(ctx, &dt_id, selector);
                    let dd_id = mapping::take_owner_id(ctx, None);
                    mapping::emit_token(ctx, &dd_id, selector);
                    format!(
                        "<dt{}>{label}</dt><dd{}{}>{rest}",
                        mapping::mapping_attrs(&dt_id),
                        mapping::mapping_attrs(&dd_id),
                        paragraph_style_attr(ctx.doc(), item.node, ctx.par_indent)
                    )
                }));
                i += 1;
                while i < items.len() && items[i].depth > depth {
                    if is_skippable_flow(&items[i], ctx) {
                        i += 1;
                        continue;
                    }
                    if !is_list_layout(&items[i].layout, ctx) {
                        break;
                    }
                    let (nested, next) = render_list(items, i, ctx, child_enum);
                    html.push_str(&nested);
                    i = next;
                }
                html.push_str("</dd>");
            } else {
                html.push_str(&mapping::with_layout(ctx, item, |ctx, selector| {
                    let id = mapping::take_owner_id(ctx, None);
                    mapping::emit_token(ctx, &id, selector);
                    format!(
                        "<{item_tag}{}{}>{}",
                        mapping::mapping_attrs(&id),
                        paragraph_style_attr(ctx.doc(), item.node, ctx.par_indent),
                        insets::render_layout_inline(item.node, ctx, false, None)
                    )
                }));
                i += 1;
                while i < items.len() && items[i].depth > depth {
                    if is_skippable_flow(&items[i], ctx) {
                        i += 1;
                        continue;
                    }
                    if !is_list_layout(&items[i].layout, ctx) {
                        break;
                    }
                    let (nested, next) = render_list(items, i, ctx, child_enum);
                    html.push_str(&nested);
                    i = next;
                }
                html.push_str(&format!("</{item_tag}>"));
            }
        } else if is_skippable_flow(item, ctx) {
            i += 1;
        } else if is_list_layout(&item.layout, ctx) {
            let (nested, next) = render_list(items, i, ctx, child_enum);
            html.push_str(&nested);
            i = next;
        } else {
            break;
        }
    }
    html.push_str(&format!("</{tag}>"));
    (html, i)
}

fn render_env(items: &[FlowItem], start: usize, ctx: &mut RenderCtx<'_>) -> (String, usize) {
    let first = &items[start];
    let spec = role(&first.layout, ctx);
    let LayoutRole::Env { tag, item } = spec else {
        return (String::new(), start);
    };
    let cls = format!(r#" class="{}""#, mapping::layout_slug(&first.layout));
    let mut i = start;
    if item == "NONE" {
        let mut lines = Vec::new();
        while i < items.len() && items[i].layout == first.layout && items[i].depth == first.depth {
            let item_flow = &items[i];
            lines.push(mapping::with_layout(ctx, item_flow, |ctx, selector| {
                let id = mapping::take_owner_id(ctx, None);
                mapping::emit_token(ctx, &id, selector);
                let body = insets::render_layout_inline(item_flow.node, ctx, false, None);
                format!("<span{}>{body}</span>", mapping::mapping_attrs(&id))
            }));
            i += 1;
        }
        return (format!("<{tag}{cls}>{}</{tag}>", lines.join("\n")), i);
    }
    let mut html = format!("<{tag}{cls}>");
    while i < items.len() && items[i].layout == first.layout && items[i].depth == first.depth {
        html.push_str(&mapping::with_layout(ctx, &items[i], |ctx, selector| {
            let id = mapping::take_owner_id(ctx, None);
            mapping::emit_token(ctx, &id, selector);
            format!(
                "<{item}{}{}>{}</{item}>",
                mapping::mapping_attrs(&id),
                paragraph_style_attr(ctx.doc(), items[i].node, ctx.par_indent),
                insets::render_layout_inline(items[i].node, ctx, false, None)
            )
        }));
        i += 1;
    }
    html.push_str(&format!("</{tag}>"));
    (html, i)
}

fn split_description(layout: NodeId, ctx: &mut RenderCtx<'_>) -> (String, String) {
    let mut label = String::new();
    let mut rest = String::new();
    let mut in_rest = false;
    let mut state = create_traversal_state();
    split_description_walk(layout, ctx, &mut state, &mut label, &mut rest, &mut in_rest);
    (label.trim().to_string(), rest.trim().to_string())
}

fn split_description_walk(
    id: NodeId,
    ctx: &mut RenderCtx<'_>,
    state: &mut TraversalState,
    label: &mut String,
    rest: &mut String,
    in_rest: &mut bool,
) {
    let children = ctx.doc().node(id).children.clone();
    for &c in &children {
        match &ctx.doc().node(c).kind.clone() {
            NodeKind::Property { key, value } => {
                if *in_rest && key == "SpecialChar" {
                    if traversal_region(state) != TextRegion::Deleted {
                        rest.push_str(&super::escape_live_html(&mapping::special_char(
                            value.as_deref().unwrap_or(""),
                        )));
                    }
                    continue;
                }
                if *in_rest && key == "backslash" {
                    if traversal_region(state) != TextRegion::Deleted {
                        rest.push('\\');
                    }
                    continue;
                }
                advance_traversal_state(state, key, value.as_deref());
            }
            NodeKind::Text { text } => {
                if traversal_region(state) == TextRegion::Deleted {
                    continue;
                }
                if *in_rest {
                    rest.push_str(&super::escape_live_html(&mapping::expand_special_in_text(
                        text,
                    )));
                    continue;
                }
                let cut = text.find([' ', '\t']);
                if let Some(cut) = cut {
                    label.push_str(&super::escape_live_html(&text[..cut]));
                    let tail = &text[cut + 1..];
                    if !tail.is_empty() {
                        rest.push_str(&super::escape_live_html(&mapping::expand_special_in_text(
                            tail,
                        )));
                    }
                    *in_rest = true;
                } else {
                    label.push_str(&super::escape_live_html(text));
                }
            }
            NodeKind::Block { tag, args, .. } => {
                let tag = tag.clone();
                let args = args.clone();
                if *in_rest {
                    if traversal_region(state) == TextRegion::Deleted {
                        continue;
                    }
                    rest.push_str(&insets::render_inset(c, state, ctx));
                    continue;
                }
                if traversal_region(state) == TextRegion::Deleted {
                    continue;
                }
                let kind = if tag == "inset" {
                    args.as_deref().unwrap_or("").trim().to_string()
                } else {
                    String::new()
                };
                if tag == "inset"
                    && (mapping::is_omitted_inset_kind(&kind)
                        || is_invisible_inset(&tag, args.as_deref()))
                {
                    if kind == "Index"
                        || kind.starts_with("Index ")
                        || kind == "Nomenclature"
                        || kind.starts_with("Nomenclature ")
                    {
                        label.push_str(&insets::render_inset(c, state, ctx));
                    }
                    continue;
                }
                if tag == "inset" {
                    label.push_str(&insets::render_inset(c, state, ctx));
                    continue;
                }
                let mut child = enter_traversal_state(state);
                split_description_walk(c, ctx, &mut child, label, rest, in_rest);
            }
            _ => {}
        }
    }
}

fn render_abstract(items: &[FlowItem], start: usize, ctx: &mut RenderCtx<'_>) -> (String, usize) {
    let mut i = start;
    let mut html =
        r#"<div class="abstract"><span class="abstract_label">Abstract</span>"#.to_string();
    while i < items.len() && items[i].layout == "Abstract" && items[i].depth == items[start].depth {
        html.push_str(&mapping::with_layout(ctx, &items[i], |ctx, selector| {
            let id = mapping::take_owner_id(ctx, None);
            mapping::emit_token(ctx, &id, selector);
            format!(
                "<div class=\"abstract_item\"{}>{}</div>",
                mapping::mapping_attrs(&id),
                insets::render_layout_inline(items[i].node, ctx, true, None)
            )
        }));
        i += 1;
    }
    html.push_str("</div>");
    (html, i)
}

fn render_bib_env(items: &[FlowItem], start: usize, ctx: &mut RenderCtx<'_>) -> (String, usize) {
    let title = ctx
        .layout_html
        .as_ref()
        .and_then(|h| h.get("Bibliography"))
        .and_then(|s| s.label_string.as_deref())
        .unwrap_or("References");
    let mut html = format!(
        r#"<div class="bibliography"><h2 class="bibliography">{}</h2>"#,
        super::escape_live_html(title)
    );
    let mut i = start;
    while i < items.len()
        && items[i].layout == "Bibliography"
        && items[i].depth == items[start].depth
    {
        html.push_str(&mapping::with_layout(ctx, &items[i], |ctx, selector| {
            let id = mapping::take_owner_id(ctx, None);
            mapping::emit_token(ctx, &id, selector);
            format!(
                "<div class=\"bibitem\"{}>{}</div>",
                mapping::mapping_attrs(&id),
                insets::render_layout_inline(items[i].node, ctx, false, None)
            )
        }));
        i += 1;
    }
    html.push_str("</div>");
    (html, i)
}

fn paragraph_style_attr(ast: &Document, node: NodeId, par_indent: bool) -> String {
    let mut align = None;
    let mut noindent = false;
    let mut leftindent = None;
    let mut spacing = None;
    for &c in &ast.node(node).children {
        let NodeKind::Property { key, value: v } = &ast.node(c).kind else {
            continue;
        };
        match key.as_str() {
            "align" => {
                if let Some(v) = v {
                    align = Some(v.to_ascii_lowercase());
                }
            }
            "noindent" => noindent = true,
            "indent" => noindent = false,
            "leftindent" => leftindent = v.clone(),
            "paragraph_spacing" => spacing = v.clone(),
            _ => {}
        }
    }
    let mut styles = Vec::new();
    match align.as_deref() {
        Some("center") => styles.push("text-align: center".into()),
        Some("left") => styles.push("text-align: left".into()),
        Some("right") => styles.push("text-align: right".into()),
        Some("block") => styles.push("text-align: justify".into()),
        _ => {}
    }
    let center_or_right = matches!(align.as_deref(), Some("center" | "right"));
    if noindent || (par_indent && center_or_right) {
        styles.push("text-indent: 0".into());
    }
    if let Some(len) = leftindent
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
    {
        styles.push(format!("padding-left: {len}"));
    }
    if let Some(line_height) = spacing_line_height(spacing.as_deref()) {
        styles.push(format!("line-height: {line_height}"));
    }
    if styles.is_empty() {
        String::new()
    } else {
        format!(r#" style="{}""#, styles.join("; "))
    }
}

fn spacing_line_height(value: Option<&str>) -> Option<String> {
    let raw = value?.trim();
    let mut parts = raw.split_whitespace();
    let kind = parts.next()?.to_ascii_lowercase();
    match kind.as_str() {
        "single" => Some("1".into()),
        "onehalf" => Some("1.5".into()),
        "double" => Some("2".into()),
        "other" => {
            let n = parts.next()?.trim();
            if n.is_empty() {
                None
            } else {
                Some(n.to_string())
            }
        }
        _ => None,
    }
}

fn static_layout_label(name: &str, ctx: &mut RenderCtx<'_>) -> String {
    let Some(spec) = layout_html_spec(name, ctx.layout_html.as_ref()) else {
        return String::new();
    };
    if spec
        .label_type
        .as_deref()
        .map(|t| t.eq_ignore_ascii_case("static"))
        != Some(true)
    {
        return String::new();
    }
    let mut fmt = spec.label_string.clone().unwrap_or_default();
    if fmt == name {
        return String::new();
    }
    if let Some(counter) = spec.label_counter.as_deref() {
        let n = ctx.layout_counters.get(counter).copied().unwrap_or(0) + 1;
        ctx.layout_counters.insert(counter.to_string(), n);
        fmt = replace_the_counters(&fmt, &n.to_string());
    }
    fmt = replace_the_counters(&fmt, "");
    let fmt = collapse_ws(&fmt);
    if fmt.is_empty() {
        return String::new();
    }
    format!(
        r#"<span class="layout-label">{}</span> "#,
        super::escape_live_html(&fmt)
    )
}

fn replace_the_counters(fmt: &str, with: &str) -> String {
    let mut out = String::new();
    let mut rest = fmt;
    while let Some(pos) = rest.find("\\the") {
        out.push_str(&rest[..pos]);
        let after = &rest[pos + 4..];
        let n = after
            .find(|c: char| !c.is_ascii_alphabetic())
            .unwrap_or(after.len());
        out.push_str(with);
        rest = &after[n..];
    }
    out.push_str(rest);
    out
}
