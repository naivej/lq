//! Line CST writer (Deno `serializer.ts`). Always joins with `\n`.

use crate::ast::{Document, NodeId, NodeKind};

pub fn serialize(doc: &Document) -> String {
    let mut lines = Vec::new();
    serialize_nodes(doc, &doc.node(doc.root()).children, &mut lines);
    lines.join("\n")
}

fn serialize_nodes(doc: &Document, ids: &[NodeId], lines: &mut Vec<String>) {
    for &id in ids {
        match &doc.node(id).kind {
            NodeKind::Document => {
                serialize_nodes(doc, &doc.node(id).children, lines);
            }
            NodeKind::Block {
                tag,
                args,
                is_begin_variant,
            } => {
                if *is_begin_variant {
                    lines.push(match args {
                        Some(a) => format!("\\begin_{tag} {a}"),
                        None => format!("\\begin_{tag}"),
                    });
                } else {
                    lines.push(match args {
                        Some(a) => format!("\\{tag} {a}"),
                        None => format!("\\{tag}"),
                    });
                }
                serialize_nodes(doc, &doc.node(id).children, lines);
                lines.push(format!("\\end_{tag}"));
            }
            NodeKind::Property { key, value } => {
                lines.push(match value {
                    Some(v) => format!("\\{key} {v}"),
                    None => format!("\\{key}"),
                });
            }
            NodeKind::Text { text } => {
                lines.push(text.clone());
            }
        }
    }
}
