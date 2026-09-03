//! Live reader projection (Deno `preview.ts`).
//!
//! Private modules split Deno's one file along existing function clusters
//! (016 JC1). One [`RenderCtx`], one inset `match` — not a renderer framework.

mod compare;
mod flow;
mod graphics;
mod index;
mod insets;
mod mapping;

use crate::ast::{Document, NodeId, NodeKind};
use crate::bib::Citation;
use crate::bind::{
    ShortcutMap, bind_dir_from_layouts, images_dir_from_layouts, load_shortcut_map_merged,
};
use crate::cache::hash_file;
use crate::latex_math::MathMacroMap;
use crate::schema::{
    LayoutHtml, LayoutSearchOptions, extract_document_layout_context, find_layout_file,
    get_layout_html_for_class, get_lyx_user_layouts_dir, resolve_layout_search_paths,
};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::{HashMap, HashSet};
use std::fmt;
use std::path::{Path, PathBuf};

pub use compare::{SemNode, decode_entities, format_sem, normalize_reader_html, semantic_equal};
pub use graphics::{find_magick, raster_magick_args};

pub const LIVE_CONTRACT: &str = "lyx-preview/live-1";
pub const LIVE_PROJECTION: &str = "live";
pub const LIVE_HASH_ALGORITHM: &str = "sha256";
pub const LIVE_HASH_INPUT: &str = "raw-file-bytes";

pub const LIVE_CAPABILITIES: LiveCapabilities = LiveCapabilities {
    review: false,
    mapping: true,
    outline: true,
    editing: false,
    source_reveal: false,
};

pub const LIVE_DEFERRED_FIELDS: &[&str] = &["editTargets", "reviewRegions", "mode"];

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct LiveTokenVia {
    pub file: String,
    pub selector: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct LiveTokenBundle {
    pub selector: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub file: Option<String>,
    #[serde(rename = "diskHash", skip_serializing_if = "Option::is_none")]
    pub disk_hash: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub via: Option<LiveTokenVia>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct LiveToken {
    pub id: String,
    pub bundle: LiveTokenBundle,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct LiveOutlineEntry {
    pub level: i32,
    pub number: String,
    pub text: String,
    pub id: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct LiveNavEntry {
    pub kind: String,
    pub number: String,
    pub text: String,
    pub id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub line: Option<i32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub children: Option<Vec<LiveNavEntry>>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum LiveChangeType {
    Inserted,
    Deleted,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct LiveChangeEntry {
    pub ordinal: u32,
    #[serde(rename = "type")]
    pub type_: LiveChangeType,
    pub author: String,
    pub ts: String,
    #[serde(rename = "anchorId")]
    pub anchor_id: String,
    pub snippet: String,
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct LiveNavigate {
    pub figures: Vec<LiveNavEntry>,
    pub tables: Vec<LiveNavEntry>,
    pub equations: Vec<LiveNavEntry>,
    pub labels: Vec<LiveNavEntry>,
    pub listings: Vec<LiveNavEntry>,
    pub algorithms: Vec<LiveNavEntry>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum LineEnding {
    Lf,
    Crlf,
    Mixed,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct LiveSourceIdentity {
    pub path: String,
    #[serde(rename = "hashAlgorithm")]
    pub hash_algorithm: String,
    #[serde(rename = "hashInput")]
    pub hash_input: String,
    #[serde(rename = "diskHash")]
    pub disk_hash: String,
    #[serde(rename = "lineEnding")]
    pub line_ending: LineEnding,
    #[serde(rename = "lineCount")]
    pub line_count: u32,
    pub fresh: bool,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct LiveDiagnostic {
    pub code: String,
    pub message: String,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct LiveCapabilities {
    pub review: bool,
    pub mapping: bool,
    pub outline: bool,
    pub editing: bool,
    #[serde(rename = "sourceReveal")]
    pub source_reveal: bool,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct LivePreviewResponse {
    pub contract: String,
    pub projection: String,
    pub html: String,
    pub source: LiveSourceIdentity,
    pub capabilities: LiveCapabilities,
    pub diagnostics: Vec<LiveDiagnostic>,
    pub outline: Vec<LiveOutlineEntry>,
    pub navigate: LiveNavigate,
    pub changes: Vec<LiveChangeEntry>,
    pub tokens: Vec<LiveToken>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct LiveRenderResult {
    pub response: LivePreviewResponse,
    pub warnings: Vec<String>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct LiveContractError {
    pub message: String,
}

impl fmt::Display for LiveContractError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.message)
    }
}

impl std::error::Error for LiveContractError {}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PreviewError {
    pub code: String,
    pub message: String,
}

impl PreviewError {
    pub fn new(code: impl Into<String>, message: impl Into<String>) -> Self {
        Self {
            code: code.into(),
            message: message.into(),
        }
    }
}

impl fmt::Display for PreviewError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.message)
    }
}

impl std::error::Error for PreviewError {}

pub use crate::html_escape::escape_live_html;

pub fn detect_line_ending(text: &str) -> LineEnding {
    let crlf = text.contains("\r\n");
    let lone_lf = text.replace("\r\n", "").contains('\n');
    if crlf && lone_lf {
        LineEnding::Mixed
    } else if crlf {
        LineEnding::Crlf
    } else {
        LineEnding::Lf
    }
}

/// Deno `text.split(/\r?\n/).length`.
pub fn count_lines(text: &str) -> u32 {
    if text.is_empty() {
        return 1;
    }
    let mut n = 1u32;
    let bytes = text.as_bytes();
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'\r' && i + 1 < bytes.len() && bytes[i + 1] == b'\n' {
            n = n.saturating_add(1);
            i += 2;
        } else if bytes[i] == b'\n' {
            n = n.saturating_add(1);
            i += 1;
        } else {
            i += 1;
        }
    }
    n
}

pub fn validate_live_response(value: &Value) -> Result<LivePreviewResponse, LiveContractError> {
    let mut obj = value.clone();
    if !obj.is_object() {
        return Err(contract_err("Live response must be a JSON object."));
    }
    let map = obj.as_object().expect("invariant: object checked");
    if map.get("contract").and_then(Value::as_str) != Some(LIVE_CONTRACT) {
        return Err(contract_err(format!("contract must be '{LIVE_CONTRACT}'.")));
    }
    if map.get("projection").and_then(Value::as_str) != Some(LIVE_PROJECTION) {
        return Err(contract_err(format!(
            "projection must be '{LIVE_PROJECTION}'."
        )));
    }
    if !map.get("html").is_some_and(Value::is_string) {
        return Err(contract_err("html must be a string."));
    }
    for field in LIVE_DEFERRED_FIELDS {
        if map.contains_key(*field) {
            return Err(contract_err(format!(
                "Live response must omit deferred field '{field}'."
            )));
        }
    }
    let Some(source) = map.get("source") else {
        return Err(contract_err("source must be an object."));
    };
    if source.is_null() || !source.is_object() {
        return Err(contract_err("source must be an object."));
    }
    let src = source.as_object().expect("invariant: source object");
    match src.get("path").and_then(Value::as_str) {
        Some(p) if !p.is_empty() => {}
        _ => return Err(contract_err("source.path must be a non-empty string.")),
    }
    if src.get("hashAlgorithm").and_then(Value::as_str) != Some(LIVE_HASH_ALGORITHM) {
        return Err(contract_err(format!(
            "source.hashAlgorithm must be '{LIVE_HASH_ALGORITHM}'."
        )));
    }
    if src.get("hashInput").and_then(Value::as_str) != Some(LIVE_HASH_INPUT) {
        return Err(contract_err(format!(
            "source.hashInput must be '{LIVE_HASH_INPUT}'."
        )));
    }
    match src.get("diskHash").and_then(Value::as_str) {
        Some(h) if is_sha256_hex(h) => {}
        _ => {
            return Err(contract_err(
                "source.diskHash must be a 64-char lowercase SHA-256 hex digest.",
            ));
        }
    }
    match src.get("lineEnding").and_then(Value::as_str) {
        Some("lf" | "crlf" | "mixed") => {}
        _ => {
            return Err(contract_err(
                "source.lineEnding must be lf, crlf, or mixed.",
            ));
        }
    }
    if !json_is_integer(src.get("lineCount"))
        || json_as_i64(src.get("lineCount")).is_none_or(|n| n < 1)
    {
        return Err(contract_err("source.lineCount must be a positive integer."));
    }
    if src.get("fresh") != Some(&Value::Bool(true)) {
        return Err(contract_err(
            "source.fresh must be true: lq always reads the saved file.",
        ));
    }
    let Some(caps) = map.get("capabilities") else {
        return Err(contract_err("capabilities must be an object."));
    };
    if caps.is_null() || !caps.is_object() {
        return Err(contract_err("capabilities must be an object."));
    }
    let c = caps.as_object().expect("invariant: capabilities object");
    check_cap(c, "review", LIVE_CAPABILITIES.review)?;
    check_cap(c, "mapping", LIVE_CAPABILITIES.mapping)?;
    check_cap(c, "outline", LIVE_CAPABILITIES.outline)?;
    check_cap(c, "editing", LIVE_CAPABILITIES.editing)?;
    check_cap(c, "sourceReveal", LIVE_CAPABILITIES.source_reveal)?;
    let Some(outline) = map.get("outline") else {
        return Err(contract_err("outline must be an array."));
    };
    let Some(outline_arr) = outline.as_array() else {
        return Err(contract_err("outline must be an array."));
    };
    for entry in outline_arr {
        if entry.is_null() || !entry.is_object() {
            return Err(contract_err("each outline entry must be an object."));
        }
        let e = entry.as_object().expect("invariant: outline entry");
        if !json_is_integer(e.get("level")) {
            return Err(contract_err("outline entry.level must be an integer."));
        }
        if !is_string_field(e.get("number"))
            || !is_string_field(e.get("text"))
            || !is_string_field(e.get("id"))
        {
            return Err(contract_err(
                "outline entry needs string number, text, and id.",
            ));
        }
    }
    let Some(navigate) = map.get("navigate") else {
        return Err(contract_err("navigate must be an object."));
    };
    if navigate.is_null() || !navigate.is_object() {
        return Err(contract_err("navigate must be an object."));
    }
    let nav = navigate.as_object().expect("invariant: navigate object");
    for key in [
        "figures",
        "tables",
        "equations",
        "labels",
        "listings",
        "algorithms",
    ] {
        if !nav.get(key).is_some_and(Value::is_array) {
            return Err(contract_err(format!("navigate.{key} must be an array.")));
        }
    }
    let Some(changes) = map.get("changes") else {
        return Err(contract_err("changes must be an array."));
    };
    let Some(changes_arr) = changes.as_array() else {
        return Err(contract_err("changes must be an array."));
    };
    for entry in changes_arr {
        if entry.is_null() || !entry.is_object() {
            return Err(contract_err("each change entry must be an object."));
        }
        let e = entry.as_object().expect("invariant: change entry");
        if !json_is_integer(e.get("ordinal")) || json_as_i64(e.get("ordinal")).is_none_or(|n| n < 1)
        {
            return Err(contract_err(
                "change entry.ordinal must be a positive integer.",
            ));
        }
        match e.get("type").and_then(Value::as_str) {
            Some("inserted" | "deleted") => {}
            _ => {
                return Err(contract_err(
                    "change entry.type must be 'inserted' or 'deleted'.",
                ));
            }
        }
        if !is_string_field(e.get("author")) || !is_string_field(e.get("ts")) {
            return Err(contract_err("change entry needs string author and ts."));
        }
        match e.get("anchorId").and_then(Value::as_str) {
            Some(s) if !s.is_empty() => {}
            _ => {
                return Err(contract_err(
                    "change entry.anchorId must be a non-empty string.",
                ));
            }
        }
        if !is_string_field(e.get("snippet")) {
            return Err(contract_err("change entry.snippet must be a string."));
        }
    }
    let Some(tokens) = map.get("tokens") else {
        return Err(contract_err("tokens must be an array."));
    };
    let Some(tokens_arr) = tokens.as_array() else {
        return Err(contract_err("tokens must be an array."));
    };
    let mut seen_token_ids = HashSet::new();
    for entry in tokens_arr {
        if entry.is_null() || !entry.is_object() {
            return Err(contract_err("each token must be an object."));
        }
        let t = entry.as_object().expect("invariant: token object");
        let Some(id) = t
            .get("id")
            .and_then(Value::as_str)
            .filter(|s| !s.is_empty())
        else {
            return Err(contract_err("token.id must be a non-empty string."));
        };
        if !seen_token_ids.insert(id.to_string()) {
            return Err(contract_err(format!("token.id '{id}' is not unique.")));
        }
        let Some(bundle) = t.get("bundle") else {
            return Err(contract_err("token.bundle must be an object."));
        };
        if bundle.is_null() || !bundle.is_object() {
            return Err(contract_err("token.bundle must be an object."));
        }
        let b = bundle.as_object().expect("invariant: bundle object");
        match b.get("selector").and_then(Value::as_str) {
            Some(s) if !s.is_empty() => {}
            _ => {
                return Err(contract_err(
                    "token.bundle.selector must be a non-empty string.",
                ));
            }
        }
        if b.contains_key("file") && !b.get("file").is_some_and(Value::is_null) {
            match b.get("file").and_then(Value::as_str) {
                Some(s) if !s.is_empty() => {}
                _ => {
                    return Err(contract_err(
                        "token.bundle.file must be a non-empty string when present.",
                    ));
                }
            }
            match b.get("diskHash").and_then(Value::as_str) {
                Some(s) if !s.is_empty() => {}
                _ => {
                    return Err(contract_err(
                        "token.bundle.diskHash must be a non-empty string when file is set.",
                    ));
                }
            }
        }
        if b.contains_key("via") && !b.get("via").is_some_and(Value::is_null) {
            let Some(via) = b.get("via") else {
                return Err(contract_err(
                    "token.bundle.via must be an object when present.",
                ));
            };
            if !via.is_object() {
                return Err(contract_err(
                    "token.bundle.via must be an object when present.",
                ));
            }
            let v = via.as_object().expect("invariant: via object");
            match v.get("file").and_then(Value::as_str) {
                Some(s) if !s.is_empty() => {}
                _ => {
                    return Err(contract_err(
                        "token.bundle.via.file must be a non-empty string.",
                    ));
                }
            }
            match v.get("selector").and_then(Value::as_str) {
                Some(s) if !s.is_empty() => {}
                _ => {
                    return Err(contract_err(
                        "token.bundle.via.selector must be a non-empty string.",
                    ));
                }
            }
        }
    }
    if let Some(diagnostics) = map.get("diagnostics") {
        let Some(arr) = diagnostics.as_array() else {
            return Err(contract_err("diagnostics must be an array."));
        };
        for d in arr {
            if d.is_null() || !d.is_object() {
                return Err(contract_err("each diagnostic must be an object."));
            }
            let diag = d.as_object().expect("invariant: diagnostic");
            if !is_string_field(diag.get("code")) || !is_string_field(diag.get("message")) {
                return Err(contract_err(
                    "each diagnostic needs string code and message.",
                ));
            }
        }
    } else {
        return Err(contract_err("diagnostics must be an array."));
    }
    if map.contains_key("warnings") {
        let Some(arr) = map.get("warnings").and_then(Value::as_array) else {
            return Err(contract_err(
                "warnings, when present, must be an array of strings.",
            ));
        };
        if arr.iter().any(|w| !w.is_string()) {
            return Err(contract_err("warnings must contain only strings."));
        }
    }

    // DL138 J3: leftover coords are ignored, not part of the contract.
    if let Some(tokens) = obj.get_mut("tokens").and_then(Value::as_array_mut) {
        for t in tokens {
            if let Some(b) = t.get_mut("bundle").and_then(Value::as_object_mut) {
                b.remove("coords");
            }
        }
    }

    serde_json::from_value(obj)
        .map_err(|e| contract_err(format!("Live response failed to deserialize: {e}")))
}

#[derive(Clone, Debug, Default)]
pub struct LiveRenderOptions {
    pub file_path: Option<PathBuf>,
    pub layouts_dir: Option<PathBuf>,
    pub overlay_layouts_dir: Option<PathBuf>,
    pub system_layouts_dir: Option<PathBuf>,
    /// `.lq/cache/raster` for Magick figure PNGs (031). `None` → derive from cwd/state.
    pub raster_dir: Option<PathBuf>,
}

pub struct LiveHtml {
    pub html: String,
    pub warnings: Vec<String>,
    pub diagnostics: Vec<LiveDiagnostic>,
    pub outline: Vec<LiveOutlineEntry>,
    pub navigate: LiveNavigate,
    pub changes: Vec<LiveChangeEntry>,
    pub tokens: Vec<LiveToken>,
}

pub fn render_live_html(
    ast: &Document,
    options: LiveRenderOptions,
) -> Result<LiveHtml, PreviewError> {
    let (search_paths, system_layouts_dir) = if options.overlay_layouts_dir.is_none()
        && options.system_layouts_dir.is_none()
        && let Some(dir) = options.layouts_dir
    {
        (vec![dir.clone()], Some(dir))
    } else {
        let roots = resolve_layout_search_paths(&LayoutSearchOptions {
            overlay_layouts_dir: options.overlay_layouts_dir.clone(),
            system_layouts_dir: options.system_layouts_dir.clone(),
        });
        (roots.search_paths, Some(roots.system))
    };
    let layout_html = load_layout_html(ast, &search_paths)?;
    let system_ref = system_layouts_dir.as_deref();
    let system_bind = bind_dir_from_layouts(system_ref);
    let user_layouts = get_lyx_user_layouts_dir(system_ref);
    let user_bind = bind_dir_from_layouts(user_layouts.as_deref());
    let (shortcuts, bind_warnings) =
        load_shortcut_map_merged(system_bind.as_deref(), user_bind.as_deref());
    let mut ctx = RenderCtx {
        warnings: bind_warnings,
        diagnostics: Vec::new(),
        footnote: 0,
        title_foot: 0,
        figure: 0,
        table: 0,
        algorithm: 0,
        listing: 0,
        equation: 0,
        chapter_label: String::new(),
        in_title: false,
        in_wrap: false,
        in_nomencl: false,
        file_path: options.file_path.clone(),
        system_doc_dir: system_ref.map(|p| p.join("..").join("doc")),
        system_images_dir: images_dir_from_layouts(system_ref),
        magick_path: graphics::find_magick(system_ref),
        raster_dir: options.raster_dir.clone().or_else(|| {
            let cwd = options
                .file_path
                .as_deref()
                .and_then(|p| p.parent())
                .unwrap_or_else(|| Path::new("."));
            crate::paths::resolve_state_paths(cwd, None).map(|s| s.cache.join("raster"))
        }),
        preview_uri_memo: HashMap::new(),
        preview_path_memo: HashMap::new(),
        icon_uri_memo: HashMap::new(),
        icon_aliases: None,
        labels: HashMap::new(),
        label_kinds: HashMap::new(),
        label_titles: HashMap::new(),
        bib: HashMap::new(),
        cited_keys: HashSet::new(),
        bibfiles: String::new(),
        btprint: String::new(),
        biboptions: String::new(),
        outline: Vec::new(),
        layout_html: Some(layout_html),
        shortcuts: Some(shortcuts),
        math_macros: index::extract_math_macros(ast),
        nomencl: Vec::new(),
        index: Vec::new(),
        nomencl_seq: 0,
        index_seq: 0,
        layout_counters: HashMap::new(),
        float_type_counts: HashMap::new(),
        sub_float_counts: HashMap::new(),
        in_float: false,
        float_number_stack: Vec::new(),
        float_stack: Vec::new(),
        float_list_entries: Vec::new(),
        nav_equations: Vec::new(),
        authors: index::document_authors(ast),
        changes: Vec::new(),
        change_seq: 0,
        author_slots: HashMap::new(),
        tokens: Vec::new(),
        query_index: mapping::build_query_index(ast, ast.root()),
        tok_seq: 0,
        current_layout_selector: None,
        current_layout_node: None,
        current_inset_selector: None,
        current_inset_node: None,
        foreign: None,
        used_token_ids: HashSet::new(),
        bibitem: 0,
        include_stack: Vec::new(),
        subeq: None,
        branches: index::document_branches(ast),
        par_indent: mapping::document_par_indent(ast),
        ast,
    };
    let body = find_body(ast);
    index::index_document(&body, &mut ctx);
    index::load_bibliography(&mut ctx);
    let inner = flow::render_flow_items(&flow::flatten_flow(ast, &body, 0), &mut ctx, None);
    let navigate = index::build_navigate(&ctx);
    let mut changes = ctx.changes;
    changes.sort_by_key(|e| e.ordinal);
    Ok(LiveHtml {
        html: format!(
            "<article{}>{inner}</article>",
            article_par_attrs(ast, ctx.par_indent)
        ),
        warnings: ctx.warnings,
        diagnostics: ctx.diagnostics,
        outline: ctx.outline,
        navigate,
        changes,
        tokens: ctx.tokens,
    })
}

pub fn build_live_response(
    file_path: &Path,
    ast: &Document,
    text: &str,
    overlay_layouts_dir: Option<&Path>,
    system_layouts_dir: Option<&Path>,
    disk_hash: Option<&str>,
) -> Result<LiveRenderResult, PreviewError> {
    let resolved = resolve_path(file_path);
    let rendered = render_live_html(
        ast,
        LiveRenderOptions {
            file_path: Some(resolved.clone()),
            layouts_dir: None,
            overlay_layouts_dir: overlay_layouts_dir.map(Path::to_path_buf),
            system_layouts_dir: system_layouts_dir.map(Path::to_path_buf),
            raster_dir: None,
        },
    )?;
    let hash = match disk_hash {
        Some(h) => h.to_string(),
        None => hash_file(&resolved).unwrap_or_else(|_| crate::cache::hash_text(text)),
    };
    let response = LivePreviewResponse {
        contract: LIVE_CONTRACT.into(),
        projection: LIVE_PROJECTION.into(),
        html: rendered.html,
        source: LiveSourceIdentity {
            path: resolved.to_string_lossy().into_owned(),
            hash_algorithm: LIVE_HASH_ALGORITHM.into(),
            hash_input: LIVE_HASH_INPUT.into(),
            disk_hash: hash,
            line_ending: detect_line_ending(text),
            line_count: count_lines(text),
            fresh: true,
        },
        capabilities: LIVE_CAPABILITIES,
        diagnostics: rendered.diagnostics,
        outline: rendered.outline,
        navigate: rendered.navigate,
        changes: rendered.changes,
        tokens: rendered.tokens,
    };
    Ok(LiveRenderResult {
        response,
        warnings: rendered.warnings,
    })
}

pub(crate) struct QueryIndexEntry {
    pub name: String,
    pub global_n: usize,
}

pub(crate) struct QueryIndex {
    pub by_id: HashMap<NodeId, QueryIndexEntry>,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Hash)]
pub(crate) enum QueryTag {
    Layout,
    Inset,
}

pub(crate) struct ForeignInclude {
    pub file: String,
    pub disk_hash: String,
    pub via: LiveTokenVia,
    pub query_index: QueryIndex,
    pub ast: Document,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum LabelKind {
    Heading,
    Float,
    Equation,
    Other,
}

#[derive(Clone, Debug)]
pub(crate) struct FloatListEntry {
    pub type_: String,
    pub number: String,
    pub text: String,
    pub id: String,
    pub children: Option<Vec<FloatListEntry>>,
}

#[derive(Clone, Debug)]
pub(crate) struct NomenclEntry {
    pub symbol: String,
    pub desc: String,
    pub sort: String,
    pub id: String,
}

#[derive(Clone, Debug)]
pub(crate) struct IndexEntry {
    pub terms: Vec<String>,
    pub see: String,
    pub sort: String,
    pub id: String,
}

pub(crate) struct SubeqState {
    pub parent: i32,
    pub child: i32,
}

pub(crate) struct RenderCtx<'a> {
    pub warnings: Vec<String>,
    pub diagnostics: Vec<LiveDiagnostic>,
    pub footnote: u32,
    pub title_foot: u32,
    pub figure: u32,
    pub table: u32,
    pub algorithm: u32,
    pub listing: u32,
    pub equation: u32,
    pub chapter_label: String,
    pub in_title: bool,
    pub in_wrap: bool,
    pub in_nomencl: bool,
    pub file_path: Option<PathBuf>,
    pub system_doc_dir: Option<PathBuf>,
    pub system_images_dir: Option<PathBuf>,
    pub magick_path: Option<PathBuf>,
    pub raster_dir: Option<PathBuf>,
    pub preview_uri_memo: HashMap<String, String>,
    pub preview_path_memo: HashMap<String, String>,
    pub icon_uri_memo: HashMap<String, Option<String>>,
    pub icon_aliases: Option<Vec<(String, String)>>,
    pub labels: HashMap<String, String>,
    pub label_kinds: HashMap<String, LabelKind>,
    pub label_titles: HashMap<String, String>,
    pub bib: HashMap<String, Citation>,
    pub cited_keys: HashSet<String>,
    pub bibfiles: String,
    pub btprint: String,
    pub biboptions: String,
    pub outline: Vec<LiveOutlineEntry>,
    pub layout_html: Option<HashMap<String, LayoutHtml>>,
    pub shortcuts: Option<ShortcutMap>,
    pub math_macros: Option<MathMacroMap>,
    pub nomencl: Vec<NomenclEntry>,
    pub index: Vec<IndexEntry>,
    pub nomencl_seq: u32,
    pub index_seq: u32,
    pub layout_counters: HashMap<String, u32>,
    pub float_type_counts: HashMap<String, u32>,
    pub sub_float_counts: HashMap<String, u32>,
    pub in_float: bool,
    pub float_number_stack: Vec<String>,
    pub float_stack: Vec<FloatListEntry>,
    pub float_list_entries: Vec<FloatListEntry>,
    pub nav_equations: Vec<LiveNavEntry>,
    pub authors: HashMap<i32, String>,
    pub changes: Vec<LiveChangeEntry>,
    pub change_seq: u32,
    pub author_slots: HashMap<i32, u32>,
    pub tokens: Vec<LiveToken>,
    pub query_index: QueryIndex,
    pub tok_seq: u32,
    pub current_layout_selector: Option<String>,
    pub current_layout_node: Option<NodeId>,
    pub current_inset_selector: Option<String>,
    pub current_inset_node: Option<NodeId>,
    pub foreign: Option<ForeignInclude>,
    pub used_token_ids: HashSet<String>,
    pub bibitem: u32,
    pub include_stack: Vec<String>,
    pub subeq: Option<SubeqState>,
    pub branches: HashMap<String, bool>,
    pub par_indent: bool,
    pub ast: &'a Document,
}

impl RenderCtx<'_> {
    pub(crate) fn doc(&self) -> &Document {
        match &self.foreign {
            Some(f) => &f.ast,
            None => self.ast,
        }
    }
}

pub(crate) struct FlowItem {
    pub layout: String,
    pub depth: i32,
    pub node: NodeId,
}

fn article_par_attrs(ast: &Document, indent: bool) -> String {
    if indent {
        match mapping::document_par_indent_css(ast) {
            Some(len) => {
                format!(r#" class="lyx-live" data-par-sep="indent" style="--par-indent: {len}""#)
            }
            None => r#" class="lyx-live" data-par-sep="indent""#.to_string(),
        }
    } else {
        r#" class="lyx-live" data-par-sep="skip""#.to_string()
    }
}

pub(crate) fn find_body(ast: &Document) -> Vec<NodeId> {
    let root_kids = &ast.node(ast.root()).children;
    let doc = root_kids
        .iter()
        .copied()
        .find(|&id| matches!(&ast.node(id).kind, NodeKind::Block { tag, .. } if tag == "document"));
    let search = doc
        .map(|id| ast.node(id).children.as_slice())
        .unwrap_or(root_kids);
    if let Some(body) = search
        .iter()
        .copied()
        .find(|&id| matches!(&ast.node(id).kind, NodeKind::Block { tag, .. } if tag == "body"))
    {
        return ast.node(body).children.clone();
    }
    search.to_vec()
}

fn load_layout_html(
    ast: &Document,
    search_paths: &[PathBuf],
) -> Result<HashMap<String, LayoutHtml>, PreviewError> {
    let ctx = extract_document_layout_context(ast);
    let Some(textclass) = ctx.textclass.as_deref() else {
        return Err(PreviewError::new(
            "NO_TEXTCLASS",
            "Could not determine textclass from the document.",
        ));
    };
    if search_paths.is_empty() {
        return Err(PreviewError::new(
            "LAYOUT_NOT_FOUND",
            format!(
                "Layout file not found for textclass '{textclass}' (no layout search paths). \
Install LyX or set --layouts-dir / config layoutsDir."
            ),
        ));
    }
    if find_layout_file(&format!("{textclass}.layout"), search_paths).is_none() {
        let listed = search_paths
            .iter()
            .map(|p| p.to_string_lossy().into_owned())
            .collect::<Vec<_>>()
            .join(", ");
        return Err(PreviewError::new(
            "LAYOUT_NOT_FOUND",
            format!(
                "Layout file not found for textclass '{textclass}' in: {listed}. \
Install LyX layouts, add a LyX user-dir layout, or set layoutsDir."
            ),
        ));
    }
    let modules: Vec<&str> = ctx.modules.iter().map(String::as_str).collect();
    Ok(get_layout_html_for_class(
        textclass,
        search_paths,
        &modules,
        Some(&ctx.local),
    ))
}

fn resolve_path(file_path: &Path) -> PathBuf {
    std::path::absolute(file_path).unwrap_or_else(|_| file_path.to_path_buf())
}

fn contract_err(message: impl Into<String>) -> LiveContractError {
    LiveContractError {
        message: message.into(),
    }
}

fn is_sha256_hex(s: &str) -> bool {
    s.len() == 64 && s.bytes().all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f'))
}

fn json_is_integer(v: Option<&Value>) -> bool {
    let Some(Value::Number(n)) = v else {
        return false;
    };
    n.as_i64().is_some() || n.as_u64().is_some() || n.as_f64().is_some_and(|f| f.fract() == 0.0)
}

fn json_as_i64(v: Option<&Value>) -> Option<i64> {
    v.and_then(Value::as_i64)
        .or_else(|| {
            v.and_then(Value::as_u64)
                .and_then(|u| i64::try_from(u).ok())
        })
        .or_else(|| {
            v.and_then(Value::as_f64)
                .filter(|f| f.fract() == 0.0)
                .map(|f| f as i64)
        })
}

fn is_string_field(v: Option<&Value>) -> bool {
    v.is_some_and(Value::is_string)
}

fn check_cap(
    c: &serde_json::Map<String, Value>,
    key: &str,
    expected: bool,
) -> Result<(), LiveContractError> {
    if c.get(key) != Some(&Value::Bool(expected)) {
        return Err(contract_err(format!(
            "capabilities.{key} must be {expected} in this slice."
        )));
    }
    Ok(())
}
