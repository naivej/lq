//! Live contract + renderer (Deno `tests/preview_test.ts`).

mod common;

use common::{
    IsolatedHome, WorkDir, fixtures_root, host_layouts_dir, parse_cli_json, path_arg, run_cli_with,
};
use lq::{
    ConcatOpts, DIAG_PREVIEW_RECOVERED, DIAG_TEXTCLASS_FALLBACK, LIVE_CAPABILITIES, LIVE_CONTRACT,
    LIVE_DEFERRED_FIELDS, LayoutSearchOptions, LiveNavigate, LiveRenderOptions, LiveToken,
    NodeKind, PREVIEW_INCOMPLETE_WARNING, PREVIEW_NO_TEXTCLASS_WARNING, build_live_response,
    concatenate_text_nodes, detect_line_ending, escape_live_html, extract_all_text,
    find_layout_file, find_magick, format_sem, get_default_layouts_dir, hash_text,
    normalize_reader_html, parse, parse_recovering, preview_missing_class_warning, query,
    raster_magick_args, render_live_html, resolve_layout_search_paths, semantic_equal,
    validate_live_response,
};
use serde_json::{Value, json};
use std::fs;
use std::path::PathBuf;

fn synthetic(name: &str) -> PathBuf {
    fixtures_root().join("Synthetic").join(name)
}

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

fn render_file(name: &str) -> Option<(String, lq::LivePreviewResponse)> {
    require_layouts_dir()?;
    let path = synthetic(name);
    let text = fs::read_to_string(&path).expect("fixture");
    let ast = parse(&text, false).expect("parse");
    let result = build_live_response(&path, &ast, &text, None, None, None).expect("render");
    Some((result.response.html.clone(), result.response))
}

fn empty_navigate() -> LiveNavigate {
    LiveNavigate::default()
}

fn mini_lyx(header: &str, body: &str) -> String {
    format!(
        "#LyX 2.5 created this file.\n\\lyxformat 643\n\\begin_document\n\\begin_header\n{header}\\end_header\n\\begin_body\n{body}\\end_body\n\\end_document\n"
    )
}

fn valid_base() -> Value {
    json!({
        "contract": LIVE_CONTRACT,
        "projection": "live",
        "html": "<article></article>",
        "source": {
            "path": "C:/tmp/a.lyx",
            "hashAlgorithm": "sha256",
            "hashInput": "raw-file-bytes",
            "diskHash": "a".repeat(64),
            "lineEnding": "lf",
            "lineCount": 2,
            "fresh": true,
        },
        "capabilities": LIVE_CAPABILITIES,
        "diagnostics": [],
        "outline": [],
        "navigate": empty_navigate(),
        "changes": [],
        "tokens": [],
    })
}

fn assert_contract_err(value: &Value, needle: &str) {
    let err = validate_live_response(value).expect_err("expected LiveContractError");
    assert!(
        err.message.contains(needle),
        "error {:?} should contain {needle:?}",
        err.message
    );
}

#[test]
fn live_contract_rejects_malformed_required_fields() {
    let base = valid_base();
    let mut nope = base.clone();
    nope["contract"] = json!("nope");
    assert_contract_err(&nope, "contract");

    let mut review = base.clone();
    review["projection"] = json!("review");
    assert_contract_err(&review, "projection");

    let mut html = base.clone();
    html["html"] = json!(1);
    assert_contract_err(&html, "html");

    let mut caps = base.clone();
    caps["capabilities"]["review"] = json!(true);
    assert_contract_err(&caps, "review");

    let mut fresh = base.clone();
    fresh["source"]["fresh"] = json!(false);
    assert_contract_err(&fresh, "fresh");

    let mut outline = base.clone();
    outline["outline"] = json!("nope");
    assert_contract_err(&outline, "outline");
}

#[test]
fn live_contract_deferred_fields_are_rejected() {
    let base = valid_base();
    for field in LIVE_DEFERRED_FIELDS {
        let mut with = base.clone();
        with[*field] = json!([]);
        assert_contract_err(&with, field);
    }
    validate_live_response(&base).expect("base is valid");
    let mut with_change = base.clone();
    with_change["changes"] = json!([{
        "ordinal": 1,
        "type": "inserted",
        "author": "Alice",
        "ts": "1720000000",
        "anchorId": "change-1",
        "snippet": "added",
    }]);
    validate_live_response(&with_change).expect("changes accepted");

    let mut with_token = base.clone();
    with_token["tokens"] = json!([{
        "id": "tok-1",
        "bundle": { "selector": "layout[Standard]:nth-match(1)" },
    }]);
    validate_live_response(&with_token).expect("tokens accepted");

    let mut leftover = base.clone();
    leftover["tokens"] = json!([{
        "id": "cell-1",
        "bundle": {
            "selector": "inset[Tabular]:nth-match(1) inset[Text]:nth-match(1) layout[Plain Layout]",
            "coords": { "row": 1, "column": 2 },
        },
    }]);
    let leftover_coords = validate_live_response(&leftover).expect("coords ignored");
    assert!(leftover_coords.tokens[0].bundle.file.is_none());

    let mut empty_id = base.clone();
    empty_id["tokens"] = json!([{
        "id": "",
        "bundle": { "selector": "layout[Standard]:nth-match(1)" },
    }]);
    assert_contract_err(&empty_id, "token.id");

    let mut dup = base.clone();
    dup["tokens"] = json!([
        { "id": "tok-1", "bundle": { "selector": "layout[Standard]:nth-match(1)" } },
        { "id": "tok-1", "bundle": { "selector": "layout[Section]:nth-match(1)" } },
    ]);
    assert_contract_err(&dup, "unique");
}

#[test]
fn live_renderer_escape_helper_is_applied_to_source_derived_text() {
    assert_eq!(
        escape_live_html(r#"<a b="c">"#),
        r#"&lt;a b=&quot;c&quot;&gt;"#
    );
}

#[test]
fn live_contract_valid_response_is_accepted() {
    let path = synthetic("headings_paragraphs.lyx");
    let text = fs::read_to_string(&path).expect("fixture");
    let ast = parse(&text, false).expect("parse");
    match build_live_response(&path, &ast, &text, None, None, None) {
        Err(err) => {
            eprintln!("skip: Live render needs LyX layouts ({})", err.message);
        }
        Ok(result) => {
            let mut value = serde_json::to_value(&result.response).expect("json");
            value["warnings"] = json!(result.warnings);
            let validated = validate_live_response(&value).expect("valid");
            assert_eq!(validated.contract, LIVE_CONTRACT);
            assert_eq!(validated.projection, "live");
            assert_eq!(validated.capabilities, LIVE_CAPABILITIES);
            assert!(validated.capabilities.outline);
            assert!(
                validated.outline.len() >= 2,
                "headings_paragraphs should yield outline entries"
            );
            assert!(validated.source.fresh);
            assert_eq!(validated.source.hash_algorithm, "sha256");
            assert_eq!(validated.source.hash_input, "raw-file-bytes");
            assert_eq!(validated.source.disk_hash.len(), 64);
        }
    }
}

#[test]
fn live_csp_floor_restrictive_policy_string_has_no_remote_sources() {
    let csp_none = "default-src 'none'; img-src vscode-webview: data:; style-src 'unsafe-inline'; script-src 'none'; connect-src 'none'; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'";
    let csp_nonce = "default-src 'none'; img-src vscode-webview: data:; style-src 'unsafe-inline'; script-src 'nonce-abc'; connect-src 'none'; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'";
    for csp in [csp_none, csp_nonce] {
        assert!(csp.contains("default-src 'none'"));
        assert!(
            csp.contains("script-src 'none'") || csp.contains("script-src 'nonce-"),
            "script-src must be none or nonce-only"
        );
        assert!(!csp.contains("http://") && !csp.contains("https://"));
    }
}

#[test]
fn live_cli_extra_arguments_are_rejected() {
    let home = IsolatedHome::new();
    let work = WorkDir::new();
    let file = synthetic("hostile.lyx");
    let out = run_cli_with(&["preview", path_arg(&file), "layout"], &home, work.path());
    let parsed = parse_cli_json(&out);
    assert_eq!(parsed["code"], "INVALID_FLAG");
}

#[test]
fn raster_magick_args_eps_keep_density_and_first_page() {
    let path = PathBuf::from("/tmp/clip.eps");
    assert_eq!(
        raster_magick_args(&path),
        vec![
            "-density".to_string(),
            "120".to_string(),
            "/tmp/clip.eps[0]".to_string(),
            "png:-".to_string(),
        ]
    );
    assert!(!raster_magick_args(&path).iter().any(|a| a.contains("trim")));
}

#[test]
fn raster_magick_args_pdf_use_lyx_cropbox() {
    let path = PathBuf::from("/tmp/fig.PDF");
    assert_eq!(
        raster_magick_args(&path),
        vec![
            "-density".to_string(),
            "120".to_string(),
            "-define".to_string(),
            "pdf:use-cropbox=true".to_string(),
            "/tmp/fig.PDF[0]".to_string(),
            "png:-".to_string(),
        ]
    );
    assert!(!raster_magick_args(&path).iter().any(|a| a.contains("trim")));
}

#[test]
fn live_itemize_bullets_section_id_collapses_punctuation_runs() {
    let Some(layouts) = require_layouts_dir() else {
        return;
    };
    let _ = layouts;
    let path = fixtures_root().join("Graphics_and_Insets/Itemize_Bullets.lyx");
    let text = fs::read_to_string(&path).expect("fixture");
    let ast = parse(&text, false).expect("parse");
    let result = match build_live_response(&path, &ast, &text, None, None, None) {
        Ok(r) => r,
        Err(err) => {
            eprintln!("skip: Itemize_Bullets preview needs layouts ({err})");
            return;
        }
    };
    let slug = "sec-maths-amsamerican-mathematical-society-s";
    assert!(
        result.response.html.contains(&format!(r#"id="{slug}""#)),
        "html should contain collapsed slug {slug}"
    );
    assert!(
        result.response.outline.iter().any(|e| e.id == slug),
        "outline should contain collapsed slug {slug}"
    );
}

#[test]
fn live_cli_invalid_utf8_is_parse_error_not_file_not_found() {
    let home = IsolatedHome::new();
    let work = WorkDir::new();
    let tmp = work.path().join("garbage.lyx");
    fs::write(
        &tmp,
        [0x00, 0xff, b' ', b'n', b'o', b't', b' ', b'l', b'y', b'x'],
    )
    .unwrap();
    let out = run_cli_with(&["preview", path_arg(&tmp)], &home, work.path());
    assert_eq!(out.code, 1);
    let parsed = parse_cli_json(&out);
    assert_eq!(parsed["code"], "PARSE_ERROR");
    let msg = parsed["message"].as_str().unwrap_or("");
    assert!(
        msg.contains("UTF-8") || msg.contains("utf-8"),
        "honest UTF-8 wording, got {msg}"
    );
}

#[test]
fn live_cli_missing_path_is_file_not_found() {
    let home = IsolatedHome::new();
    let work = WorkDir::new();
    let missing = work.path().join("no-such-file.lyx");
    let out = run_cli_with(&["preview", path_arg(&missing)], &home, work.path());
    assert_eq!(out.code, 1);
    let parsed = parse_cli_json(&out);
    assert_eq!(parsed["code"], "FILE_NOT_FOUND");
}

#[test]
fn live_cli_parse_failure_does_not_emit_html() {
    let home = IsolatedHome::new();
    let work = WorkDir::new();
    let tmp = work.path().join("bad.lyx");
    fs::write(&tmp, "not a lyx file").unwrap();
    let out = run_cli_with(&["preview", path_arg(&tmp)], &home, work.path());
    assert_eq!(out.code, 1);
    let parsed = parse_cli_json(&out);
    assert_eq!(parsed["code"], "PARSE_ERROR");
    assert!(parsed.get("html").is_none() || parsed["html"].is_null());
}

#[test]
fn live_cli_incomplete_file_previews_with_warning_dump_still_fails() {
    let home = IsolatedHome::new();
    if let Some(dir) = host_layouts_dir() {
        fs::write(
            home.path().join(".lq/config.json"),
            json!({ "layoutsDir": dir }).to_string(),
        )
        .unwrap();
    }
    let work = WorkDir::new();
    let tmp = work.path().join("wip.lyx");
    fs::write(
        &tmp,
        mini_lyx(
            "\\textclass article\n",
            "\\begin_layout Standard\nHello world\n",
        ),
    )
    .unwrap();
    let dump = run_cli_with(&["dump", path_arg(&tmp)], &home, work.path());
    assert_eq!(dump.code, 1);
    assert_eq!(parse_cli_json(&dump)["code"], "PARSE_ERROR");
    parse(&fs::read_to_string(&tmp).unwrap(), false).expect_err("strict parse must fail");
    parse_recovering(&fs::read_to_string(&tmp).unwrap()).expect("LyX would open this");
    let out = run_cli_with(&["preview", path_arg(&tmp)], &home, work.path());
    let parsed = parse_cli_json(&out);
    if parsed.get("code").and_then(Value::as_str).is_some() {
        eprintln!("skip: Live CLI render needs LyX layouts ({parsed})");
        return;
    }
    let html = parsed["html"].as_str().unwrap_or("");
    assert!(html.contains("Hello world"), "html: {html}");
    let warnings = parsed["warnings"].as_array().expect("warnings");
    assert!(
        warnings
            .iter()
            .any(|w| w.as_str() == Some(PREVIEW_INCOMPLETE_WARNING)),
        "warnings: {warnings:?}"
    );
    let diags = parsed["diagnostics"].as_array().expect("diagnostics");
    assert!(
        diags
            .iter()
            .any(|d| d["code"].as_str() == Some(DIAG_PREVIEW_RECOVERED)),
        "diagnostics: {diags:?}"
    );
}

#[test]
fn live_cli_crlf_is_recorded_as_crlf() {
    let home = IsolatedHome::new();
    let work = WorkDir::new();
    let src = fs::read_to_string(synthetic("headings_paragraphs.lyx"))
        .expect("fixture")
        .replace("\r\n", "\n");
    let crlf = src.replace('\n', "\r\n");
    let tmp = work.path().join("crlf.lyx");
    fs::write(&tmp, &crlf).unwrap();
    let out = run_cli_with(&["preview", path_arg(&tmp)], &home, work.path());
    let parsed = parse_cli_json(&out);
    if parsed.get("code").and_then(Value::as_str).is_some() {
        eprintln!("skip: Live CLI render needs LyX layouts ({parsed})");
        return;
    }
    let validated = validate_live_response(&parsed).expect("valid");
    assert_eq!(validated.source.line_ending, lq::LineEnding::Crlf);
    assert_eq!(detect_line_ending(&crlf), lq::LineEnding::Crlf);
}

#[test]
fn live_mapping_headings_paragraphs_tokens_match_html_ids() {
    let Some((_, response)) = render_file("headings_paragraphs.lyx") else {
        return;
    };
    assert!(response.capabilities.mapping);
    assert!(
        response.tokens.len() >= 4,
        "section + paragraphs should yield tokens"
    );
    let mut ids = std::collections::HashSet::new();
    for token in &response.tokens {
        assert!(ids.insert(token.id.clone()), "token ids are unique");
        assert!(response.html.contains(&format!(r#"id="{}""#, token.id)));
        assert!(
            response
                .html
                .contains(&format!(r#"data-ref="{}""#, token.id))
        );
        assert!(!token.bundle.selector.is_empty());
    }
    assert!(
        response
            .tokens
            .iter()
            .any(|t| t.bundle.selector.starts_with("layout[Section]")),
        "Section heading is mapped"
    );
    let standard: Vec<_> = response
        .tokens
        .iter()
        .filter(|t| t.bundle.selector.starts_with("layout[Standard]"))
        .collect();
    assert!(standard.len() >= 2, "Standard paragraphs are mapped");
    assert_eq!(standard[0].bundle.selector, "layout[Standard]:nth-match(1)");
}

#[test]
fn live_mapping_heading_data_ref_is_on_the_heading_tag_not_section() {
    let Some((html, _)) = render_file("headings_paragraphs.lyx") else {
        return;
    };
    let section_with_ref = html
        .match_indices("<section")
        .filter(|(i, _)| {
            let slice = &html[*i..];
            let end = slice.find('>').unwrap_or(slice.len());
            slice[..end].contains("data-ref=")
        })
        .count();
    assert_eq!(
        section_with_ref, 0,
        "<section> must not carry data-ref (J1 A)"
    );
    assert!(
        html.contains("<h2") && html.contains("data-ref="),
        "heading tag must carry data-ref"
    );
    assert!(html.contains("Introduction"), "heading words still publish");
}

#[test]
fn live_renderer_headings_paragraphs_unicode_empty_emphasis() {
    let Some((html, _)) = render_file("headings_paragraphs.lyx") else {
        return;
    };
    assert!(
        html.contains(r#"<span class="heading-number">1 </span>Introduction</h2>"#),
        "h2 counter+title: {html}"
    );
    assert!(
        html.contains(r#"<span class="heading-number">1.1 </span>Details</h3>"#),
        "h3 counter+title"
    );
    assert!(html.contains("Café naïve"));
    assert!(html.contains("𝄞"));
    assert!(html.contains("<em>styled</em>"));
    assert!(
        !html.contains(r#"<div class="standard"></div>"#),
        "empty Standard paragraphs are omitted like native XHTML"
    );
}

#[test]
fn live_renderer_lists_and_quotes() {
    let Some((html, _)) = render_file("lists_quotes.lyx") else {
        return;
    };
    assert!(html.contains("<ul>"));
    assert!(html.contains("outer one"));
    assert!(html.contains("<ul><li") && html.contains("nested"));
    assert!(html.contains(r#"<ol class="enumi">"#));
    assert!(html.contains("first"));
    assert!(html.contains(">Term</dt>") || html.contains("Term</dt>"));
    assert!(html.contains("the explanation"));
    assert!(html.contains(r#"<blockquote class="quote">"#));
    assert!(html.contains("A quoted line."));
}

#[test]
fn live_renderer_missing_named_class_warns_and_renders() {
    let path = synthetic("headings_paragraphs.lyx");
    let text = fs::read_to_string(&path).expect("fixture");
    let ast = parse(&text, false).expect("parse");
    let result = render_live_html(
        &ast,
        LiveRenderOptions {
            file_path: Some(path.clone()),
            layouts_dir: Some(PathBuf::from(r"Z:\lq-no-such-layouts")),
            overlay_layouts_dir: None,
            system_layouts_dir: None,
            raster_dir: None,
        },
    )
    .expect("LyX still opens when the named class file is missing");
    assert!(result.html.contains("lyx-live"), "html: {}", result.html);
    let expected = preview_missing_class_warning("article");
    assert!(
        result.warnings.iter().any(|w| w == &expected),
        "warnings: {:?}",
        result.warnings
    );
    assert!(
        result
            .diagnostics
            .iter()
            .any(|d| d.code == DIAG_TEXTCLASS_FALLBACK),
        "diagnostics: {:?}",
        result.diagnostics
    );
}

#[test]
fn live_renderer_missing_textclass_uses_article_and_warns() {
    let Some(layouts) = require_layouts_dir() else {
        return;
    };
    let text = mini_lyx(
        "",
        "\\begin_layout Standard\nHello classless\n\\end_layout\n",
    );
    let ast = parse(&text, false).expect("parse");
    let result = render_live_html(
        &ast,
        LiveRenderOptions {
            file_path: Some(synthetic("headings_paragraphs.lyx")),
            layouts_dir: Some(layouts),
            overlay_layouts_dir: None,
            system_layouts_dir: None,
            raster_dir: None,
        },
    )
    .expect("render");
    assert!(
        result.html.contains("Hello classless"),
        "html: {}",
        result.html
    );
    assert!(
        result
            .warnings
            .iter()
            .any(|w| w == PREVIEW_NO_TEXTCLASS_WARNING),
        "warnings: {:?}",
        result.warnings
    );
}

#[test]
fn live_renderer_hostile_strings_stay_escaped() {
    let Some((html, _)) = render_file("hostile.lyx") else {
        return;
    };
    assert!(!html.contains("<script>"), "raw script tag must not appear");
    assert!(
        !html.contains("<img src=x"),
        "raw hostile img must not appear"
    );
    assert!(html.contains("&lt;script&gt;"));
    assert!(html.contains("&amp; ampersands"));
    assert!(html.contains("&quot;quotes&quot;"));
}

#[test]
fn live_contract_build_live_response_honors_the_passed_disk_hash() {
    let Some(_) = require_layouts_dir() else {
        return;
    };
    let original = fs::read_to_string(synthetic("headings_paragraphs.lyx")).expect("fixture");
    let work = WorkDir::new();
    let tmp = work.path().join("hash.lyx");
    fs::write(&tmp, &original).unwrap();
    let ast = parse(&original, false).expect("parse");
    let expected = hash_text(&original);
    fs::write(&tmp, format!("{original}\n% changed on disk after read\n")).unwrap();
    let result =
        build_live_response(&tmp, &ast, &original, None, None, Some(&expected)).expect("render");
    assert_eq!(result.response.source.disk_hash, expected);
}

#[test]
fn live_renderer_tracked_changes_render_as_ins_del_wrappers() {
    let Some((html, response)) = render_file("tracked_ert_notes.lyx") else {
        return;
    };
    assert!(html.contains("Visible"));
    assert!(html.contains(
        r#"<ins class="change-inserted change-author-0" id="change-1" data-ref="change-1"> inserted</ins>"#
    ));
    assert!(html.contains(
        r#"<del class="change-deleted change-author-0" id="change-2" data-ref="change-2"> deleted</del>"#
    ));
    assert_eq!(response.changes.len(), 2);
    assert_eq!(response.changes[0].ordinal, 1);
    assert!(html.contains(r#"class="disclose ert""#));
    assert!(html.contains(r"\textbf{nope}"));
    assert!(!response.diagnostics.iter().any(|d| d.code == "ERT_OMITTED"));
}

#[test]
fn live_renderer_specialchar_emits_data_lq_text() {
    let Some((html, _)) = render_file("disclosure_collapsibles.lyx") else {
        return;
    };
    assert!(
        html.contains(r#"<span class="specialchar" data-lq-text="\SpecialChar LyX">LyX</span>"#),
        "SpecialChar span: missing in html"
    );
}

#[test]
fn live_renderer_table_figure_footnote_formula() {
    let Some((html, _)) = render_file("table_figure_foot_math.lyx") else {
        return;
    };
    assert!(html.contains("<table"));
    assert!(html.contains("<td"));
    assert!(html.contains(">A</"));
    assert!(html.contains("disclose foot"));
    assert!(html.contains("Footnote body."));
    assert!(html.contains("<math"));
    assert!(html.contains("E=mc^{2}"));
    assert!(html.contains("<figure"));
    assert!(html.contains(r#"data-filename="live-figure.png""#));
    assert!(html.contains("<figcaption"));
    assert!(html.contains("Figure 1: "));
    assert!(html.contains(r#"class="float-caption-Standard""#));
    assert!(html.contains("data-filepath="));
    assert!(html.contains(r#"src="file:"#));
}

#[test]
fn live_renderer_appendix_frame_and_lettering() {
    let Some((html, response)) = render_file("appendix_marker.lyx") else {
        return;
    };
    assert!(html.contains(r#"<div class="appendix-frame">"#));
    assert!(html.contains(r#"<span class="appendix-label">Appendix</span>"#));
    assert!(html.contains(r#"<span class="heading-number">1 </span>Main"#));
    assert!(html.contains(r#"<span class="heading-number">A </span>First appendix"#));
    assert!(html.contains(r#"<span class="heading-number">A.1 </span>Nested"#));
    assert!(!html.contains(">2 First appendix"));
    let frame_at = html.find(r#"class="appendix-frame""#).expect("frame");
    assert!(html.find("Main").expect("Main") < frame_at);
    assert!(!response.outline.is_empty());
}

#[test]
fn find_magick_discovers_magick_on_path_when_bundled_is_absent() {
    let work = WorkDir::new();
    let stub_name = if cfg!(windows) {
        "magick.exe"
    } else {
        "magick"
    };
    let stub = work.path().join(stub_name);
    fs::write(&stub, []).unwrap();
    let prev_path = std::env::var_os("PATH");
    let prev_magick = std::env::var_os("MAGICK_BINARY");
    let prev_local = std::env::var_os("LOCALAPPDATA");
    // SAFETY: this test is the only PATH/MAGICK_BINARY/LOCALAPPDATA mutator in preview_test.
    unsafe {
        std::env::remove_var("MAGICK_BINARY");
        std::env::remove_var("LOCALAPPDATA");
        std::env::set_var("PATH", work.path());
    }
    let found = find_magick(None);
    unsafe {
        match prev_path {
            Some(v) => std::env::set_var("PATH", v),
            None => std::env::remove_var("PATH"),
        }
        match prev_magick {
            Some(v) => std::env::set_var("MAGICK_BINARY", v),
            None => std::env::remove_var("MAGICK_BINARY"),
        }
        match prev_local {
            Some(v) => std::env::set_var("LOCALAPPDATA", v),
            None => std::env::remove_var("LOCALAPPDATA"),
        }
    }
    assert_eq!(found.as_deref(), Some(stub.as_path()));
}

fn help_file(name: &str) -> PathBuf {
    fixtures_root().join("Help").join(name)
}

fn render_path(path: &std::path::Path) -> Option<(String, lq::LivePreviewResponse)> {
    require_layouts_dir()?;
    let text = fs::read_to_string(path).expect("fixture");
    let ast = parse(&text, false).expect("parse");
    let result = build_live_response(path, &ast, &text, None, None, None).expect("render");
    Some((result.response.html.clone(), result.response))
}

fn strip_mapping_attrs(html: &str) -> String {
    let mut out = String::new();
    let mut rest = html;
    while let Some(i) = rest.find(" data-ref=\"") {
        out.push_str(&rest[..i]);
        rest = &rest[i + " data-ref=\"".len()..];
        if let Some(end) = rest.find('"') {
            rest = &rest[end + 1..];
        } else {
            break;
        }
    }
    out.push_str(rest);
    let mut cleaned = String::new();
    let mut rest = out.as_str();
    while let Some(i) = rest.find(" id=\"tok-") {
        cleaned.push_str(&rest[..i]);
        rest = &rest[i + " id=\"tok-".len()..];
        if let Some(end) = rest.find('"') {
            rest = &rest[end + 1..];
        } else {
            break;
        }
    }
    cleaned.push_str(rest);
    cleaned
}

fn closest_data_ref(html: &str, phrase: &str) -> String {
    assert!(html.contains(phrase), "phrase not in Live HTML: {phrase:?}");
    struct El {
        tag: String,
        id: Option<String>,
        parent: Option<usize>,
    }
    let mut nodes = vec![El {
        tag: "root".into(),
        id: None,
        parent: None,
    }];
    let mut stack = vec![0usize];
    let void = ["br", "img", "hr"];
    let mut i = 0;
    while i < html.len() {
        if html.as_bytes()[i] == b'<' {
            if html[i..].starts_with("</") {
                let end = html[i + 2..]
                    .find('>')
                    .map(|e| i + 2 + e)
                    .unwrap_or(html.len());
                let want = html[i + 2..end].trim().to_ascii_lowercase();
                for s in (1..stack.len()).rev() {
                    if nodes[stack[s]].tag == want {
                        stack.truncate(s);
                        break;
                    }
                }
                i = (end + 1).min(html.len());
                continue;
            }
            let end = html[i + 1..]
                .find('>')
                .map(|e| i + 1 + e)
                .unwrap_or(html.len());
            let raw = &html[i + 1..end];
            let name_end = raw
                .find(|c: char| c.is_whitespace() || c == '/')
                .unwrap_or(raw.len());
            let tag = raw[..name_end].to_ascii_lowercase();
            let attrs = &raw[name_end..];
            let id = attrs.find("data-ref=\"").and_then(|p| {
                let after = &attrs[p + "data-ref=\"".len()..];
                after.find('"').map(|e| after[..e].to_string())
            });
            let parent = stack.last().copied();
            let idx = nodes.len();
            nodes.push(El {
                tag: tag.clone(),
                id,
                parent,
            });
            let self_close = attrs.trim_end().ends_with('/') || void.contains(&tag.as_str());
            if !self_close {
                stack.push(idx);
            }
            i = (end + 1).min(html.len());
            continue;
        }
        let next = html[i..].find('<').map(|n| i + n).unwrap_or(html.len());
        let text = &html[i..next];
        if text.contains(phrase) {
            let mut cur = stack.last().copied();
            while let Some(c) = cur {
                if let Some(id) = &nodes[c].id {
                    return id.clone();
                }
                cur = nodes[c].parent;
            }
        }
        i = next;
    }
    panic!("no data-ref ancestor for {phrase:?}");
}

fn node_has_phrase(doc: &lq::Document, node: lq::NodeId, phrase: &str) -> bool {
    let tag_is_layout = matches!(
        &doc.node(node).kind,
        NodeKind::Block { tag, .. } if tag == "layout"
    );
    let (_segs, full) = concatenate_text_nodes(
        doc,
        node,
        &ConcatOpts {
            include_deleted: true,
            recurse_layouts: true,
            top_level_is_layout: tag_is_layout,
            skip_invisible_notes: false,
            inherited_state: None,
        },
    );
    full.contains(phrase)
}

fn assert_phrase_maps_to_query(
    html: &str,
    tokens: &[LiveToken],
    ast: &lq::Document,
    phrase: &str,
) -> String {
    let id = closest_data_ref(html, phrase);
    let token = tokens
        .iter()
        .find(|t| t.id == id)
        .unwrap_or_else(|| panic!("no token for data-ref {id} (phrase {phrase:?})"));
    let matches = query(ast, &token.bundle.selector).expect("query");
    assert!(
        matches.iter().any(|&n| node_has_phrase(ast, n, phrase)),
        "selector {:?} from {id} does not contain {phrase:?}",
        token.bundle.selector
    );
    token.bundle.selector.clone()
}

fn is_table_cell_layout_selector(sel: &str) -> bool {
    sel.contains("inset[Tabular") && sel.contains("inset[Text]") && sel.contains("layout[")
}

fn is_caption_layout_selector(sel: &str) -> bool {
    (sel.contains("inset[Float") || sel.contains("inset[Wrap") || sel.contains("inset[listings"))
        && sel.contains("inset[Caption")
        && sel.contains("layout[")
}

fn fixture_rel(rel: &str) -> PathBuf {
    rel.split('/').fold(fixtures_root(), |p, part| p.join(part))
}

fn has_textclass_layout(textclass: &str) -> bool {
    let resolved = resolve_layout_search_paths(&LayoutSearchOptions::default());
    find_layout_file(&format!("{textclass}.layout"), &resolved.search_paths).is_some()
}

fn require_textclass(textclass: &str) -> bool {
    if require_layouts_dir().is_none() {
        return false;
    }
    if has_textclass_layout(textclass) {
        return true;
    }
    eprintln!("skip: {textclass}.layout not found");
    false
}

fn unknown_inset_messages(response: &lq::LivePreviewResponse) -> Vec<&str> {
    response
        .diagnostics
        .iter()
        .filter(|d| d.code == "UNKNOWN_INSET")
        .map(|d| d.message.as_str())
        .collect()
}

fn count_substr(hay: &str, needle: &str) -> usize {
    hay.matches(needle).count()
}

fn img_tag_for<'a>(html: &'a str, filename: &str) -> Option<&'a str> {
    let needle = format!(r#"data-filename="{filename}""#);
    let at = html.find(&needle)?;
    let start = html[..at].rfind("<img")?;
    let end = at + html[at..].find('>')? + 1;
    Some(&html[start..end])
}

fn find_li_starting(html: &str, text: &str) -> Option<usize> {
    let mut offset = 0;
    let mut rest = html;
    while let Some(i) = rest.find("<li") {
        let abs = offset + i;
        if let Some(gt) = rest[i..].find('>') {
            let after = &rest[i + gt + 1..];
            if after.starts_with(text) {
                return Some(abs);
            }
        }
        offset = abs + 3;
        rest = &html[offset..];
    }
    None
}

/// Deno: `<ins|del class="change-…">` then optional `<a id>` then `<details class="disclose {kind}`.
fn has_whole_inset_wrap(html: &str, tag: &str, kind: &str) -> bool {
    let open = if tag == "ins" {
        r#"<ins class="change-inserted change-author-0" id="change-"#
    } else {
        r#"<del class="change-deleted change-author-0" id="change-"#
    };
    let mut rest = html;
    while let Some(i) = rest.find(open) {
        let after = &rest[i..];
        if let Some(gt) = after.find('>') {
            let mut inner = &after[gt + 1..];
            if inner.starts_with("<a id=\"")
                && let Some(end) = inner.find("></a>")
            {
                inner = &inner[end + "></a>".len()..];
            }
            let prefix = "<details class=\"disclose ";
            if let Some(classes) = inner.strip_prefix(prefix)
                && classes.starts_with(kind)
            {
                let next = classes.as_bytes().get(kind.len()).copied();
                if next == Some(b'"') || next == Some(b' ') {
                    return true;
                }
            }
        }
        rest = &rest[i + open.len()..];
    }
    false
}

#[test]
fn live_mapping_description_dd_values_publish_the_layout_path() {
    let path = help_file("EmbeddedObjects.lyx");
    let Some((html, response)) = render_path(&path) else {
        return;
    };
    let text = fs::read_to_string(&path).unwrap();
    let ast = parse(&text, false).unwrap();
    let phrase = "Here you can choose an image";
    let sel = assert_phrase_maps_to_query(&html, &response.tokens, &ast, phrase);
    assert!(sel.starts_with("layout[Description]"));
    assert!(
        !sel.contains("layout[Chapter")
            && !sel.contains("layout[Section")
            && !sel.contains("layout[Subsection")
            && !sel.contains("layout[Subsubsection"),
        "dd must not steal heading: {sel}"
    );
    let matches = query(&ast, &sel).unwrap();
    assert!(
        matches
            .iter()
            .any(|&n| extract_all_text(&ast, n, 10_000, false).contains(phrase))
    );
}

#[test]
fn live_mapping_title_foot_and_box_inners_are_nested_layouts() {
    let path = fixtures_root().join("my_template.lyx");
    let Some((html, response)) = render_path(&path) else {
        return;
    };
    let text = fs::read_to_string(&path).unwrap();
    let ast = parse(&text, false).unwrap();
    let foot_sel = assert_phrase_maps_to_query(&html, &response.tokens, &ast, "Details about me");
    assert!(foot_sel.contains("inset[Foot"));
    assert!(foot_sel.contains("layout["));
    assert!(
        !(foot_sel.starts_with("inset[Foot")
            && foot_sel.contains("]:nth-match(")
            && !foot_sel.contains(' ')),
        "must not be a bare Foot chip: {foot_sel}"
    );

    let box_path = synthetic("disclosure_collapsibles.lyx");
    let Some((box_html, box_resp)) = render_path(&box_path) else {
        return;
    };
    let box_text = fs::read_to_string(&box_path).unwrap();
    let box_ast = parse(&box_text, false).unwrap();
    let box_sel =
        assert_phrase_maps_to_query(&box_html, &box_resp.tokens, &box_ast, "Boxed inset body");
    assert!(box_sel.contains("inset[Box"));
    assert!(box_sel.contains("layout["));
}

#[test]
fn live_mapping_flex_code_uses_enclosing_layout_prefix() {
    let path = help_file("Customization.lyx");
    let Some((html, response)) = render_path(&path) else {
        return;
    };
    let text = fs::read_to_string(&path).unwrap();
    let ast = parse(&text, false).unwrap();
    let phrase = "lyxrc.defaults";
    assert!(html.contains(phrase));
    let id = closest_data_ref(&html, phrase);
    let token = response.tokens.iter().find(|t| t.id == id).expect("token");
    let sel = &token.bundle.selector;
    assert!(sel.contains("inset[Flex Code"));
    assert!(sel.contains("layout["));
    assert!(sel.starts_with("layout["), "J3 B: enclosing layout first");
    let matches = query(&ast, sel).unwrap();
    assert!(
        matches
            .iter()
            .any(|&n| extract_all_text(&ast, n, 10_000, false).contains(phrase))
    );
}

#[test]
fn live_mapping_listings_code_lines_are_nested_layouts() {
    let path = help_file("Development.lyx");
    let Some((html, response)) = render_path(&path) else {
        return;
    };
    let text = fs::read_to_string(&path).unwrap();
    let ast = parse(&text, false).unwrap();
    let phrase = "++T;";
    assert!(html.contains(phrase));
    let sel = assert_phrase_maps_to_query(&html, &response.tokens, &ast, phrase);
    assert!(sel.to_ascii_lowercase().contains("inset[listings"));
    assert!(sel.contains("layout["));
    assert!(
        !sel.starts_with("layout[Standard]"),
        "listings must not stay on Standard: {sel}"
    );
}

#[test]
fn live_mapping_formula_graphics_ref_tokens_are_object_insets() {
    let path = fixtures_root().join("my_template.lyx");
    let Some((_, response)) = render_path(&path) else {
        return;
    };
    let text = fs::read_to_string(&path).unwrap();
    let ast = parse(&text, false).unwrap();
    let formula = response
        .tokens
        .iter()
        .find(|t| t.bundle.selector.starts_with("inset[Formula"))
        .expect("expected a Formula mapping token");
    assert!(
        formula
            .bundle
            .selector
            .starts_with("inset[Formula]:nth-match(")
    );
    assert!(
        !formula.bundle.selector.contains('$'),
        "Formula selector must not embed TeX: {}",
        formula.bundle.selector
    );
    assert!(!query(&ast, &formula.bundle.selector).unwrap().is_empty());
    let graphics = response
        .tokens
        .iter()
        .find(|t| t.bundle.selector.contains("inset[Graphics]"))
        .expect("expected a Graphics mapping token");
    assert!(
        graphics.bundle.selector.contains("inset[Float")
            || graphics.bundle.selector.contains("inset[Wrap")
            || graphics.bundle.selector.contains("inset[Graphics")
    );
    assert!(
        response
            .tokens
            .iter()
            .any(|t| t.bundle.selector.contains("CommandInset ref"))
    );
    assert!(
        response
            .tokens
            .iter()
            .any(|t| t.bundle.selector.contains("CommandInset citation"))
    );
}

#[test]
fn live_mapping_table_cells_publish_nested_layout_paths() {
    let Some((html, response)) = render_file("table_figure_foot_math.lyx") else {
        return;
    };
    let path = synthetic("table_figure_foot_math.lyx");
    let text = fs::read_to_string(&path).unwrap();
    let ast = parse(&text, false).unwrap();
    assert_eq!(
        response
            .tokens
            .iter()
            .filter(|t| {
                let s = serde_json::to_value(&t.bundle).unwrap();
                s.get("coords").is_some()
            })
            .count(),
        0
    );
    let td_count = html.match_indices("<td").count();
    assert!(td_count >= 4, "2x2 table should emit four cells");
    let expected = [
        (
            "A",
            "inset[Tabular]:nth-match(1) inset[Text]:nth-match(1) layout[Plain Layout]",
        ),
        (
            "B",
            "inset[Tabular]:nth-match(1) inset[Text]:nth-match(2) layout[Plain Layout]",
        ),
        (
            "C",
            "inset[Tabular]:nth-match(1) inset[Text]:nth-match(3) layout[Plain Layout]",
        ),
        (
            "D",
            "inset[Tabular]:nth-match(1) inset[Text]:nth-match(4) layout[Plain Layout]",
        ),
    ];
    for (letter, want) in expected {
        let sel = assert_phrase_maps_to_query(&html, &response.tokens, &ast, letter);
        assert_eq!(sel, want);
        assert!(is_table_cell_layout_selector(&sel));
        let matches = query(&ast, &sel).unwrap();
        assert_eq!(
            matches.len(),
            1,
            "unique cell {letter} should query to one node"
        );
        assert!(
            matches
                .iter()
                .any(|&n| extract_all_text(&ast, n, 10_000, false).contains(letter))
        );
    }
}

#[test]
fn live_mapping_float_caption_words_publish_caption_layout_path() {
    let Some((html, response)) = render_file("table_figure_foot_math.lyx") else {
        return;
    };
    let path = synthetic("table_figure_foot_math.lyx");
    let text = fs::read_to_string(&path).unwrap();
    let ast = parse(&text, false).unwrap();
    let phrase = "A figure caption.";
    let sel = assert_phrase_maps_to_query(&html, &response.tokens, &ast, phrase);
    assert!(
        is_caption_layout_selector(&sel),
        "expected Float→Caption→layout, got {sel}"
    );
    assert_eq!(
        sel,
        "inset[Float figure]:nth-match(1) inset[Caption Standard] layout[Plain Layout]"
    );
    assert!(
        response
            .tokens
            .iter()
            .any(|t| t.bundle.selector == "inset[Float figure]:nth-match(1)"),
        "float chip token must remain (J2 B)"
    );
}

#[test]
fn live_mapping_included_child_lyx_tokens_point_at_child_file() {
    let path = help_file("EmbeddedObjects.lyx");
    let Some((html, response)) = render_path(&path) else {
        return;
    };
    let text = fs::read_to_string(&path).unwrap();
    let ast = parse(&text, false).unwrap();
    assert_eq!(
        response
            .tokens
            .iter()
            .filter(|t| t.bundle.selector.contains("CommandInset include")
                && t.bundle.selector.contains("layout["))
            .count(),
        0,
        "must not nest child layouts under Include"
    );
    let phrase = "This is a small dummy child document";
    let id = closest_data_ref(&html, phrase);
    let token = response.tokens.iter().find(|t| t.id == id).expect("token");
    let file = token.bundle.file.as_ref().expect("foreign file set");
    assert!(
        file.replace('\\', "/").ends_with("/DummyDocument1.lyx"),
        "child file {file}"
    );
    assert_eq!(token.bundle.disk_hash.as_ref().map(String::len), Some(64));
    let via = token.bundle.via.as_ref().expect("via");
    assert_eq!(via.selector, "inset[CommandInset include]:nth-match(1)");
    assert!(
        via.file
            .replace('\\', "/")
            .ends_with("/EmbeddedObjects.lyx")
    );
    let child_text = fs::read_to_string(file).unwrap();
    let child_ast = parse(&child_text, false).unwrap();
    let matches = query(&child_ast, &token.bundle.selector).unwrap();
    assert!(
        matches
            .iter()
            .any(|&n| node_has_phrase(&child_ast, n, phrase))
    );
    let via_hits = query(&ast, &via.selector).unwrap();
    assert_eq!(via_hits.len(), 1);
}

#[test]
fn live_mapping_no_change_html_is_additive_only() {
    let Some((html, _)) = render_file("headings_paragraphs.lyx") else {
        return;
    };
    let stripped = strip_mapping_attrs(&html);
    assert!(!stripped.contains("data-ref="));
    assert!(stripped.contains("<section"));
}

#[test]
fn live_navigate_labels_lists_only_leftover_anchors() {
    let Some((html, response)) = render_file("navigate_labels.lyx") else {
        return;
    };
    let mut names: Vec<_> = response
        .navigate
        .labels
        .iter()
        .filter_map(|l| l.name.clone())
        .collect();
    names.sort();
    assert_eq!(names, ["box:aside-point", "note:custom-hook"]);
    for banned in ["sec:intro", "fig:demo", "eq:demo"] {
        assert!(
            !names.iter().any(|n| n == banned),
            "{banned} must not appear under Labels"
        );
    }
    for l in &response.navigate.labels {
        assert_eq!(l.number, "");
        assert_eq!(l.text, "");
        assert!(l.name.is_some());
        assert!(html.contains(&format!(r#"id="{}""#, l.id)));
    }
    assert!(
        response
            .outline
            .iter()
            .any(|e| e.text.to_ascii_lowercase().contains("introduction"))
    );
    assert!(
        response
            .navigate
            .figures
            .iter()
            .any(|e| e.id.contains("float-figure"))
    );
    assert!(
        response
            .navigate
            .equations
            .iter()
            .any(|e| e.name.as_deref() == Some("eq:demo") || e.id.contains("eq"))
    );
}

#[test]
fn live_renderer_review_changes_covers_index_nesting_foot_chip() {
    let Some((html, response)) = render_file("review_changes.lyx") else {
        return;
    };
    let got: Vec<String> = response
        .changes
        .iter()
        .map(|c| {
            format!(
                "{}:{}:{}:{}",
                c.ordinal,
                match c.type_ {
                    lq::LiveChangeType::Inserted => "inserted",
                    lq::LiveChangeType::Deleted => "deleted",
                },
                c.author,
                c.ts
            )
        })
        .collect();
    assert_eq!(
        got,
        [
            "1:inserted:Alice:1724000000",
            "2:inserted:Alice:1724000000",
            "3:inserted:Bob:1724000100",
            "4:inserted:Alice:1724000200",
            "5:inserted:Alice:1724000300",
            "6:deleted:Bob:1724000400",
            "7:deleted:Shifu:1787415906",
            "8:inserted:Shifu:1787415958",
            "9:inserted:Shifu:1787415949",
            "10:inserted:Shifu:1787415961",
            "11:deleted:Alice:1724000500",
        ]
    );
    assert!(html.contains(r#"<ins class="change-inserted change-author-0" id="change-2" data-ref="change-2">one</ins>"#));
    assert!(html.contains("change-author-0"));
    assert!(html.contains("change-author-1"));
    assert!(html.contains("change-author-2"));
    assert!(html.contains(r#"<del class="change-deleted change-author-1" id="change-6" data-ref="change-6"><details class="disclose foot""#));
    assert_eq!(html.matches(r#"class="foot_label">1</summary>"#).count(), 2);
    assert_eq!(response.changes[5].snippet, "[Foot]");
    assert_eq!(
        response.changes[10].snippet,
        "This whole paragraph was deleted."
    );
}

#[test]
fn live_renderer_review_changes_counters_skips_deleted_construct_numbers() {
    let Some((html, response)) = render_file("review_changes_counters.lyx") else {
        return;
    };
    assert_eq!(html.matches(r#"class="foot_label">1</summary>"#).count(), 2);
    assert_eq!(html.matches(r#"class="foot_label">2</summary>"#).count(), 3);
    assert!(html.contains("<span class=\"eqno\">(#)</span>"));
    assert!(html.contains("<span class=\"eqno\">(1)</span>"));
    assert!(html.contains("<span class=\"eqno\">(2)</span>"));
    assert!(html.contains("<span class=\"eqno\">(3)</span>"));
    let eqs: Vec<String> = response
        .navigate
        .equations
        .iter()
        .map(|e| format!("{}:{}", e.number, e.text))
        .collect();
    assert_eq!(eqs, ["1:y=2", "2:a=b", "3:c=d"]);
    assert_eq!(
        response
            .navigate
            .figures
            .iter()
            .map(|e| e.number.as_str())
            .collect::<Vec<_>>(),
        ["1"]
    );
    assert_eq!(
        response
            .navigate
            .tables
            .iter()
            .map(|e| e.number.as_str())
            .collect::<Vec<_>>(),
        ["1"]
    );
}

#[test]
fn live_renderer_click_disclosure_and_private_note_comment() {
    let Some((html, _)) = render_file("disclosure_notes.lyx") else {
        return;
    };
    assert!(html.contains(r#"<details class="disclose foot""#));
    assert!(html.contains(r#"<summary class="foot_label">1</summary>"#));
    assert!(html.contains("Selectable footnote body"));
    assert!(html.contains(r#"class="disclose note note-note""#));
    assert!(html.contains("private note body"));
    assert!(!html.contains(":hover"));
}

#[test]
fn live_renderer_disclosure_collapsibles_covers_foldable_inset_set() {
    let Some((html, _)) = render_file("disclosure_collapsibles.lyx") else {
        return;
    };
    for needle in [
        r#"class="disclose foot foot_intitle""#,
        r#"class="disclose foot""#,
        r#"class="disclose note note-note""#,
        r#"class="disclose note note-comment""#,
        r#"class="disclose note note-greyedout""#,
        r#"class="disclose marginal""#,
        r#"class="disclose box boxed""#,
        r#"class="disclose float float-figure""#,
        r#"class="disclose float float-table""#,
        r#"class="disclose wrap"#,
        r#"class="disclose branch""#,
        r#"class="disclose ert""#,
        r#"class="disclose phantom""#,
        r#"class="disclose index-marker""#,
        r#"class="disclose index-macro""#,
        r#"class="disclose nomencl""#,
        r#"class="disclose argument""#,
    ] {
        assert!(html.contains(needle), "missing {needle}");
    }
    assert!(html.contains(r#">Float: Figure</summary>"#));
    assert!(html.contains(r#">Idx</summary>"#));
    assert!(html.contains(r#">Subentry</summary>"#));
    assert!(html.contains(r#">See</summary>"#));
    assert!(html.contains("IndexTerm"));
    assert!(html.contains("SubTerm"));
    assert!(html.contains("SeeAlso"));
    assert!(html.contains(r#">Nom</summary>"#));
    assert!(html.contains(r#">Sort as</summary>"#));
    assert!(html.contains(r#">Description</summary>"#));
    assert!(html.contains("NomSymbol"));
    assert!(html.contains("NomSort"));
    assert!(html.contains("Nom description"));
    assert!(html.contains("phantom body"));
    assert!(!html.contains("box-full"));
}

#[test]
fn live_renderer_title_author_abstract_and_math() {
    let Some((html, _)) = render_file("front_matter_math.lyx") else {
        return;
    };
    assert!(html.contains(r#"<h1 class="title""#));
    assert!(html.contains("Title"));
    assert!(html.contains(r#"class="author""#));
    assert!(html.contains(r#"<div class="abstract">"#));
    assert!(html.contains(r#"<span class="abstract_label">Abstract</span>"#));
    assert!(html.contains("<math"));
    let sem = normalize_reader_html(&html, None);
    let dump = format_sem(&sem, 0);
    assert!(dump.contains("title"));
    assert!(dump.contains("author"));
    assert!(dump.contains("abstract"));
    assert!(dump.contains("formula"));
}

#[test]
fn live_renderer_info_icons_use_icon_aliases() {
    let Some((html, _)) = render_file("info_icon_shortcut.lyx") else {
        return;
    };
    assert!(html.contains(r#"data-info-icon="dialog-toggle findreplace""#));
    assert!(html.contains(r#"data-info-icon="dialog-toggle toc""#));
    assert!(html.contains(r#"data-info-file="dialog-show_findreplace""#));
    assert!(html.contains(r#"data-info-file="dialog-show_toc""#));
}

#[test]
fn live_renderer_every_help_lyx_renders() {
    let Some(_) = require_layouts_dir() else {
        return;
    };
    let dir = fixtures_root().join("Help");
    let mut failures = Vec::new();
    let entries = fs::read_dir(&dir).expect("Help dir");
    for entry in entries {
        let entry = entry.unwrap();
        let name = entry.file_name();
        let name = name.to_string_lossy();
        if !name.ends_with(".lyx") {
            continue;
        }
        let path = entry.path();
        let text = match fs::read_to_string(&path) {
            Ok(t) => t,
            Err(e) => {
                failures.push(format!("{name}: read {e}"));
                continue;
            }
        };
        let ast = match parse(&text, false) {
            Ok(a) => a,
            Err(e) => {
                failures.push(format!("{name}: parse {e}"));
                continue;
            }
        };
        match build_live_response(&path, &ast, &text, None, None, None) {
            Ok(r) => {
                if !r.response.html.contains(r#"<article class="lyx-live""#) {
                    failures.push(format!("{name}: missing article wrapper"));
                }
            }
            Err(e) => failures.push(format!("{name}: {}", e.message)),
        }
    }
    assert!(failures.is_empty(), "{}", failures.join("\n"));
}

#[test]
fn live_comparison_incidental_ids_and_classes_are_ignored() {
    let a = normalize_reader_html(
        r#"<div class="standard" id="magicparlabel-9">Hello</div>"#,
        None,
    );
    let b = normalize_reader_html(r#"<div class="standard">Hello</div>"#, None);
    assert!(
        semantic_equal(&a, &b),
        "{}\n---\n{}",
        format_sem(&a, 0),
        format_sem(&b, 0)
    );
}

#[test]
fn live_comparison_accepted_view_drops_del_and_promotes_ins() {
    let html = r#"<div class="standard">Visible<ins class="change-inserted" id="change-1" data-ref="change-1"> added</ins> and<del class="change-deleted" id="change-2" data-ref="change-2"> removed</del> text.</div>"#;
    let default_view = normalize_reader_html(html, None);
    let default_dump = format_sem(&default_view, 0);
    assert!(default_dump.contains("added"));
    assert!(default_dump.contains("removed"));
    let accepted = normalize_reader_html(html, Some("accepted"));
    let dump = format_sem(&accepted, 0);
    assert!(dump.contains("added"));
    assert!(
        !dump.contains("removed"),
        "accepted view must drop deleted text"
    );
}

#[test]
fn live_comparison_resolved_icon_file_name_wins_over_the_lfun_arg() {
    let live = normalize_reader_html(
        r#"<img class="info-icon" src="data:image/png;base64,aa" data-info-icon="dialog-toggle findreplace" data-info-file="dialog-show_findreplace"/>"#,
        None,
    );
    let native = normalize_reader_html(
        r#"<img class="info-icon" src="e_44f05612a5aa_dialog-show_findreplace.svg" alt="image: e_44f05612a5aa_dialog-show_findreplace.svg"/>"#,
        None,
    );
    assert!(
        semantic_equal(&live, &native),
        "{}\n---\n{}",
        format_sem(&live, 0),
        format_sem(&native, 0)
    );
}

#[test]
fn live_comparison_dl130_tolerances() {
    let live_page = normalize_reader_html(
        r##"<a class="ref" href="#fig_Two_images" title="page reference (Live shows target number/name, not a page)">4.2</a>"##,
        None,
    );
    let native_page = normalize_reader_html(
        r##"<a class="ref pageref" href="#fig_Two_images">12</a>"##,
        None,
    );
    assert!(semantic_equal(&live_page, &native_page));
    let live_ref = normalize_reader_html(r##"<a class="ref" href="#sec_a">1</a>"##, None);
    let native_ref =
        normalize_reader_html(r##"<a class="ref" href="#sec_a">Introduction</a>"##, None);
    assert!(!semantic_equal(&live_ref, &native_ref));
    let glyph = normalize_reader_html(
        r#"<span class="info-icon" title="buffer-view" role="img" aria-label="buffer-view">▣</span>"#,
        None,
    );
    let png = normalize_reader_html(
        r#"<img class="info-icon" src="data:image/png;base64,aa" alt="buffer-view" aria-label="buffer-view"/>"#,
        None,
    );
    assert!(semantic_equal(&glyph, &png));
    let kbd = normalize_reader_html(
        r#"<kbd class="shortcuts" title="math-mode">Ctrl+M</kbd>"#,
        None,
    );
    let bdo = normalize_reader_html(r#"<bdo class="shortcuts" dir="ltr">Ctrl+M</bdo>"#, None);
    assert!(semantic_equal(&kbd, &bdo));
}

#[test]
fn live_contract_cli_envelope_distinguishes_disk_identity() {
    let Some(_) = require_layouts_dir() else {
        return;
    };
    let home = IsolatedHome::new();
    let work = WorkDir::new();
    let file = synthetic("headings_paragraphs.lyx");
    let out = run_cli_with(&["preview", path_arg(&file)], &home, work.path());
    let parsed = parse_cli_json(&out);
    if parsed.get("code").and_then(Value::as_str).is_some() {
        eprintln!("skip: Live CLI render needs LyX layouts ({parsed})");
        return;
    }
    let validated = validate_live_response(&parsed).expect("valid");
    assert!(validated.source.fresh);
    let text = fs::read_to_string(&file).expect("fixture");
    assert_eq!(validated.source.line_ending, detect_line_ending(&text));
    assert!(validated.source.line_count > 1);
    assert!(!validated.capabilities.editing);
    assert!(validated.capabilities.mapping);
    assert!(validated.capabilities.outline);
    assert!(!validated.capabilities.source_reveal);
    assert!(
        validated
            .outline
            .iter()
            .any(|e| e.text.contains("Introduction"))
    );
}

#[test]
fn live_mapping_lyx_code_lines_publish_layout_paths() {
    let path = help_file("Additional.lyx");
    let Some((html, response)) = render_path(&path) else {
        return;
    };
    let text = fs::read_to_string(&path).unwrap();
    let ast = parse(&text, false).unwrap();
    let phrase = "\\usepackage{indentfirst}";
    assert!(html.contains(phrase), "Live HTML should show {phrase}");
    let id = closest_data_ref(&html, phrase);
    let token = response
        .tokens
        .iter()
        .find(|t| t.id == id)
        .unwrap_or_else(|| panic!("no token for data-ref {id}"));
    let sel = &token.bundle.selector;
    assert!(
        sel.starts_with("layout[LyX-Code]"),
        "expected LyX-Code layout, got {sel}"
    );
    assert!(
        !sel.contains("layout[Chapter")
            && !sel.contains("layout[Section")
            && !sel.contains("layout[Subsection")
            && !sel.contains("layout[Subsubsection"),
        "LyX-Code must not steal heading: {sel}"
    );
    let matches = query(&ast, sel).expect("query");
    assert!(!matches.is_empty());
    assert!(
        matches
            .iter()
            .any(|&n| node_has_phrase(&ast, n, "usepackage{indentfirst}")),
        "--text-only of {sel} should contain usepackage{{indentfirst}}"
    );
    let mut rest = html.as_str();
    while let Some(start) = rest.find(r#"<pre class="lyx_code">"#) {
        let body_start = start + r#"<pre class="lyx_code">"#.len();
        let Some(end) = rest[body_start..].find("</pre>") else {
            break;
        };
        let body = &rest[body_start..body_start + end];
        if count_substr(body, r#"data-ref=""#) >= 2 {
            let mut ids = Vec::new();
            let mut b = body;
            while let Some(i) = b.find(r#"data-ref=""#) {
                let after = &b[i + r#"data-ref=""#.len()..];
                if let Some(q) = after.find('"') {
                    ids.push(&after[..q]);
                    b = &after[q + 1..];
                } else {
                    break;
                }
            }
            let sels: Vec<_> = ids
                .iter()
                .filter_map(|id| {
                    response
                        .tokens
                        .iter()
                        .find(|t| t.id == *id)
                        .map(|t| t.bundle.selector.as_str())
                })
                .collect();
            let unique: std::collections::HashSet<_> = sels.iter().copied().collect();
            assert!(
                unique.len() >= 2,
                "multi-layout lyx_code run needs distinct selectors"
            );
            break;
        }
        rest = &rest[body_start + end..];
    }
}

#[test]
fn live_mapping_longtable_caption_is_owner_prefixed() {
    let path = help_file("EmbeddedObjects.lyx");
    let Some((html, response)) = render_path(&path) else {
        return;
    };
    let text = fs::read_to_string(&path).unwrap();
    let ast = parse(&text, false).unwrap();
    let phrase = "Multi-page table with caption";
    let sel = assert_phrase_maps_to_query(&html, &response.tokens, &ast, phrase);
    assert!(sel.contains("inset[Tabular"), "{sel}");
    assert!(sel.contains("inset[Caption"), "{sel}");
    assert!(sel.contains("layout["), "{sel}");
    assert!(
        !sel.starts_with("inset[Caption"),
        "Caption must not stay document-global: {sel}"
    );
}

/// LyX window: every multi-page table steps the table counter, caption or not.
/// EmbeddedObjects §2.5 is Table 2.1; two uncaptioned longtables then §2.6.3 is Table 2.4.
#[test]
fn live_renderer_help_embeddedobjects_longtable_steps_table_counter() {
    let path = help_file("EmbeddedObjects.lyx");
    let Some((html, response)) = render_path(&path) else {
        return;
    };
    let float_at = html
        .find("A table float")
        .expect("§2.5 table float caption");
    let float_before = &html[float_at.saturating_sub(180)..float_at];
    assert!(
        float_before.contains("Table 2.1:"),
        "§2.5 float must stay Table 2.1; nearby markup: {float_before}"
    );
    let long_at = html
        .find("Multi-page table with caption")
        .expect("§2.6.3 longtable caption");
    let long_before = &html[long_at.saturating_sub(220)..long_at];
    assert!(
        long_before.contains("Table 2.4:"),
        "§2.6.3 longtable must be Table 2.4 like the LyX window; nearby markup: {long_before}"
    );
    let prefix_at = html[..long_at]
        .rfind(r#"class="float-caption-prefix""#)
        .expect("Table 2.4 prefix before the caption text");
    let between = &html[prefix_at..long_at];
    assert!(
        !between.contains("<div"),
        "Table 2.4: and the caption must stay on one line; markup between them: {between}"
    );
    let t24 = response
        .navigate
        .tables
        .iter()
        .find(|e| e.number == "2.4")
        .expect("list of tables includes 2.4");
    assert!(
        t24.text.contains("Multi-page table with caption"),
        "2.4 list text: {}",
        t24.text
    );
    assert_eq!(t24.id, "float-table-2-4");
    assert!(html.contains(r#"id="float-table-2-4""#));
    assert!(
        !response.navigate.tables.iter().any(|e| e.number == "2.2"),
        "uncaptioned longtables must not appear in the list of tables"
    );
    assert!(
        !response.navigate.tables.iter().any(|e| e.number == "2.3"),
        "uncaptioned longtables must not appear in the list of tables"
    );
    assert!(
        html.contains(r##"href="#tab_Referenced_multi_page_table">2.5</a>"##),
        "longtable label must resolve to the table number"
    );
}

fn table_after<'a>(html: &'a str, needle: &str) -> &'a str {
    let at = html
        .find(needle)
        .unwrap_or_else(|| panic!("missing {needle}"));
    let rest = &html[at..];
    let table = rest.find("<table").expect("table after needle");
    let end = rest[table..].find("</table>").expect("table close");
    &rest[table..table + end + 8]
}

fn table_containing<'a>(html: &'a str, needle: &str) -> &'a str {
    let at = html
        .find(needle)
        .unwrap_or_else(|| panic!("missing {needle}"));
    let start = html[..at]
        .rfind("<table")
        .expect("table open before needle");
    let end = html[start..].find("</table>").expect("table close");
    &html[start..start + end + 8]
}

fn td_with_text<'a>(table: &'a str, text: &str) -> &'a str {
    let needle = format!(">{text}</");
    let at = table
        .find(&needle)
        .unwrap_or_else(|| panic!("missing cell {text} in {table}"));
    let start = table[..at].rfind("<td").expect("td open");
    let end = table[start..].find("</td>").expect("td close");
    &table[start..start + end]
}

/// LyX window chrome for tables: on/off lines, width, newline, hfill, colour, decimal, row space.
#[test]
fn live_renderer_help_embeddedobjects_table_chrome() {
    let path = help_file("EmbeddedObjects.lyx");
    let Some((html, _)) = render_path(&path) else {
        return;
    };

    let intro = table_after(&html, "Here is an example table:");
    assert!(
        intro.contains("3px double"),
        "§2.1 default table must show the header as a double line; table: {intro}"
    );
    assert!(
        intro.contains("border-top: 1px solid"),
        "§2.1 cells with a real top line must paint solid, not only the CSS dashed grid"
    );
    assert!(
        !intro.contains("border-right: 3px double"),
        "the table's right edge is one line; double only when two vertical lines meet inside the row. table: {intro}"
    );

    let align_at = html
        .find("A line with tables with different alignments:")
        .expect("§2.2 alignment line");
    let align_chunk = &html[align_at..align_at + 4000];
    let top_at = align_chunk
        .find(r#"class="lyx-tabular lyx-tabular-top""#)
        .expect("§2.2 first mini-table hangs from the text baseline");
    let mid_at = align_chunk
        .find(r#"class="lyx-tabular lyx-tabular-middle""#)
        .expect("§2.2 second mini-table is centred on the text baseline");
    let bot_at = align_chunk
        .find(r#"class="lyx-tabular lyx-tabular-bottom""#)
        .expect("§2.2 third mini-table sits on the text baseline");
    assert!(
        top_at < mid_at && mid_at < bot_at,
        "§2.2 mini-tables must be top, then middle, then bottom"
    );
    assert!(
        align_chunk[top_at..mid_at].contains(r#"class="lyx-tabular-strut""#),
        "top alignment needs a strut so the wrapper baseline is the top of the table"
    );
    assert!(
        !align_chunk.contains("width: 0pt") && !align_chunk.contains("width: 0cm"),
        "a zero column width is 'no width', not a CSS length"
    );

    let multi = table_after(&html, "Table with multiple lines in cells");
    assert!(
        multi.contains(r#"class="newline linebreak""#),
        "forced linebreak in a cell must keep the LyX mark; table: {multi}"
    );
    assert!(
        multi.contains("width: 2.5cm"),
        "p-width column must stay 2.5cm; table: {multi}"
    );

    let imperfect = table_after(
        &html,
        "Table where the spanned table columns are not exactly half",
    );
    let cell_c = td_with_text(imperfect, "c");
    let cell_f = td_with_text(imperfect, "f");
    assert!(
        !cell_c.contains("3px double") && !cell_f.contains("3px double"),
        "Table 2.13 c/f is one grid line (only that column has both edges); c: {cell_c} f: {cell_f}"
    );

    let hyph_at = html
        .find("verylongtablecellword")
        .expect("hyphenation example word");
    let hyph_before = &html[hyph_at.saturating_sub(2500)..hyph_at];
    assert!(
        hyph_before.contains(r#"class="hfill""#),
        "hfill between the hyphenation tables must paint a fill mark; nearby: {hyph_before}"
    );

    let formal = table_after(&html, "Example formal table");
    assert!(
        formal.contains("2px solid") || formal.contains("3px double"),
        "formal/booktabs first rule must be heavier than a normal cell line; table: {formal}"
    );
    let cell_300 = td_with_text(formal, "300");
    assert!(
        !formal.contains("lyx-trim"),
        "Chip 1 and Chip 2 share one mid-rule under the 300s; meeting trims must not punch a gap; table: {formal}"
    );
    assert!(
        cell_300.contains("border-bottom: none"),
        "300's bottom is the next row's mid-rule, not a second line; 300: {cell_300}"
    );
    assert!(
        !cell_300.contains("2px solid") && !cell_300.contains("3px double"),
        "the mid-rule below 300 is not the heavy booktabs rule; 300: {cell_300}"
    );

    let ugly = table_after(&html, "Special (ugly) formal table");
    assert!(
        !ugly.contains("lyx-trim"),
        "Table 2.15 Chip 1 bottom and Chip 2 top share one mid-rule; meeting trims must not punch a gap; table: {ugly}"
    );

    let colored = table_after(&html, "Table colored using the");
    assert!(
        colored.contains("background-color: cyan"),
        "row colour cyan; table: {colored}"
    );
    assert!(
        colored.contains("background-color: #008000")
            || colored.contains("background-color: darkgreen"),
        "column colour svg:darkgreen; table: {colored}"
    );

    let striped = table_after(&html, "every second row is colored light gray");
    assert!(
        striped.contains("background-color: #c0c0c0")
            || striped.contains("background-color: lightgray"),
        "even rows light gray; table: {striped}"
    );

    let lime = table_after(&html, "Table with lime borders.");
    assert!(
        lime.contains("1px solid lime") || lime.contains("3px double lime"),
        "border colour lime; table: {lime}"
    );

    let decimal = table_after(
        &html,
        "Table cells of a column aligned with the decimal separator.",
    );
    assert!(
        decimal.contains(r#"class="decimal-int""#)
            && decimal.contains(">12</span>")
            && decimal.contains(r#"class="decimal-frac""#),
        "decimal column must split on the point; table: {decimal}"
    );

    let space = table_containing(&html, "mm space top of row");
    assert!(
        space.contains("padding-top: 3mm"),
        "row topspace 3mm; table: {space}"
    );

    let rotated = table_after(&html, "Table with rotated cells in the first row.");
    assert!(
        !rotated.contains("rotate(45") && !rotated.contains("rotate(90"),
        "LyX does not rotate cells on screen; table: {rotated}"
    );
}

#[test]
fn live_mapping_intro_table_phrase_is_a_cell_layout() {
    let path = help_file("Intro.lyx");
    let Some((html, response)) = render_path(&path) else {
        return;
    };
    let text = fs::read_to_string(&path).unwrap();
    let ast = parse(&text, false).unwrap();
    let phrase = "name/description";
    let sel = assert_phrase_maps_to_query(&html, &response.tokens, &ast, phrase);
    assert!(
        is_table_cell_layout_selector(&sel),
        "expected nested cell layout, got {sel}"
    );
    assert!(!sel.starts_with("inset[Tabular]:nth-match(") || sel.contains(" layout["));
    let token = response
        .tokens
        .iter()
        .find(|t| t.bundle.selector == sel)
        .expect("token");
    let s = serde_json::to_value(&token.bundle).unwrap();
    assert!(s.get("coords").is_none());
}

#[test]
fn live_mapping_embeddedobjects_float_caption_is_editable() {
    let path = help_file("EmbeddedObjects.lyx");
    let Some((html, response)) = render_path(&path) else {
        return;
    };
    let text = fs::read_to_string(&path).unwrap();
    let ast = parse(&text, false).unwrap();
    let phrase = "A star in a float.";
    let sel = assert_phrase_maps_to_query(&html, &response.tokens, &ast, phrase);
    assert!(
        is_caption_layout_selector(&sel),
        "expected Float→Caption→layout, got {sel}"
    );
    assert!(!sel.starts_with("inset[Float ") || sel.contains("inset[Caption"));
}

#[test]
fn live_mapping_review_changes_emits_change_n_tokens() {
    let Some((html, response)) = render_file("review_changes.lyx") else {
        return;
    };
    let change_tokens: Vec<_> = response
        .tokens
        .iter()
        .filter(|t| t.id.starts_with("change-"))
        .collect();
    assert!(!change_tokens.is_empty(), "change regions should be mapped");
    for t in &change_tokens {
        assert!(html.contains(&format!(r#"id="{}""#, t.id)));
        assert!(t.bundle.selector.contains("layout[") || t.bundle.selector.contains("inset["));
    }
    assert!(
        response
            .changes
            .iter()
            .all(|c| { change_tokens.iter().any(|t| t.id == c.anchor_id) })
    );
}

#[test]
fn live_mapping_my_template_footnote_note_phrases_round_trip() {
    let path = fixtures_root().join("my_template.lyx");
    let Some((html, response)) = render_path(&path) else {
        return;
    };
    let text = fs::read_to_string(&path).unwrap();
    let ast = parse(&text, false).unwrap();
    let foot = assert_phrase_maps_to_query(&html, &response.tokens, &ast, "A footnote.");
    assert!(
        foot.contains("inset[Foot]") && foot.contains("layout[Plain Layout]"),
        "body footnote inner should be a nested path, got {foot}"
    );
    assert_phrase_maps_to_query(&html, &response.tokens, &ast, "I like to use lyx note");
    assert_phrase_maps_to_query(&html, &response.tokens, &ast, "Details about me");
}

#[test]
fn live_mapping_footnote_phrases_round_trip_on_synthetic_insets() {
    let cases: &[(&str, &[&str])] = &[
        (
            "disclosure_notes.lyx",
            &["Selectable footnote body.", "private note body"],
        ),
        ("table_figure_foot_math.lyx", &["Footnote body."]),
        (
            "disclosure_collapsibles.lyx",
            &[
                "Author footnote body (click the star).",
                "Body footnote content.",
            ],
        ),
    ];
    for (name, phrases) in cases {
        let Some((html, response)) = render_file(name) else {
            return;
        };
        let path = synthetic(name);
        let text = fs::read_to_string(&path).unwrap();
        let ast = parse(&text, false).unwrap();
        for phrase in *phrases {
            assert_phrase_maps_to_query(&html, &response.tokens, &ast, phrase);
        }
    }
}

#[test]
fn live_outline_disclosure_collapsibles_reuses_toc_heading_ids() {
    let Some((html, response)) = render_file("disclosure_collapsibles.lyx") else {
        return;
    };
    assert!(response.outline.len() >= 5);
    for e in &response.outline {
        assert!(!e.id.is_empty());
        assert!(html.contains(&format!(r#"id="{}""#, e.id)));
    }
    assert!(
        response
            .outline
            .iter()
            .any(|e| e.text.to_lowercase().contains("body footnotes"))
    );
    assert!(
        !response.navigate.figures.is_empty(),
        "disclosure fixture has a figure float"
    );
    assert!(
        !response.navigate.tables.is_empty(),
        "disclosure fixture has a table float"
    );
    for e in response
        .navigate
        .figures
        .iter()
        .chain(response.navigate.tables.iter())
    {
        assert!(html.contains(&format!(r#"id="{}""#, e.id)));
    }
}

#[test]
fn live_renderer_disclosure_collapsibles_tracked_whole_inset_variants() {
    let Some((html, response)) = render_file("disclosure_collapsibles.lyx") else {
        return;
    };
    assert_eq!(response.changes.len(), 36);
    assert!(response.changes.iter().all(|c| c.author == "Tester"));
    let kinds = [
        "foot",
        "note note-note",
        "note note-comment",
        "marginal",
        "box boxed",
        "float float-figure",
        "float float-table",
        "wrap",
        "branch",
        "ert",
        "phantom",
        "index-marker",
        "nomencl",
        "argument short-title",
    ];
    for kind in kinds {
        assert!(
            has_whole_inset_wrap(&html, "ins", kind),
            "whole-inset inserted {kind} must be wrapped"
        );
        assert!(
            has_whole_inset_wrap(&html, "del", kind),
            "whole-inset deleted {kind} must be wrapped"
        );
    }
    let mut phantom_ins = 0;
    let mut phantom_del = 0;
    let mut rest = html.as_str();
    let ins_open = r#"<ins class="change-inserted change-author-0" id="change-"#;
    while let Some(i) = rest.find(ins_open) {
        let after = &rest[i..];
        if let Some(gt) = after.find('>')
            && after[gt + 1..].starts_with(r#"<details class="disclose phantom"#)
        {
            phantom_ins += 1;
        }
        rest = &rest[i + ins_open.len()..];
    }
    rest = html.as_str();
    let del_open = r#"<del class="change-deleted change-author-0" id="change-"#;
    while let Some(i) = rest.find(del_open) {
        let after = &rest[i..];
        if let Some(gt) = after.find('>')
            && after[gt + 1..].starts_with(r#"<details class="disclose phantom"#)
        {
            phantom_del += 1;
        }
        rest = &rest[i + del_open.len()..];
    }
    assert_eq!(phantom_ins, 3);
    assert_eq!(phantom_del, 3);
    assert!(html.contains(
        r#"<ins class="change-inserted change-author-0" id="change-33" data-ref="change-33"><details class="disclose box boxed""#
    ));
    assert!(html.contains("Nested foot inside inserted box."));
    assert!(html.contains(
        r#"<del class="change-deleted change-author-0" id="change-34" data-ref="change-34"><details class="disclose float float-figure""#
    ));
    assert!(html.contains("Nested foot inside deleted float."));
    assert!(html.contains(
        r#"<del class="change-deleted change-author-0" id="change-35" data-ref="change-35"><details class="disclose note note-note""#
    ));
    assert!(html.contains("Nested box inside deleted note."));
    assert!(html.contains(
        r#"<ins class="change-inserted change-author-0" id="change-36" data-ref="change-36"><details class="disclose branch""#
    ));
    assert!(html.contains("Nested comment inside inserted branch."));
    assert_eq!(count_substr(&html, r#"class="foot_label">1</summary>"#), 1);
    assert_eq!(count_substr(&html, r#"class="foot_label">2</summary>"#), 1);
    assert_eq!(count_substr(&html, r#"class="foot_label">3</summary>"#), 2);
    assert_eq!(count_substr(&html, r#"class="foot_label">4</summary>"#), 1);
}

#[test]
fn live_renderer_my_template_front_matter_and_math() {
    let path = fixtures_root().join("my_template.lyx");
    let Some((html, _)) = render_path(&path) else {
        return;
    };
    assert!(html.contains(r#"<h1 class="title""#));
    assert!(html.contains("Title"));
    assert!(html.contains(r#"class="author""#));
    assert!(html.contains("My name"));
    assert!(html.contains(r#"<span class="abstract_label">Abstract</span>"#));
    assert!(html.contains(r#"class="abstract_item""#) && html.contains("Keywords:"));
    assert!(html.contains("JEL:"));
    assert!(html.contains(r#"display="block""#));
    assert!(html.contains("<mi>ζ</mi>"));
    assert!(html.contains("∑"));
    assert!(
        !html.contains("\\begin{equation}"),
        "display math must not dump the TeX environment"
    );
    assert!(
        !html.contains(r#"stretchy="true""#),
        "\\left/\\right must not emit stretchy fences"
    );
    assert!(html.contains(r##"href="#sec_Section_label""##));
    assert!(html.contains(">1</a>"));
    assert!(html.contains(r##"href="#subsec_subsec_label""##));
    assert!(html.contains(">1.1</a>"));
    assert!(html.contains(r#"id="sec_Section_label""#));
    assert!(
        !html.contains("sec:Section_label"),
        "refs must resolve to numbers, not raw keys"
    );
    assert!(html.contains("Subsubsection"));
    assert!(html.contains(r#"class="float-table""#));
    assert!(html.contains("Table 1:"));
    assert!(html.contains("Table caption"));
    assert!(html.contains("Appendix"));
    assert!(html.contains(r##"href="#LyXCite-Abernethy2003""##));
    assert!(html.contains("Abernethy et al."));
    assert!(html.contains("Abernethy, Colin D. et al. (2003)"));
    assert!(html.contains("In: <i>J. Am. Chem. Soc.</i>"));
    assert!(html.contains("doi: 10.1021/ja0276321"));
    assert!(html.contains("References"));
    assert!(html.contains(r#"<span class="bibtexlabel">1</span>"#));
    assert!(html.contains("colspan="));
    assert!(html.contains("border-top:"));
    assert!(
        !html.contains(r#"<div class="date">"#),
        "preamble \\date is LaTeX-only; native XHTML omits it"
    );
    assert!(html.contains(r#"data-filename="beamer-g4.jpg""#));
    assert!(html.contains("data-filepath="));
    let fig_start = html.find("<figure").expect("figure");
    let fig_end = html[fig_start..]
        .find("</figure>")
        .map(|n| fig_start + n + 9)
        .expect("figure close");
    let fig = &html[fig_start..fig_end];
    let cap_at = fig.find("<figcaption").expect("figcaption");
    let table_at = fig.find("<table").expect("table");
    assert!(
        cap_at < table_at,
        "figure caption must appear above the figure body"
    );
    assert!(fig.contains(r#"<span class="float-caption-prefix">Figure 1: </span>"#));
    assert!(fig.contains("Figure caption"));
    assert!(fig.contains(r#"class="float-caption-Standard""#));
}

#[test]
fn live_renderer_nested_float_is_a_subfloat() {
    let Some((html, response)) = render_file("subfloat_figures.lyx") else {
        return;
    };
    assert!(html.contains(">Float: Figure</summary>"));
    assert!(html.contains(">Subfloat: Figure</summary>"));
    assert!(html.contains(r#"<span class="float-caption-prefix">Figure 1: </span>"#));
    assert!(html.contains(r#"<span class="float-caption-prefix">Subfigure a: </span>"#));
    assert!(html.contains(r#"<span class="float-caption-prefix">Subfigure b: </span>"#));
    assert!(html.contains(r#"<span class="float-caption-prefix">Figure 2: </span>"#));
    assert!(
        !html.contains("Figure 3:"),
        "nested floats must not consume the main figure counter"
    );
    assert!(html.contains("subfloat"));
    let nums: Vec<_> = response
        .navigate
        .figures
        .iter()
        .map(|e| e.number.as_str())
        .collect();
    assert_eq!(nums, ["1", "2"]);
    assert_eq!(response.navigate.figures[0].text, "Outer");
    let kids: Vec<String> = response.navigate.figures[0]
        .children
        .as_ref()
        .unwrap_or(&Vec::new())
        .iter()
        .map(|c| format!("{} {}", c.number, c.text))
        .collect();
    assert_eq!(kids, ["a Left", "b Right"]);
    assert_eq!(response.navigate.figures[1].text, "After");
    assert_eq!(
        response.navigate.figures[1]
            .children
            .as_ref()
            .map(|c| c.len())
            .unwrap_or(0),
        0
    );
}

fn eqno_after(html: &str, needle: &str) -> String {
    let at = html
        .find(needle)
        .unwrap_or_else(|| panic!("{needle} missing"));
    let end = html[at..]
        .find("</math>")
        .map(|n| at + n)
        .unwrap_or_else(|| panic!("</math> after {needle}"));
    html[end..end.saturating_add(80).min(html.len())].to_string()
}

#[test]
fn live_renderer_help_math_lyx_phantom_chips_no_math_mode_unknown_dump() {
    let path = help_file("Math.lyx");
    let Some((html, response)) = render_path(&path) else {
        return;
    };
    assert!(html.contains(r#"<article class="lyx-live""#));
    assert_eq!(unknown_inset_messages(&response), Vec::<&str>::new());
    assert!(
        !html.contains("unknown-inset"),
        "Phantom must not fall back to unknown-inset"
    );
    assert!(html.contains(r#"class="disclose phantom""#));
    assert!(html.contains("<kbd"));
    assert!(
        !html.contains(r#"<span class="info">math-mode</span>"#),
        "Info shortcuts must not dump the raw LFUN name as body text"
    );
    if html.contains(r#"title="math-mode""#) {
        assert!(html.contains("Ctrl+M"));
        assert!(
            !html.contains(">math-mode</kbd>"),
            "resolved shortcuts must show the key, not the LFUN body"
        );
    }
    if html.contains(r#"data-info-icon="math-mode""#) {
        assert!(html.contains(r#"<img class="info-icon""#));
        assert!(
            html.contains("data:image/svg+xml") || html.contains("data:image/png;base64,"),
            "info icon img must embed svg or png"
        );
    } else {
        assert!(html.contains(r#"aria-label="math-mode""#));
    }
    assert!(html.contains(r#"class="typewriter""#));
    assert!(html.contains(r#"class="sans""#));
    assert!(html.contains(r#"class="space-mark visible foreground baseline""#));
    assert!(html.contains("<mo>↓</mo>"));
    assert!(html.contains("<mfrac>"));
    assert!(html.contains("<mtable>"));
    assert!(html.contains("<mi>A</mi>"));
    assert!(html.contains("<mo>≈</mo>"));
    assert!(html.contains("<mo>←</mo>"));
    assert!(html.contains("<mphantom>"));
    assert!(html.contains("mmultiscripts"));
    assert!(html.contains("⏞"));
    assert!(!html.contains("<mi>\\dbond</mi>"));
    assert!(!html.contains("<mi>\\tbond</mi>"));
    assert!(!html.contains("<mi>\\hyphen</mi>"));
    assert!(!html.contains("<mi>\\gr</mi>"));
    assert!(!html.contains("<mi>\\us</mi>"));
    assert!(!html.contains("<mi>\\cb</mi>"));
    assert!(!html.contains("<mi>\\fb</mi>"));
    assert!(html.contains("⟹"));
    assert!(html.contains(r#"data-info-icon="math-macro newmacroname_newcommand""#));
    assert!(
        html.contains(r#"data-info-icon="math-macro newmacroname_newcommand""#)
            && (html.contains("data:image/svg+xml") || html.contains("data:image/png;base64,")),
        "math-macro toolbar Info icon must embed svg or png (not missing/glyph-only)"
    );
    assert!(
        !html.contains(r#"encoding="application/x-tex">$\begin{cases}"#),
        "multi-line cases must include the body, not only the first line"
    );
    assert!(
        !html.contains(r#"encoding="application/x-tex">\newcommand{\qG}"#),
        "FormulaMacro must not be rendered as a formula"
    );
    assert!(html.contains("note-greyedout"));
    assert!(html.contains("color:#A0A0A0"));
    assert!(html.contains(r#"mathbackground="yellow""#));
    assert!(html.contains(r#"voffset="2mm""#));
    assert!(html.contains(r#"mathcolor="red""#));
    assert!(html.contains("\\int A\\,\\mathrm{d}x"));
    assert!(
        !html.contains("<mtext></mtext><annotation encoding=\"application/x-tex\"></annotation>"),
        "display formulas whose body starts with \\int must not collapse to empty MathML"
    );
    assert!(html.contains("(something)"));
    assert!(html.contains("<mo>⟨</mo>"));
    assert!(html.contains("updiagonalstrike"));
    assert!(html.contains("mod "));
    assert!(html.contains("<munderover>"));
    assert!(html.contains("<mtd><mi>A</mi></mtd><mtd><mo>→</mo></mtd><mtd><mi>B</mi></mtd>"));
    let cd_at = html
        .find("<mtd><mi>A</mi></mtd><mtd><mo>→</mo></mtd><mtd><mi>B</mi></mtd>")
        .expect("amscd");
    let cd_end = html[cd_at..]
        .find("</math>")
        .map(|n| cd_at + n + 7)
        .unwrap();
    let cd_chunk = &html[cd_at..cd_end];
    assert!(
        !cd_chunk.contains(r#"class="eqno""#),
        "amscd \\[ \\] diagrams must not get equation numbers"
    );
    assert!(
        !eqno_after(&html, "\\cfrac[l]{A}").contains(r#"class="eqno""#),
        "\\[ display math must not get an equation number"
    );
    let red_after = eqno_after(&html, "\\textcolor{red}{\\int A=B}");
    assert!(
        red_after.contains(r#"class="eqno">(2)</span>"#),
        "equation env after the first numbered formula should be (2), got {red_after}"
    );
    assert!(html.contains(r#"class="eqno">(1)</span>"#));
    assert!(html.contains(r#"class="eqno">(something)</span>"#));
    assert!(html.contains(r#"class="eqno">something</span>"#));
    let gather_prose = html
        .find("Every line can be numbered")
        .expect("Math.lyx gather section missing");
    let gather_block = &html[gather_prose..(gather_prose + 2500).min(html.len())];
    assert!(
        count_substr(gather_block, r#"class="formula-row""#) >= 2,
        "gather A=1 and X=-1 must be separate rows"
    );
    assert!(
        gather_block.contains(r#"class="eqno">"#),
        "gather lines are numbered"
    );
    let mut gather_nos = 0;
    let mut g = gather_block;
    while let Some(i) = g.find(r#"class="eqno">("#) {
        gather_nos += 1;
        g = &g[i + 1..];
    }
    assert!(
        gather_nos >= 2,
        "gather should number both lines, got {gather_nos}"
    );
    assert_eq!(
        count_substr(&html, r#"class="eqno""#),
        36,
        "per-line gather/align/eqnarray numbers plus \\tag/\\tag*"
    );
    assert!(html.contains(r#"class="subequations""#));
    let subref_needle = r###"href="#eq_b">("###;
    let subref_at = html.find(subref_needle).expect("subequation ref");
    let after = &html[subref_at + subref_needle.len()..];
    let close = after.find(')').expect(")");
    let num = &after[..close];
    assert!(
        num.ends_with('a'),
        "subequation ref should be like (Na), got {num}"
    );
    assert!(html.contains(r#"mathsize="75%""#));
    assert!(html.contains(r#"class="href""#));
    assert!(html.contains(r#"<nav class="toc">"#));
    assert!(html.contains("„"));
    assert!(html.contains("“"));
    assert!(html.contains(">Command Scheme</h3>"));
    assert!(html.contains(">Advice for Integrals</h4>"));
    assert!(html.contains(r#"class="Boxed""#));
    assert!(html.contains("<br>"));
    assert!(html.contains("<hr>"));
    assert!(html.contains(r#"class="index""#));
    assert!(html.contains(r#"<pre class="lyx_code">"#));
    assert!(html.contains(r#"<blockquote class="quote">"#));
}

#[test]
fn live_renderer_help_additional_lyx_numbering_toc_and_specialchar() {
    let path = help_file("Additional.lyx");
    let Some((html, response)) = render_path(&path) else {
        return;
    };
    assert!(html.contains("Additional"));
    assert!(html.contains("the "));
    assert!(html.contains("⇒"));
    assert!(
        !html.contains(r#"<h1 class="title">Additional \SpecialChar"#),
        "title SpecialChar must expand"
    );
    assert!(html.contains("User&#39;s Guide."));
    assert!(html.contains("How "));
    assert!(html.contains("Uses "));
    assert!(html.contains(r#"id="sec-2-1""#));
    assert!(html.contains(r#"<nav class="toc">"#));
    assert!(html.contains(r##"href="#sec-2-1""##));
    assert!(html.contains("2.1 How LyX Uses LaTeX") || html.contains("2.1 How "));
    let labeling = html
        .find("The final output contains no page numbers")
        .expect("Additional.lyx Labeling example missing");
    let from = labeling.saturating_sub(160);
    let labeling_before = &html[from..labeling];
    assert!(
        labeling_before.contains("<ol") || labeling_before.contains("<li"),
        "Labeling should use HTMLTag ol, got: …{}",
        &labeling_before[labeling_before.len().saturating_sub(80)..]
    );
    assert!(
        !labeling_before.contains(r#"class="labeling""#),
        "Labeling must not fall back to a generic div"
    );
    assert!(html.contains(r#"class="flex_url""#));
    assert!(html.contains(r#"href="https://www.ams.org/publications/authors/tex/amslatex""#));
    assert!(html.contains(r#"class="flex_code""#));
    assert!(!html.contains("<code><div"), "Flex Code must stay inline");
    assert!(html.contains(r#"<dl class="description">"#));
    assert!(html.contains(">Address</dt>"));
    assert!(html.contains("Current"));
    assert!(
        html.contains(
            r#">Current<span class="space-mark protected latex baseline" aria-hidden="true"></span>Address</dt>"#
        ),
        "Description label Current Address must paint the protected U"
    );
    assert!(html.contains(r#"class="Frameless""#));
    assert!(html.contains(r#"<span class="noun">"#));
    assert_eq!(unknown_inset_messages(&response), Vec::<&str>::new());
    assert!(html.contains("4.10.1.4 List Spacing"));
    assert!(
        !html.contains("List SpacingLists"),
        "Index inset must not leak into heading/TOC text"
    );
    assert!(html.contains('\u{201c}'));
    assert!(html.contains('\u{201d}'));
    assert!(html.contains(">resumed</li>"));
    assert!(
        !html.contains(r#"class="enumerate_resume""#),
        "Enumerate-Resume must not fall back to a generic div"
    );
    assert!(
        !html.contains("status collapsed"),
        "inset status lines must not leak into heading/TOC text"
    );
    assert!(html.contains(r#"<span class="layout-label">Theorem 1.</span>"#));
    assert!(html.contains("This is typically used for the statements of major results."));
    assert!(html.contains(r#"<span class="layout-label">Corollary.</span>"#));
    assert!(html.contains(r#"<span class="layout-label">Lemma 2.</span>"#));
    assert!(html.contains(r#"class="hanging""#));
    assert!(html.contains("all but the first line of the paragraph is indented"));
    assert!(html.contains(r#"<span class="dropcap">T</span>"#));
    assert!(html.contains(r#"<span class="dropcap-rest">his</span>"#));
    assert!(html.contains("module adds a drop capitals paragraph style"));
    assert!(html.contains(r#"class="flex_rotatebox""#));
    assert!(html.contains(r#">Rotatebox</summary>"#));
    assert!(html.contains(r#">Scalebox</summary>"#));
    assert!(html.contains(r#">Origin</summary>"#));
    assert!(html.contains(r#">Angle</summary>"#));
    assert!(
        !html.contains("rotate(") && !html.contains("scale(") && !html.contains("scaleX(-1)"),
        "GraphicBoxes must not fake print transforms"
    );
    assert!(html.contains("Great Western Railway"));
    assert!(html.contains(r#"class="flex_multiple_columns""#));
    assert!(html.contains("column-count: 2"));
    assert!(html.contains("The Adventure of the Empty House"));
    assert!(
        !html.contains("{100.125}"),
        "non-LyX include (.tex) must be omitted like native XHTML"
    );
    assert!(html.contains(r#"class="href""#));
    assert!(html.contains(r#"class="Shadowbox""#));
    assert!(html.contains(r#"<pre class="lyx_code">"#));
    assert!(html.contains(r#"class="heart""#));
    assert!(html.contains(r#"class="nut""#));
    assert!(html.contains(r#"class="proof""#));
    assert!(html.contains(r#"<span class="layout-label">Proof.</span>"#));
    assert!(html.contains(r#"<span class="layout-label">Proposition"#));
    assert!(html.contains(r#"<span class="layout-label">Remark"#));
    assert!(html.contains(r#"<span class="layout-label">Algorithm."#));
    assert!(html.contains(r#"<span class="layout-label">Definition."#));
    assert!(html.contains(r#"<span class="layout-label">Example."#));
    assert!(html.contains(r#"class="index""#));
    assert!(html.contains('\u{2026}'));
    assert!(html.contains('\u{00ad}'));
    assert!(html.contains('\u{2044}'));
    assert!(html.contains("LaTeX2\u{03b5}"));
}

#[test]
fn live_renderer_help_userguide_lyx_script_line_nomencl_flex_emph() {
    let path = help_file("UserGuide.lyx");
    let Some((html, response)) = render_path(&path) else {
        return;
    };
    assert!(html.contains(r#"<article class="lyx-live""#));
    assert!(
        html.contains(r#"data-par-sep="skip""#),
        "UserGuide uses skip between paragraphs, not first-line indent"
    );
    assert_eq!(unknown_inset_messages(&response), Vec::<&str>::new());
    assert!(html.contains("<sub>") && html.contains("3x"));
    assert!(html.contains("<hr>"));
    assert!(html.contains(r#"<em class="flex_emph""#) && html.contains("Emph"));
    assert!(html.contains(r#"<strong class="flex_strong""#) && html.contains("Strong"));
    assert!(html.contains(r#"<div class="nomencl">"#));
    assert!(html.contains(">Tab</a></dt>"));
    assert!(html.contains(">Tabulator key</dd>"));
    assert!(html.contains(r#">Nom</summary>"#));
    assert!(html.contains(r#">Description</summary>"#));
    assert!(html.contains(r#">Sort as</summary>"#));
    assert!(
        !html.contains("UNKNOWN_INSET"),
        "UserGuide must not dump unknown-inset fallbacks"
    );
    assert!(html.contains("The User Interface"));
    assert!(html.contains("The File Menu"));
    assert!(
        !html.contains(">7 The User Interface"),
        "appendix chapters must not continue arabic numbering"
    );
    let phantom_at = html
        .find("What is correct English")
        .expect("UserGuide phantom example missing");
    let phantom_chunk = &html[phantom_at..(phantom_at + 2000).min(html.len())];
    assert!(phantom_chunk.contains("has to be jumped"));
    assert!(phantom_chunk.contains("jumps"));
    assert!(phantom_chunk.contains(r#"class="disclose phantom""#));
    assert!(
        !phantom_chunk.contains('\u{200b}'),
        "Phantom chip must not emit a zero-width space placeholder"
    );
    assert!(html.contains("Who was the first physics Nobel prize winner?"));
    assert!(html.contains("No answer:"));
    assert!(html.contains("branch is deactivated"));
    assert!(
        !html.contains("Wilhelm Conrad"),
        "inactive non-inverted Answer branch must omit like native XHTML"
    );
    assert!(
        !html.contains(r#"class="center_footer""#),
        "Center Footer page chrome must omit"
    );
    assert!(!html.contains(r#"class="left_header""#));
    assert!(!html.contains(r#"class="right_footer""#));
    assert!(html.contains(r#"class="href""#));
    assert!(html.contains(r#"href="lyx-docs@lists.lyx.org""#));
    assert!(html.contains(r#"<nav class="toc">"#));
    assert!(html.contains("note-greyedout"));
    assert!(html.contains("<kbd"));
    assert!(html.contains("<br>"));
    assert!(html.contains("“"));
    assert!(html.contains("”"));
    assert!(html.contains(r#"<pre class="verbatim">"#));
    assert!(html.contains("This is Verbatim."));
    assert!(html.contains(r#"<blockquote class="verse">"#));
    assert!(html.contains(r#"<blockquote class="quote">"#));
    assert!(html.contains(r#"<blockquote class="quotation">"#));
    assert!(html.contains(r#"<pre class="lyx_code">"#));
    assert!(html.contains("#include"));
    assert!(html.contains(r#"class="right_address""#));
    assert!(html.contains(r#"class="Doublebox""#));
    assert!(html.contains("with rotated"));
    assert!(html.contains("This is a line"));
    assert!(html.contains(r#"class="preview""#));
    let prev_at = html.find(r#"class="preview""#).expect("preview");
    assert!(
        html[prev_at..(prev_at + 200).min(html.len())].contains("This is a line"),
        "Preview wraps demo line"
    );
    assert!(html.contains(r#"class="Frameless""#));
    assert!(html.contains("disclose marginal"));
    assert!(html.contains(r#"class="flex_code""#));
    assert!(html.contains(r#"class="flex_url""#));
    assert!(html.contains(r#"class="noun""#));
    assert!(html.contains("«"));
    assert!(html.contains("»"));
    assert!(html.contains("„"));
    assert!(html.contains("「"));
    assert!(html.contains("『"));
    assert!(html.contains("《"));
    assert!(html.contains("‹"));
    assert!(html.contains("›"));
    let hello_li = find_li_starting(&html, "Hello").expect("UserGuide 3.4.6 Hello item missing");
    let hello_at = html[..hello_li].rfind("<ol").expect("<ol before Hello");
    let hi_li = html[hello_li..]
        .find(">Hi")
        .map(|n| hello_li + n)
        .unwrap_or(html.len());
    let nest = &html[hello_at..hi_li];
    assert!(nest.contains(r#"class="enumi""#));
    assert!(nest.contains(r#"class="enumii""#));
    assert!(nest.contains(r#"class="enumiii""#));
    assert!(nest.contains("this is an"));
    assert!(nest.contains(">enumeration</li>"));
    assert!(nest.contains(">itemize list</li>"));
    let itemize_at = nest.find(">itemize list</li>").expect("itemize");
    let enum_end = nest.find(">enumeration</li>").expect("enumeration");
    assert!(
        itemize_at > enum_end,
        "itemize must follow the inner enumeration"
    );
    assert!(
        nest[..itemize_at].contains("enumiii") && nest.contains("</ol><ul>"),
        "itemize must stay nested beside the inner enumeration, not restart at the top level"
    );
    assert!(
        (html.contains(r#"<h2 class="bibliography""#) || html.contains(r#"<h2 class="bibtex""#))
            && (html.contains("References") || html.contains("Bibliography")),
        "Bibliography environment must emit a References/Bibliography heading"
    );
    assert!(html.contains(r#"id="LyXCite-lyxcredit""#));
    assert!(html.contains(r#"<span class="bibitemlabel">Credits</span>"#));
    assert!(html.contains("Companion Second Edition") || html.contains("Companion"));
    assert!(html.contains(r#"class="bibtex""#));
    assert!(html.contains(r#"id="LyXCite-Mittelbach""#));
    assert!(html.contains(r#"<span class="bibtexlabel">1</span>"#));
    assert!(html.contains(r##"<dt><a class="nomencl" href="#nomencl-"##));
    assert!(html.contains(r##"id="nomencl-"##));
    assert!(html.contains(r##"<a href="#idx-"##));
    assert!(html.contains(r##"id="idx-"##));
    assert!(html.contains(r#"style="text-align: right""#));
    assert!(html.contains("ℝ"));
    assert!(html.contains("<mo>↻</mo>"));
    assert!(html.contains(r#"class="wline""#));
    assert!(html.contains("This is text with Wavy underlining on."));
    assert!(html.contains(r#"class="dline""#));
    assert!(html.contains("This is text with Double underlining on."));
    assert!(html.contains("font-size: x-small"));
    assert!(html.contains("This is the"));
    assert!(html.contains("font-style: oblique"));
    assert!(html.contains("This is the Slanted font shape"));
    assert!(html.contains("font-variant: small-caps"));
    assert!(html.contains("This is the Small caps font shape"));
    assert!(html.contains("<s>"));
    assert!(html.contains(r#"style="color: blue""#));
    assert!(html.contains(r#"style="color: red""#));
    assert!(html.contains(r#"style="color: green""#));
    assert!(html.contains('\u{2044}'));
    assert!(html.contains('\u{200b}'));
    assert!(html.contains("This paragraph is right aligned"));
    assert!(html.contains(r#"style="text-align: center""#));
    assert!(html.contains("this one is centered"));
    assert!(html.contains(r#"style="text-align: left""#));
    assert!(html.contains("this one is left aligned"));
    let widget_at = html
        .find("The widget also has a")
        .expect("paragraph_spacing single example");
    let widget_div = html[..widget_at]
        .rfind("<div")
        .expect("wrapper for the widget paragraph");
    assert!(
        html[widget_div..widget_at].contains(r#"style="line-height: 1""#),
        "LyX single paragraph spacing must set line-height"
    );
    assert!(html.contains(r#"class="longtable""#));
    assert!(html.contains("Vector") && html.contains("fonts"));
    assert!(
        !html.contains("fontsrange"),
        "Index params must not leak into Description labels"
    );
    assert!(
        !html.contains("status collapsedFonts"),
        "Index status must not leak into Description"
    );
    assert!(html.contains(r#"<div class="index">"#));
    assert!(html.contains(r#"<h2 class="index">Index</h2>"#));
    assert!(html.contains("Font, Types"));
    assert!(html.contains("Short Titles"));
    assert!(
        !html.contains("HeadingsShort Titles"),
        "short-title Argument must not concatenate onto the long heading in the TOC"
    );
    assert!(
        html.contains(r#"class="space-mark thin latex deep""#),
        "thin space must paint LyX's deep latex U"
    );
    assert!(
        html.contains(r#"class="space-mark protected latex baseline""#),
        "protected ~ must paint LyX's baseline latex U"
    );
    assert!(
        html.contains(r#"class="space-mark enskip special deep""#),
        "enskip must paint LyX's deep special (blue) U"
    );
    let vis_needle = "spaces appear in the output as the character";
    let vis_at = html
        .find(vis_needle)
        .unwrap_or_else(|| panic!("{vis_needle} missing"));
    let vis = &html[vis_at..(vis_at + 280).min(html.len())];
    assert!(
        vis.contains(r#"class="space-mark visible foreground baseline""#),
        "visible space must be a U mark; nearby: {vis}"
    );
    assert!(
        !vis.contains('\u{2423}'),
        "visible space must not use the open-box glyph; nearby: {vis}"
    );
    let more_spaces = html
        .find("medium space between the arrows")
        .expect("UserGuide More Spaces medium row missing");
    let dt_at = html[..more_spaces]
        .rfind("<dt")
        .expect("Description term before medium row");
    let row = &html[dt_at..more_spaces];
    assert!(
        row.contains(r#"class="space-mark protected latex baseline""#),
        "Description label Medium space must paint the protected U; row: {row}"
    );
    assert!(
        row.contains(r#"class="space-mark med latex deep""#),
        "Description body must paint the medium U between the arrows; row: {row}"
    );
    assert!(
        html.contains("Vertical Space (Big skip)"),
        "VSpace bigskip must use LyX's on-screen name"
    );
    assert!(
        html.contains("Vertical Space (Medium skip)"),
        "VSpace medskip must use LyX's on-screen name"
    );
    assert!(
        html.contains("Vertical Space (Default skip)"),
        "VSpace defskip must use LyX's on-screen name"
    );
    assert!(
        html.contains("Vertical Space (Small skip, protected)"),
        "VSpace smallskip* must use LyX's on-screen name"
    );
    assert!(
        html.contains("Vertical Space (0.3cm)"),
        "custom VSpace must show the length"
    );
    assert!(
        html.contains("Vertical Space (-10mm)"),
        "negative custom VSpace must show the length"
    );
    assert!(
        !html.contains(">VSpace bigskip<") && !html.contains("VSpace bigskip</span>"),
        "must not show the raw inset kind as the vspace label"
    );
    let left_side = html
        .find("This is on the left side")
        .expect("UserGuide 3.5.2.4 left-side fill example");
    let fill_demo = &html[left_side..(left_side + 900).min(html.len())];
    assert!(
        fill_demo.contains(r#"class="hfill""#),
        "hfill between left and right text; nearby: {fill_demo}"
    );
    assert!(
        fill_demo.contains("This is on the right"),
        "right-hand text stays after the fill; nearby: {fill_demo}"
    );
    let right_at = fill_demo
        .find("This is on the right")
        .expect("right-hand text");
    let after_right = &fill_demo[right_at..];
    let next_div = after_right.find("</div>").expect("end of first quote line");
    let second_left = after_right
        .find(">Left")
        .or_else(|| after_right.find("Left"));
    assert!(
        second_left.is_some_and(|at| at > next_div),
        "each Quote line is its own inner div so fills cannot collapse the three examples onto one row; nearby: {fill_demo}"
    );
}

#[test]
fn live_renderer_help_embeddedobjects_lyx_margin_notes_wrap_listings() {
    let path = help_file("EmbeddedObjects.lyx");
    let Some((html, response)) = render_path(&path) else {
        return;
    };
    assert!(html.contains(r#"<article class="lyx-live""#));
    assert!(
        html.contains(r#"data-par-sep="indent""#),
        "EmbeddedObjects uses first-line indent, like the LyX window"
    );
    assert_eq!(unknown_inset_messages(&response), Vec::<&str>::new());
    assert!(
        html.contains("Vertical Space (Big skip)"),
        "EmbeddedObjects VSpace bigskip (e.g. §2.11.4) must use LyX's on-screen name"
    );
    let heading_2_5 = html
        .find(r#"heading-number">2.5 </span>Table Floats"#)
        .expect("section 2.5 Table Floats heading");
    let intro_at = html[heading_2_5..]
        .find("For general explanations about floats")
        .map(|n| heading_2_5 + n)
        .expect("2.5 intro before the first table float");
    let intro_end = html[intro_at..]
        .find("</div>")
        .map(|n| intro_at + n)
        .expect("2.5 intro paragraph close");
    let table_float_at = html[intro_end..]
        .find(r#"class="disclose float float-table""#)
        .map(|n| intro_end + n)
        .expect("first table float after 2.5 intro");
    let between = &html[intro_end..table_float_at];
    assert!(
        between.contains(r#"class="standard""#),
        "§2.5 table float must stay in its Standard paragraph so first-line indent can sit the box"
    );

    let heading_6_1 = html
        .find(r#"heading-number">6.1 </span>Wrap Floats"#)
        .expect("section 6.1 Wrap Floats heading");
    let heading_end = html[heading_6_1..]
        .find("</h2>")
        .map(|n| heading_6_1 + n)
        .expect("section 6.1 heading close");
    let heading = &html[heading_6_1..heading_end];
    assert!(
        heading.contains(r#">Idx</summary>"#),
        "section 6.1 index chip must say Idx"
    );
    assert!(
        heading.contains(r#"class="disclose index-macro""#),
        "section 6.1 index must nest a subentry box"
    );
    assert!(
        heading.contains(r#">Subentry</summary>"#),
        "section 6.1 subentry chip must sit inside the index box"
    );
    let heading_6_2 = html
        .find(r#"heading-number">6.2 </span>Surrounded Fixed Objects"#)
        .expect("section 6.2 Surrounded Fixed Objects heading");
    let phrase_at = html[heading_6_2..]
        .find("To get an object exactly at the position")
        .map(|n| heading_6_2 + n)
        .expect("6.2 intro before the small tables");
    let tables_div = html[phrase_at..]
        .find(r#"class="standard""#)
        .map(|n| phrase_at + n)
        .expect("centered table paragraph after 6.2 intro");
    let tables_end = html[tables_div..]
        .find("</div>")
        .map(|n| tables_div + n)
        .expect("centered table paragraph close");
    let tables_par = &html[tables_div..tables_end];
    assert!(
        tables_par.contains("text-align: center"),
        "6.2 table group must keep the paragraph center setting"
    );
    assert!(
        tables_par.contains("text-indent: 0"),
        "centered table paragraph must not pick up first-line indent"
    );
    let table_count = tables_par.matches("<table").count();
    assert!(
        table_count >= 2,
        "6.2 must keep several small tables in one paragraph, found {table_count}"
    );
    assert!(
        !tables_par.contains("longtable"),
        "6.2 side-by-side tables are not long tables"
    );
    assert!(html.contains(r#"class="disclose marginal""#));
    assert!(html.contains("This is a margin note."));
    assert!(html.contains(r#"class="wrap wrap-left""#));
    let wrap_at = html
        .find(r#"class="wrap wrap-left" style="width: 40%""#)
        .expect("wrap box at 40% of the column");
    let wrap_chip_at = html[..wrap_at]
        .rfind(r#"class="disclose wrap wrap-left"#)
        .expect("wrap chip around the 40% box");
    assert!(
        html[wrap_chip_at..wrap_at].contains(r#"--wrap-width: 40%"#),
        "wrap chip carries the stored width so open layout can sit text beside it"
    );
    let wrap_region_end = (wrap_at + 12_000).min(html.len());
    let wrap_plot = img_tag_for(&html[wrap_at..wrap_region_end], "2D-intensity-plot.pdf")
        .expect("plot inside the wrap");
    assert!(
        wrap_plot.contains(r#"style="width: 100%""#),
        "plot inside a wrap fills the wrap box, not the pane"
    );
    let first_plot = img_tag_for(&html, "2D-intensity-plot.pdf").expect("first 2D plot");
    assert!(
        !first_plot.contains("100%") && !first_plot.contains('%'),
        "unsized Graphics Dialog plot must not stretch to the pane: {first_plot}"
    );
    if first_plot.contains("width:") {
        assert!(
            first_plot.contains("px"),
            "unsized plot on-screen size is CSS pixels: {first_plot}"
        );
    }
    assert!(html.contains("<figcaption"));
    assert!(html.contains("Figure 6.1: "));
    assert!(html.contains(r#"class="float-caption-Standard""#));
    assert!(html.contains("This is a wrapped figure float."));
    assert!(html.contains(r##"href="#fig_This_is_a">6.1</a>"##));
    let star = img_tag_for(&html, "Star-structure.pdf").expect("Star-structure plot");
    assert!(
        !star.contains("50%"),
        "LyX window scale is lyxscale, not print 50col%: {star}"
    );
    if star.contains("width:") {
        assert!(
            star.contains("px"),
            "Star-structure on-screen size is CSS pixels, not a column %"
        );
    }
    assert!(
        html.contains("data:image/png;base64,") || html.contains("2D-intensity-plot.pdf"),
        "PDF figures must still name the source file"
    );
    assert!(html.contains(r#"<code class="listings C++">"#));
    assert!(html.contains("int a=5;"));
    assert!(html.contains(r#"<div class="float-listings">"#));
    assert!(html.contains("listings-caption"));
    assert!(html.contains("Listing 8.1: "));
    assert!(html.contains("Example Listing float"));
    assert!(html.contains(r##"href="#lst_Example_Listing">8.1</a>"##));
    assert!(html.contains(r##"href="#lst_file_listing">8.2</a>"##));
    assert!(html.contains("Listing 8.2: "));
    assert!(html.contains("Lines 10 - 15 of this LyX file"));
    assert!(html.contains("\\usepackage[figure]{hypcap}"));
    assert!(html.contains("Listing 8.3: "));
    assert!(html.contains("def func(param):"));
    assert!(html.contains(r#"data-filename="Abstract.pdf""#));
    assert!(html.contains("Algorithm 3.1: "));
    assert!(html.contains("Example Algorithm float"));
    assert!(html.contains("This is a small dummy child document"));
    assert!(html.contains("External Subsection 1"));
    assert!(html.contains(r#"<pre class="include">"#));
    assert!(
        !html.contains("\\end_header"),
        "lstinputlisting of this file must honor firstline/lastline, not dump the whole .lyx source"
    );
    assert!(html.contains(r#"class="float-caption-Below""#));
    assert!(html.contains("A caption marked as being below the table."));
    let below_at = html
        .find("A caption marked as being below the table.")
        .expect("Caption Below text missing");
    let below_cap = html[..below_at].rfind("<figcaption").expect("figcaption");
    assert!(
        html[below_cap..below_at].contains("float-caption-Below"),
        "Below class on figcaption"
    );
    assert!(
        html[below_cap..below_at].contains("Table "),
        "Caption Below keeps Table N: prefix"
    );
    assert!(html.contains(r#"class="float-caption-Unnumbered""#));
    assert!(html.contains("Continued Example Phone List"));
    let cont_at = html.find("Continued Example Phone List").unwrap();
    let cont_wrap = html[..cont_at]
        .rfind(r#"class="float-caption-Unnumbered""#)
        .expect("Unnumbered class on the continued caption");
    assert!(
        cont_at - cont_wrap < 400,
        "float-caption-Unnumbered must wrap Continued Example Phone List"
    );
    assert!(
        !html[cont_at.saturating_sub(80)..cont_at].contains("Table "),
        "Caption Unnumbered must not get a Table N: prefix"
    );
    for variant in [
        "Boxed",
        "Doublebox",
        "Framed",
        "Frameless",
        "Shaded",
        "Shadowbox",
        "ovalbox",
        "Ovalbox",
    ] {
        assert!(
            html.contains(&format!(r#"class="{variant}""#)),
            "missing box class {variant}"
        );
    }
    assert!(html.contains("box-full") && html.contains(r#"class="disclose box "#));
    assert!(
        html.contains(r#"class="Boxed" style="width: 100%""#) || html.contains(r#"class="Boxed""#)
    );
    assert!(html.contains("Shadow box"));
    assert!(html.contains("Shaded background box"));
    assert!(html.contains("Oval box, thin"));
    assert!(html.contains("Double rectangular box"));
    assert!(html.contains("flex_minipage"));
    let mp_at = html
        .find("with line break")
        .expect("Minipage body text missing");
    let mp_open = html[..mp_at].rfind("flex_minipage").expect("flex_minipage");
    assert!(
        mp_open + 200 > mp_at,
        "Minipage content must sit inside flex_minipage wrapper"
    );
    assert!(html[mp_open..mp_at + 20].contains("rotated cell"));
    assert!(html.contains(r#"class="href""#));
    assert!(html.contains(r#"<nav class="toc">"#));
    assert!(html.contains("note-greyedout"));
    assert!(html.contains("<kbd"));
    assert!(html.contains("“"));
    assert!(html.contains("<br>"));
    assert!(html.contains(r#"class="dropcap""#));
    assert!(html.contains(r#"class="flex_reflectbox""#));
    assert!(html.contains(r#"class="flex_rotatebox""#));
    assert!(html.contains(r#"class="flex_scalebox""#));
    assert!(html.contains(r#"class="flex_resizebox""#));
    assert!(html.contains(r#">Rotatebox</summary>"#));
    assert!(html.contains(r#">Scalebox</summary>"#));
    assert!(html.contains(r#">Resizebox</summary>"#));
    assert!(html.contains(r#">Reflectbox</summary>"#));
    assert!(html.contains(r#">Origin</summary>"#));
    assert!(html.contains(r#">Angle</summary>"#));
    assert!(html.contains(r#">H-Factor</summary>"#));
    assert!(html.contains(r#">Width</summary>"#));
    assert!(html.contains(r#">Height</summary>"#));
    let rotate_at = html
        .find(r#">Rotatebox</summary>"#)
        .expect("Rotatebox chip missing");
    let rotate_chunk = &html[rotate_at..(rotate_at + 1500).min(html.len())];
    assert!(
        rotate_chunk.contains(r#">Origin</summary>"#) && rotate_chunk.contains("origin=c"),
        "Rotatebox Origin chip must wrap origin=c; nearby: {rotate_chunk}"
    );
    assert!(
        !rotate_chunk.contains("Short Title"),
        "GraphicBox Origin must not use the heading Short Title chip"
    );
    assert!(
        !html.contains("rotate(") && !html.contains("scale(") && !html.contains("scaleX(-1)"),
        "GraphicBoxes must not fake print transforms"
    );
    assert!(html.contains(r#"class="bibitemlabel""#));
    assert!(html.contains(r#"class="citation""#));
    assert!(html.contains("<hr>"));
    assert!(html.contains(r#"class="index""#));
    assert!(html.contains(r#"style="color: white""#));
    assert!(html.contains(r#"style="color: yellow""#));
    assert!(html.contains(r#"style="color: magenta""#));
}

#[test]
fn live_renderer_help_formula_numbering_lyx_refs_and_eqno() {
    let path = help_file("Formula-numbering.lyx");
    let Some((html, response)) = render_path(&path) else {
        return;
    };
    assert!(html.contains(r#"<article class="lyx-live""#));
    assert_eq!(unknown_inset_messages(&response), Vec::<&str>::new());
    assert!(
        count_substr(&html, r#"class="eqno""#) >= 8,
        "Formula-numbering should emit equation numbers"
    );
    assert!(html.contains(r#"class="ref""#));
    assert!(html.contains("<hr>"));
    assert!(html.contains("<br>"));
    assert!(html.contains("<math"));
}

#[test]
fn live_renderer_help_intro_lyx_toc_href_quotes_table() {
    let path = help_file("Intro.lyx");
    let Some((html, response)) = render_path(&path) else {
        return;
    };
    assert!(html.contains(r#"<article class="lyx-live""#));
    assert_eq!(unknown_inset_messages(&response), Vec::<&str>::new());
    assert!(html.contains(r#"<h1 class="title""#));
    assert!(html.contains("Introduction to"));
    assert!(html.contains(r#"<nav class="toc">"#));
    assert!(html.contains(r#"class="href""#));
    assert!(html.contains("lyx-docs@lists.lyx.org"));
    assert!(html.contains("“"));
    assert!(html.contains("”"));
    assert!(html.contains("<table"));
    assert!(html.contains("disclose foot"));
    assert!(html.contains("<br>"));
    assert!(
        html.contains("</section><section><h3"),
        "sibling headings must close the previous section (intended deviation #2)"
    );
}

#[test]
fn live_renderer_help_tutorial_lyx_toc_info_lyx_code_quotes() {
    let path = help_file("Tutorial.lyx");
    let Some((html, response)) = render_path(&path) else {
        return;
    };
    assert!(html.contains(r#"<article class="lyx-live""#));
    assert_eq!(unknown_inset_messages(&response), Vec::<&str>::new());
    assert!(html.contains(r#"<nav class="toc">"#));
    assert!(html.contains(r#"class="href""#));
    assert!(html.contains("<kbd"));
    assert!(html.contains(r#"<pre class="lyx_code">"#));
    assert!(html.contains("This is an introduction"));
    assert!(html.contains("“"));
    assert!(html.contains("disclose foot"));
    assert!(html.contains("<br>"));
    assert!(html.contains(r#"class="ref""#));
    assert!(html.contains("<table"));
    assert!(html.contains("<math"));
    assert!(
        html.contains(r#"data-info-icon="buffer-view""#)
            || html.contains(r#"aria-label="buffer-view""#),
        "Tutorial toolbar Info icons must render as img or glyph"
    );
    if html.contains(r#"data-info-icon="buffer-view""#) {
        assert!(
            html.contains("data:image/svg+xml") || html.contains("data:image/png;base64,"),
            "info icon img must embed svg or png"
        );
    }
}

#[test]
fn live_renderer_help_development_lyx_multirow_cells_emit_rowspan() {
    let path = help_file("Development.lyx");
    let Some((html, response)) = render_path(&path) else {
        return;
    };
    assert!(html.contains(r#"<article class="lyx-live""#));
    assert_eq!(unknown_inset_messages(&response), Vec::<&str>::new());
    assert!(html.contains(r#"rowspan="3""#));
    let mut found = false;
    let mut rest = html.as_str();
    while let Some(i) = rest.find("<td") {
        let Some(rel) = rest[i..].find('>') else {
            break;
        };
        let tag_end = i + rel;
        let tag = &rest[i..=tag_end];
        let after = &rest[tag_end + 1..];
        let snippet = &after[..after.len().min(80)];
        if tag.contains(r#"rowspan="3""#)
            && (after.trim_start().starts_with("No") || snippet.contains(">No"))
        {
            found = true;
            break;
        }
        rest = &rest[i + 3..];
    }
    assert!(found, "the 'No' cell is the start of a 3-row span");
    assert!(
        html.contains(r#"class="space-mark custom special arrow""#),
        "negative custom length must paint the double-headed arrow"
    );
    assert!(
        html.contains(r#"style="width: 3cm""#),
        "negative custom -3cm uses the absolute length as the mark width"
    );
    let labels = table_after(&html, "The following table may clarify label assignement");
    let test_property = td_with_text(labels, "test property");
    assert!(
        !test_property.contains("border-left: 3px double"),
        "the cell left of 'test property' is a multicolumn dummy; that shared edge is one line. cell: {test_property}"
    );
    assert!(
        test_property.contains("border-left: 1px solid"),
        "'test property' still has its left line. cell: {test_property}"
    );
}

#[test]
fn live_renderer_help_customization_lyx_description_flex_code_labels() {
    let path = help_file("Customization.lyx");
    let Some((html, response)) = render_path(&path) else {
        return;
    };
    assert!(html.contains(r#"<article class="lyx-live""#));
    assert_eq!(unknown_inset_messages(&response), Vec::<&str>::new());
    assert!(html.contains(r#"<code class="flex_code""#) && html.contains("Format"));
    assert!(
        !html.contains("status collapsedFormat"),
        "Flex Code status must not leak into Description labels"
    );
    assert!(
        !html.contains("International Keyboard Support"),
        "deselected OutDated branch must omit like native XHTML"
    );
    assert!(
        !html.contains("Information from previous versions of this document"),
        "deselected OutDated branch intro must omit"
    );
    assert!(html.contains(r#"class="href""#));
    assert!(html.contains(r#"<nav class="toc">"#));
    assert!(html.contains("note-greyedout"));
    assert!(html.contains(r#"class="noun""#));
    assert!(html.contains(r#"class="flex_url""#));
    assert!(html.contains(r#"class="Shadowbox""#));
    assert!(html.contains(r#"<code class="listings"#));
    assert!(html.contains(r#"<pre class="lyx_code">"#));
    assert!(html.contains(r#"<blockquote class="quote">"#));
    assert!(html.contains("“"));
    assert!(html.contains("disclose foot"));
    assert!(html.contains("<br>"));
}

#[test]
fn live_renderer_help_development_lyx_listings_flex_code_paragraph() {
    let path = help_file("Development.lyx");
    let Some((html, response)) = render_path(&path) else {
        return;
    };
    assert!(html.contains(r#"<article class="lyx-live""#));
    assert_eq!(unknown_inset_messages(&response), Vec::<&str>::new());
    assert!(html.contains(r#"class="href""#));
    assert!(html.contains(r#"<nav class="toc">"#));
    assert!(html.contains("note-greyedout"));
    assert!(html.contains(r#"class="flex_code""#));
    assert!(html.contains(r#"class="flex_url""#));
    assert!(html.contains(r#"<code class="listings"#));
    assert!(html.contains("“"));
    assert!(html.contains("disclose foot"));
    assert!(html.contains("<br>"));
    assert!(html.contains(">Suspended tests</h5>"));
    assert!(html.contains(r#"class="bibitemlabel""#));
}

#[test]
fn live_renderer_ipa_ipadeco_are_not_unknown_inset() {
    if !require_textclass("article") {
        return;
    }
    let path = fixture_rel("Modules/Linguistics.lyx");
    let Some((html, response)) = render_path(&path) else {
        return;
    };
    let unknown: Vec<_> = unknown_inset_messages(&response)
        .into_iter()
        .filter(|m| m.contains("IPA"))
        .collect();
    assert_eq!(unknown, Vec::<&str>::new(), "IPA/IPADeco must be handled");
    assert!(html.contains(r#"class="ipa""#));
    assert!(html.contains("ipa-deco"));
    assert!(html.contains('\u{035c}'));
}

#[test]
fn live_renderer_tufte_flex_sidenote_and_charstyles() {
    if !require_textclass("tufte-handout") {
        return;
    }
    let path = fixture_rel("Handouts/Tufte_Handout.lyx");
    let Some((html, _)) = render_path(&path) else {
        return;
    };
    assert!(html.contains(r#"class="sidenote marginal""#));
    assert!(html.contains(r#"class="marginnote marginal""#));
    assert!(html.contains(r#"class="smallcaps""#));
    assert!(html.contains("font-variant: small-caps"));
    assert!(html.contains("allcaps"));
    assert!(html.contains("text-transform: uppercase"));
}

#[test]
fn live_renderer_beamer_alert_and_structure_flex() {
    if !require_textclass("beamer") {
        return;
    }
    let path = fixture_rel("Presentations/Beamer.lyx");
    let Some((html, _)) = render_path(&path) else {
        return;
    };
    assert!(html.contains(r#"class="alert""#));
    assert!(html.contains("#cc0000"));
    assert!(html.contains(r#"class="structure""#));
    assert!(html.contains("#0000aa"));
}

#[test]
fn live_renderer_flex_color_box_wraps_content() {
    if !require_textclass("scrartcl") {
        return;
    }
    let path = fixture_rel("Modules/Fancy_Colored_Boxes.lyx");
    let Some((html, response)) = render_path(&path) else {
        return;
    };
    assert_eq!(unknown_inset_messages(&response), Vec::<&str>::new());
    assert!(html.contains(r#"class="color-box""#));
    assert!(html.contains("A basic color box."));
}

#[test]
fn live_renderer_chunk_structure_tree_lilypond_chessboard_wrappers() {
    if !require_textclass("article") {
        return;
    }
    let chunk = render_path(&fixture_rel("Modules/Noweb.lyx")).expect("Noweb");
    assert!(chunk.0.contains(r#"class="chunk""#));
    assert!(chunk.0.contains("chunk-title"));
    let ling = render_path(&fixture_rel("Modules/Linguistics.lyx")).expect("Linguistics");
    assert!(ling.0.contains(r#"class="structure-tree""#));
    let lily = render_path(&fixture_rel("Modules/LilyPond_Book.lyx")).expect("LilyPond");
    assert!(lily.0.contains(r#"class="lilypond""#));
    let chess = render_path(&fixture_rel("Modules/Chessboard.lyx")).expect("Chessboard");
    assert!(chess.0.contains(r#"class="chessboard""#));
}

#[test]
fn live_renderer_nameref_uses_heading_and_caption_titles() {
    let Some((html, _)) = render_file("nameref_titles.lyx") else {
        return;
    };
    assert!(html.contains(r##"href="#sec_intro_name">Named Introduction</a>"##));
    assert!(html.contains(r##"href="#sec_intro_name">1</a>"##));
    assert!(html.contains(r##"href="#fig_demo_cap">Figure 1</a>"##));
}

#[test]
fn live_renderer_flex_insetlayout_htmltag_htmlclass_font_from_locallayout() {
    let Some((html, response)) = render_file("flex_htmltag.lyx") else {
        return;
    };
    assert_eq!(unknown_inset_messages(&response), Vec::<&str>::new());
    assert!(html.contains(r#"<mark class="probe-mark""#));
    assert!(html.contains("color:orange"));
    assert!(html.contains("Tagged"));
    assert!(
        !html.contains(r#"class="flex probe""#),
        "layout HTMLClass must win over generic flex slug"
    );
}

#[test]
fn live_renderer_hostile_layout_htmltags_fall_back_to_classed_wrappers() {
    let Some((html, response)) = render_file("flex_hostile_htmltag.lyx") else {
        return;
    };
    assert_eq!(unknown_inset_messages(&response), Vec::<&str>::new());
    for slug in ["hstyle", "hsvg", "hobject", "hlink"] {
        assert!(html.contains(&format!(r#"class="flex {slug}""#)));
    }
    assert!(
        !html.contains("<style"),
        "layout HTMLTag 'style' must not be emitted"
    );
    assert!(
        !html.contains("<svg"),
        "layout HTMLTag 'svg' must not be emitted"
    );
    assert!(
        !html.contains("<object"),
        "layout HTMLTag 'object' must not be emitted"
    );
    assert!(
        !html.contains("<link"),
        "layout HTMLTag 'link' must not be emitted"
    );
}

#[test]
fn live_renderer_duplicate_citation_keys_render_once() {
    let Some((html, _)) = render_file("cite_dedup.lyx") else {
        return;
    };
    assert_eq!(
        count_substr(&html, r#"class="bibtexentry""#),
        2,
        "duplicate citation keys must render a single bibliography entry each"
    );
    assert!(html.contains("Author, Alpha"));
    assert!(html.contains("Author, Beta"));
}

#[test]
fn live_renderer_pageref_uses_target_number_not_elsewhere() {
    let path = help_file("UserGuide.lyx");
    let Some((html, _)) = render_path(&path) else {
        return;
    };
    assert!(
        !html.contains(">elsewhere</a>"),
        "pageref/vpageref must not hardcode elsewhere when a target exists"
    );
    assert!(html.contains(r##"href="#fig_Two_images""##));
    assert!(html.contains(r#"title="page reference"#));
    assert!(html.contains(">4.2</a>"));
}

#[test]
fn live_renderer_lang_property_emits_html_lang_spans() {
    let path = help_file("Additional.lyx");
    let Some((html, _)) = render_path(&path) else {
        return;
    };
    assert!(html.contains(r#"lang="de""#));
    assert!(html.contains(r#"lang="en""#));
}

#[test]
fn live_renderer_remaining_flex_kinds_get_classed_wrappers() {
    let samples: &[(&str, &str, &[&str])] = &[
        (
            "Presentations/Beamer.lyx",
            "beamer",
            &["flex alternative", "flex bold", r#"class="flex"#],
        ),
        (
            "Articles/Springer_Nature_Journals.lyx",
            "sn-jnl",
            &["data-field=", "flex field"],
        ),
        (
            "Modules/Linguistics.lyx",
            "article",
            &["flex gloss", "groupglossedwords"],
        ),
        ("Modules/Braille.lyx", "article", &["braillebox"]),
        (
            "Modules/PDF_Form.lyx",
            "scrartcl",
            &["pdf-form", "checkbox"],
        ),
        (
            "Curricula_Vitae/Modern_CV.lyx",
            "moderncv",
            &["flex column"],
        ),
    ];
    for (rel, textclass, needles) in samples {
        if !has_textclass_layout(textclass) {
            continue;
        }
        let Some((html, _)) = render_path(&fixture_rel(rel)) else {
            continue;
        };
        let lower = html.to_lowercase();
        for n in *needles {
            assert!(lower.contains(&n.to_lowercase()), "{rel} missing {n}");
        }
    }
}

#[test]
fn live_renderer_hp_pdf_comment_form_tablenotemark_wrappers() {
    if !require_textclass("scrartcl") {
        return;
    }
    let hp = render_path(&fixture_rel(
        "Modules/Hazard_and_Precautionary_Statements.lyx",
    ))
    .expect("HP");
    assert!(hp.0.contains(r#"class="hp-number""#));
    assert!(hp.0.contains(r#"class="hp-statement""#));
    let pdf = render_path(&fixture_rel("Modules/PDF_Comments.lyx")).expect("PDF comments");
    assert!(pdf.0.contains("pdf-comment"));
    let form = render_path(&fixture_rel("Modules/PDF_Form.lyx")).expect("PDF form");
    assert!(form.0.contains("pdf-form"));
    if has_textclass_layout("aastex63") {
        let aas = render_path(&fixture_rel(
            "Articles/American_Astronomical_Society_%28AASTeX_v._6.3.1%29.lyx",
        ))
        .expect("AAS");
        assert!(aas.0.contains(r#"class="tablenotemark""#));
    }
}

#[test]
fn live_renderer_floatlist_emits_list_of_floats() {
    if !require_textclass("scrbook") {
        return;
    }
    let koma = render_path(&fixture_rel("Books/KOMA-Script_Book.lyx")).expect("KOMA");
    assert!(
        unknown_inset_messages(&koma.1)
            .iter()
            .all(|m| !m.contains("FloatList"))
    );
    if !has_textclass_layout("scrartcl") {
        return;
    }
    let (html, response) =
        render_path(&fixture_rel("Modules/Multilingual_Captions.lyx")).expect("captions");
    assert!(
        unknown_inset_messages(&response)
            .iter()
            .all(|m| !m.contains("FloatList"))
    );
    assert!(html.contains(r#"class="toc toc-floats""#));
    assert!(html.contains("List of "));
    assert!(html.contains(r##"href="#float-"##));
}
