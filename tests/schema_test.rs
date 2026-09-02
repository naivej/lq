//! Layout schema (Deno `tests/schema_test.ts`).

use lq::{
    LayoutSearchOptions, LocalLayoutTexts, get_default_layouts_dir, get_layout_html_for_class,
    get_schema_for_class, resolve_layout_search_paths,
};
use std::fs;
use std::path::PathBuf;

fn require_layouts_dir() -> Option<PathBuf> {
    let layouts_dir = get_default_layouts_dir();
    if layouts_dir.is_dir() {
        return Some(layouts_dir);
    }
    eprintln!(
        "skip: LyX layouts dir not found at {} — install LyX or set layoutsDir via 'lq init --layouts-dir'",
        layouts_dir.display()
    );
    None
}

fn paths(dir: &PathBuf) -> &[PathBuf] {
    std::slice::from_ref(dir)
}

fn html_tag(
    html: &std::collections::HashMap<String, lq::LayoutHtml>,
    name: &str,
) -> Option<String> {
    html.get(name)
        .and_then(|h| h.html_tag.as_ref())
        .map(|s| s.to_lowercase())
}

#[test]
fn schema_parsing_for_book_class() {
    let Some(layouts_dir) = require_layouts_dir() else {
        return;
    };
    let schema = get_schema_for_class("book", paths(&layouts_dir), &[], None).unwrap();

    assert_eq!(schema.textclass, "book");
    assert!(
        !schema.document_layouts.is_empty(),
        "Should have parsed document layouts"
    );
    assert!(
        schema.document_layouts.iter().any(|s| s == "Chapter"),
        "Book class should include Chapter layout"
    );

    assert!(schema.inset_layouts.iter().any(|s| s == "Plain Layout"));
    assert!(
        schema
            .inline_properties
            .iter()
            .any(|s| s == "change_inserted")
    );

    let json = serde_json::to_string(&schema).unwrap();
    let value: serde_json::Value = serde_json::from_str(&json).unwrap();
    assert!(
        value.get("insetCatalog").is_none(),
        "catalog payload is insets, not insetCatalog"
    );
    assert!(
        value.get("commandInsetSubtypes").is_none(),
        "CommandInset subtypes live on insets"
    );

    let formula = schema
        .insets
        .iter()
        .find(|e| e.name == "Formula")
        .expect("insets should include Formula");
    assert_eq!(formula.kind, lq::InsetKind::Content);
    let note = schema.insets.iter().find(|e| e.name == "Note");
    assert_eq!(note.map(|n| n.kind), Some(lq::InsetKind::Collapsible));
    assert_eq!(
        note.map(|n| n.subtypes.clone()).unwrap_or_default(),
        vec!["Note".to_string(), "Comment".into(), "Greyedout".into()]
    );
    let command = schema
        .insets
        .iter()
        .find(|e| e.name == "CommandInset")
        .unwrap();
    assert_eq!(command.kind, lq::InsetKind::Command);
    assert!(
        command.subtypes.iter().any(|s| s == "citation"),
        "CommandInset subtypes include citation"
    );
    assert!(
        !json.contains("htmlTag"),
        "lq schema JSON must not carry renderer HTML keys"
    );
}

#[test]
fn layout_html_lookup_is_renderer_private_and_resolves_copy_style() {
    let Some(layouts_dir) = require_layouts_dir() else {
        return;
    };
    let html = get_layout_html_for_class("article", paths(&layouts_dir), &[], None);
    assert!(
        !html.is_empty(),
        "article.layout should yield Style HTML keys"
    );
    assert_eq!(html_tag(&html, "Section").as_deref(), Some("h2"));
    assert_eq!(html.get("Section").and_then(|h| h.toc_level), Some(1));
    assert_eq!(html_tag(&html, "Itemize").as_deref(), Some("ul"));
    assert_eq!(html_tag(&html, "Labeling").as_deref(), Some("ol"));
    assert_eq!(
        html_tag(&html, "Quotation").as_deref(),
        Some("blockquote"),
        "CopyStyle Quote must inherit HTMLTag"
    );
    assert_eq!(html.get("Title").and_then(|h| h.html_title), Some(true));
    assert_eq!(
        html.get("LyX-Code").and_then(|h| h.html_tag.as_deref()),
        None,
        "LyX-Code has no HTMLTag; fallback tables still apply"
    );

    let logical = get_layout_html_for_class("article", paths(&layouts_dir), &["logicalmkup"], None);
    assert_eq!(
        html_tag(&logical, "Flex:Emph").as_deref(),
        Some("em"),
        "InsetLayout Flex:Emph HTMLTag"
    );
    assert_eq!(html_tag(&logical, "Flex:Strong").as_deref(), Some("strong"));
    assert_eq!(html_tag(&logical, "Flex:Code").as_deref(), Some("code"));
    assert_eq!(html_tag(&logical, "Flex:Noun").as_deref(), Some("span"));
    assert_eq!(
        logical
            .get("Flex:Noun")
            .and_then(|h| h.html_class.as_deref()),
        Some("noun")
    );
    assert_eq!(
        logical
            .get("Flex:Noun")
            .and_then(|h| h.font.as_ref())
            .and_then(|f| f.shape.as_ref())
            .map(|s| s.to_lowercase()),
        Some("smallcaps".to_string())
    );

    let koma = get_layout_html_for_class("scrbook", paths(&layouts_dir), &[], None);
    assert_eq!(
        html_tag(&koma, "Labeling").as_deref(),
        Some("ol"),
        "later Style Labeling must merge, not replace"
    );
    assert_eq!(html_tag(&koma, "Section").as_deref(), Some("h2"));

    let missing = get_layout_html_for_class(
        "article",
        &[PathBuf::from(r"Z:\lq-no-such-layouts")],
        &[],
        None,
    );
    assert!(missing.is_empty());

    let with_modules =
        get_layout_html_for_class("scrbook", paths(&layouts_dir), &["enumitem"], None);
    assert_eq!(
        html_tag(&with_modules, "Enumerate-Resume").as_deref(),
        Some("ol"),
        "header module Enumerate-Resume CopyStyle Enumerate must resolve HTMLTag"
    );

    let with_headers = get_layout_html_for_class(
        "scrbook",
        paths(&layouts_dir),
        &["customHeadersFooters"],
        None,
    );
    assert_eq!(
        with_headers
            .get("Left Header")
            .and_then(|h| h.category.as_deref()),
        Some("Header/Footer"),
        "Style \"Left Header\" quotes must strip so Category Header/Footer resolves"
    );
    assert_eq!(
        with_headers
            .get("Center Footer")
            .and_then(|h| h.category.as_deref()),
        Some("Header/Footer"),
        "CopyStyle from quoted Left Header must inherit Category"
    );
    assert!(
        !with_headers.contains_key("\"Left Header\""),
        "quoted key must not remain"
    );
    assert_eq!(
        koma.get("Right_Address")
            .and_then(|h| h.category.as_deref()),
        Some("FrontMatter"),
        "layout file uses Right_Address with underscore"
    );

    let theorems =
        get_layout_html_for_class("scrbook", paths(&layouts_dir), &["theorems-ams"], None);
    assert_eq!(
        theorems
            .get("Theorem")
            .and_then(|h| h.label_type.as_ref())
            .map(|s| s.to_lowercase()),
        Some("static".to_string())
    );
    assert_eq!(
        theorems
            .get("Theorem")
            .and_then(|h| h.label_string.as_deref()),
        Some("Theorem \\thetheorem.")
    );
    assert_eq!(
        theorems
            .get("Theorem")
            .and_then(|h| h.label_counter.as_deref()),
        Some("theorem")
    );
}

#[test]
fn layout_search_overlay_before_system_local_layout_merges_style_html() {
    let Some(system) = require_layouts_dir() else {
        return;
    };
    let roots = resolve_layout_search_paths(&LayoutSearchOptions {
        system_layouts_dir: Some(system.clone()),
        overlay_layouts_dir: None,
    });
    assert_eq!(roots.search_paths.last(), Some(&system));
    assert!(roots.search_paths.iter().any(|p| p == &system));

    let overlay = std::env::temp_dir().join(format!(
        "lq_layout_overlay_{}_{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    fs::create_dir_all(&overlay).unwrap();
    let article = overlay.join("article.layout");
    fs::write(
        &article,
        [
            "# overlay article",
            "Format 104",
            "Input stdclass.inc",
            "Style OverlayProbe",
            "HTMLTag               div",
            "Category             FrontMatter",
            "End",
        ]
        .join("\n"),
    )
    .unwrap();

    let search_paths = vec![overlay.clone(), system.clone()];
    let html = get_layout_html_for_class("article", &search_paths, &[], None);
    assert_eq!(html_tag(&html, "OverlayProbe").as_deref(), Some("div"));
    assert_eq!(
        html_tag(&html, "Section").as_deref(),
        Some("h2"),
        "Input stdclass from system still loads"
    );

    let with_local = get_layout_html_for_class(
        "article",
        paths(&system),
        &[],
        Some(&LocalLayoutTexts {
            normal: Some(
                [
                    "Style LocalProbe",
                    "CopyStyle             Section",
                    "HTMLTag               h3",
                    "End",
                ]
                .join("\n"),
            ),
            forced: None,
        }),
    );
    assert_eq!(html_tag(&with_local, "LocalProbe").as_deref(), Some("h3"));
    assert_eq!(
        with_local.get("LocalProbe").and_then(|h| h.toc_level),
        Some(1),
        "CopyStyle Section brings TocLevel"
    );

    let schema = get_schema_for_class(
        "article",
        paths(&system),
        &[],
        Some(&LocalLayoutTexts {
            normal: Some("Style LocalOnly\nHTMLTag div\nEnd\n".into()),
            forced: None,
        }),
    )
    .unwrap();
    assert!(schema.document_layouts.iter().any(|s| s == "LocalOnly"));

    let _ = fs::remove_dir_all(&overlay);
}
