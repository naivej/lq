//! 022 honest-failure wave (G-23, B-1, E-2, JC2/JC3).

mod common;

use common::{IsolatedHome, MutationSession, WorkDir, json_warnings, path_arg, run_cli_with};
use lq::{build_live_response, parse};
use serde_json::json;
use std::fs;
use std::path::{Path, PathBuf};

fn stub_layouts(root: &Path) -> PathBuf {
    let layouts = root.join("layouts");
    fs::create_dir_all(&layouts).unwrap();
    fs::write(
        layouts.join("article.layout"),
        "Format 104\nStyle Standard\nEnd\n",
    )
    .unwrap();
    layouts
}

fn article_lyx(body: &str) -> String {
    format!(
        "#LyX 2.5 created this file.\n\\lyxformat 643\n\\begin_document\n\\begin_header\n\\textclass article\n\\end_header\n\\begin_body\n{body}\\end_body\n\\end_document\n"
    )
}

fn include_body(filename: &str, command: &str) -> String {
    format!(
        "\\begin_layout Standard\n\\begin_inset CommandInset include\nLatexCommand {command}\nfilename \"{filename}\"\nliteral \"true\"\n\n\\end_inset\n\n\n\\end_layout\n"
    )
}

fn preview_parent(work: &Path, body: &str) -> lq::LiveRenderResult {
    let layouts = stub_layouts(work);
    let lyx = work.join("parent.lyx");
    let text = article_lyx(body);
    fs::write(&lyx, &text).unwrap();
    let ast = parse(&text, false).unwrap();
    build_live_response(&lyx, &ast, &text, Some(&layouts), Some(&layouts), None).expect("preview")
}

#[test]
fn mutation_warns_when_undo_snapshot_cannot_be_saved() {
    let env = MutationSession::new();
    fs::write(env.home.path().join(".lq/undo"), b"not-a-directory").unwrap();
    let file = env.template("honest_undo.lyx");
    let before = fs::read_to_string(&file).unwrap();
    let p = path_arg(&file);
    let result = env.run(&["set", p, "layout[Title]", "Changed Title"]);
    assert!(
        result.get("code").is_none(),
        "mutation must succeed: {result}"
    );
    let expected = format!(
        "Undo snapshot could not be saved. The file was written. Later 'lq undo {p}' will report UNDO_SNAPSHOT_UNAVAILABLE until a later mutation saves a snapshot."
    );
    assert!(
        json_warnings(&result).iter().any(|w| w == &expected),
        "warnings: {:?}",
        json_warnings(&result)
    );
    let after = fs::read_to_string(&file).unwrap();
    assert_ne!(after, before);
    let undone = env.run(&["undo", p]);
    assert_eq!(undone["code"], "UNDO_SNAPSHOT_UNAVAILABLE");
}

#[test]
fn preview_include_missing_child_warns() {
    let work = WorkDir::new();
    let result = preview_parent(work.path(), &include_body("missing-child.lyx", "include"));
    assert!(
        result
            .warnings
            .iter()
            .any(|w| w == "Could not read included file 'missing-child.lyx'."),
        "{:?}",
        result.warnings
    );
}

#[test]
fn preview_include_invalid_utf8_warns() {
    let work = WorkDir::new();
    fs::write(work.path().join("bad.lyx"), [0xffu8, 0xfe, 0x00]).unwrap();
    let result = preview_parent(work.path(), &include_body("bad.lyx", "include"));
    assert!(
        result
            .warnings
            .iter()
            .any(|w| w == "Included file 'bad.lyx' exists but is not valid UTF-8."),
        "{:?}",
        result.warnings
    );
}

#[test]
fn preview_include_unparsable_child_warns() {
    let work = WorkDir::new();
    fs::write(
        work.path().join("notlyx.lyx"),
        "this is not a lyx document\n",
    )
    .unwrap();
    let result = preview_parent(work.path(), &include_body("notlyx.lyx", "include"));
    assert!(
        result
            .warnings
            .iter()
            .any(|w| w == "Could not parse included file 'notlyx.lyx'."),
        "{:?}",
        result.warnings
    );
}

#[test]
fn preview_listing_include_invalid_utf8_warns() {
    let work = WorkDir::new();
    fs::write(work.path().join("code.txt"), [0xffu8, 0xfe]).unwrap();
    let result = preview_parent(work.path(), &include_body("code.txt", "lstinputlisting"));
    assert!(
        result
            .warnings
            .iter()
            .any(|w| w == "Included file 'code.txt' exists but is not valid UTF-8."),
        "{:?}",
        result.warnings
    );
}

#[test]
fn preview_listing_include_missing_warns() {
    let work = WorkDir::new();
    let result = preview_parent(work.path(), &include_body("gone.txt", "verbatiminput"));
    assert!(
        result
            .warnings
            .iter()
            .any(|w| w == "Could not read included file 'gone.txt'."),
        "{:?}",
        result.warnings
    );
}

#[test]
fn preview_bib_invalid_utf8_warns() {
    let work = WorkDir::new();
    fs::write(work.path().join("junk.bib"), [0xffu8, 0xfe]).unwrap();
    let body = "\\begin_layout Standard\n\\begin_inset CommandInset bibtex\nLatexCommand bibtex\nbtprint \"btPrintCited\"\nbibfiles \"junk\"\nencoding \"default\"\n\n\\end_inset\n\n\n\\end_layout\n";
    let result = preview_parent(work.path(), body);
    assert!(
        result
            .warnings
            .iter()
            .any(|w| w == "Bibliography file 'junk.bib' exists but is not valid UTF-8."),
        "{:?}",
        result.warnings
    );
}

#[test]
fn preview_bind_invalid_utf8_warns() {
    let work = WorkDir::new();
    let layouts = stub_layouts(work.path());
    fs::create_dir_all(work.path().join("bind")).unwrap();
    fs::write(work.path().join("bind").join("cua.bind"), [0xffu8, 0xfe]).unwrap();
    let lyx = work.path().join("parent.lyx");
    let text = article_lyx("\\begin_layout Standard\nHi.\n\\end_layout\n");
    fs::write(&lyx, &text).unwrap();
    let ast = parse(&text, false).unwrap();
    let result = build_live_response(&lyx, &ast, &text, Some(&layouts), Some(&layouts), None)
        .expect("preview");
    assert!(
        result
            .warnings
            .iter()
            .any(|w| w == "Bind file 'cua.bind' exists but is not valid UTF-8."),
        "{:?}",
        result.warnings
    );
}

#[test]
fn preview_icon_aliases_invalid_utf8_warns() {
    let work = WorkDir::new();
    let layouts = stub_layouts(work.path());
    fs::create_dir_all(work.path().join("images")).unwrap();
    fs::write(
        work.path().join("images").join("icon.aliases"),
        [0xffu8, 0xfe],
    )
    .unwrap();
    let body = "\\begin_layout Standard\n\\begin_inset Info\ntype  \"icon\"\narg   \"math-mode\"\n\\end_inset\n\n\\end_layout\n";
    let lyx = work.path().join("parent.lyx");
    let text = article_lyx(body);
    fs::write(&lyx, &text).unwrap();
    let ast = parse(&text, false).unwrap();
    let result = build_live_response(&lyx, &ast, &text, Some(&layouts), Some(&layouts), None)
        .expect("preview");
    assert!(
        result
            .warnings
            .iter()
            .any(|w| w == "icon.aliases exists but is not valid UTF-8."),
        "{:?}",
        result.warnings
    );
}

#[test]
fn schema_invalid_utf8_layout_warns_and_falls_back() {
    let home = IsolatedHome::new();
    let work = WorkDir::new();
    let layouts = work.path().join("layouts");
    fs::create_dir_all(&layouts).unwrap();
    fs::write(layouts.join("article.layout"), [0xffu8, 0xfe]).unwrap();
    fs::write(
        home.path().join(".lq/config.json"),
        json!({ "layoutsDir": layouts }).to_string(),
    )
    .unwrap();
    let file = work.path().join("doc.lyx");
    fs::write(
        &file,
        article_lyx("\\begin_layout Standard\nX\n\\end_layout\n"),
    )
    .unwrap();
    let out = run_cli_with(&["schema", path_arg(&file)], &home, work.path());
    assert_eq!(out.code, 0, "{}", out.stdout);
    let result: serde_json::Value = serde_json::from_str(out.stdout.trim()).unwrap();
    let warnings = json_warnings(&result);
    assert!(
        warnings
            .iter()
            .any(|w| w.contains("Could not read layout file for textclass 'article'")),
        "{warnings:?}"
    );
    assert_eq!(result["data"]["documentLayouts"], json!([]));
}

#[test]
fn schema_invalid_utf8_nested_inc_warns_and_falls_back() {
    let home = IsolatedHome::new();
    let work = WorkDir::new();
    let layouts = work.path().join("layouts");
    fs::create_dir_all(&layouts).unwrap();
    fs::write(
        layouts.join("article.layout"),
        "Format 104\nInput bad\nStyle Standard\nEnd\n",
    )
    .unwrap();
    fs::write(layouts.join("bad.inc"), [0xffu8, 0xfe]).unwrap();
    fs::write(
        home.path().join(".lq/config.json"),
        json!({ "layoutsDir": layouts }).to_string(),
    )
    .unwrap();
    let file = work.path().join("doc.lyx");
    fs::write(
        &file,
        article_lyx("\\begin_layout Standard\nX\n\\end_layout\n"),
    )
    .unwrap();
    let out = run_cli_with(&["schema", path_arg(&file)], &home, work.path());
    assert_eq!(out.code, 0, "{}", out.stdout);
    let result: serde_json::Value = serde_json::from_str(out.stdout.trim()).unwrap();
    let warnings = json_warnings(&result);
    assert!(
        warnings
            .iter()
            .any(|w| w.contains("Could not read layout file for textclass 'article'")),
        "{warnings:?}"
    );
    assert_eq!(result["data"]["documentLayouts"], json!([]));
}

#[test]
fn invalid_utf8_cache_file_is_a_miss() {
    let env = MutationSession::new();
    let file = env.template("cache_miss.lyx");
    let first = env.run(&["read", path_arg(&file), "layout[Title]"]);
    assert!(first.get("code").is_none(), "{first}");
    let cache = env.home.path().join(".lq/cache");
    let mut found = false;
    if cache.is_dir() {
        for ent in fs::read_dir(&cache).unwrap() {
            let path = ent.unwrap().path();
            if path.extension().and_then(|s| s.to_str()) == Some("cst") {
                fs::write(&path, [0xffu8, 0xfe]).unwrap();
                found = true;
            }
        }
    }
    assert!(found, "expected a cache .cst after read");
    let second = env.run(&["read", path_arg(&file), "layout[Title]"]);
    assert!(second.get("code").is_none(), "{second}");
    assert!(
        json_warnings(&second)
            .iter()
            .all(|w| !w.to_ascii_lowercase().contains("utf-8")),
        "{:?}",
        json_warnings(&second)
    );
}
