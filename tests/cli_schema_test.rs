//! `lq schema` CLI (Deno `tests/cli_test.ts` schema cases).

mod common;

use common::{IsolatedHome, WorkDir, json_stdout, run_cli_with, temp_lyx};
use serde_json::{Value, json};
use std::fs;
use std::path::{Path, PathBuf};

fn require_layouts_dir() -> Option<PathBuf> {
    let layouts_dir = lq::get_default_layouts_dir();
    if layouts_dir.is_dir() {
        return Some(layouts_dir);
    }
    eprintln!(
        "skip: LyX layouts dir not found at {} — install LyX or set layoutsDir via 'lq init --layouts-dir'",
        layouts_dir.display()
    );
    None
}

fn write_document(work: &WorkDir, name: &str, textclass: Option<&str>) -> PathBuf {
    let class_line = textclass
        .map(|class| format!("\\textclass {class}\n"))
        .unwrap_or_default();
    let path = work.path().join(name);
    fs::write(
        &path,
        format!(
            "#LyX 2.5 created this file.\n\
             \\lyxformat 643\n\
             \\begin_document\n\
             \\begin_header\n\
             {class_line}\
             \\end_header\n\
             \\begin_body\n\
             \\begin_layout Standard\n\
             Schema test.\n\
             \\end_layout\n\
             \\end_body\n\
             \\end_document\n"
        ),
    )
    .unwrap();
    path
}

fn configure_layouts_dir(home: &IsolatedHome, layouts_dir: &Path) {
    fs::create_dir_all(layouts_dir).unwrap();
    fs::write(
        home.path().join(".lq/config.json"),
        json!({ "layoutsDir": layouts_dir }).to_string(),
    )
    .unwrap();
}

fn assert_six_schema_categories(data: &Value) {
    let mut keys: Vec<&str> = data
        .as_object()
        .expect("schema data should be an object")
        .keys()
        .map(String::as_str)
        .collect();
    keys.sort_unstable();
    assert_eq!(
        keys,
        [
            "documentLayouts",
            "headingHierarchy",
            "inlineProperties",
            "insetLayouts",
            "insets",
            "textclass",
        ]
    );
}

fn assert_formula_content_metadata(data: &Value) {
    let formula = data["insets"]
        .as_array()
        .expect("insets should be an array")
        .iter()
        .find(|inset| inset["name"] == "Formula")
        .expect("insets should include Formula");
    assert_eq!(
        formula,
        &json!({
            "name": "Formula",
            "kind": "content",
            "subtypes": [],
        })
    );
}

fn builtin_inset_catalog_json() -> Value {
    Value::Array(
        lq::INSET_CATALOG
            .iter()
            .map(|inset| {
                json!({
                    "name": inset.name,
                    "kind": inset.kind,
                    "subtypes": inset.subtypes,
                })
            })
            .collect(),
    )
}

#[test]
fn cli_schema_uses_configured_overlay() {
    let home = IsolatedHome::new();
    let work = WorkDir::new();
    let layouts = work.path().join("layouts");
    configure_layouts_dir(&home, &layouts);
    fs::write(
        layouts.join("s8overlay.layout"),
        "Format 104\n\
         Style Standard\n\
         End\n\
         Style \"Overlay Heading\"\n\
         TocLevel 2\n\
         End\n",
    )
    .unwrap();
    let file = write_document(&work, "overlay.lyx", Some("s8overlay"));

    let out = run_cli_with(&["schema", file.to_str().unwrap()], &home, work.path());
    let result = json_stdout(&out);
    assert_eq!(
        out.code, 0,
        "unexpected response: {result}\nstderr: {}",
        out.stderr
    );

    let data = &result["data"];
    assert_six_schema_categories(data);
    assert_eq!(data["textclass"], "s8overlay");
    assert_eq!(
        data["documentLayouts"],
        json!(["Overlay Heading", "Standard"])
    );
    assert_eq!(data["insetLayouts"], json!(["Plain Layout"]));
    assert_eq!(
        data["headingHierarchy"],
        json!([{ "layout": "Overlay Heading", "tocLevel": 2 }])
    );
    assert!(
        data["inlineProperties"]
            .as_array()
            .unwrap()
            .iter()
            .any(|property| property == "change_inserted")
    );
    assert_formula_content_metadata(data);
    assert_eq!(result["warnings"], json!([]));
}

#[test]
fn cli_schema_extra_positional_is_rejected() {
    let home = IsolatedHome::new();
    let work = WorkDir::new();
    let file = write_document(&work, "extra.lyx", Some("article"));

    let out = run_cli_with(
        &["schema", file.to_str().unwrap(), "ignored-extra-positional"],
        &home,
        work.path(),
    );
    let result = json_stdout(&out);
    assert_eq!(out.code, 1);
    assert_eq!(result["code"], "INVALID_FLAG");
    assert!(
        result["message"]
            .as_str()
            .unwrap_or("")
            .contains("Unexpected argument 'ignored-extra-positional'"),
        "{result}"
    );
}

#[test]
fn cli_schema_selector_position_bogus_flag_is_rejected() {
    let home = IsolatedHome::new();
    let work = WorkDir::new();
    let file = write_document(&work, "flag.lyx", Some("article"));

    let out = run_cli_with(
        &["schema", file.to_str().unwrap(), "--bogus-flag"],
        &home,
        work.path(),
    );
    let result = json_stdout(&out);
    assert_eq!(out.code, 1);
    assert_eq!(result["code"], "INVALID_FLAG");
    assert_eq!(
        result["message"],
        "Unknown flag for 'schema': --bogus-flag. Run 'lq schema --help' to list valid flags."
    );
}

#[test]
fn cli_schema_without_textclass_reports_no_textclass() {
    let home = IsolatedHome::new();
    let work = WorkDir::new();
    let file = write_document(&work, "no_textclass.lyx", None);

    let out = run_cli_with(&["schema", file.to_str().unwrap()], &home, work.path());
    let result = json_stdout(&out);
    assert_eq!(out.code, 1);
    assert_eq!(result["code"], "NO_TEXTCLASS");
    assert_eq!(
        result["message"],
        "Could not determine textclass from the document."
    );
}

#[test]
fn cli_schema_missing_layout_returns_fallback_catalog_and_hierarchy() {
    const MISSING_CLASS: &str = "lq-s8-no-such-class";

    let home = IsolatedHome::new();
    let work = WorkDir::new();
    let layouts = work.path().join("empty-layouts");
    configure_layouts_dir(&home, &layouts);
    let file = write_document(&work, "missing_layout.lyx", Some(MISSING_CLASS));

    let out = run_cli_with(&["schema", file.to_str().unwrap()], &home, work.path());
    let result = json_stdout(&out);
    assert_eq!(
        out.code, 0,
        "unexpected response: {result}\nstderr: {}",
        out.stderr
    );
    assert!(out.stderr.is_empty());

    let data = &result["data"];
    assert_six_schema_categories(data);
    assert_eq!(data["textclass"], MISSING_CLASS);
    assert_eq!(data["documentLayouts"], json!([]));
    assert_eq!(data["insetLayouts"], json!(lq::INSET_LAYOUTS));
    assert_eq!(data["insets"], builtin_inset_catalog_json());
    assert_eq!(data["inlineProperties"], json!(lq::INLINE_PROPERTIES));
    assert_eq!(
        data["headingHierarchy"],
        json!([
            { "layout": "Part", "tocLevel": -1 },
            { "layout": "Chapter", "tocLevel": 0 },
            { "layout": "Section", "tocLevel": 1 },
            { "layout": "Bibliography", "tocLevel": 1 },
            { "layout": "Subsection", "tocLevel": 2 },
            { "layout": "Subsubsection", "tocLevel": 3 },
            { "layout": "Paragraph", "tocLevel": 4 },
            { "layout": "Subparagraph", "tocLevel": 5 },
        ])
    );
    assert_formula_content_metadata(data);

    let warnings = result["warnings"]
        .as_array()
        .expect("warnings should be an array");
    assert_eq!(warnings.len(), 1);
    let warning = warnings[0].as_str().unwrap();
    assert!(
        warning.starts_with(&format!(
            "Could not read layout file for textclass '{MISSING_CLASS}': \
             Layout file not found for textclass '{MISSING_CLASS}' in: "
        )),
        "{warning}"
    );
}

#[test]
fn cli_schema_fallback_auto_detects_layouts() {
    let Some(_layouts_dir) = require_layouts_dir() else {
        return;
    };
    let home = IsolatedHome::new();
    let work = WorkDir::new();
    let file = temp_lyx(&work, "my_template.lyx");

    let out = run_cli_with(&["schema", file.to_str().unwrap()], &home, work.path());
    let result = json_stdout(&out);
    assert_eq!(
        out.code, 0,
        "unexpected response: {result}\nstderr: {}",
        out.stderr
    );

    let data = &result["data"];
    assert_six_schema_categories(data);
    assert!(
        !data["headingHierarchy"]
            .as_array()
            .expect("headingHierarchy should be an array")
            .is_empty(),
        "headingHierarchy should not be empty"
    );
    assert_formula_content_metadata(data);
}
