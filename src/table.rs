//! Native LyX tables: `--table` / `--data` text, catalog, and grid edits.

use crate::ast::{Document, NodeId, NodeKind};
use crate::preview::QueryIndex;
use crate::preview::mapping::{build_query_index, is_path_prefix_inset, layout_host_selector};
use crate::query::query;
use crate::text_utils::{TextRegion, TraversalState, advance_change_depths, traversal_region};
use crate::tracked_changes::{
    ChangeKind, is_change_closer, is_change_opener, wrap_in_change_markers,
};
use serde::Serialize;
use std::collections::HashMap;

pub const OPS: &[&str] = &[
    "set",
    "add-row",
    "add-column",
    "delete-row",
    "delete-column",
];

#[derive(Debug)]
pub struct TableError {
    pub code: &'static str,
    pub message: String,
    pub rows: Option<usize>,
    pub columns: Option<usize>,
}

impl TableError {
    pub fn new(code: &'static str, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
            rows: None,
            columns: None,
        }
    }

    pub fn with_size(mut self, rows: usize, columns: usize) -> Self {
        self.rows = Some(rows);
        self.columns = Some(columns);
        self
    }
}

#[derive(Clone, Debug, Serialize)]
pub struct Merge {
    pub r: usize,
    pub c: usize,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub colspan: Option<usize>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub rowspan: Option<usize>,
}

#[derive(Clone, Debug, Serialize)]
pub struct CatalogRow {
    pub n: usize,
    pub kind: String,
    pub at: String,
    pub caption: Option<String>,
    pub label: Option<String>,
    pub region: String,
    pub data: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub merges: Option<Vec<Merge>>,
}

#[derive(Clone, Debug)]
struct CellModel {
    open: String,
    inset: NodeId,
}

#[derive(Clone, Debug)]
struct RowModel {
    open: String,
    cells: Vec<CellModel>,
}

#[derive(Clone, Debug)]
struct GridModel {
    tabular_open: String,
    features: String,
    columns: Vec<String>,
    rows: Vec<RowModel>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum ColSpan {
    Normal,
    Begin,
    Part,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum RowSpan {
    Normal,
    Begin,
    Part,
}

pub fn is_op(token: &str) -> bool {
    OPS.contains(&token)
}

pub fn parse_index_token(token: &str) -> Option<usize> {
    if token.is_empty() || !token.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    token.parse().ok()
}

/// Parse `--table` / `--data` text. Empty string is `MISSING_CONTENT`.
pub fn parse_rect(input: &str) -> Result<Vec<Vec<String>>, TableError> {
    if input.is_empty() {
        return Err(TableError::new(
            "MISSING_CONTENT",
            "Provide a non-empty table as comma-separated fields, one row per line.",
        ));
    }
    let stripped = input.strip_suffix('\n').unwrap_or(input);
    let stripped = stripped.strip_suffix('\r').unwrap_or(stripped);
    if stripped.is_empty() {
        return Err(TableError::new(
            "MISSING_CONTENT",
            "Provide a non-empty table as comma-separated fields, one row per line.",
        ));
    }
    let mut rows: Vec<Vec<String>> = Vec::new();
    for line in stripped.split('\n') {
        let line = line.strip_suffix('\r').unwrap_or(line);
        rows.push(parse_csv_line(line)?);
    }
    let width = rows[0].len();
    if width == 0 {
        return Err(TableError::new(
            "INVALID_FLAG",
            "Each row needs at least one field.",
        ));
    }
    if let Some((i, row)) = rows.iter().enumerate().find(|(_, r)| r.len() != width) {
        return Err(TableError::new(
            "INVALID_FLAG",
            format!(
                "Row {} has {} fields, expected {width} (same count on every row).",
                i + 1,
                row.len()
            ),
        ));
    }
    Ok(rows)
}

pub fn serialize_rect(rows: &[Vec<String>]) -> String {
    rows.iter()
        .map(|row| {
            row.iter()
                .map(|field| escape_field(field))
                .collect::<Vec<_>>()
                .join(",")
        })
        .collect::<Vec<_>>()
        .join("\n")
}

fn escape_field(s: &str) -> String {
    if s.contains(',') || s.contains('"') {
        format!("\"{}\"", s.replace('"', "\"\""))
    } else {
        s.to_string()
    }
}

fn parse_csv_line(line: &str) -> Result<Vec<String>, TableError> {
    let mut fields = Vec::new();
    let mut cur = String::new();
    let mut chars = line.chars().peekable();
    let mut in_quotes = false;
    while let Some(ch) = chars.next() {
        if in_quotes {
            if ch == '"' {
                if chars.peek() == Some(&'"') {
                    chars.next();
                    cur.push('"');
                } else {
                    in_quotes = false;
                }
            } else {
                cur.push(ch);
            }
        } else if ch == '"' {
            in_quotes = true;
        } else if ch == ',' {
            fields.push(std::mem::take(&mut cur));
        } else {
            cur.push(ch);
        }
    }
    if in_quotes {
        return Err(TableError::new(
            "INVALID_FLAG",
            "A quoted field must end on the same line. Newlines inside quotes are not allowed.",
        ));
    }
    fields.push(cur);
    Ok(fields)
}

pub fn list_tabulars(doc: &Document) -> Vec<NodeId> {
    query(doc, "inset[Tabular]").unwrap_or_default()
}

pub fn catalog_of(
    doc: &Document,
    tabulars: &[NodeId],
    traversal: &HashMap<NodeId, TraversalState>,
) -> Result<(Vec<CatalogRow>, Vec<String>), TableError> {
    let all = list_tabulars(doc);
    let parents = parent_map(doc);
    let index = build_query_index(doc, doc.root());
    let mut rows = Vec::new();
    let mut warnings = Vec::new();
    for &id in tabulars {
        let n = all
            .iter()
            .position(|&t| t == id)
            .map(|i| i + 1)
            .unwrap_or(0);
        if n == 0 {
            continue;
        }
        let (row, warn) = catalog_row(doc, id, n, &parents, &index, traversal)?;
        if let Some(w) = warn {
            warnings.push(w);
        }
        rows.push(row);
    }
    if rows.is_empty() {
        return Err(TableError::new(
            "NO_MATCH",
            "No matching table. Run 'lq table FILE' to list indexes.",
        ));
    }
    Ok((rows, warnings))
}

pub fn pick_by_n(doc: &Document, n: usize) -> Result<NodeId, TableError> {
    let ids = list_tabulars(doc);
    if n == 0 || n > ids.len() {
        return Err(TableError::new(
            "NO_MATCH",
            format!("No table with index {n}. Run 'lq table FILE' to list indexes."),
        ));
    }
    Ok(ids[n - 1])
}

pub fn resolve_to_tables(doc: &Document, nodes: &[NodeId]) -> Vec<NodeId> {
    let parents = parent_map(doc);
    let mut out = Vec::new();
    let mut seen = std::collections::HashSet::new();
    for &node in nodes {
        for id in tables_for_node(doc, node, &parents) {
            if seen.insert(id) {
                out.push(id);
            }
        }
    }
    let order = list_tabulars(doc);
    out.sort_by_key(|id| order.iter().position(|&t| t == *id).unwrap_or(usize::MAX));
    out
}

fn tables_for_node(doc: &Document, node: NodeId, parents: &HashMap<NodeId, NodeId>) -> Vec<NodeId> {
    if is_tabular(doc, node) {
        return vec![node];
    }
    if let Some(anc) = nearest_ancestor_tabular(doc, node, parents) {
        return vec![anc];
    }
    let desc = descendant_tabulars(doc, node);
    if !desc.is_empty() {
        return desc;
    }
    let mut cur = node;
    while let Some(&p) = parents.get(&cur) {
        let desc = descendant_tabulars(doc, p);
        if !desc.is_empty() {
            return desc;
        }
        cur = p;
    }
    Vec::new()
}

fn nearest_ancestor_tabular(
    doc: &Document,
    node: NodeId,
    parents: &HashMap<NodeId, NodeId>,
) -> Option<NodeId> {
    let mut cur = node;
    while let Some(&p) = parents.get(&cur) {
        if is_tabular(doc, p) {
            return Some(p);
        }
        cur = p;
    }
    None
}

fn descendant_tabulars(doc: &Document, root: NodeId) -> Vec<NodeId> {
    let mut out = Vec::new();
    fn walk(doc: &Document, id: NodeId, out: &mut Vec<NodeId>) {
        for &c in &doc.node(id).children {
            if is_tabular(doc, c) {
                out.push(c);
            }
            if matches!(doc.node(c).kind, NodeKind::Block { .. }) {
                walk(doc, c, out);
            }
        }
    }
    walk(doc, root, &mut out);
    out
}

fn catalog_row(
    doc: &Document,
    tabular: NodeId,
    n: usize,
    parents: &HashMap<NodeId, NodeId>,
    index: &QueryIndex,
    traversal: &HashMap<NodeId, TraversalState>,
) -> Result<(CatalogRow, Option<String>), TableError> {
    let grid = parse_grid(doc, tabular)?;
    let (data, merges, nested) = grid_data(doc, &grid);
    let kind = table_kind(doc, tabular, parents);
    let at = table_at(doc, tabular, parents, index);
    let (caption, label) = caption_and_label(doc, tabular, parents);
    let region = table_region(tabular, traversal);
    let warn = if nested {
        Some(format!(
            "Table {n} has nested insets (formula, graphics, caption, …). They are not in data."
        ))
    } else {
        None
    };
    Ok((
        CatalogRow {
            n,
            kind,
            at,
            caption,
            label,
            region,
            data,
            merges,
        },
        warn,
    ))
}

fn table_kind(doc: &Document, tabular: NodeId, parents: &HashMap<NodeId, NodeId>) -> String {
    if tabular_is_longtable(doc, tabular) {
        return "longtable".into();
    }
    if enclosing_float_table(doc, tabular, parents).is_some() {
        return "float".into();
    }
    "inline".into()
}

fn table_region(tabular: NodeId, traversal: &HashMap<NodeId, TraversalState>) -> String {
    match traversal.get(&tabular).map(traversal_region) {
        Some(TextRegion::Inserted) => "inserted".into(),
        Some(TextRegion::Deleted) => "deleted".into(),
        _ => "current".into(),
    }
}

fn tabular_is_longtable(doc: &Document, tabular: NodeId) -> bool {
    tabular_xml_meta(doc, tabular).contains("islongtable=\"true\"")
}

fn tabular_xml_meta(doc: &Document, block: NodeId) -> String {
    let mut meta = String::new();
    for &c in &doc.node(block).children {
        if let NodeKind::Text { text } = &doc.node(c).kind {
            if !meta.is_empty() {
                meta.push('\n');
            }
            meta.push_str(text);
        }
    }
    meta
}

fn caption_and_label(
    doc: &Document,
    tabular: NodeId,
    parents: &HashMap<NodeId, NodeId>,
) -> (Option<String>, Option<String>) {
    if let Some(float) = enclosing_float_table(doc, tabular, parents)
        && let Some(cap) = first_caption_named(doc, float, "Caption Standard")
    {
        return (
            Some(layout_prose(doc, cap)).filter(|s| !s.is_empty()),
            first_label_name(doc, cap),
        );
    }
    if let Some(cap) = first_caption_named(doc, tabular, "Caption Standard") {
        return (
            Some(layout_prose(doc, cap)).filter(|s| !s.is_empty()),
            first_label_name(doc, cap),
        );
    }
    (None, None)
}

fn first_caption_named(doc: &Document, root: NodeId, name: &str) -> Option<NodeId> {
    let mut found = None;
    fn walk(doc: &Document, id: NodeId, name: &str, found: &mut Option<NodeId>) {
        if found.is_some() {
            return;
        }
        for &c in &doc.node(id).children {
            if inset_args(doc, c) == Some(name) {
                *found = Some(c);
                return;
            }
            if matches!(doc.node(c).kind, NodeKind::Block { .. }) {
                walk(doc, c, name, found);
            }
        }
    }
    walk(doc, root, name, &mut found);
    found
}

fn first_label_name(doc: &Document, root: NodeId) -> Option<String> {
    let mut found = None;
    fn walk(doc: &Document, id: NodeId, found: &mut Option<String>) {
        if found.is_some() {
            return;
        }
        if inset_args(doc, id) == Some("CommandInset label") {
            *found = label_name_of(doc, id);
            return;
        }
        for &c in &doc.node(id).children {
            if matches!(doc.node(c).kind, NodeKind::Block { .. })
                || matches!(doc.node(c).kind, NodeKind::Text { .. })
            {
                walk(doc, c, found);
            }
        }
    }
    walk(doc, root, &mut found);
    found
}

fn label_name_of(doc: &Document, inset: NodeId) -> Option<String> {
    for &c in &doc.node(inset).children {
        if let NodeKind::Text { text } = &doc.node(c).kind {
            let t = text.trim();
            if let Some(rest) = t.strip_prefix("name ") {
                return Some(unquote_xml(rest));
            }
        }
    }
    None
}

fn unquote_xml(s: &str) -> String {
    let s = s.trim();
    if s.len() >= 2 && s.starts_with('"') && s.ends_with('"') {
        s[1..s.len() - 1].to_string()
    } else {
        s.to_string()
    }
}

fn layout_prose(doc: &Document, caption_inset: NodeId) -> String {
    let layout = first_layout(doc, caption_inset).unwrap_or(caption_inset);
    cell_prose(doc, layout)
}

fn table_at(
    doc: &Document,
    tabular: NodeId,
    parents: &HashMap<NodeId, NodeId>,
    index: &QueryIndex,
) -> String {
    let host = host_layout(doc, tabular, parents);
    let name = block_args(doc, host).unwrap_or("").trim();
    let prefix = innermost_path_prefix(doc, host, parents);
    let host_sel = layout_host_selector(doc, host, name, prefix, index);
    let host_tabs = descendant_tabulars(doc, host);
    let suffix = if host_tabs.len() == 1 {
        "inset[Tabular]".to_string()
    } else {
        let k = host_tabs.iter().position(|&t| t == tabular).unwrap_or(0) + 1;
        format!("inset[Tabular]:nth-match({k})")
    };
    format!("{host_sel} {suffix}")
}

fn host_layout(doc: &Document, tabular: NodeId, parents: &HashMap<NodeId, NodeId>) -> NodeId {
    let start = enclosing_float_table(doc, tabular, parents).unwrap_or(tabular);
    let mut cur = start;
    while let Some(&p) = parents.get(&cur) {
        if is_layout(doc, p) && !is_cell_layout(doc, p, parents) {
            return p;
        }
        cur = p;
    }
    tabular
}

fn is_cell_layout(doc: &Document, layout: NodeId, parents: &HashMap<NodeId, NodeId>) -> bool {
    let mut cur = layout;
    while let Some(&p) = parents.get(&cur) {
        if is_tabular(doc, p) {
            return inset_args(doc, cur) == Some("Text");
        }
        cur = p;
    }
    false
}

fn enclosing_float_table(
    doc: &Document,
    tabular: NodeId,
    parents: &HashMap<NodeId, NodeId>,
) -> Option<NodeId> {
    let mut cur = tabular;
    while let Some(&p) = parents.get(&cur) {
        if inset_args(doc, p) == Some("Float table") {
            return Some(p);
        }
        cur = p;
    }
    None
}

fn innermost_path_prefix(
    doc: &Document,
    host: NodeId,
    parents: &HashMap<NodeId, NodeId>,
) -> Option<NodeId> {
    let mut cur = host;
    while let Some(&p) = parents.get(&cur) {
        if let Some(kind) = inset_args(doc, p)
            && is_path_prefix_inset(kind)
        {
            return Some(p);
        }
        cur = p;
    }
    None
}

fn parent_map(doc: &Document) -> HashMap<NodeId, NodeId> {
    let mut map = HashMap::new();
    fn walk(doc: &Document, parent: NodeId, map: &mut HashMap<NodeId, NodeId>) {
        for &c in &doc.node(parent).children {
            map.insert(c, parent);
            if matches!(doc.node(c).kind, NodeKind::Block { .. }) {
                walk(doc, c, map);
            }
        }
    }
    walk(doc, doc.root(), &mut map);
    map
}

fn is_tabular(doc: &Document, id: NodeId) -> bool {
    matches!(
        inset_args(doc, id),
        Some(a) if a == "Tabular" || a.starts_with("Tabular ")
    )
}

fn is_layout(doc: &Document, id: NodeId) -> bool {
    matches!(&doc.node(id).kind, NodeKind::Block { tag, .. } if tag == "layout")
}

fn is_block(doc: &Document, id: NodeId) -> bool {
    matches!(doc.node(id).kind, NodeKind::Block { .. })
}

fn inset_args(doc: &Document, id: NodeId) -> Option<&str> {
    match &doc.node(id).kind {
        NodeKind::Block { tag, args, .. } if tag == "inset" => args.as_deref().map(str::trim),
        _ => None,
    }
}

fn block_args(doc: &Document, id: NodeId) -> Option<&str> {
    match &doc.node(id).kind {
        NodeKind::Block { args, .. } => args.as_deref(),
        _ => None,
    }
}

fn parse_grid(doc: &Document, tabular: NodeId) -> Result<GridModel, TableError> {
    let mut xml_lines = Vec::new();
    let mut insets = Vec::new();
    for &c in &doc.node(tabular).children {
        match &doc.node(c).kind {
            NodeKind::Text { text } => xml_lines.push(text.clone()),
            NodeKind::Block { tag, args, .. } if tag == "inset" => {
                let name = args.as_deref().unwrap_or("").trim();
                if name == "Text" {
                    insets.push(c);
                }
            }
            _ => {}
        }
    }
    let xml = xml_lines.join("\n");
    let tabular_open = xml_lines
        .iter()
        .find(|l| l.starts_with("<lyxtabular") || l.starts_with("<Tabular"))
        .cloned()
        .ok_or_else(|| {
            TableError::new(
                "INVALID_CONTEXT",
                "This table is missing its <lyxtabular> header. Open it in LyX and save, then retry.",
            )
        })?;
    let features = xml_lines
        .iter()
        .find(|l| l.starts_with("<features"))
        .cloned()
        .unwrap_or_else(|| "<features tabularvalignment=\"middle\">".into());
    let columns: Vec<String> = xml_lines
        .iter()
        .filter(|l| l.starts_with("<column"))
        .cloned()
        .collect();
    let mut rows = Vec::new();
    let mut cur_row: Option<RowModel> = None;
    let mut pending_cell: Option<String> = None;
    let mut inset_i = 0usize;
    for line in xml.split('\n') {
        let t = line.trim_start();
        if t.starts_with("<row") {
            if let Some(row) = cur_row.take() {
                rows.push(row);
            }
            cur_row = Some(RowModel {
                open: line.to_string(),
                cells: Vec::new(),
            });
        } else if t.starts_with("<cell") {
            pending_cell = Some(line.to_string());
        } else if t.starts_with("</cell") {
            let open = pending_cell.take().unwrap_or_else(|| {
                "<cell alignment=\"left\" valignment=\"top\" usebox=\"none\">".into()
            });
            let inset = insets.get(inset_i).copied().ok_or_else(|| {
                TableError::new(
                    "INVALID_CONTEXT",
                    "This table's cells do not match its grid. Open it in LyX and save, then retry.",
                )
            })?;
            inset_i += 1;
            if let Some(ref mut row) = cur_row {
                row.cells.push(CellModel { open, inset });
            }
        } else if t.starts_with("</row")
            && let Some(row) = cur_row.take()
        {
            rows.push(row);
        }
    }
    if let Some(row) = cur_row {
        rows.push(row);
    }
    if rows.is_empty() {
        return Err(TableError::new(
            "INVALID_CONTEXT",
            "This table has no rows. Open it in LyX and save, then retry.",
        ));
    }
    let width = rows[0].cells.len();
    if width == 0 || rows.iter().any(|r| r.cells.len() != width) {
        return Err(TableError::new(
            "INVALID_CONTEXT",
            "This table's cells do not match its grid. Open it in LyX and save, then retry.",
        ));
    }
    if columns.len() != width {
        // LyX may omit nothing; still proceed with the cell grid.
    }
    Ok(GridModel {
        tabular_open,
        features,
        columns,
        rows,
    })
}

fn grid_data(doc: &Document, grid: &GridModel) -> (String, Option<Vec<Merge>>, bool) {
    let mut fields: Vec<Vec<String>> = Vec::new();
    let mut merges = Vec::new();
    let mut nested = false;
    for (ri, row) in grid.rows.iter().enumerate() {
        let mut line = Vec::new();
        for (ci, cell) in row.cells.iter().enumerate() {
            let layout = cell_layout(doc, cell.inset);
            if cell_has_nested_inset(doc, cell.inset) {
                nested = true;
            }
            let col = col_span(&cell.open);
            let rowsp = row_span(&cell.open);
            if col == ColSpan::Part || rowsp == RowSpan::Part {
                line.push(String::new());
            } else {
                line.push(cell_prose(doc, layout));
            }
            if col == ColSpan::Begin || rowsp == RowSpan::Begin {
                let mut m = Merge {
                    r: ri + 1,
                    c: ci + 1,
                    colspan: None,
                    rowspan: None,
                };
                if col == ColSpan::Begin {
                    let mut span = 1usize;
                    for next in row.cells.iter().skip(ci + 1) {
                        if col_span(&next.open) == ColSpan::Part {
                            span += 1;
                        } else {
                            break;
                        }
                    }
                    if span > 1 {
                        m.colspan = Some(span);
                    }
                }
                if rowsp == RowSpan::Begin {
                    let mut span = 1usize;
                    for next in grid.rows.iter().skip(ri + 1) {
                        if next
                            .cells
                            .get(ci)
                            .is_some_and(|c| row_span(&c.open) == RowSpan::Part)
                        {
                            span += 1;
                        } else {
                            break;
                        }
                    }
                    if span > 1 {
                        m.rowspan = Some(span);
                    }
                }
                if m.colspan.is_some() || m.rowspan.is_some() {
                    merges.push(m);
                }
            }
        }
        fields.push(line);
    }
    (
        serialize_rect(&fields),
        if merges.is_empty() {
            None
        } else {
            Some(merges)
        },
        nested,
    )
}

fn col_span(open: &str) -> ColSpan {
    match xml_attr(open, "multicolumn").as_deref() {
        Some("1") => ColSpan::Begin,
        Some("2") => ColSpan::Part,
        _ => ColSpan::Normal,
    }
}

fn row_span(open: &str) -> RowSpan {
    match xml_attr(open, "multirow").as_deref() {
        Some("3") => RowSpan::Begin,
        Some("4") => RowSpan::Part,
        _ => RowSpan::Normal,
    }
}

fn xml_attr(tag: &str, key: &str) -> Option<String> {
    let pat = format!("{key}=\"");
    let start = tag.find(&pat)? + pat.len();
    let rest = &tag[start..];
    let end = rest.find('"')?;
    Some(rest[..end].to_string())
}

fn set_xml_attr(tag: &str, key: &str, value: Option<&str>) -> String {
    let pat = format!("{key}=\"");
    if let Some(i) = tag.find(&pat) {
        let val_start = i + pat.len();
        if let Some(rel) = tag[val_start..].find('"') {
            let val_end = val_start + rel;
            if let Some(v) = value {
                let mut out = String::new();
                out.push_str(&tag[..val_start]);
                out.push_str(v);
                out.push_str(&tag[val_end..]);
                return out;
            }
            let mut from = i;
            if from > 0 && tag.as_bytes()[from - 1] == b' ' {
                from -= 1;
            }
            let mut out = String::new();
            out.push_str(&tag[..from]);
            out.push_str(&tag[val_end + 1..]);
            return out;
        }
    }
    if let Some(v) = value
        && let Some(gt) = tag.rfind('>')
    {
        let mut out = String::new();
        out.push_str(&tag[..gt]);
        if !tag[..gt].ends_with(' ') {
            out.push(' ');
        }
        out.push_str(key);
        out.push_str("=\"");
        out.push_str(v);
        out.push('"');
        out.push_str(&tag[gt..]);
        return out;
    }
    tag.to_string()
}

fn default_cell_open() -> String {
    "<cell alignment=\"left\" valignment=\"top\" usebox=\"none\">".into()
}

fn copy_true_attr(from: &str, to: &mut String, key: &str) {
    if xml_attr(from, key).as_deref() == Some("true") {
        *to = set_xml_attr(to, key, Some("true"));
    }
}

fn inherit_cell_alignment(from: &str, mut open: String) -> String {
    if let Some(a) = xml_attr(from, "alignment") {
        open = set_xml_attr(&open, "alignment", Some(&a));
    }
    if let Some(a) = xml_attr(from, "valignment") {
        open = set_xml_attr(&open, "valignment", Some(&a));
    }
    open
}

/// Empty cell, then F3 insertRow: multirow Begin→Part and line inherit. Never copies colspan.
fn new_row_cell_open(above: &str, insert_after: bool) -> (String, bool, bool) {
    let mut open = inherit_cell_alignment(above, default_cell_open());
    let mut move_bottom = false;
    let mut move_top = false;
    if insert_after {
        if row_span(above) == RowSpan::Begin {
            open = set_xml_attr(&open, "multirow", Some("4"));
        }
        if row_span(above) != RowSpan::Part {
            copy_true_attr(above, &mut open, "leftline");
            copy_true_attr(above, &mut open, "rightline");
            copy_true_attr(above, &mut open, "topline");
            let top = xml_attr(above, "topline").as_deref() == Some("true");
            let bottom = xml_attr(above, "bottomline").as_deref() == Some("true");
            if top && bottom {
                open = set_xml_attr(&open, "bottomline", Some("true"));
                move_bottom = true;
            }
        }
    } else {
        copy_true_attr(above, &mut open, "leftline");
        copy_true_attr(above, &mut open, "rightline");
        copy_true_attr(above, &mut open, "topline");
        if xml_attr(above, "topline").as_deref() == Some("true") {
            move_top = true;
        }
    }
    (open, move_bottom, move_top)
}

/// Empty cell, then F3 insertColumn: may become a multicolumn part; inherit lines.
fn new_column_cell_open(left: &str, insert_after: bool, right_is_part: bool) -> String {
    let mut open = inherit_cell_alignment(left, default_cell_open());
    if insert_after {
        if col_span(left) == ColSpan::Begin || (col_span(left) == ColSpan::Part && right_is_part) {
            open = set_xml_attr(&open, "multicolumn", Some("2"));
        }
        if col_span(left) != ColSpan::Part {
            copy_true_attr(left, &mut open, "topline");
            copy_true_attr(left, &mut open, "bottomline");
            copy_true_attr(left, &mut open, "leftline");
            copy_true_attr(left, &mut open, "rightline");
        }
    } else {
        copy_true_attr(left, &mut open, "topline");
        copy_true_attr(left, &mut open, "bottomline");
        copy_true_attr(left, &mut open, "leftline");
        copy_true_attr(left, &mut open, "rightline");
    }
    open
}

fn cell_layout(doc: &Document, text_inset: NodeId) -> NodeId {
    first_layout(doc, text_inset).unwrap_or(text_inset)
}

fn first_layout(doc: &Document, root: NodeId) -> Option<NodeId> {
    fn walk(doc: &Document, id: NodeId) -> Option<NodeId> {
        for &c in &doc.node(id).children {
            if is_layout(doc, c) {
                return Some(c);
            }
            if matches!(doc.node(c).kind, NodeKind::Block { .. })
                && let Some(found) = walk(doc, c)
            {
                return Some(found);
            }
        }
        None
    }
    walk(doc, root)
}

fn cell_has_nested_inset(doc: &Document, text_inset: NodeId) -> bool {
    fn walk(doc: &Document, id: NodeId, skip: NodeId) -> bool {
        for &c in &doc.node(id).children {
            if c != skip
                && matches!(&doc.node(c).kind, NodeKind::Block { tag, .. } if tag == "inset")
            {
                return true;
            }
            if matches!(doc.node(c).kind, NodeKind::Block { .. }) && walk(doc, c, skip) {
                return true;
            }
        }
        false
    }
    walk(doc, text_inset, text_inset)
}

fn cell_prose(doc: &Document, layout: NodeId) -> String {
    let mut parts: Vec<String> = Vec::new();
    let mut d_depth = 0i32;
    let mut i_depth = 0i32;
    for &c in &doc.node(layout).children {
        match &doc.node(c).kind {
            NodeKind::Text { text } if d_depth == 0 => {
                if !text.is_empty() {
                    parts.push(text.clone());
                }
            }
            NodeKind::Property { key, .. } if is_change_opener(key) || is_change_closer(key) => {
                let d = advance_change_depths(key, d_depth, i_depth);
                d_depth = d.0;
                i_depth = d.1;
            }
            NodeKind::Block { .. } => {}
            _ => {}
        }
    }
    parts.join("\n").replace('\n', " ")
}

fn alloc_text(doc: &mut Document, text: &str) -> NodeId {
    doc.alloc(NodeKind::Text {
        text: text.to_string(),
    })
}

fn alloc_block(doc: &mut Document, tag: &str, args: Option<&str>) -> NodeId {
    doc.alloc(NodeKind::Block {
        tag: tag.to_string(),
        args: args.map(str::to_string),
        is_begin_variant: true,
    })
}

fn empty_cell_inset(doc: &mut Document) -> NodeId {
    let inset = alloc_block(doc, "inset", Some("Text"));
    let layout = alloc_block(doc, "layout", Some("Plain Layout"));
    let t = alloc_text(doc, "");
    doc.set_children(layout, vec![t]);
    let blank = alloc_text(doc, "");
    doc.set_children(inset, vec![blank, layout]);
    inset
}

fn set_cell_layout(
    doc: &mut Document,
    layout: NodeId,
    new_value: &str,
    track: bool,
    aid: i32,
    ts: &str,
) -> bool {
    if cell_prose(doc, layout) == new_value {
        return false;
    }
    let children = doc.node(layout).children.clone();
    let insets: Vec<NodeId> = children
        .iter()
        .copied()
        .filter(|&c| is_block(doc, c))
        .collect();
    if !track {
        let mut kids = vec![alloc_text(doc, new_value)];
        kids.extend(insets);
        doc.set_children(layout, kids);
        return true;
    }
    let reauthor: Vec<NodeId> = children
        .iter()
        .copied()
        .filter(|&c| !is_block(doc, c))
        .collect();
    let mut out = Vec::new();
    if !reauthor.is_empty() {
        let wrapped = wrap_in_change_markers(doc, &reauthor, ChangeKind::Deleted, aid, ts);
        if wrapped.len() > 1 {
            out.extend_from_slice(&wrapped[..wrapped.len() - 1]);
        } else {
            out.extend(wrapped);
        }
    }
    let new_text = alloc_text(doc, new_value);
    out.extend(wrap_in_change_markers(
        doc,
        &[new_text],
        ChangeKind::Inserted,
        aid,
        ts,
    ));
    out.extend(insets);
    doc.set_children(layout, out);
    true
}

fn apply_line_to_row(
    doc: &mut Document,
    grid: &GridModel,
    row_i: usize,
    fields: &[String],
    track: bool,
    aid: i32,
    ts: &str,
) -> Result<(), TableError> {
    let row = &grid.rows[row_i];
    if fields.len() != row.cells.len() {
        return Err(TableError::new(
            "INVALID_FLAG",
            format!(
                "This line has {} fields, expected {}.",
                fields.len(),
                row.cells.len()
            ),
        )
        .with_size(grid.rows.len(), row.cells.len()));
    }
    for (cell, field) in row.cells.iter().zip(fields.iter()) {
        let part = col_span(&cell.open) == ColSpan::Part || row_span(&cell.open) == RowSpan::Part;
        if part {
            if !field.is_empty() {
                return Err(TableError::new(
                    "INVALID_FLAG",
                    "A merge-part cell must be an empty field in --data.",
                ));
            }
            continue;
        }
        let layout = cell_layout(doc, cell.inset);
        set_cell_layout(doc, layout, field, track, aid, ts);
    }
    Ok(())
}

pub struct SetResult {
    pub rows: usize,
    pub columns: usize,
}

pub fn set_table_data(
    doc: &mut Document,
    tabular: NodeId,
    data: &str,
    track: bool,
    aid: i32,
    ts: &str,
) -> Result<SetResult, TableError> {
    let rect = parse_rect(data)?;
    let grid = parse_grid(doc, tabular)?;
    let rows = grid.rows.len();
    let cols = grid.rows[0].cells.len();
    if rect.len() != rows || rect.iter().any(|r| r.len() != cols) {
        return Err(TableError::new(
            "INVALID_FLAG",
            format!("--data must be a {rows}×{cols} rectangle (same shape as the catalog data)."),
        )
        .with_size(rows, cols));
    }
    for (i, fields) in rect.iter().enumerate() {
        apply_line_to_row(doc, &grid, i, fields, track, aid, ts)?;
    }
    Ok(SetResult {
        rows,
        columns: cols,
    })
}

fn write_grid(doc: &mut Document, tabular: NodeId, grid: &GridModel) {
    let rows = grid.rows.len();
    let cols = grid.rows.first().map(|r| r.cells.len()).unwrap_or(0);
    let mut tabular_open = set_xml_attr(&grid.tabular_open, "rows", Some(&rows.to_string()));
    tabular_open = set_xml_attr(&tabular_open, "columns", Some(&cols.to_string()));
    let mut kids = Vec::new();
    kids.push(alloc_text(doc, &tabular_open));
    kids.push(alloc_text(doc, &grid.features));
    for col in &grid.columns {
        kids.push(alloc_text(doc, col));
    }
    for row in &grid.rows {
        kids.push(alloc_text(doc, &row.open));
        for cell in &row.cells {
            kids.push(alloc_text(doc, &cell.open));
            kids.push(cell.inset);
            kids.push(alloc_text(doc, "</cell>"));
        }
        kids.push(alloc_text(doc, "</row>"));
    }
    kids.push(alloc_text(doc, "</lyxtabular>"));
    doc.set_children(tabular, kids);
}

fn parse_change_attr(open: &str) -> Option<(String, i32)> {
    let raw = xml_attr(open, "change")?;
    let mut parts = raw.split_whitespace();
    let kind = parts.next()?.to_string();
    let aid = parts.next()?.parse().ok()?;
    Some((kind, aid))
}

pub struct LineOpResult {
    pub rows: usize,
    pub columns: usize,
    pub index: usize,
    pub already_deleted: bool,
    pub pending: bool,
}

pub fn add_row(
    doc: &mut Document,
    tabular: NodeId,
    index: Option<usize>,
    data: Option<&str>,
    track: bool,
    aid: i32,
    ts: &str,
) -> Result<LineOpResult, TableError> {
    let mut grid = parse_grid(doc, tabular)?;
    let nrows = grid.rows.len();
    let ncols = grid.rows[0].cells.len();
    let at = match index {
        None => nrows + 1,
        Some(n) if n >= 1 && n <= nrows + 1 => n,
        Some(n) => {
            return Err(TableError::new(
                "INVALID_FLAG",
                format!("--index {n} is out of range (1..={}).", nrows + 1),
            ));
        }
    };
    let insert_at = at - 1;
    let above = if insert_at == 0 { 0 } else { insert_at - 1 };
    let ref_opens: Vec<String> = grid.rows[above]
        .cells
        .iter()
        .map(|c| c.open.clone())
        .collect();
    let mut move_bottom = vec![false; ref_opens.len()];
    let mut move_top = vec![false; ref_opens.len()];
    let mut new_cells = Vec::new();
    for (c, ref_open) in ref_opens.iter().enumerate() {
        let (open, midrule, take_top) = new_row_cell_open(ref_open, insert_at > 0);
        move_bottom[c] = midrule;
        move_top[c] = take_top;
        new_cells.push(CellModel {
            open,
            inset: empty_cell_inset(doc),
        });
    }
    for (c, take) in move_bottom.iter().enumerate() {
        if *take {
            grid.rows[above].cells[c].open =
                set_xml_attr(&grid.rows[above].cells[c].open, "bottomline", None);
        }
    }
    for (c, take) in move_top.iter().enumerate() {
        if *take {
            grid.rows[above].cells[c].open =
                set_xml_attr(&grid.rows[above].cells[c].open, "topline", None);
        }
    }
    let mut row_open = grid.rows[above].open.clone();
    if track {
        row_open = set_xml_attr(&row_open, "change", Some(&format!("inserted {aid} {ts}")));
    } else {
        row_open = set_xml_attr(&row_open, "change", None);
    }
    grid.rows.insert(
        insert_at,
        RowModel {
            open: row_open,
            cells: new_cells,
        },
    );
    write_grid(doc, tabular, &grid);
    if let Some(data) = data {
        let fields = parse_rect_line(data, ncols)?;
        let grid = parse_grid(doc, tabular)?;
        apply_line_to_row(doc, &grid, insert_at, &fields, false, aid, ts)?;
    }
    let grid = parse_grid(doc, tabular)?;
    Ok(LineOpResult {
        rows: grid.rows.len(),
        columns: ncols,
        index: at,
        already_deleted: false,
        pending: false,
    })
}

fn parse_rect_line(data: &str, expect: usize) -> Result<Vec<String>, TableError> {
    let rect = parse_rect(data)?;
    if rect.len() != 1 {
        return Err(TableError::new(
            "INVALID_FLAG",
            format!("--data for a new row must be one line with {expect} fields."),
        ));
    }
    if rect[0].len() != expect {
        return Err(TableError::new(
            "INVALID_FLAG",
            format!("--data has {} fields, expected {expect}.", rect[0].len()),
        ));
    }
    Ok(rect[0].clone())
}

pub fn add_column(
    doc: &mut Document,
    tabular: NodeId,
    index: Option<usize>,
    data: Option<&str>,
    track: bool,
    aid: i32,
    ts: &str,
) -> Result<LineOpResult, TableError> {
    let mut grid = parse_grid(doc, tabular)?;
    let nrows = grid.rows.len();
    let ncols = grid.rows[0].cells.len();
    let at = match index {
        None => ncols + 1,
        Some(n) if n >= 1 && n <= ncols + 1 => n,
        Some(n) => {
            return Err(TableError::new(
                "INVALID_FLAG",
                format!("--index {n} is out of range (1..={}).", ncols + 1),
            ));
        }
    };
    let insert_at = at - 1;
    let left = if insert_at == 0 { 0 } else { insert_at - 1 };
    let ref_col = grid
        .columns
        .get(left)
        .cloned()
        .unwrap_or_else(|| "<column alignment=\"left\" valignment=\"top\">".into());
    let mut col_open = ref_col;
    if track {
        col_open = set_xml_attr(&col_open, "change", Some(&format!("inserted {aid} {ts}")));
    } else {
        col_open = set_xml_attr(&col_open, "change", None);
    }
    if insert_at >= grid.columns.len() {
        grid.columns.push(col_open);
    } else {
        grid.columns.insert(insert_at, col_open);
    }
    for row in &mut grid.rows {
        let left_open = row.cells[left].open.clone();
        let right_is_part = row
            .cells
            .get(insert_at)
            .is_some_and(|n| col_span(&n.open) == ColSpan::Part);
        let open = new_column_cell_open(&left_open, insert_at > 0, right_is_part);
        if insert_at > 0
            && xml_attr(&open, "leftline").as_deref() == Some("true")
            && col_span(&open) == ColSpan::Normal
        {
            row.cells[left].open = set_xml_attr(&row.cells[left].open, "rightline", None);
        }
        row.cells.insert(
            insert_at,
            CellModel {
                open,
                inset: empty_cell_inset(doc),
            },
        );
    }
    write_grid(doc, tabular, &grid);
    if let Some(data) = data {
        let rect = parse_rect(data)?;
        let fields: Vec<String> = if rect.len() == 1 && rect[0].len() == nrows {
            rect[0].clone()
        } else {
            return Err(TableError::new(
                "INVALID_FLAG",
                format!(
                    "--data for a new column must be one comma-separated line with {nrows} fields (one per row)."
                ),
            ));
        };
        let grid = parse_grid(doc, tabular)?;
        for (ri, field) in fields.iter().enumerate() {
            let cell = &grid.rows[ri].cells[insert_at];
            let part =
                col_span(&cell.open) == ColSpan::Part || row_span(&cell.open) == RowSpan::Part;
            if part {
                if !field.is_empty() {
                    return Err(TableError::new(
                        "INVALID_FLAG",
                        "A merge-part cell must be an empty field in --data.",
                    ));
                }
                continue;
            }
            let layout = cell_layout(doc, cell.inset);
            set_cell_layout(doc, layout, field, false, aid, ts);
        }
    }
    let grid = parse_grid(doc, tabular)?;
    Ok(LineOpResult {
        rows: nrows,
        columns: grid.rows[0].cells.len(),
        index: at,
        already_deleted: false,
        pending: false,
    })
}

pub fn delete_row(
    doc: &mut Document,
    tabular: NodeId,
    index: usize,
    track: bool,
    aid: i32,
    ts: &str,
) -> Result<LineOpResult, TableError> {
    let mut grid = parse_grid(doc, tabular)?;
    let nrows = grid.rows.len();
    let ncols = grid.rows[0].cells.len();
    if index < 1 || index > nrows {
        return Err(TableError::new(
            "INVALID_FLAG",
            format!("--index {index} is out of range (1..={nrows})."),
        ));
    }
    if nrows == 1 {
        return Err(TableError::new(
            "INVALID_FLAG",
            "Cannot delete the last row of a table.",
        ));
    }
    let i = index - 1;
    if let Some((kind, _)) = parse_change_attr(&grid.rows[i].open)
        && kind == "deleted"
    {
        return Ok(LineOpResult {
            rows: nrows,
            columns: ncols,
            index,
            already_deleted: true,
            pending: false,
        });
    }
    let own_insert =
        parse_change_attr(&grid.rows[i].open).is_some_and(|(k, a)| k == "inserted" && a == aid);
    let pending = parse_change_attr(&grid.rows[i].open)
        .is_some_and(|(k, a)| k != "deleted" && !(k == "inserted" && a == aid));
    if i + 1 < nrows {
        for c in 0..ncols {
            if row_span(&grid.rows[i].cells[c].open) == RowSpan::Begin
                && row_span(&grid.rows[i + 1].cells[c].open) == RowSpan::Part
            {
                grid.rows[i + 1].cells[c].open = grid.rows[i].cells[c].open.clone();
            }
        }
    }
    if track && !own_insert {
        grid.rows[i].open = set_xml_attr(
            &grid.rows[i].open,
            "change",
            Some(&format!("deleted {aid} {ts}")),
        );
    } else {
        grid.rows.remove(i);
    }
    write_grid(doc, tabular, &grid);
    let grid = parse_grid(doc, tabular)?;
    Ok(LineOpResult {
        rows: grid.rows.len(),
        columns: ncols,
        index,
        already_deleted: false,
        pending,
    })
}

pub fn delete_column(
    doc: &mut Document,
    tabular: NodeId,
    index: usize,
    track: bool,
    aid: i32,
    ts: &str,
) -> Result<LineOpResult, TableError> {
    let mut grid = parse_grid(doc, tabular)?;
    let nrows = grid.rows.len();
    let ncols = grid.rows[0].cells.len();
    if index < 1 || index > ncols {
        return Err(TableError::new(
            "INVALID_FLAG",
            format!("--index {index} is out of range (1..={ncols})."),
        ));
    }
    if ncols == 1 {
        return Err(TableError::new(
            "INVALID_FLAG",
            "Cannot delete the last column of a table.",
        ));
    }
    let i = index - 1;
    let col_open = grid.columns.get(i).cloned().unwrap_or_default();
    if let Some((kind, _)) = parse_change_attr(&col_open)
        && kind == "deleted"
    {
        return Ok(LineOpResult {
            rows: nrows,
            columns: ncols,
            index,
            already_deleted: true,
            pending: false,
        });
    }
    let own_insert = parse_change_attr(&col_open).is_some_and(|(k, a)| k == "inserted" && a == aid);
    let pending = parse_change_attr(&col_open)
        .is_some_and(|(k, a)| k != "deleted" && !(k == "inserted" && a == aid));
    for r in 0..nrows {
        if i + 1 < ncols
            && col_span(&grid.rows[r].cells[i].open) == ColSpan::Begin
            && col_span(&grid.rows[r].cells[i + 1].open) == ColSpan::Part
        {
            grid.rows[r].cells[i + 1].open = grid.rows[r].cells[i].open.clone();
        }
    }
    if track && !own_insert {
        if let Some(col) = grid.columns.get_mut(i) {
            *col = set_xml_attr(col, "change", Some(&format!("deleted {aid} {ts}")));
        }
    } else {
        if i < grid.columns.len() {
            grid.columns.remove(i);
        }
        for row in &mut grid.rows {
            row.cells.remove(i);
        }
    }
    write_grid(doc, tabular, &grid);
    let grid = parse_grid(doc, tabular)?;
    Ok(LineOpResult {
        rows: nrows,
        columns: grid.rows[0].cells.len(),
        index,
        already_deleted: false,
        pending,
    })
}

/// New Standard layout whose content is a table float with an empty caption (JC1-A).
pub fn build_create_layout(doc: &mut Document, rect: &[Vec<String>]) -> NodeId {
    let layout = alloc_block(doc, "layout", Some("Standard"));
    let float = alloc_block(doc, "inset", Some("Float table"));
    let mut float_kids = vec![
        alloc_text(doc, "placement document"),
        alloc_text(doc, "alignment document"),
        alloc_text(doc, "wide false"),
        alloc_text(doc, "sideways false"),
        alloc_text(doc, "status open"),
        alloc_text(doc, ""),
    ];
    let cap_par = alloc_block(doc, "layout", Some("Plain Layout"));
    let cap_inset = alloc_block(doc, "inset", Some("Caption Standard"));
    let cap_inner = alloc_block(doc, "layout", Some("Plain Layout"));
    let cap_blank = alloc_text(doc, "");
    doc.set_children(cap_inner, vec![cap_blank]);
    let cap_lead = alloc_text(doc, "");
    doc.set_children(cap_inset, vec![cap_lead, cap_inner]);
    let cap_trail = alloc_text(doc, "");
    doc.set_children(cap_par, vec![cap_inset, cap_trail]);
    float_kids.push(cap_par);
    float_kids.push(alloc_text(doc, ""));
    let tab_par = alloc_block(doc, "layout", Some("Plain Layout"));
    let tabular = build_tabular_inset(doc, rect);
    let tab_trail = alloc_text(doc, "");
    doc.set_children(tab_par, vec![tabular, tab_trail]);
    float_kids.push(tab_par);
    doc.set_children(float, float_kids);
    let layout_trail = alloc_text(doc, "");
    doc.set_children(layout, vec![float, layout_trail]);
    layout
}

fn build_tabular_inset(doc: &mut Document, rect: &[Vec<String>]) -> NodeId {
    let rows = rect.len();
    let cols = rect.first().map(|r| r.len()).unwrap_or(0);
    let tabular = alloc_block(doc, "inset", Some("Tabular"));
    let mut grid = GridModel {
        tabular_open: format!("<lyxtabular version=\"3\" rows=\"{rows}\" columns=\"{cols}\">"),
        features: "<features tabularvalignment=\"middle\">".into(),
        columns: (0..cols)
            .map(|_| "<column alignment=\"left\" valignment=\"top\">".into())
            .collect(),
        rows: Vec::new(),
    };
    for row in rect {
        let mut cells = Vec::new();
        for field in row {
            let inset = empty_cell_inset(doc);
            let layout = cell_layout(doc, inset);
            if !field.is_empty() {
                let t = alloc_text(doc, field);
                doc.set_children(layout, vec![t]);
            }
            cells.push(CellModel {
                open: "<cell alignment=\"left\" valignment=\"top\" usebox=\"none\">".into(),
                inset,
            });
        }
        grid.rows.push(RowModel {
            open: "<row>".into(),
            cells,
        });
    }
    write_grid(doc, tabular, &grid);
    tabular
}

pub fn is_document_layout_target(doc: &Document, node: NodeId) -> bool {
    if !is_layout(doc, node) {
        return false;
    }
    let parents = parent_map(doc);
    let mut cur = node;
    while let Some(&p) = parents.get(&cur) {
        if matches!(&doc.node(p).kind, NodeKind::Block { tag, .. } if tag == "inset") {
            return false;
        }
        cur = p;
    }
    true
}
