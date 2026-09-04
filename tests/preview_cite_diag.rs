//! Citation chips follow the LyX work area (053).

mod common;

use common::fixtures_root;
use lq::{LiveRenderOptions, get_default_layouts_dir, parse, render_live_html};
use std::fs;
use std::path::PathBuf;

fn require_layouts_dir() -> Option<PathBuf> {
    let layouts_dir = get_default_layouts_dir();
    if layouts_dir.is_dir() && layouts_dir.join("article.layout").is_file() {
        return Some(layouts_dir);
    }
    eprintln!(
        "skip: LyX layouts dir not found at {} — install LyX or set layoutsDir via 'lq init --layouts-dir'",
        layouts_dir.display()
    );
    None
}

fn render_path(path: &std::path::Path) -> Option<(String, lq::LivePreviewResponse)> {
    require_layouts_dir()?;
    let text = fs::read_to_string(path).expect("fixture");
    let ast = parse(&text, false).expect("parse");
    let result = lq::build_live_response(path, &ast, &text, None, None, None).expect("render");
    Some((result.response.html.clone(), result.response))
}

fn citation_inner<'a>(html: &'a str, needle: &str) -> Option<&'a str> {
    let at = html.find(needle)?;
    let start = html[..at].rfind("<a class=\"citation\"")?;
    let inner_start = html[start..].find('>')? + start + 1;
    let inner_end = html[inner_start..].find("</a>")? + inner_start;
    Some(&html[inner_start..inner_end])
}

#[test]
fn cite_dedup_one_chip_per_inset() {
    let path = fixtures_root().join("Synthetic/cite_dedup.lyx");
    let Some((html, response)) = render_path(&path) else {
        return;
    };
    assert_eq!(
        citation_inner(&html, "#alpha, #beta, #alpha"),
        Some("[#alpha, #beta, #alpha]")
    );
    assert_eq!(html.matches("class=\"citation\"").count(), 2);
    assert!(
        !html.contains("(Author 2020)"),
        "Basic chips are #key, not author-year"
    );
    let cite_tokens = response
        .tokens
        .iter()
        .filter(|t| t.bundle.selector.contains("CommandInset citation"))
        .count();
    assert_eq!(cite_tokens, 2, "one mapping token per citation inset");
}

#[test]
fn userguide_chapter_3_after_text() {
    let path = fixtures_root().join("Help/UserGuide.lyx");
    let Some((html, _)) = render_path(&path) else {
        return;
    };
    assert!(
        html.contains(r#"[#latexcompanion, Chapter 3]"#),
        "UserGuide citation after-text must sit inside the Basic chip"
    );
    assert_eq!(
        citation_inner(&html, "[#latexcompanion, Chapter 3]"),
        Some("[#latexcompanion, Chapter 3]")
    );
}

#[test]
fn beamer_sec_after_text() {
    let Some(layouts) = require_layouts_dir() else {
        return;
    };
    if !layouts.join("beamer.layout").is_file() {
        eprintln!("skip: beamer.layout not found");
        return;
    }
    let path = fixtures_root().join("Presentations/Beamer.lyx");
    let Some((html, _)) = render_path(&path) else {
        return;
    };
    assert_eq!(
        citation_inner(&html, "[#beamer-ug, sec.~10.3]"),
        Some("[#beamer-ug, sec.~10.3]")
    );
}

#[test]
fn nocite_uses_engine_chip() {
    let Some(layouts) = require_layouts_dir() else {
        return;
    };
    let src = "#LyX 2.5 created this file.\n\
\\lyxformat 643\n\
\\begin_document\n\
\\begin_header\n\
\\textclass article\n\
\\cite_engine basic\n\
\\cite_engine_type default\n\
\\end_header\n\
\\begin_body\n\
\\begin_layout Standard\n\
\\begin_inset CommandInset citation\n\
LatexCommand nocite\n\
key \"alpha\"\n\
literal \"false\"\n\
\n\
\\end_inset\n\
\n\
\\end_layout\n\
\\end_body\n\
\\end_document\n";
    let ast = parse(src, false).expect("parse");
    let rendered = render_live_html(
        &ast,
        LiveRenderOptions {
            file_path: None,
            layouts_dir: Some(layouts),
            overlay_layouts_dir: None,
            system_layouts_dir: None,
            raster_dir: None,
        },
    )
    .expect("render");
    assert!(
        rendered.html.contains(">alpha (not cited)</a>"),
        "nocite must use the engine chip, not author-year; html={}",
        rendered.html
    );
}

#[test]
fn my_template_biblatex_citet_citep() {
    let path = fixtures_root().join("my_template.lyx");
    let Some((html, _)) = render_path(&path) else {
        return;
    };
    assert_eq!(
        citation_inner(&html, "Abernethy et al."),
        Some("Abernethy et al. (2003)")
    );
    assert_eq!(
        citation_inner(&html, "Cotton et al."),
        Some("(Cotton et al. 1999)")
    );
}
