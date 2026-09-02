//! Semantic HTML comparison (Deno `preview.ts` `normalizeReaderHtml`).

use std::collections::{HashMap, HashSet};

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SemNode {
    pub role: String,
    pub text: Option<String>,
    pub attrs: Option<HashMap<String, String>>,
    pub children: Vec<SemNode>,
}

const VOID_TAGS: &[&str] = &["br", "img", "hr", "meta", "link", "input"];

const INLINE_MERGE_ROLES: &[&str] = &["emphasis", "strong", "underline", "strike"];

const INLINE_EDGE_ROLES: &[&str] = &[
    "wrap",
    "emphasis",
    "strong",
    "underline",
    "strike",
    "ref",
    "link",
    "citation",
    "shortcut",
    "icon",
];

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum ChangeView {
    Accepted,
}

pub fn normalize_reader_html(html: &str, change_view: Option<&str>) -> SemNode {
    let view = match change_view {
        Some("accepted") => Some(ChangeView::Accepted),
        _ => None,
    };
    let parsed = parse_fragment(html);
    collapse(map_role(&parsed, view))
}

pub fn semantic_equal(a: &SemNode, b: &SemNode) -> bool {
    strip_empty(a) == strip_empty(b)
}

pub fn format_sem(node: &SemNode, indent: usize) -> String {
    let pad = "  ".repeat(indent);
    let attr = match &node.attrs {
        Some(attrs) if !attrs.is_empty() => {
            let mut parts: Vec<_> = attrs.iter().map(|(k, v)| format!("{k}={v}")).collect();
            parts.sort();
            format!(" {}", parts.join(" "))
        }
        _ => String::new(),
    };
    let text = node
        .text
        .as_ref()
        .map(|t| format!(" \"{t}\""))
        .unwrap_or_default();
    let mut lines = vec![format!("{pad}{}{attr}{text}", node.role)];
    for c in &node.children {
        lines.push(format_sem(c, indent + 1));
    }
    lines.join("\n")
}

fn strip_empty(node: &SemNode) -> SemNode {
    let children: Vec<SemNode> = node
        .children
        .iter()
        .map(strip_empty)
        .filter(|c| !(c.role == "text" && c.text.as_deref().is_none_or(str::is_empty)))
        .collect();
    let mut next = SemNode {
        role: node.role.clone(),
        text: None,
        attrs: None,
        children,
    };
    if let Some(t) = &node.text
        && !t.is_empty()
    {
        next.text = Some(t.clone());
    }
    if let Some(attrs) = &node.attrs
        && !attrs.is_empty()
    {
        next.attrs = Some(attrs.clone());
    }
    next
}

fn collapse(node: SemNode) -> SemNode {
    let mut children: Vec<SemNode> = node
        .children
        .into_iter()
        .map(collapse)
        .flat_map(|c| flatten_child(&node.role, c))
        .collect();
    if node.role == "figure" {
        children = children
            .into_iter()
            .map(|c| {
                if c.role != "text" {
                    return c;
                }
                let Some(text) = &c.text else {
                    return c;
                };
                let stripped = strip_float_prefix(text);
                if stripped == *text {
                    return c;
                }
                SemNode {
                    role: "caption".into(),
                    text: None,
                    attrs: None,
                    children: vec![SemNode {
                        role: "text".into(),
                        text: Some(stripped),
                        attrs: None,
                        children: Vec::new(),
                    }],
                }
            })
            .collect();
    }
    if node.role == "caption" {
        for c in &mut children {
            if c.role == "text"
                && let Some(text) = &c.text
            {
                c.text = Some(strip_float_prefix(text));
            }
        }
    }
    let mut merged: Vec<SemNode> = Vec::new();
    for c in children {
        if let Some(last) = merged.last_mut()
            && c.role == "text"
            && last.role == "text"
        {
            let combined = format!(
                "{}{}",
                last.text.as_deref().unwrap_or(""),
                c.text.as_deref().unwrap_or("")
            );
            last.text = Some(combined);
            continue;
        }
        if INLINE_MERGE_ROLES.contains(&c.role.as_str())
            && let Some(last) = merged.last_mut()
            && c.role == last.role
            && attrs_eq(c.attrs.as_ref(), last.attrs.as_ref())
        {
            for inner in c.children {
                if let Some(tail) = last.children.last_mut()
                    && inner.role == "text"
                    && tail.role == "text"
                {
                    let combined = format!(
                        "{}{}",
                        tail.text.as_deref().unwrap_or(""),
                        inner.text.as_deref().unwrap_or("")
                    );
                    tail.text = Some(combined);
                } else {
                    last.children.push(inner);
                }
            }
            continue;
        }
        merged.push(c);
    }
    if node.role != "pre" {
        for cur in &mut merged {
            if cur.role == "text"
                && let Some(t) = &cur.text
            {
                cur.text = Some(collapse_ws(t, false));
            }
        }
        if !INLINE_EDGE_ROLES.contains(&node.role.as_str()) {
            if let Some(first) = merged.first_mut()
                && first.role == "text"
                && let Some(t) = &first.text
            {
                first.text = Some(t.trim_start().to_string());
            }
            if let Some(last) = merged.last_mut()
                && last.role == "text"
                && let Some(t) = &last.text
            {
                last.text = Some(t.trim_end().to_string());
            }
        }
        let blocky: HashSet<&str> = [
            "list",
            "table",
            "figure",
            "section",
            "quote",
            "formula",
            "document",
            "heading",
            "paragraph",
            "caption",
            "title",
            "abstract",
            "author",
            "note",
        ]
        .into_iter()
        .collect();
        let len = merged.len();
        for i in 0..len {
            if merged[i].role != "text" {
                continue;
            }
            if i > 0
                && blocky.contains(merged[i - 1].role.as_str())
                && let Some(t) = &merged[i].text
            {
                merged[i].text = Some(t.trim_start().to_string());
            }
            if i + 1 < len
                && blocky.contains(merged[i + 1].role.as_str())
                && let Some(t) = &merged[i].text
            {
                merged[i].text = Some(t.trim_end().to_string());
            }
        }
        merged.retain(|cur| {
            !(cur.role == "text" && cur.text.as_deref().is_none_or(|t| t.trim().is_empty()))
        });
    }
    let mut next = SemNode {
        role: node.role.clone(),
        text: None,
        attrs: None,
        children: merged,
    };
    if let Some(t) = &node.text {
        next.text = Some(if node.role == "formula" {
            normalize_formula(t)
        } else {
            collapse_ws(t, node.role == "pre")
        });
    }
    if let Some(attrs) = &node.attrs
        && !attrs.is_empty()
    {
        next.attrs = Some(attrs.clone());
    }
    if let Some(t) = &next.text
        && next.role != "pre"
        && next.role != "formula"
    {
        next.text = Some(collapse_ws(t, false));
    }
    if next.role != "pre" {
        for c in &mut next.children {
            if c.role == "text"
                && let Some(t) = &c.text
            {
                c.text = Some(collapse_ws(t, false));
            }
        }
    }
    next
}

fn flatten_child(parent_role: &str, c: SemNode) -> Vec<SemNode> {
    if c.role == "wrap" {
        return c.children;
    }
    if c.role == "text"
        && c.text.as_deref().is_none_or(|t| t.trim().is_empty())
        && parent_role != "pre"
    {
        if c.text
            .as_deref()
            .is_some_and(|t| !t.is_empty() && t.chars().all(|ch| ch == ' ' || ch == '\t'))
        {
            return vec![SemNode {
                role: "text".into(),
                text: Some(" ".into()),
                attrs: None,
                children: Vec::new(),
            }];
        }
        return Vec::new();
    }
    if (parent_role == "cell" || parent_role == "figure") && c.role == "paragraph" {
        return c.children;
    }
    if parent_role == "caption" && c.role == "paragraph" {
        return c.children;
    }
    if (parent_role == "author" || parent_role == "title") && c.role == "footnote" {
        return vec![SemNode {
            role: "text".into(),
            text: Some(collect_text(&c)),
            attrs: None,
            children: Vec::new(),
        }];
    }
    vec![c]
}

fn strip_float_prefix(text: &str) -> String {
    let lower = text.to_ascii_lowercase();
    for prefix in ["figure", "table"] {
        if let Some(rest) = lower.strip_prefix(prefix) {
            let rest = rest.trim_start();
            let digits = rest.chars().take_while(|c| c.is_ascii_digit()).count();
            if digits == 0 {
                continue;
            }
            let after_num = &rest[digits..];
            if let Some(colon) = after_num.strip_prefix(':') {
                return text[text.len() - colon.trim_start().len()..].to_string();
            }
        }
    }
    text.to_string()
}

fn attrs_eq(a: Option<&HashMap<String, String>>, b: Option<&HashMap<String, String>>) -> bool {
    match (a, b) {
        (None, None) => true,
        (Some(a), Some(b)) => a == b,
        (None, Some(b)) => b.is_empty(),
        (Some(a), None) => a.is_empty(),
    }
}

fn normalize_formula(source: &str) -> String {
    let t = source.trim();
    let t = if (t.starts_with("$$") && t.ends_with("$$") && t.len() >= 4)
        || (t.starts_with("\\[") && t.ends_with("\\]") && t.len() >= 4)
    {
        &t[2..t.len() - 2]
    } else if t.starts_with('$') && t.ends_with('$') && t.len() >= 2 {
        &t[1..t.len() - 1]
    } else {
        t
    };
    t.trim().to_string()
}

fn collapse_ws(text: &str, preserve: bool) -> String {
    if preserve {
        return text.to_string();
    }
    let mut out = String::new();
    let mut pending_ws = false;
    let punct = ['.', ',', ';', ':', '!', '?'];
    for ch in text.chars() {
        if ch == ' ' || ch == '\t' || ch == '\r' || ch == '\n' {
            pending_ws = true;
            continue;
        }
        if pending_ws && !punct.contains(&ch) {
            out.push(' ');
        }
        pending_ws = false;
        out.push(ch);
    }
    if pending_ws {
        out.push(' ');
    }
    out
}

fn map_role(node: &SemNode, change_view: Option<ChangeView>) -> SemNode {
    let tag = node.role.as_str();
    let cls = node
        .attrs
        .as_ref()
        .and_then(|a| a.get("class"))
        .cloned()
        .unwrap_or_default();
    let classes: Vec<&str> = cls.split_whitespace().filter(|s| !s.is_empty()).collect();
    let children: Vec<SemNode> = node
        .children
        .iter()
        .map(|c| map_role(c, change_view))
        .collect();
    if tag == "root" {
        if children.len() == 1 && children[0].role == "document" {
            return children.into_iter().next().expect("invariant: one child");
        }
        return SemNode {
            role: "document".into(),
            text: None,
            attrs: None,
            children,
        };
    }
    if tag == "article" {
        return SemNode {
            role: "document".into(),
            text: None,
            attrs: None,
            children,
        };
    }
    if tag == "section" {
        return SemNode {
            role: "section".into(),
            text: None,
            attrs: None,
            children,
        };
    }
    if tag == "h1" && classes.contains(&"title") {
        return SemNode {
            role: "title".into(),
            text: None,
            attrs: None,
            children,
        };
    }
    if matches!(tag, "h1" | "h2" | "h3" | "h4" | "h5" | "h6") {
        let mut attrs = HashMap::new();
        attrs.insert("level".into(), tag[1..].to_string());
        return SemNode {
            role: "heading".into(),
            text: None,
            attrs: Some(attrs),
            children,
        };
    }
    if tag == "blockquote" {
        return wrap_role("quote", children);
    }
    if tag == "pre" {
        return wrap_role("pre", children);
    }
    if tag == "ul" || tag == "ol" || tag == "dl" {
        let mut attrs = HashMap::new();
        attrs.insert("kind".into(), tag.to_string());
        return SemNode {
            role: "list".into(),
            text: None,
            attrs: Some(attrs),
            children,
        };
    }
    if tag == "li" || tag == "dd" {
        return wrap_role("item", children);
    }
    if tag == "dt" {
        return wrap_role("term", children);
    }
    if tag == "table" {
        return wrap_role("table", children);
    }
    if tag == "tbody" || tag == "thead" || tag == "tfoot" {
        return wrap_role("wrap", children);
    }
    if tag == "tr" {
        return wrap_role("row", children);
    }
    if tag == "td" || tag == "th" {
        return wrap_role("cell", children);
    }
    if tag == "figure" {
        return wrap_role("figure", children);
    }
    if tag == "figcaption" || tag == "caption" {
        return wrap_role("caption", children);
    }
    if tag == "math" || classes.iter().any(|c| *c == "formula" || *c == "math") {
        let tex = find_tex_annotation(node);
        let mut text = normalize_formula(&tex.unwrap_or_else(|| collect_text(node)));
        if let Some(eqno) = find_eqno(node)
            && !text.ends_with(&eqno)
        {
            text.push_str(&eqno);
        }
        return SemNode {
            role: "formula".into(),
            text: Some(text),
            attrs: None,
            children: Vec::new(),
        };
    }
    if classes.iter().any(|c| *c == "foot" || *c == "foot_inner") {
        if classes.contains(&"foot_label") {
            return wrap_role("footnote-label", children);
        }
        if classes.contains(&"foot_inner") {
            return wrap_role("footnote-body", children);
        }
        return wrap_role("footnote", children);
    }
    if tag == "img" {
        let from_attr = node
            .attrs
            .as_ref()
            .and_then(|a| {
                a.get("data-info-file")
                    .or_else(|| a.get("data-info-icon"))
                    .or_else(|| a.get("aria-label"))
                    .or_else(|| a.get("title"))
            })
            .cloned()
            .unwrap_or_default();
        let from_file = basename_attr(
            node.attrs
                .as_ref()
                .and_then(|a| a.get("src"))
                .map(String::as_str)
                .unwrap_or(""),
        );
        let from_file = strip_image_ext(&from_file);
        let icon_name = if !from_attr.trim().is_empty() {
            from_attr.trim().to_string()
        } else {
            from_file.trim().to_string()
        };
        if classes.contains(&"info-icon")
            || node
                .attrs
                .as_ref()
                .is_some_and(|a| a.contains_key("data-info-icon"))
        {
            return SemNode {
                role: "icon".into(),
                text: None,
                attrs: if icon_name.is_empty() {
                    None
                } else {
                    Some(HashMap::from([("name".into(), icon_name)]))
                },
                children: Vec::new(),
            };
        }
        let src = node
            .attrs
            .as_ref()
            .and_then(|a| a.get("data-filename").cloned())
            .unwrap_or_else(|| {
                basename_attr(
                    node.attrs
                        .as_ref()
                        .and_then(|a| a.get("src"))
                        .map(String::as_str)
                        .unwrap_or(""),
                )
            });
        return SemNode {
            role: "image".into(),
            text: None,
            attrs: if src.is_empty() {
                None
            } else {
                Some(HashMap::from([("filename".into(), src)]))
            },
            children: Vec::new(),
        };
    }
    if tag == "br" {
        return wrap_role("break", Vec::new());
    }
    if tag == "details" {
        if classes.iter().any(|c| *c == "foot" || *c == "foot_intitle") {
            return wrap_role("footnote", children);
        }
        return wrap_role("wrap", children);
    }
    if tag == "summary" {
        if classes.contains(&"foot_label") || classes.contains(&"foot_intitle_label") {
            return wrap_role("wrap", children);
        }
        return wrap_role("wrap", Vec::new());
    }
    if tag == "em" || tag == "i" {
        return wrap_role("emphasis", children);
    }
    if tag == "strong" || tag == "b" {
        return wrap_role("strong", children);
    }
    if tag == "u" {
        return wrap_role("underline", children);
    }
    if (tag == "ins" || tag == "del")
        && classes
            .iter()
            .any(|c| *c == "change-inserted" || *c == "change-deleted")
    {
        if change_view == Some(ChangeView::Accepted) && tag == "del" {
            return wrap_role("wrap", Vec::new());
        }
        return wrap_role("wrap", children);
    }
    if tag == "s" || tag == "del" {
        return wrap_role("strike", children);
    }
    if tag == "aside" {
        return wrap_role("note", children);
    }
    if (tag == "kbd" || tag == "bdo")
        && classes
            .iter()
            .any(|c| *c == "shortcut" || *c == "shortcuts" || *c == "info-shortcut")
    {
        let text = collapse_ws(&collect_text(node), false).trim().to_string();
        return SemNode {
            role: "shortcut".into(),
            text: if text.is_empty() { None } else { Some(text) },
            attrs: None,
            children: Vec::new(),
        };
    }
    if tag == "a" {
        let href = node
            .attrs
            .as_ref()
            .and_then(|a| a.get("href"))
            .cloned()
            .unwrap_or_default();
        if classes.iter().any(|c| *c == "ref" || *c == "reference") {
            return map_ref_role(node, children);
        }
        if href.starts_with('#') {
            return map_ref_role(node, children);
        }
        if classes.contains(&"citation") {
            return wrap_role("citation", children);
        }
        if classes.contains(&"href") || !href.is_empty() {
            return SemNode {
                role: "link".into(),
                text: None,
                attrs: if href.is_empty() {
                    None
                } else {
                    Some(HashMap::from([("href".into(), href)]))
                },
                children,
            };
        }
        if node.attrs.as_ref().is_some_and(|a| a.contains_key("id"))
            && href.is_empty()
            && children.is_empty()
        {
            return wrap_role("wrap", Vec::new());
        }
    }
    if tag == "p" || tag == "div" {
        if change_view == Some(ChangeView::Accepted) && classes.contains(&"change-deleted") {
            return wrap_role("wrap", Vec::new());
        }
        if classes
            .iter()
            .any(|c| *c == "float-figure" || *c == "float-table")
        {
            return wrap_role("figure", children);
        }
        if classes.contains(&"float-body") {
            return wrap_role("wrap", children);
        }
        if classes.contains(&"abstract") {
            return wrap_role("abstract", children);
        }
        if classes.contains(&"author") {
            return wrap_role("author", children);
        }
        if classes.contains(&"date") {
            return wrap_role("date", children);
        }
        return wrap_role("paragraph", children);
    }
    if tag == "span" {
        if classes.contains(&"citation") {
            return wrap_role("citation", children);
        }
        if classes.contains(&"ref") {
            return map_ref_role(node, children);
        }
        if classes.contains(&"info-icon") {
            let name = node
                .attrs
                .as_ref()
                .and_then(|a| {
                    a.get("data-info-file")
                        .or_else(|| a.get("aria-label"))
                        .or_else(|| a.get("title"))
                })
                .cloned()
                .unwrap_or_else(|| collect_text(node).trim().to_string());
            return SemNode {
                role: "icon".into(),
                text: None,
                attrs: if name.is_empty() {
                    None
                } else {
                    Some(HashMap::from([("name".into(), name)]))
                },
                children: Vec::new(),
            };
        }
        if classes.contains(&"guiicon") {
            let promoted: Vec<SemNode> = children
                .into_iter()
                .map(|c| {
                    if c.role != "image" {
                        return c;
                    }
                    let name = c
                        .attrs
                        .as_ref()
                        .and_then(|a| a.get("filename"))
                        .map(|f| strip_image_ext(f))
                        .unwrap_or_default();
                    SemNode {
                        role: "icon".into(),
                        text: None,
                        attrs: if name.is_empty() {
                            None
                        } else {
                            Some(HashMap::from([("name".into(), name)]))
                        },
                        children: Vec::new(),
                    }
                })
                .collect();
            return wrap_role("wrap", promoted);
        }
        return wrap_role("wrap", children);
    }
    if tag == "text" {
        return SemNode {
            role: "text".into(),
            text: node.text.clone(),
            attrs: None,
            children: Vec::new(),
        };
    }
    wrap_role("wrap", children)
}

fn wrap_role(role: &str, children: Vec<SemNode>) -> SemNode {
    SemNode {
        role: role.into(),
        text: None,
        attrs: None,
        children,
    }
}

fn map_ref_role(node: &SemNode, children: Vec<SemNode>) -> SemNode {
    let href = node
        .attrs
        .as_ref()
        .and_then(|a| a.get("href"))
        .map(|h| h.trim_start_matches('#').to_string())
        .unwrap_or_default();
    let title = node
        .attrs
        .as_ref()
        .and_then(|a| a.get("title"))
        .cloned()
        .unwrap_or_default();
    let class = node
        .attrs
        .as_ref()
        .and_then(|a| a.get("class"))
        .cloned()
        .unwrap_or_default();
    let page_tolerant = title.to_ascii_lowercase().contains("page")
        && title.to_ascii_lowercase().contains("reference")
        || class.split_whitespace().any(|c| c == "pageref");
    let mut attrs = HashMap::new();
    if !href.is_empty() {
        attrs.insert("target".into(), href);
    }
    if page_tolerant {
        attrs.insert("page".into(), "tolerant".into());
        return SemNode {
            role: "ref".into(),
            text: None,
            attrs: Some(attrs),
            children: Vec::new(),
        };
    }
    SemNode {
        role: "ref".into(),
        text: None,
        attrs: if attrs.is_empty() { None } else { Some(attrs) },
        children,
    }
}

fn collect_text(node: &SemNode) -> String {
    if let Some(t) = &node.text {
        return t.clone();
    }
    node.children.iter().map(collect_text).collect()
}

fn find_eqno(node: &SemNode) -> Option<String> {
    let cls = node
        .attrs
        .as_ref()
        .and_then(|a| a.get("class"))
        .cloned()
        .unwrap_or_default();
    if cls.split_whitespace().any(|c| c == "eqno") {
        return Some(collect_text(node).split_whitespace().collect::<String>());
    }
    for child in &node.children {
        if let Some(found) = find_eqno(child) {
            return Some(found);
        }
    }
    None
}

fn find_tex_annotation(node: &SemNode) -> Option<String> {
    if node.role == "annotation" {
        let enc = node
            .attrs
            .as_ref()
            .and_then(|a| a.get("encoding"))
            .map(String::as_str)
            .unwrap_or("");
        if enc == "application/x-tex" {
            return Some(collect_text(node));
        }
    }
    for child in &node.children {
        if let Some(found) = find_tex_annotation(child) {
            return Some(found);
        }
    }
    None
}

fn basename_attr(src: &str) -> String {
    let clean = src.split(['?', '#']).next().unwrap_or(src);
    let base = clean.rsplit(['/', '\\']).next().unwrap_or("").to_string();
    if let Some(hashed) = strip_hashed_prefix(&base) {
        return hashed;
    }
    base
}

fn strip_hashed_prefix(base: &str) -> Option<String> {
    // /^(?:[a-z0-9]+_)?[a-f0-9]{8,}_(.+)$/i
    let lower = base.to_ascii_lowercase();
    let bytes = lower.as_bytes();
    let mut i = 0;
    while i < bytes.len() && (bytes[i].is_ascii_alphanumeric()) {
        i += 1;
    }
    if i < bytes.len() && bytes[i] == b'_' {
        let after = &lower[i + 1..];
        if looks_hex_prefix(after)
            && let Some(rest) = after.split_once('_').map(|(_, r)| r)
            && !rest.is_empty()
        {
            return Some(base[base.len() - rest.len()..].to_string());
        }
    }
    if looks_hex_prefix(&lower)
        && let Some((_, rest)) = base.split_once('_')
        && !rest.is_empty()
        && lower
            .split_once('_')
            .is_some_and(|(h, _)| h.len() >= 8 && h.chars().all(|c| c.is_ascii_hexdigit()))
    {
        return Some(rest.to_string());
    }
    None
}

fn looks_hex_prefix(s: &str) -> bool {
    let hex: String = s.chars().take_while(|c| c.is_ascii_hexdigit()).collect();
    hex.len() >= 8 && s[hex.len()..].starts_with('_')
}

fn strip_image_ext(name: &str) -> String {
    for ext in [".svgz", ".svg", ".png", ".jpeg", ".jpg", ".gif", ".webp"] {
        if name.len() >= ext.len() && name[name.len() - ext.len()..].eq_ignore_ascii_case(ext) {
            return name[..name.len() - ext.len()].to_string();
        }
    }
    name.to_string()
}

struct ParsedTag {
    name: String,
    attrs: HashMap<String, String>,
    closing: bool,
    self_closing: bool,
}

fn parse_fragment(html: &str) -> SemNode {
    let mut root = SemNode {
        role: "root".into(),
        text: None,
        attrs: None,
        children: Vec::new(),
    };
    let mut stack: Vec<SemNode> = Vec::new();
    let mut i = 0;
    while i < html.len() {
        if html.as_bytes()[i] == b'<' {
            if html[i..].starts_with("<!--") {
                let end = html[i + 4..].find("-->").map(|e| i + 4 + e);
                i = end.map(|e| e + 3).unwrap_or(html.len());
                continue;
            }
            let Some(rel) = html[i + 1..].find('>') else {
                break;
            };
            let gt = i + 1 + rel;
            let raw = &html[i + 1..gt];
            let tag = parse_tag(raw);
            i = gt + 1;
            if tag.closing {
                flush_until(&mut stack, &mut root, &tag.name);
                continue;
            }
            let node = SemNode {
                role: tag.name.clone(),
                text: None,
                attrs: if tag.attrs.is_empty() {
                    None
                } else {
                    Some(tag.attrs)
                },
                children: Vec::new(),
            };
            if tag.self_closing || VOID_TAGS.contains(&tag.name.as_str()) {
                push_child(&mut stack, &mut root, node);
            } else {
                stack.push(node);
            }
            continue;
        }
        let next = html[i..].find('<').map(|n| i + n).unwrap_or(html.len());
        let text = &html[i..next];
        i = next;
        if text.is_empty() {
            continue;
        }
        push_child(
            &mut stack,
            &mut root,
            SemNode {
                role: "text".into(),
                text: Some(decode_entities(text)),
                attrs: None,
                children: Vec::new(),
            },
        );
    }
    while let Some(n) = stack.pop() {
        push_child(&mut stack, &mut root, n);
    }
    root
}

fn flush_until(stack: &mut Vec<SemNode>, root: &mut SemNode, name: &str) {
    let mut found = None;
    for s in (0..stack.len()).rev() {
        if stack[s].role == name {
            found = Some(s);
            break;
        }
    }
    let Some(s) = found else {
        return;
    };
    while stack.len() > s + 1 {
        let extra = stack.pop().expect("invariant: stack shrink");
        push_child(stack, root, extra);
    }
    let closed = stack.pop().expect("invariant: matching tag");
    push_child(stack, root, closed);
}

fn push_child(stack: &mut [SemNode], root: &mut SemNode, node: SemNode) {
    if let Some(top) = stack.last_mut() {
        top.children.push(node);
    } else {
        root.children.push(node);
    }
}

fn parse_tag(raw: &str) -> ParsedTag {
    let mut s = raw.trim();
    let closing = s.starts_with('/');
    if closing {
        s = s[1..].trim();
    }
    let self_closing = s.ends_with('/');
    if self_closing {
        s = s[..s.len() - 1].trim();
    }
    let name_end = s
        .find(|c: char| !c.is_ascii_alphanumeric() && c != '_' && c != ':' && c != '-')
        .unwrap_or(s.len());
    let name = if name_end == 0 {
        "span".to_string()
    } else {
        s[..name_end].to_ascii_lowercase()
    };
    let rest = &s[name.len()..];
    ParsedTag {
        name,
        attrs: parse_attrs(rest),
        closing,
        self_closing,
    }
}

fn parse_attrs(rest: &str) -> HashMap<String, String> {
    let mut attrs = HashMap::new();
    let mut s = rest.trim_start();
    while !s.is_empty() {
        let name_end = s
            .find(|c: char| c == '=' || c.is_whitespace())
            .unwrap_or(s.len());
        if name_end == 0 {
            s = &s[1..];
            s = s.trim_start();
            continue;
        }
        let name = s[..name_end].to_ascii_lowercase();
        s = s[name_end..].trim_start();
        if s.starts_with('=') {
            s = s[1..].trim_start();
            let (val, rest) = parse_attr_value(s);
            attrs.insert(name, decode_entities(&val));
            s = rest.trim_start();
        } else {
            attrs.insert(name, String::new());
        }
    }
    attrs
}

fn parse_attr_value(s: &str) -> (String, &str) {
    if s.is_empty() {
        return (String::new(), s);
    }
    let bytes = s.as_bytes();
    if bytes[0] == b'"' || bytes[0] == b'\'' {
        let quote = bytes[0];
        if let Some(end) = s.as_bytes()[1..].iter().position(|&b| b == quote) {
            return (s[1..1 + end].to_string(), &s[2 + end..]);
        }
        return (s[1..].to_string(), "");
    }
    let end = s.find(char::is_whitespace).unwrap_or(s.len());
    (s[..end].to_string(), &s[end..])
}

pub fn decode_entities(text: &str) -> String {
    let mut out = String::new();
    let mut rest = text;
    while let Some(amp) = rest.find('&') {
        out.push_str(&rest[..amp]);
        rest = &rest[amp..];
        if let Some(num) = rest
            .strip_prefix("&#x")
            .or_else(|| rest.strip_prefix("&#X"))
        {
            if let Some(end) = num.find(';')
                && let Ok(cp) = u32::from_str_radix(&num[..end], 16)
                && let Some(ch) = char::from_u32(cp)
            {
                out.push(ch);
                rest = &num[end + 1..];
                continue;
            }
        } else if let Some(num) = rest.strip_prefix("&#")
            && let Some(end) = num.find(';')
            && let Ok(cp) = num[..end].parse::<u32>()
            && let Some(ch) = char::from_u32(cp)
        {
            out.push(ch);
            rest = &num[end + 1..];
            continue;
        }
        let named = [
            ("&lt;", "<"),
            ("&gt;", ">"),
            ("&quot;", "\""),
            ("&#39;", "'"),
            ("&nbsp;", "\u{00a0}"),
            ("&amp;", "&"),
        ];
        let mut matched = false;
        for (ent, repl) in named {
            if rest.starts_with(ent) {
                out.push_str(repl);
                rest = &rest[ent.len()..];
                matched = true;
                break;
            }
        }
        if !matched {
            out.push('&');
            rest = &rest[1..];
        }
    }
    out.push_str(rest);
    out
}
