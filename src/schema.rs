//! `.layout` / `.inc` / `.module` class schema (Deno `schema.ts`).

use crate::ast::{Document, NodeId, NodeKind};
use crate::paths::{TextReadError, read_text_file};
use crate::registry::{INLINE_PROPERTIES, INSET_CATALOG, InsetKind, InsetMeta};
use serde::Serialize;
use std::collections::{HashMap, HashSet};
use std::fmt;
use std::fs;
use std::path::{Path, PathBuf};

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HeadingLevel {
    pub layout: String,
    pub toc_level: i32,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SchemaInset {
    pub name: String,
    pub kind: InsetKind,
    pub subtypes: Vec<String>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LyxSchema {
    pub textclass: String,
    pub document_layouts: Vec<String>,
    pub inset_layouts: Vec<String>,
    pub insets: Vec<SchemaInset>,
    pub inline_properties: Vec<String>,
    pub heading_hierarchy: Vec<HeadingLevel>,
}

pub const INSET_LAYOUTS: &[&str] = &["Plain Layout"];

pub(crate) fn default_heading_hierarchy() -> Vec<HeadingLevel> {
    [
        ("Part", -1),
        ("Chapter", 0),
        ("Section", 1),
        ("Bibliography", 1),
        ("Subsection", 2),
        ("Subsubsection", 3),
        ("Paragraph", 4),
        ("Subparagraph", 5),
    ]
    .into_iter()
    .map(|(layout, toc_level)| HeadingLevel {
        layout: layout.to_string(),
        toc_level,
    })
    .collect()
}

pub(crate) fn fallback_schema(textclass: &str) -> LyxSchema {
    LyxSchema {
        textclass: textclass.to_string(),
        document_layouts: Vec::new(),
        inset_layouts: INSET_LAYOUTS
            .iter()
            .map(|layout| (*layout).to_string())
            .collect(),
        insets: INSET_CATALOG
            .iter()
            .map(|inset| SchemaInset {
                name: inset.name.to_string(),
                kind: inset.kind,
                subtypes: inset
                    .subtypes
                    .iter()
                    .map(|subtype| (*subtype).to_string())
                    .collect(),
            })
            .collect(),
        inline_properties: INLINE_PROPERTIES
            .iter()
            .map(|property| (*property).to_string())
            .collect(),
        heading_hierarchy: default_heading_hierarchy(),
    }
}

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct LayoutFont {
    pub color: Option<String>,
    pub shape: Option<String>,
    pub series: Option<String>,
    pub family: Option<String>,
    pub size: Option<String>,
}

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct LayoutHtml {
    pub html_tag: Option<String>,
    pub html_class: Option<String>,
    pub html_item: Option<String>,
    pub html_title: Option<bool>,
    pub category: Option<String>,
    pub toc_level: Option<i32>,
    pub label_type: Option<String>,
    pub label_string: Option<String>,
    pub label_counter: Option<String>,
    pub font: Option<LayoutFont>,
}

#[derive(Clone, Debug, Default, PartialEq, Eq)]
struct RawStyle {
    html: LayoutHtml,
    copy_style: Option<String>,
}

#[derive(Clone, Debug, Default)]
struct ParsedLayout {
    allowed: HashSet<String>,
    disallowed: HashSet<String>,
    heading_levels: HashMap<String, i32>,
    heading_order: Vec<String>,
    custom_insets: HashSet<String>,
    disallowed_insets: HashSet<String>,
    styles: HashMap<String, RawStyle>,
}

fn empty_parsed() -> ParsedLayout {
    ParsedLayout::default()
}

fn split_layout_lines(text: &str) -> Vec<&str> {
    text.split('\n')
        .map(|l| l.strip_suffix('\r').unwrap_or(l))
        .collect()
}

fn parse_layout_file(
    file_path: &Path,
    search_paths: &[PathBuf],
    visited: &mut HashSet<PathBuf>,
) -> Result<ParsedLayout, SchemaError> {
    if !visited.insert(file_path.to_path_buf()) {
        return Ok(empty_parsed());
    }
    let text = match read_text_file(file_path) {
        Ok(text) => text,
        Err(TextReadError::NotUtf8) => {
            return Err(SchemaError {
                message: format!(
                    "File exists but is not valid UTF-8: {}",
                    file_path.display()
                ),
            });
        }
        Err(TextReadError::Io(error)) => {
            return Err(SchemaError {
                message: format!("Could not read {}: {error}", file_path.display()),
            });
        }
    };
    parse_layout_text(&text, search_paths, visited)
}

fn parse_layout_text(
    text: &str,
    search_paths: &[PathBuf],
    visited: &mut HashSet<PathBuf>,
) -> Result<ParsedLayout, SchemaError> {
    let mut allowed = HashSet::new();
    let mut disallowed = HashSet::new();
    let mut heading_levels: HashMap<String, i32> = HashMap::new();
    let mut heading_order: Vec<String> = Vec::new();
    let mut custom_insets = HashSet::new();
    let mut disallowed_insets = HashSet::new();
    let mut styles: HashMap<String, RawStyle> = HashMap::new();

    let lines = split_layout_lines(text);
    let mut i = 0;
    while i < lines.len() {
        let mut line = lines[i].trim().to_string();
        if line.starts_with('#') || line.is_empty() {
            i += 1;
            continue;
        }
        if let Some(comment_idx) = line.find('#') {
            line = line[..comment_idx].trim().to_string();
        }

        if let Some(rest) = strip_keyword(&line, "Style") {
            let style_name = unquote_layout_name(rest.trim());
            allowed.insert(style_name.clone());
            let (raw, end) = parse_style_body(&lines, i);
            i = end;
            let merged = merge_style(styles.get(&style_name), raw);
            if let Some(toc) = merged.html.toc_level {
                set_heading(&mut heading_levels, &mut heading_order, &style_name, toc);
            }
            styles.insert(style_name, merged);
            i += 1;
            continue;
        }

        if let Some(rest) = strip_keyword(&line, "NoStyle") {
            disallowed.insert(unquote_layout_name(rest.trim()));
            i += 1;
            continue;
        }

        if let Some(rest) = strip_keyword(&line, "InsetLayout") {
            let inset_name = unquote_layout_name(rest.trim());
            custom_insets.insert(inset_name.clone());
            let (raw, end) = parse_style_body(&lines, i);
            i = end;
            let merged = merge_style(styles.get(&inset_name), raw);
            styles.insert(inset_name, merged);
            i += 1;
            continue;
        }

        if let Some(rest) = strip_keyword(&line, "NoInsetLayout") {
            disallowed_insets.insert(rest.trim().to_string());
            i += 1;
            continue;
        }

        if let Some(rest) = strip_keyword(&line, "Input") {
            let mut inc_file = rest.trim().to_string();
            if !inc_file.ends_with(".inc") && !inc_file.ends_with(".layout") {
                inc_file.push_str(".inc");
            }
            let mut found_path: Option<PathBuf> = None;
            for search_path in search_paths {
                let full = search_path.join(&inc_file);
                if full.is_file() {
                    found_path = Some(full);
                    break;
                }
            }
            if let Some(found) = found_path {
                let sub = parse_layout_file(&found, search_paths, visited)?;
                for s in sub.allowed {
                    allowed.insert(s);
                }
                for s in sub.disallowed {
                    disallowed.insert(s);
                }
                for name in &sub.heading_order {
                    if let Some(&v) = sub.heading_levels.get(name) {
                        set_heading(&mut heading_levels, &mut heading_order, name, v);
                    }
                }
                for s in sub.custom_insets {
                    custom_insets.insert(s);
                }
                for s in sub.disallowed_insets {
                    disallowed_insets.insert(s);
                }
                for (k, v) in sub.styles {
                    let merged = merge_style(styles.get(&k), v);
                    styles.insert(k, merged);
                }
            }
        }

        i += 1;
    }

    Ok(ParsedLayout {
        allowed,
        disallowed,
        heading_levels,
        heading_order,
        custom_insets,
        disallowed_insets,
        styles,
    })
}

fn set_heading(levels: &mut HashMap<String, i32>, order: &mut Vec<String>, name: &str, toc: i32) {
    if !levels.contains_key(name) {
        order.push(name.to_string());
    }
    levels.insert(name.to_string(), toc);
}

fn strip_keyword<'a>(line: &'a str, keyword: &str) -> Option<&'a str> {
    let rest = line.strip_prefix(keyword)?;
    if rest.starts_with(char::is_whitespace) {
        Some(rest.trim_start())
    } else {
        None
    }
}

fn strip_keyword_ci<'a>(line: &'a str, keyword: &str) -> Option<&'a str> {
    if line.len() < keyword.len() || !line[..keyword.len()].eq_ignore_ascii_case(keyword) {
        return None;
    }
    let rest = &line[keyword.len()..];
    if rest.starts_with(char::is_whitespace) {
        Some(rest.trim_start())
    } else {
        None
    }
}

/// `Style "Left Header"` / `CopyStyle "Left Header"` → `Left Header`.
fn unquote_layout_name(name: &str) -> String {
    let t = name.trim();
    let b = t.as_bytes();
    if b.len() >= 2
        && ((b[0] == b'"' && b[b.len() - 1] == b'"') || (b[0] == b'\'' && b[b.len() - 1] == b'\''))
    {
        t[1..t.len() - 1].trim().to_string()
    } else {
        t.to_string()
    }
}

fn overlay_html_fields(out: &mut LayoutHtml, next: &LayoutHtml) {
    if next.html_tag.is_some() {
        out.html_tag.clone_from(&next.html_tag);
    }
    if next.html_class.is_some() {
        out.html_class.clone_from(&next.html_class);
    }
    if next.html_item.is_some() {
        out.html_item.clone_from(&next.html_item);
    }
    if next.html_title.is_some() {
        out.html_title = next.html_title;
    }
    if next.category.is_some() {
        out.category.clone_from(&next.category);
    }
    if next.toc_level.is_some() {
        out.toc_level = next.toc_level;
    }
    if next.label_type.is_some() {
        out.label_type.clone_from(&next.label_type);
    }
    if next.label_string.is_some() {
        out.label_string.clone_from(&next.label_string);
    }
    if next.label_counter.is_some() {
        out.label_counter.clone_from(&next.label_counter);
    }
}

fn merge_style(prev: Option<&RawStyle>, next: RawStyle) -> RawStyle {
    let Some(prev) = prev else {
        return next;
    };
    let mut out = prev.clone();
    if next.copy_style.is_some() {
        out.copy_style.clone_from(&next.copy_style);
    }
    if next.html.font.is_some() {
        out.html.font = merge_font(prev.html.font.clone(), next.html.font.clone());
    }
    overlay_html_fields(&mut out.html, &next.html);
    out
}

fn merge_font(prev: Option<LayoutFont>, next: Option<LayoutFont>) -> Option<LayoutFont> {
    match (prev, next) {
        (None, n) => n,
        (p, None) => p,
        (Some(p), Some(n)) => Some(LayoutFont {
            color: n.color.or(p.color),
            shape: n.shape.or(p.shape),
            series: n.series.or(p.series),
            family: n.family.or(p.family),
            size: n.size.or(p.size),
        }),
    }
}

fn skip_until(lines: &[&str], start: usize, end_marker: &str) -> usize {
    let mut i = start;
    while i + 1 < lines.len() {
        i += 1;
        if lines[i].trim() == end_marker {
            break;
        }
    }
    i
}

fn is_argument_line(line: &str) -> bool {
    let Some(rest) = line.strip_prefix("Argument") else {
        return false;
    };
    rest.is_empty() || rest.starts_with(|c: char| !(c.is_ascii_alphanumeric() || c == '_'))
}

fn first_token(s: &str) -> &str {
    s.split_whitespace().next().unwrap_or("")
}

fn strip_wrapping_quotes(s: &str) -> String {
    let t = s.trim();
    let mut out = t.to_string();
    if let Some(stripped) = out.strip_prefix('"') {
        out = stripped.to_string();
    }
    if let Some(stripped) = out.strip_suffix('"') {
        out = stripped.to_string();
    }
    out
}

fn parse_style_body(lines: &[&str], start: usize) -> (RawStyle, usize) {
    let mut style = RawStyle::default();
    let mut i = start;
    while i + 1 < lines.len() {
        i += 1;
        let mut body_line = lines[i].trim().to_string();
        if body_line == "End" {
            break;
        }
        if body_line.starts_with('#') || body_line.is_empty() {
            continue;
        }
        if body_line == "Font" {
            let (font, end) = parse_font_body(lines, i);
            i = end;
            style.html.font = merge_font(style.html.font.clone(), Some(font));
            continue;
        }
        if body_line == "LabelFont" {
            i = skip_until(lines, i, "EndFont");
            continue;
        }
        if body_line == "Preamble" {
            i = skip_until(lines, i, "EndPreamble");
            continue;
        }
        if body_line == "HTMLStyle" {
            i = skip_until(lines, i, "EndHTMLStyle");
            continue;
        }
        if is_argument_line(&body_line) {
            i = skip_until(lines, i, "EndArgument");
            continue;
        }
        if let Some(comment_idx) = body_line.find('#') {
            body_line = body_line[..comment_idx].trim().to_string();
        }
        if let Some(rest) = strip_keyword_ci(&body_line, "HTMLTag") {
            style.html.html_tag = Some(first_token(rest).to_string());
            continue;
        }
        if let Some(rest) = strip_keyword_ci(&body_line, "HTMLClass") {
            style.html.html_class = Some(strip_wrapping_quotes(rest));
            continue;
        }
        if let Some(rest) = strip_keyword_ci(&body_line, "HTMLItem") {
            style.html.html_item = Some(first_token(rest).to_string());
            continue;
        }
        if let Some(rest) = strip_keyword_ci(&body_line, "HTMLTitle") {
            style.html.html_title = Some(first_token(rest).eq_ignore_ascii_case("true"));
            continue;
        }
        if let Some(rest) = strip_keyword_ci(&body_line, "Category") {
            style.html.category = Some(first_token(rest).to_string());
            continue;
        }
        if let Some(rest) = strip_keyword_ci(&body_line, "TocLevel") {
            let tok = first_token(rest);
            if let Ok(n) = tok.parse::<i32>() {
                // Deno `/^TocLevel\s+(-?\d+)$/i` — whole rest must be the integer.
                if tok == rest {
                    style.html.toc_level = Some(n);
                }
            }
            continue;
        }
        if let Some(rest) = strip_keyword_ci(&body_line, "CopyStyle") {
            style.copy_style = Some(unquote_layout_name(rest.trim()));
            continue;
        }
        if let Some(rest) = strip_keyword_ci(&body_line, "LabelType") {
            style.html.label_type = Some(first_token(rest).to_string());
            continue;
        }
        if let Some(rest) = strip_keyword_ci(&body_line, "LabelString") {
            style.html.label_string = Some(strip_wrapping_quotes(rest));
            continue;
        }
        if let Some(rest) = strip_keyword_ci(&body_line, "LabelCounter") {
            style.html.label_counter = Some(first_token(rest).to_string());
            continue;
        }
    }
    (style, i)
}

fn resolve_style(
    name: &str,
    raw: &HashMap<String, RawStyle>,
    seen: &mut HashSet<String>,
) -> LayoutHtml {
    let Some(own) = raw.get(name) else {
        return LayoutHtml::default();
    };
    if own.copy_style.is_none() || seen.contains(name) {
        return own.html.clone();
    }
    seen.insert(name.to_string());
    let base = resolve_style(
        own.copy_style
            .as_deref()
            .expect("invariant: copy_style is Some"),
        raw,
        seen,
    );
    let mut out = base;
    if own.html.font.is_some() {
        out.font = merge_font(out.font.clone(), own.html.font.clone());
    }
    overlay_html_fields(&mut out, &own.html);
    out
}

fn parse_font_body(lines: &[&str], start: usize) -> (LayoutFont, usize) {
    let mut font = LayoutFont::default();
    let mut i = start;
    while i + 1 < lines.len() {
        i += 1;
        let mut body_line = lines[i].trim().to_string();
        if body_line == "EndFont" {
            break;
        }
        if body_line.starts_with('#') || body_line.is_empty() {
            continue;
        }
        if let Some(comment_idx) = body_line.find('#') {
            body_line = body_line[..comment_idx].trim().to_string();
        }
        if let Some(rest) = strip_keyword_ci(&body_line, "Color") {
            font.color = Some(first_token(rest).to_string());
            continue;
        }
        if let Some(rest) = strip_keyword_ci(&body_line, "Shape") {
            font.shape = Some(first_token(rest).to_string());
            continue;
        }
        if let Some(rest) = strip_keyword_ci(&body_line, "Series") {
            font.series = Some(first_token(rest).to_string());
            continue;
        }
        if let Some(rest) = strip_keyword_ci(&body_line, "Family") {
            font.family = Some(first_token(rest).to_string());
            continue;
        }
        if let Some(rest) = strip_keyword_ci(&body_line, "Size") {
            font.size = Some(first_token(rest).to_string());
            continue;
        }
    }
    (font, i)
}

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct LocalLayoutTexts {
    pub forced: Option<String>,
    pub normal: Option<String>,
}

fn layout_block_to_text(doc: &Document, block: NodeId) -> String {
    let mut lines = Vec::new();
    for &c in &doc.node(block).children {
        match &doc.node(c).kind {
            NodeKind::Text { text } => lines.push(text.clone()),
            NodeKind::Property { key, value } => match value {
                Some(v) if !v.is_empty() => lines.push(format!("\\{key} {v}")),
                _ => lines.push(format!("\\{key}")),
            },
            _ => {}
        }
    }
    lines.join("\n")
}

pub struct DocumentLayoutContext {
    pub textclass: Option<String>,
    pub modules: Vec<String>,
    pub local: LocalLayoutTexts,
}

/// textclass, modules, and LocalLayout bodies from a parsed document.
pub fn extract_document_layout_context(ast: &Document) -> DocumentLayoutContext {
    let mut textclass = None;
    let mut modules = Vec::new();
    let mut local = LocalLayoutTexts::default();
    walk_layout_context(ast, ast.root(), &mut textclass, &mut modules, &mut local);
    DocumentLayoutContext {
        textclass,
        modules,
        local,
    }
}

fn walk_layout_context(
    ast: &Document,
    id: NodeId,
    textclass: &mut Option<String>,
    modules: &mut Vec<String>,
    local: &mut LocalLayoutTexts,
) {
    for &n in &ast.node(id).children {
        match &ast.node(n).kind {
            NodeKind::Property { key, value } if key == "textclass" => {
                if textclass.is_none()
                    && let Some(v) = value
                    && !v.is_empty()
                {
                    *textclass = Some(v.clone());
                }
            }
            NodeKind::Block { tag, .. } => match tag.as_str() {
                "modules" => {
                    for &c in &ast.node(n).children {
                        if let NodeKind::Text { text } = &ast.node(c).kind {
                            let name = text.trim();
                            if !name.is_empty() {
                                modules.push(name.to_string());
                            }
                        }
                    }
                }
                "forced_local_layout" => {
                    if local.forced.is_none() {
                        local.forced = Some(layout_block_to_text(ast, n));
                    }
                }
                "local_layout" => {
                    if local.normal.is_none() {
                        local.normal = Some(layout_block_to_text(ast, n));
                    }
                }
                "header" | "document" => {
                    walk_layout_context(ast, n, textclass, modules, local);
                }
                _ => {}
            },
            _ => {}
        }
    }
}

#[derive(Clone, Debug, Default)]
pub struct LayoutSearchOptions {
    pub overlay_layouts_dir: Option<PathBuf>,
    pub system_layouts_dir: Option<PathBuf>,
}

#[derive(Clone, Debug)]
pub struct LayoutSearchResolved {
    pub system: PathBuf,
    pub user: Option<PathBuf>,
    pub overlay: Option<PathBuf>,
    pub search_paths: Vec<PathBuf>,
}

fn is_dir(p: &Path) -> bool {
    p.is_dir()
}

fn is_file(p: &Path) -> bool {
    p.is_file()
}

/// LyX user-dir layouts folder aligned with the install that owns `system_layouts_dir`.
pub fn get_lyx_user_layouts_dir(system_layouts_dir: Option<&Path>) -> Option<PathBuf> {
    let family = system_layouts_dir.and_then(version_family_from_system_layouts);
    let dotted = family.as_ref().and_then(|f| {
        if f.len() >= 2 {
            Some(format!("{}.{}", &f[..1], &f[1..]))
        } else {
            None
        }
    });

    if cfg!(windows) {
        let roaming = std::env::var("APPDATA").ok()?;
        let roaming = PathBuf::from(roaming);
        let mut candidates: Vec<PathBuf> = Vec::new();
        if let Some(ref fam) = family {
            candidates.push(roaming.join(format!("LyX{fam}")).join("layouts"));
        }
        if let Ok(rd) = fs::read_dir(&roaming) {
            for entry in rd.flatten() {
                if !entry.file_type().map(|t| t.is_dir()).unwrap_or(false) {
                    continue;
                }
                let name = entry.file_name();
                let name = name.to_string_lossy();
                if is_lyx_user_folder_name(&name) {
                    candidates.push(roaming.join(name.as_ref()).join("layouts"));
                }
            }
        }
        return candidates.into_iter().find(|c| is_dir(c));
    }

    if cfg!(target_os = "macos") {
        let home = std::env::var("HOME").ok()?;
        let home = PathBuf::from(home);
        let library = home.join("Library").join("Application Support");
        let mut candidates: Vec<PathBuf> = Vec::new();
        if let Some(ref d) = dotted {
            candidates.push(library.join(format!("LyX{d}")).join("layouts"));
        }
        if let Some(ref fam) = family {
            candidates.push(library.join(format!("LyX{fam}")).join("layouts"));
        }
        candidates.push(home.join(".lyx").join("layouts"));
        return candidates.into_iter().find(|c| is_dir(c));
    }

    let home = std::env::var("HOME").ok()?;
    let home = PathBuf::from(home);
    let mut candidates = vec![home.join(".lyx").join("layouts")];
    if let Some(ref d) = dotted {
        candidates.insert(0, home.join(format!(".lyx{d}")).join("layouts"));
    }
    candidates.into_iter().find(|c| is_dir(c))
}

fn is_lyx_user_folder_name(name: &str) -> bool {
    let Some(rest) = name.strip_prefix("LyX") else {
        return false;
    };
    !rest.is_empty() && rest.chars().all(|c| c.is_ascii_digit())
}

fn version_family_from_system_layouts(system_layouts_dir: &Path) -> Option<String> {
    let norm = system_layouts_dir.to_string_lossy().replace('\\', "/");
    if let Some(fam) = capture_lyx_space_version(&norm) {
        return Some(fam);
    }
    capture_lyx_nospace_version(&norm)
}

fn find_ci_substr(hay: &str, needle: &str) -> Option<usize> {
    hay.to_ascii_lowercase().find(&needle.to_ascii_lowercase())
}

fn take_digits(s: &str) -> Option<(&str, &str)> {
    let n = s.find(|c: char| !c.is_ascii_digit()).unwrap_or(s.len());
    if n == 0 {
        return None;
    }
    Some((&s[..n], &s[n..]))
}

fn capture_lyx_space_version(norm: &str) -> Option<String> {
    let mut start = 0;
    while let Some(rel) = find_ci_substr(&norm[start..], "lyx ") {
        let i = start + rel;
        let rest = &norm[i + 4..];
        if let Some((maj, rest2)) = take_digits(rest)
            && let Some(after_dot) = rest2.strip_prefix('.')
            && let Some((min, _)) = take_digits(after_dot)
        {
            return Some(format!("{maj}{min}"));
        }
        start = i + 1;
    }
    None
}

fn capture_lyx_nospace_version(norm: &str) -> Option<String> {
    let mut start = 0;
    while let Some(rel) = find_ci_substr(&norm[start..], "lyx") {
        let i = start + rel;
        let rest = &norm[i + 3..];
        if rest.starts_with(char::is_whitespace) {
            start = i + 1;
            continue;
        }
        if let Some((maj, rest2)) = take_digits(rest)
            && let Some(after_dot) = rest2.strip_prefix('.')
            && let Some((min, _)) = take_digits(after_dot)
        {
            return Some(format!("{maj}{min}"));
        }
        start = i + 1;
    }
    None
}

/// Search path order (LyX-like): config overlay, LyX user-dir, system install.
pub fn resolve_layout_search_paths(opts: &LayoutSearchOptions) -> LayoutSearchResolved {
    let system = match opts.system_layouts_dir.as_ref() {
        Some(p) if is_dir(p) => p.clone(),
        _ => get_default_layouts_dir(),
    };
    let user = get_lyx_user_layouts_dir(Some(&system));
    let overlay = opts
        .overlay_layouts_dir
        .as_ref()
        .filter(|p| is_dir(p))
        .cloned();
    let mut search_paths: Vec<PathBuf> = Vec::new();
    if let Some(ref o) = overlay {
        search_paths.push(o.clone());
    }
    if let Some(ref u) = user
        && Some(u) != overlay.as_ref()
        && u != &system
    {
        search_paths.push(u.clone());
    }
    if !search_paths.iter().any(|p| p == &system) {
        search_paths.push(system.clone());
    }
    LayoutSearchResolved {
        system,
        user,
        overlay,
        search_paths,
    }
}

/// First hit for `file_name` in ordered search paths (overlay → user → system).
pub fn find_layout_file(file_name: &str, search_paths: &[PathBuf]) -> Option<PathBuf> {
    for dir in search_paths {
        let full = dir.join(file_name);
        if is_file(&full) {
            return Some(full);
        }
    }
    None
}

fn merge_parsed(into: &mut ParsedLayout, sub: ParsedLayout) {
    for s in sub.allowed {
        into.allowed.insert(s);
    }
    for s in sub.disallowed {
        into.disallowed.insert(s);
    }
    for name in &sub.heading_order {
        if let Some(&v) = sub.heading_levels.get(name) {
            set_heading(&mut into.heading_levels, &mut into.heading_order, name, v);
        }
    }
    for s in sub.custom_insets {
        into.custom_insets.insert(s);
    }
    for s in sub.disallowed_insets {
        into.disallowed_insets.insert(s);
    }
    for (k, v) in sub.styles {
        let merged = merge_style(into.styles.get(&k), v);
        into.styles.insert(k, merged);
    }
}

fn load_parsed_for_class(
    textclass: &str,
    layouts_dir: &[PathBuf],
    modules: &[&str],
    local: Option<&LocalLayoutTexts>,
) -> Result<Option<ParsedLayout>, SchemaError> {
    let main_layout_path = match find_layout_file(&format!("{textclass}.layout"), layouts_dir) {
        Some(path) => path,
        None => return Ok(None),
    };
    let mut visited = HashSet::new();
    let mut parsed = parse_layout_file(&main_layout_path, layouts_dir, &mut visited)?;
    for name in modules {
        let trimmed = name.trim();
        if trimmed.is_empty() {
            continue;
        }
        let Some(module_path) = find_layout_file(&format!("{trimmed}.module"), layouts_dir) else {
            continue;
        };
        merge_parsed(
            &mut parsed,
            parse_layout_file(&module_path, layouts_dir, &mut visited)?,
        );
    }
    if let Some(forced) = local.and_then(|l| l.forced.as_deref())
        && !forced.trim().is_empty()
    {
        merge_parsed(
            &mut parsed,
            parse_layout_text(forced, layouts_dir, &mut visited)?,
        );
    }
    if let Some(normal) = local.and_then(|l| l.normal.as_deref())
        && !normal.trim().is_empty()
    {
        merge_parsed(
            &mut parsed,
            parse_layout_text(normal, layouts_dir, &mut visited)?,
        );
    }
    Ok(Some(parsed))
}

/// Renderer-private HTML keys for a textclass. Missing layout file → empty map.
pub fn get_layout_html_for_class(
    textclass: &str,
    layouts_dir: &[PathBuf],
    modules: &[&str],
    local: Option<&LocalLayoutTexts>,
) -> HashMap<String, LayoutHtml> {
    let Ok(Some(parsed)) = load_parsed_for_class(textclass, layouts_dir, modules, local) else {
        return HashMap::new();
    };
    let mut out = HashMap::new();
    for name in parsed.styles.keys() {
        if parsed.disallowed.contains(name) {
            continue;
        }
        out.insert(
            name.clone(),
            resolve_style(name, &parsed.styles, &mut HashSet::new()),
        );
    }
    out
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SchemaError {
    pub message: String,
}

impl fmt::Display for SchemaError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.message)
    }
}

impl std::error::Error for SchemaError {}

pub fn get_schema_for_class(
    textclass: &str,
    layouts_dir: &[PathBuf],
    modules: &[&str],
    local: Option<&LocalLayoutTexts>,
) -> Result<LyxSchema, SchemaError> {
    let mut parsed = match load_parsed_for_class(textclass, layouts_dir, modules, local) {
        Ok(Some(parsed)) => parsed,
        Ok(None) => {
            let hint = layouts_dir
                .iter()
                .map(|p| p.display().to_string())
                .collect::<Vec<_>>()
                .join(", ");
            return Err(SchemaError {
                message: format!("Layout file not found for textclass '{textclass}' in: {hint}"),
            });
        }
        Err(error) => return Err(error),
    };

    parsed.allowed.retain(|s| !parsed.disallowed.contains(s));

    let mut all_insets: HashSet<String> =
        INSET_CATALOG.iter().map(|e| e.name.to_string()).collect();
    for s in &parsed.custom_insets {
        all_insets.insert(s.clone());
    }
    for s in &parsed.disallowed_insets {
        all_insets.remove(s);
    }

    let mut heading_hierarchy = Vec::new();
    for layout in &parsed.heading_order {
        if parsed.disallowed.contains(layout) {
            continue;
        }
        if let Some(&toc_level) = parsed.heading_levels.get(layout) {
            heading_hierarchy.push(HeadingLevel {
                layout: layout.clone(),
                toc_level,
            });
        }
    }
    heading_hierarchy.sort_by_key(|h| h.toc_level);

    let catalog_by_name: HashMap<&str, &InsetMeta> =
        INSET_CATALOG.iter().map(|e| (e.name, e)).collect();
    let mut names: Vec<String> = all_insets.into_iter().collect();
    names.sort();
    let insets: Vec<SchemaInset> = names
        .into_iter()
        .map(|name| {
            if let Some(builtin) = catalog_by_name.get(name.as_str()) {
                SchemaInset {
                    name: builtin.name.to_string(),
                    kind: builtin.kind,
                    subtypes: builtin.subtypes.iter().map(|s| (*s).to_string()).collect(),
                }
            } else {
                SchemaInset {
                    name,
                    kind: InsetKind::Collapsible,
                    subtypes: Vec::new(),
                }
            }
        })
        .collect();

    let mut document_layouts: Vec<String> = parsed.allowed.into_iter().collect();
    document_layouts.sort();

    Ok(LyxSchema {
        textclass: textclass.to_string(),
        document_layouts,
        inset_layouts: INSET_LAYOUTS.iter().map(|s| (*s).to_string()).collect(),
        insets,
        inline_properties: INLINE_PROPERTIES.iter().map(|s| (*s).to_string()).collect(),
        heading_hierarchy,
    })
}

fn parse_dotted_version(s: &str) -> Option<Vec<u32>> {
    if s.is_empty() {
        return None;
    }
    let mut parts = Vec::new();
    for p in s.split('.') {
        if p.is_empty() || !p.chars().all(|c| c.is_ascii_digit()) {
            return None;
        }
        parts.push(p.parse().ok()?);
    }
    Some(parts)
}

fn cmp_version_desc(a: &[u32], b: &[u32]) -> std::cmp::Ordering {
    let n = a.len().max(b.len());
    for i in 0..n {
        let va = a.get(i).copied().unwrap_or(0);
        let vb = b.get(i).copied().unwrap_or(0);
        if va != vb {
            return vb.cmp(&va);
        }
    }
    std::cmp::Ordering::Equal
}

fn lyx_windows_install_version(name: &str) -> Option<Vec<u32>> {
    let rest = name.strip_prefix("LyX ")?;
    parse_dotted_version(rest)
}

fn lyx_darwin_app_version(name: &str) -> Option<Vec<u32>> {
    let rest = name.strip_prefix("LyX")?;
    let rest = rest.strip_suffix(".app")?;
    parse_dotted_version(rest)
}

/// Scan installed LyX versions for the layouts directory.
pub fn get_default_layouts_dir() -> PathBuf {
    if cfg!(windows) {
        let mut bases: Vec<PathBuf> = Vec::new();
        if let Ok(pf) = std::env::var("PROGRAMFILES") {
            bases.push(PathBuf::from(pf));
        }
        if let Ok(local) = std::env::var("LOCALAPPDATA") {
            bases.push(PathBuf::from(local).join("Programs"));
        }

        let mut candidates: Vec<(Vec<u32>, PathBuf)> = Vec::new();
        for base in &bases {
            let Ok(rd) = fs::read_dir(base) else {
                continue;
            };
            for entry in rd.flatten() {
                if !entry.file_type().map(|t| t.is_dir()).unwrap_or(false) {
                    continue;
                }
                let name = entry.file_name();
                let name = name.to_string_lossy();
                let Some(version) = lyx_windows_install_version(&name) else {
                    continue;
                };
                let layouts_dir = base.join(name.as_ref()).join("Resources").join("layouts");
                if layouts_dir.is_dir() {
                    candidates.push((version, layouts_dir));
                }
            }
        }

        candidates.sort_by(|a, b| cmp_version_desc(&a.0, &b.0));
        if let Some((_, dir)) = candidates.into_iter().next() {
            return dir;
        }

        let fallbacks = [
            PathBuf::from(std::env::var("LOCALAPPDATA").unwrap_or_default())
                .join("Programs")
                .join("LyX 2.5")
                .join("Resources")
                .join("layouts"),
            PathBuf::from(r"C:\Program Files\LyX 2.5\Resources\layouts"),
        ];
        return fallbacks
            .into_iter()
            .find(|f| f.is_dir())
            .unwrap_or_else(|| PathBuf::from(r"C:\Program Files\LyX 2.5\Resources\layouts"));
    }

    if cfg!(target_os = "macos") {
        let apps = PathBuf::from("/Applications");
        let mut candidates: Vec<(Vec<u32>, PathBuf)> = Vec::new();
        if let Ok(rd) = fs::read_dir(&apps) {
            for entry in rd.flatten() {
                if !entry.file_type().map(|t| t.is_dir()).unwrap_or(false) {
                    continue;
                }
                let name = entry.file_name();
                let name = name.to_string_lossy();
                let Some(version) = lyx_darwin_app_version(&name) else {
                    continue;
                };
                let layouts_dir = apps
                    .join(name.as_ref())
                    .join("Contents")
                    .join("Resources")
                    .join("layouts");
                if layouts_dir.is_dir() {
                    candidates.push((version, layouts_dir));
                }
            }
        }
        candidates.sort_by(|a, b| cmp_version_desc(&a.0, &b.0));
        if let Some((_, dir)) = candidates.into_iter().next() {
            return dir;
        }
        return PathBuf::from("/Applications/LyX.app/Contents/Resources/layouts");
    }

    let linux_paths = [
        PathBuf::from("/usr/share/lyx/layouts"),
        PathBuf::from("/usr/local/share/lyx/layouts"),
    ];
    linux_paths
        .into_iter()
        .find(|p| p.is_dir())
        .unwrap_or_else(|| PathBuf::from("/usr/share/lyx/layouts"))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_dir(prefix: &str) -> PathBuf {
        let p = std::env::temp_dir().join(format!(
            "lq_schema_{prefix}_{}_{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        fs::create_dir_all(&p).unwrap();
        p
    }

    #[test]
    fn style_merge_copy_quoted_names_and_overlay_input() {
        let system = temp_dir("sys");
        let overlay = temp_dir("ovl");
        fs::write(
            system.join("stdclass.inc"),
            [
                "Style Section",
                "HTMLTag               h2",
                "TocLevel              1",
                "End",
                "Style Labeling",
                "HTMLTag               ol",
                "End",
                "Style Quote",
                "HTMLTag               blockquote",
                "End",
            ]
            .join("\n"),
        )
        .unwrap();
        fs::write(
            overlay.join("article.layout"),
            [
                "Input stdclass.inc",
                "Style OverlayProbe",
                "HTMLTag               div",
                "Category             FrontMatter",
                "End",
                "Style Labeling",
                "Category             List",
                "End",
                "Style Quotation",
                "CopyStyle             Quote",
                "End",
                "Style \"Left Header\"",
                "Category             Header/Footer",
                "End",
                "Style Center Footer",
                "CopyStyle             \"Left Header\"",
                "End",
                "InsetLayout Flex:Emph",
                "HTMLTag               em",
                "End",
            ]
            .join("\n"),
        )
        .unwrap();

        let search = vec![overlay.clone(), system.clone()];
        let html = get_layout_html_for_class("article", &search, &[], None);
        assert_eq!(
            html.get("OverlayProbe").and_then(|h| h.html_tag.as_deref()),
            Some("div")
        );
        assert_eq!(
            html.get("Section").and_then(|h| h.html_tag.as_deref()),
            Some("h2")
        );
        assert_eq!(html.get("Section").and_then(|h| h.toc_level), Some(1));
        assert_eq!(
            html.get("Labeling").and_then(|h| h.html_tag.as_deref()),
            Some("ol"),
            "later Style Labeling must merge, not replace"
        );
        assert_eq!(
            html.get("Labeling").and_then(|h| h.category.as_deref()),
            Some("List")
        );
        assert_eq!(
            html.get("Quotation").and_then(|h| h.html_tag.as_deref()),
            Some("blockquote")
        );
        assert_eq!(
            html.get("Left Header").and_then(|h| h.category.as_deref()),
            Some("Header/Footer")
        );
        assert_eq!(
            html.get("Center Footer")
                .and_then(|h| h.category.as_deref()),
            Some("Header/Footer")
        );
        assert!(!html.contains_key("\"Left Header\""));
        assert_eq!(
            html.get("Flex:Emph").and_then(|h| h.html_tag.as_deref()),
            Some("em")
        );

        let schema = get_schema_for_class(
            "article",
            &search,
            &[],
            Some(&LocalLayoutTexts {
                normal: Some("Style LocalOnly\nHTMLTag div\nEnd\n".into()),
                forced: None,
            }),
        )
        .unwrap();
        assert!(schema.document_layouts.iter().any(|s| s == "LocalOnly"));
        assert!(schema.document_layouts.iter().any(|s| s == "Section"));
        assert!(schema.insets.iter().any(|e| e.name == "Flex:Emph"));

        let missing = get_layout_html_for_class(
            "article",
            &[PathBuf::from("Z:\\lq-no-such-layouts")],
            &[],
            None,
        );
        assert!(missing.is_empty());
        assert!(get_schema_for_class("nope", &search, &[], None).is_err());

        let _ = fs::remove_dir_all(&system);
        let _ = fs::remove_dir_all(&overlay);
    }
}
