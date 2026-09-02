//! Line CST parser (Deno `parser.ts`).

use crate::ast::{Document, NodeId, NodeKind};
use std::fmt;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ParseError {
    pub message: String,
}

impl fmt::Display for ParseError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.message)
    }
}

impl std::error::Error for ParseError {}

fn is_ident_char(c: char) -> bool {
    c.is_ascii_alphanumeric() || c == '_'
}

/// After a command prefix, take `[a-zA-Z0-9_]+` and optional `\s+(.*)` args.
/// `None` args when there is no whitespace after the ident (Deno `undefined`).
fn ident_and_args(rest: &str) -> Option<(&str, Option<&str>)> {
    let ident_len = rest.find(|c: char| !is_ident_char(c)).unwrap_or(rest.len());
    if ident_len == 0 {
        return None;
    }
    let ident = &rest[..ident_len];
    let after = &rest[ident_len..];
    if after.is_empty() {
        Some((ident, None))
    } else if after.starts_with(char::is_whitespace) {
        Some((ident, Some(after.trim_start())))
    } else {
        None
    }
}

fn parse_begin(line: &str) -> Option<(&str, Option<&str>)> {
    let rest = line.strip_prefix("\\begin_")?;
    ident_and_args(rest)
}

fn parse_end(line: &str) -> Option<&str> {
    let rest = line.strip_prefix("\\end_")?;
    if rest.is_empty() || !rest.chars().all(is_ident_char) {
        return None;
    }
    Some(rest)
}

fn parse_prop(line: &str) -> Option<(&str, Option<&str>)> {
    let rest = line.strip_prefix('\\')?;
    ident_and_args(rest)
}

fn block_tag(doc: &Document, id: NodeId) -> Option<&str> {
    match &doc.node(id).kind {
        NodeKind::Block { tag, .. } => Some(tag.as_str()),
        _ => None,
    }
}

/// `is_snippet == true` skips the `#` header guard (Deno `parse(text, isSnippet)`).
pub fn parse(text: &str, is_snippet: bool) -> Result<Document, ParseError> {
    if !is_snippet && !text.trim().starts_with('#') {
        return Err(ParseError {
            message: "Invalid LyX file format. Expected '#' comment header.".to_string(),
        });
    }

    let mut doc = Document::new();
    let root = doc.root();
    let mut stack: Vec<NodeId> = Vec::new();
    let mut stack_line: Vec<usize> = Vec::new();
    let mut in_opaque = false;
    let mut opaque_tag = String::new();

    for (i, line) in text
        .split('\n')
        .map(|l| l.strip_suffix('\r').unwrap_or(l))
        .enumerate()
    {
        if in_opaque {
            let closer = format!("\\end_{opaque_tag}");
            if line == closer {
                in_opaque = false;
                stack.pop();
                stack_line.pop();
            } else {
                let parent = *stack
                    .last()
                    .expect("invariant: opaque block is on the stack");
                let child = doc.alloc(NodeKind::Text {
                    text: line.to_string(),
                });
                doc.push_child(parent, child);
            }
            continue;
        }

        if let Some((tag, args)) = parse_begin(line) {
            let args = args.map(str::to_string);
            let opaque_args = args.as_deref().unwrap_or("").trim();
            let enter_opaque = tag == "preamble"
                || (tag == "inset" && (opaque_args == "Formula" || opaque_args == "ERT"));
            let id = doc.alloc(NodeKind::Block {
                tag: tag.to_string(),
                args,
                is_begin_variant: true,
            });
            let parent = stack.last().copied().unwrap_or(root);
            doc.push_child(parent, id);
            stack.push(id);
            stack_line.push(i);
            if enter_opaque {
                in_opaque = true;
                opaque_tag = tag.to_string();
            }
            continue;
        }

        if let Some(tag) = parse_end(line) {
            let expected = stack.last().copied().and_then(|id| block_tag(&doc, id));
            if expected != Some(tag) {
                return Err(ParseError {
                    message: format!(
                        "Mismatched end tag: expected {}, got {tag} at line {i}",
                        expected.unwrap_or("undefined")
                    ),
                });
            }
            stack.pop();
            stack_line.pop();
            continue;
        }

        if let Some((key, value)) = parse_prop(line) {
            if key == "index" || key == "branch" || key == "modules" {
                let id = doc.alloc(NodeKind::Block {
                    tag: key.to_string(),
                    args: value.map(str::to_string),
                    is_begin_variant: false,
                });
                let parent = stack.last().copied().unwrap_or(root);
                doc.push_child(parent, id);
                stack.push(id);
                stack_line.push(i);
                continue;
            }
            let id = doc.alloc(NodeKind::Property {
                key: key.to_string(),
                value: value.map(str::to_string),
            });
            let parent = stack.last().copied().unwrap_or(root);
            doc.push_child(parent, id);
            continue;
        }

        let id = doc.alloc(NodeKind::Text {
            text: line.to_string(),
        });
        let parent = stack.last().copied().unwrap_or(root);
        doc.push_child(parent, id);
    }

    if let Some(&open) = stack.last() {
        let tag = block_tag(&doc, open).unwrap_or("undefined");
        let opened = *stack_line
            .last()
            .expect("invariant: stack_line tracks stack");
        return Err(ParseError {
            message: format!("Unclosed tag: {tag} (opened at line {opened})"),
        });
    }

    Ok(doc)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_missing_hash_header() {
        let err = parse("\\begin_document\n\\end_document", false).unwrap_err();
        assert_eq!(
            err.message,
            "Invalid LyX file format. Expected '#' comment header."
        );
    }

    #[test]
    fn snippet_skips_header_guard() {
        parse("\\begin_layout Standard\n\\end_layout", true).unwrap();
    }

    #[test]
    fn mismatched_end_tag() {
        let src = "#x\n\\begin_layout Standard\n\\end_document";
        let err = parse(src, false).unwrap_err();
        assert_eq!(
            err.message,
            "Mismatched end tag: expected layout, got document at line 2"
        );
    }

    #[test]
    fn mismatched_end_with_empty_stack() {
        let src = "#x\n\\end_layout";
        let err = parse(src, false).unwrap_err();
        assert_eq!(
            err.message,
            "Mismatched end tag: expected undefined, got layout at line 1"
        );
    }

    #[test]
    fn unclosed_tag() {
        let src = "#x\n\\begin_layout Standard";
        let err = parse(src, false).unwrap_err();
        assert_eq!(err.message, "Unclosed tag: layout (opened at line 1)");
    }
}
