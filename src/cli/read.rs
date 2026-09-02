//! `lq read` (Deno `cli.ts` read branch).

use super::common::{CliError, assert_no_selector_mistakes, print_json, push_warning};
use crate::ast::{Document, NodeId, NodeKind};
use crate::query::query;
use crate::tracked_changes::{annotate_changes, extract_all_text};
use serde_json::{Map, Value, json};

fn node_label(doc: &Document, id: NodeId) -> String {
    match &doc.node(id).kind {
        NodeKind::Block { tag, args, .. } => {
            format!("{}[{}]", tag, args.as_deref().unwrap_or("").trim())
        }
        NodeKind::Property { key, .. } => format!("property[{key}]"),
        NodeKind::Text { .. } => "text".into(),
        NodeKind::Document => "document".into(),
    }
}

fn block_prefix(doc: &Document, id: NodeId) -> String {
    match &doc.node(id).kind {
        NodeKind::Block { tag, args, .. } => {
            format!("{}[{}]", tag, args.as_deref().unwrap_or("").trim())
        }
        _ => String::new(),
    }
}

fn text_of_node(doc: &Document, id: NodeId) -> String {
    if let NodeKind::Block { tag, .. } = &doc.node(id).kind
        && tag == "inset"
    {
        let layouts: Vec<NodeId> = doc
            .node(id)
            .children
            .iter()
            .copied()
            .filter(|&child| {
                matches!(&doc.node(child).kind, NodeKind::Block { tag, .. } if tag == "layout")
            })
            .collect();
        if !layouts.is_empty() {
            return layouts
                .into_iter()
                .map(|layout| {
                    let args = match &doc.node(layout).kind {
                        NodeKind::Block { args, .. } => args.as_deref().unwrap_or("").trim(),
                        _ => "",
                    };
                    format!(
                        "layout[{args}] {}",
                        extract_all_text(doc, layout, usize::MAX, false).trim()
                    )
                })
                .collect::<Vec<_>>()
                .join("\n");
        }
    }
    extract_all_text(doc, id, usize::MAX, false)
        .trim()
        .to_string()
}

fn js_utf16_len(s: &str) -> usize {
    s.encode_utf16().count()
}

pub fn run_read(
    ast: &Document,
    selector: Option<&str>,
    count_only: bool,
    text_only: bool,
) -> Result<(), CliError> {
    let Some(selector) = selector.filter(|s| !s.is_empty()) else {
        return Err(CliError::new(
            "MISSING_SELECTOR",
            "A CSS selector is required for this command. Run 'lq help selectors' for selector syntax.",
        ));
    };

    let nodes = match query(ast, selector) {
        Ok(nodes) => nodes,
        Err(error) => return Err(CliError::new("INVALID_SELECTOR", error.message)),
    };
    assert_no_selector_mistakes(Some(selector))?;

    let mut result = Map::new();

    if count_only {
        let mut tally = Map::new();
        for &node in &nodes {
            let label = node_label(ast, node);
            let next = tally.get(&label).and_then(Value::as_u64).unwrap_or(0) + 1;
            tally.insert(label, json!(next));
        }
        result.insert("count".into(), Value::Object(tally));
    }

    if text_only {
        let mut texts = Vec::new();
        for &node in &nodes {
            let prefix = block_prefix(ast, node);
            let text = text_of_node(ast, node);
            let combined = if prefix.is_empty() {
                text
            } else {
                format!("{prefix} {text}")
            };
            if !combined.is_empty() {
                texts.push(combined);
            }
        }
        let output = format!("{}\n", texts.join("\n\n"));
        let utf16_len = js_utf16_len(&output);
        if utf16_len > 10 * 1024 {
            let size_kb = (utf16_len as f64 / 1024.0).round() as u64;
            push_warning(format!(
                "--text-only output is {size_kb}KB across {} nodes. Consider a more specific selector to reduce noise.",
                nodes.len()
            ));
        }
        result.insert("text".into(), json!(output));
    }

    if !count_only && !text_only {
        let data: Vec<Value> = nodes.iter().map(|&n| annotate_changes(ast, n)).collect();
        result.insert("data".into(), Value::Array(data));
        result.insert("count".into(), json!(nodes.len()));
    }

    print_json(Value::Object(result));
    Ok(())
}
