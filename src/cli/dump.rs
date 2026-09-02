//! `lq dump` (Deno `cli.ts` dump branch).

use super::common::{
    CliError, ParsedArgs, UserConfig, assert_no_selector_mistakes, print_json, push_warning,
    resolve_document_layout_roots,
};
use crate::ast::{Document, NodeId, NodeKind};
use crate::query::query;
use crate::schema::{
    HeadingLevel, default_heading_hierarchy, extract_document_layout_context, get_schema_for_class,
};
use crate::tracked_changes::annotate_changes;
use serde::Serialize;
use serde_json::{Value, json};

#[derive(Serialize)]
struct TocNode {
    layout: String,
    text: String,
    children: Vec<TocNode>,
}

fn compute_max_depth(doc: &Document, children: &[NodeId], current_depth: usize) -> usize {
    let mut max_depth = current_depth;
    for &child in children {
        if matches!(doc.node(child).kind, NodeKind::Block { .. }) {
            let child_depth = compute_max_depth(doc, &doc.node(child).children, current_depth + 1);
            if child_depth > max_depth {
                max_depth = child_depth;
            }
        }
    }
    max_depth
}

fn child_count_indicator(children: &[Value]) -> String {
    let mut blocks = 0usize;
    let mut texts = 0usize;
    let mut props = 0usize;
    for child in children {
        match child.get("type").and_then(Value::as_str) {
            Some("block") => blocks += 1,
            Some("text") => texts += 1,
            Some("property") => props += 1,
            _ => {}
        }
    }
    let mut parts = Vec::new();
    if blocks > 0 {
        parts.push(format!("{blocks} blocks"));
    }
    if texts > 0 {
        parts.push(format!("{texts} text nodes"));
    }
    if props > 0 {
        parts.push(format!("{props} properties"));
    }
    if parts.is_empty() {
        parts.push(format!("{} children", children.len()));
    }
    format!("... ({})", parts.join(", "))
}

/// Structural cutoff on an already-annotated JSON tree (plan: annotate then truncate).
fn truncate_json(value: &Value, max_depth: usize, current_depth: usize) -> Value {
    let Some(obj) = value.as_object() else {
        return value.clone();
    };
    let children = obj
        .get("children")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    if current_depth >= max_depth {
        return json!({
            "type": "document",
            "children": [child_count_indicator(&children)],
        });
    }
    let new_children: Vec<Value> = children
        .into_iter()
        .map(|child| {
            if child.get("type").and_then(Value::as_str) == Some("block") {
                let nested = json!({
                    "type": "document",
                    "children": child.get("children").cloned().unwrap_or(json!([])),
                });
                let truncated = truncate_json(&nested, max_depth, current_depth + 1);
                let mut block = child;
                if let Some(obj) = block.as_object_mut()
                    && let Some(kids) = truncated.get("children")
                {
                    obj.insert("children".into(), kids.clone());
                }
                block
            } else {
                child
            }
        })
        .collect();
    json!({
        "type": "document",
        "children": new_children,
    })
}

fn wrap_as_doc(node: Value) -> Value {
    json!({ "type": "document", "children": [node] })
}

fn textclass_of(ast: &Document) -> Option<String> {
    let nodes = query(ast, "textclass").ok()?;
    let id = *nodes.first()?;
    match &ast.node(id).kind {
        NodeKind::Property { value, .. } => value.clone().filter(|v| !v.is_empty()),
        _ => None,
    }
}

fn heading_hierarchy(ast: &Document, config: &UserConfig) -> Result<Vec<HeadingLevel>, CliError> {
    let Some(textclass) = textclass_of(ast) else {
        return Err(CliError::new(
            "NO_TEXTCLASS",
            "Could not determine textclass from the document.",
        ));
    };
    let roots = resolve_document_layout_roots(config);
    let ctx = extract_document_layout_context(ast);
    let modules: Vec<&str> = ctx.modules.iter().map(String::as_str).collect();
    match get_schema_for_class(&textclass, &roots.search_paths, &modules, Some(&ctx.local)) {
        Ok(schema) => Ok(schema.heading_hierarchy),
        Err(_) => Ok(default_heading_hierarchy()),
    }
}

fn top_level_body_children(doc: &Document) -> &[NodeId] {
    let root_children = &doc.node(doc.root()).children;
    let Some(document) = root_children
        .iter()
        .copied()
        .find(|&id| matches!(&doc.node(id).kind, NodeKind::Block { tag, .. } if tag == "document"))
    else {
        return root_children;
    };
    let Some(body) = doc
        .node(document)
        .children
        .iter()
        .copied()
        .find(|&id| matches!(&doc.node(id).kind, NodeKind::Block { tag, .. } if tag == "body"))
    else {
        return root_children;
    };
    &doc.node(body).children
}

fn extract_heading_text(doc: &Document, node: NodeId) -> String {
    match &doc.node(node).kind {
        NodeKind::Text { text } => text.clone(),
        NodeKind::Block { tag, .. } if tag == "inset" => String::new(),
        NodeKind::Block { .. } | NodeKind::Document => {
            let children = doc.node(node).children.clone();
            children
                .into_iter()
                .map(|child| extract_heading_text(doc, child))
                .collect()
        }
        NodeKind::Property { .. } => String::new(),
    }
}

fn layout_name(doc: &Document, node: NodeId) -> Option<String> {
    let NodeKind::Block { args, .. } = &doc.node(node).kind else {
        return None;
    };
    let first = args.as_deref().unwrap_or("").split_whitespace().next()?;
    Some(first.to_string())
}

fn attach_toc_node(stack: &mut Vec<TocNode>, roots: &mut Vec<TocNode>) {
    let Some(finished) = stack.pop() else {
        return;
    };
    if let Some(parent) = stack.last_mut() {
        parent.children.push(finished);
    } else {
        roots.push(finished);
    }
}

fn build_toc(
    ast: &Document,
    heading_hierarchy: &[HeadingLevel],
    max_level: Option<i32>,
) -> Vec<TocNode> {
    let rank_map: std::collections::HashMap<&str, usize> = heading_hierarchy
        .iter()
        .enumerate()
        .map(|(i, h)| (h.layout.as_str(), i))
        .collect();
    let level_map: std::collections::HashMap<&str, i32> = heading_hierarchy
        .iter()
        .map(|h| (h.layout.as_str(), h.toc_level))
        .collect();

    let mut stack: Vec<TocNode> = Vec::new();
    let mut roots: Vec<TocNode> = Vec::new();

    for &node in top_level_body_children(ast) {
        if !matches!(ast.node(node).kind, NodeKind::Block { .. }) {
            continue;
        }
        let Some(name) = layout_name(ast, node) else {
            continue;
        };
        let Some(&rank) = rank_map.get(name.as_str()) else {
            continue;
        };
        let toc_level = level_map.get(name.as_str()).copied().unwrap_or(i32::MAX);
        if let Some(max) = max_level
            && toc_level > max
        {
            continue;
        }
        let entry = TocNode {
            layout: name,
            text: extract_heading_text(ast, node).trim().to_string(),
            children: Vec::new(),
        };
        while stack.last().is_some_and(|top| {
            rank_map
                .get(top.layout.as_str())
                .copied()
                .unwrap_or(usize::MAX)
                >= rank
        }) {
            attach_toc_node(&mut stack, &mut roots);
        }
        stack.push(entry);
    }
    while !stack.is_empty() {
        attach_toc_node(&mut stack, &mut roots);
    }
    roots
}

pub fn run_dump(
    ast: &Document,
    file_path: &str,
    selector: Option<&str>,
    flags: &ParsedArgs,
    config: &UserConfig,
) -> Result<(), CliError> {
    let depth_str = flags.str("depth").map(str::to_string);
    let toc_mode = flags.bool("toc");
    let dump_selector = selector;

    if toc_mode {
        if dump_selector.is_some() {
            return Err(CliError::new(
                "FLAG_CONFLICT",
                "--toc and selector are mutually exclusive.",
            ));
        }
        let hierarchy = heading_hierarchy(ast, config)?;
        let max_level = if let Some(ref raw) = depth_str {
            let trimmed = raw.trim();
            if !trimmed
                .strip_prefix('-')
                .unwrap_or(trimmed)
                .bytes()
                .all(|b| b.is_ascii_digit())
                || trimmed.is_empty()
                || trimmed == "-"
            {
                return Err(CliError::new(
                    "INVALID_FLAG",
                    "--depth must be an integer (Part=-1, Chapter=0, Section=1, ...).",
                ));
            }
            Some(trimmed.parse::<i32>().unwrap_or(0))
        } else {
            None
        };
        let toc = build_toc(ast, &hierarchy, max_level);
        if toc.is_empty() {
            if let Some(level) = max_level {
                push_warning(format!(
                    "No headings at TocLevel ≤ {level} in this document — this class's heading levels may start higher (e.g. Section = 1). Try '--depth 1' for top-level headings."
                ));
            } else {
                push_warning("No headings found in this document.");
            }
        }
        print_json(json!({ "data": toc }));
        return Ok(());
    }

    let (roots, use_full_ast) = if let Some(dump_selector) = dump_selector {
        let roots = match query(ast, dump_selector) {
            Ok(nodes) => nodes,
            Err(error) => return Err(CliError::new("INVALID_SELECTOR", error.message)),
        };
        assert_no_selector_mistakes(Some(dump_selector))?;
        if roots.is_empty() {
            return Err(CliError::new(
                "NO_MATCH",
                format!(
                    "Selector matched no nodes to dump. Run 'lq read {file_path} \"{dump_selector}\" --count' to verify or refine the selector."
                ),
            ));
        }
        (roots, false)
    } else {
        (Vec::new(), true)
    };

    if let Some(ref raw) = depth_str {
        let trimmed = raw.trim();
        if !trimmed.bytes().all(|b| b.is_ascii_digit()) || trimmed.is_empty() {
            return Err(CliError::new(
                "INVALID_FLAG",
                "--depth must be a non-negative integer.",
            ));
        }
        let depth: usize = trimmed.parse().unwrap_or(0);
        if use_full_ast {
            let max_depth = compute_max_depth(ast, &ast.node(ast.root()).children, 0);
            if depth > max_depth {
                push_warning(format!(
                    "Depth {depth} exceeds document depth ({max_depth}). Showing full CST."
                ));
                print_json(json!({ "data": annotate_changes(ast, ast.root()) }));
            } else {
                let annotated = annotate_changes(ast, ast.root());
                print_json(json!({ "data": truncate_json(&annotated, depth, 0) }));
            }
        } else {
            let results: Vec<Value> = roots
                .iter()
                .map(|&root| {
                    let wrapped = wrap_as_doc(annotate_changes(ast, root));
                    let max_depth = compute_max_depth(ast, &[root], 0);
                    if depth > max_depth {
                        push_warning(format!(
                            "Depth {depth} exceeds subtree depth ({max_depth}). Showing full subtree."
                        ));
                        wrapped
                    } else {
                        truncate_json(&wrapped, depth, 0)
                    }
                })
                .collect();
            let data = if roots.len() == 1 {
                results.into_iter().next().unwrap_or(Value::Null)
            } else {
                Value::Array(results)
            };
            print_json(json!({ "count": roots.len(), "data": data }));
        }
        return Ok(());
    }

    if use_full_ast {
        print_json(json!({ "data": annotate_changes(ast, ast.root()) }));
    } else {
        let docs: Vec<Value> = roots
            .iter()
            .map(|&root| wrap_as_doc(annotate_changes(ast, root)))
            .collect();
        let data = if roots.len() == 1 {
            docs.into_iter().next().unwrap_or(Value::Null)
        } else {
            Value::Array(docs)
        };
        print_json(json!({ "count": roots.len(), "data": data }));
    }
    Ok(())
}
