//! `lq bib` (Deno `cli.ts` bib branches).

use super::common::{CliError, ParsedArgs, print_json};
use crate::Document;
use crate::ast::NodeKind;
use crate::bib::{Citation, parse_bibtex};
use crate::query::query;
use serde_json::json;
use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};

fn parse_bib_flags(flags: &ParsedArgs) -> Option<String> {
    flags
        .str("search")
        .filter(|s| !s.is_empty())
        .map(str::to_string)
}

fn js_field(value: &Option<String>) -> &str {
    value.as_deref().unwrap_or("undefined")
}

fn dedup_citations(citations: Vec<Citation>) -> Vec<Citation> {
    let mut order: Vec<Citation> = Vec::new();
    let mut index_of: HashMap<String, usize> = HashMap::new();
    for citation in citations {
        if let Some(&idx) = index_of.get(&citation.key) {
            order[idx] = citation;
        } else {
            index_of.insert(citation.key.clone(), order.len());
            order.push(citation);
        }
    }
    order
}

fn filter_search(mut citations: Vec<Citation>, search: Option<&str>) -> Vec<Citation> {
    let Some(search) = search else {
        return citations;
    };
    let terms: Vec<String> = search
        .to_ascii_lowercase()
        .split_whitespace()
        .filter(|t| !t.is_empty())
        .map(str::to_string)
        .collect();
    if terms.is_empty() {
        return citations;
    }
    citations.retain(|c| {
        let haystack = format!(
            "{} {} {} {}",
            c.key,
            js_field(&c.author),
            js_field(&c.title),
            js_field(&c.year)
        )
        .to_ascii_lowercase();
        terms.iter().all(|t| haystack.contains(t))
    });
    citations
}

fn print_bib_files(bib_paths: &[PathBuf], search: Option<&str>) -> Result<(), CliError> {
    let mut citations = Vec::new();
    for bib_path in bib_paths {
        let raw = match fs::read(bib_path) {
            Ok(bytes) => match String::from_utf8(bytes) {
                Ok(text) => text,
                Err(_) => {
                    return Err(CliError::new(
                        "BIB_READ_ERROR",
                        format!("File exists but is not valid UTF-8: {}", bib_path.display()),
                    ));
                }
            },
            Err(error) => {
                return Err(CliError::new(
                    "BIB_READ_ERROR",
                    format!(
                        "Could not read or parse bib file '{}': {error}",
                        bib_path.display()
                    ),
                ));
            }
        };
        citations.extend(parse_bibtex(&raw));
    }
    if bib_paths.is_empty() {
        return Err(CliError::new(
            "NO_BIBFILE",
            "No .bib files are referenced by the bibliography inset. Add a .bib file in LyX, then rerun 'lq bib'.",
        ));
    }
    let unique = filter_search(dedup_citations(citations), search);
    print_json(json!({ "data": unique }));
    Ok(())
}

fn strip_wrapping_quotes(s: &str) -> String {
    let mut out = s.to_string();
    if out.starts_with('"') {
        out.remove(0);
    }
    if out.ends_with('"') {
        out.pop();
    }
    out
}

fn final_segment(path: &str) -> &str {
    path.rsplit(['/', '\\']).next().unwrap_or(path)
}

fn lyx_dir(file_path: &str) -> PathBuf {
    let path = Path::new(file_path);
    let abs = if path.is_absolute() {
        path.to_path_buf()
    } else {
        std::env::current_dir()
            .unwrap_or_else(|_| PathBuf::from("."))
            .join(path)
    };
    abs.parent().map(Path::to_path_buf).unwrap_or(abs)
}

fn collect_bib_paths(ast: &Document, file_path: &str) -> Result<Vec<PathBuf>, CliError> {
    let nodes = match query(ast, "inset[CommandInset bibtex]") {
        Ok(nodes) => nodes,
        Err(error) => return Err(CliError::new("INVALID_SELECTOR", error.message)),
    };
    if nodes.is_empty() {
        return Err(CliError::new(
            "NO_BIBLIO",
            "No bibliography inset was found. Inspect the document with 'lq read <file> \"inset[CommandInset bibtex]\"' or add a bibliography in LyX, then rerun 'lq bib'.",
        ));
    }
    let lyx_dir = lyx_dir(file_path);
    let mut bib_paths = Vec::new();
    for node in nodes {
        for &child in &ast.node(node).children {
            let NodeKind::Text { text } = &ast.node(child).kind else {
                continue;
            };
            if !text.starts_with("bibfiles ") {
                continue;
            }
            let value = text
                .strip_prefix("bibfiles")
                .map(str::trim_start)
                .unwrap_or(text);
            for file in value.split(',') {
                let mut bib_file = strip_wrapping_quotes(file.trim());
                let segment = final_segment(&bib_file);
                let has_ext = segment.contains('.');
                if has_ext && !bib_file.to_ascii_lowercase().ends_with(".bib") {
                    continue;
                }
                if !has_ext {
                    bib_file.push_str(".bib");
                }
                let path = Path::new(&bib_file);
                let resolved = if path.is_absolute() {
                    path.to_path_buf()
                } else {
                    lyx_dir.join(path)
                };
                bib_paths.push(resolved);
            }
        }
    }
    Ok(bib_paths)
}

pub fn run_direct_bib(file_path: &str, flags: &ParsedArgs) -> Result<(), CliError> {
    let search = parse_bib_flags(flags);
    print_bib_files(&[PathBuf::from(file_path)], search.as_deref())
}

pub fn run_document_bib(
    ast: &Document,
    file_path: &str,
    flags: &ParsedArgs,
) -> Result<(), CliError> {
    let search = parse_bib_flags(flags);
    let bib_paths = collect_bib_paths(ast, file_path)?;
    print_bib_files(&bib_paths, search.as_deref())
}
