//! `lq bib` CLI cases (Deno `tests/cli_test.ts`).

mod common;

use common::{WorkDir, fixtures_root, json_stdout, run_cli, run_cli_no_home};
use serde_json::{Value, json};
use std::collections::HashSet;
use std::fs;
use std::path::{Path, PathBuf};

fn write_temp_file(work: &WorkDir, name: &str, contents: &str) -> PathBuf {
    let path = work.path().join(name);
    fs::write(&path, contents)
        .unwrap_or_else(|e| panic!("failed to write {}: {e}", path.display()));
    path
}

fn lyx_with_bibfiles(reference: &str) -> String {
    format!(
        "#LyX 2.5 created this file.\n\
         \\begin_document\n\\begin_header\n\\end_header\n\
         \\begin_body\n\
         \\begin_layout Standard\n\
         A citation.\n\
         \\begin_inset CommandInset bibtex\n\
         LatexCommand bibtex\n\
         btprint \"btPrintAll\"\n\
         bibfiles \"{reference}\"\n\
         \\end_inset\n\
         \\end_layout\n\
         \\end_body\n\\end_document\n"
    )
}

fn run_bib<'a>(path: &'a Path, trailing: &[&'a str]) -> common::CliOutput {
    let path = path.to_str().expect("test path must be UTF-8");
    let mut args = vec!["bib", path];
    args.extend_from_slice(trailing);
    run_cli(&args)
}

fn bib_data<'a>(path: &'a Path, trailing: &[&'a str]) -> Vec<Value> {
    let out = run_bib(path, trailing);
    assert_eq!(
        out.code, 0,
        "stdout: {}\nstderr: {}",
        out.stdout, out.stderr
    );
    let value = json_stdout(&out);
    value["data"]
        .as_array()
        .unwrap_or_else(|| panic!("missing citation array: {value}"))
        .clone()
}

fn assert_error(out: &common::CliOutput, code: &str, message: &str) {
    assert_eq!(
        out.code, 1,
        "stdout: {}\nstderr: {}",
        out.stdout, out.stderr
    );
    let value = json_stdout(out);
    assert_eq!(value["code"], code);
    assert_eq!(value["message"], message);
}

#[test]
fn cli_bib_search() {
    let fixture = fixtures_root().join("my_template.lyx");
    let data = bib_data(&fixture, &["--search", "Mena"]);
    assert_eq!(data.len(), 1);
    assert_eq!(data[0]["key"], "Mena2000");
}

#[test]
fn cli_bib_search_no_match() {
    let fixture = fixtures_root().join("my_template.lyx");
    let data = bib_data(&fixture, &["--search", "ZZZZZ_NO_MATCH"]);
    assert!(data.is_empty());
}

#[test]
fn cli_bib_on_bib_file_returns_all_citations() {
    let fixture = fixtures_root().join("biblioExample.bib");
    let data = bib_data(&fixture, &[]);
    assert_eq!(data.len(), 15);

    let keys: Vec<&str> = data
        .iter()
        .map(|citation| citation["key"].as_str().expect("citation key"))
        .collect();
    assert!(keys.contains(&"Mena2000"));
    assert!(keys.contains(&"Abernethy2003"));
    assert_eq!(
        keys.iter().copied().collect::<HashSet<_>>().len(),
        keys.len()
    );
}

#[test]
fn cli_bib_invalid_utf8_is_bib_read_error_not_file_not_found() {
    let work = WorkDir::new();
    let path = work.path().join("garbage.bib");
    fs::write(
        &path,
        [0x00, 0xff, b' ', b'n', b'o', b't', b' ', b'b', b'i', b'b'],
    )
    .unwrap();
    let out = run_bib(&path, &[]);
    assert_eq!(
        out.code, 1,
        "stdout: {}\nstderr: {}",
        out.stdout, out.stderr
    );
    let value = json_stdout(&out);
    assert_eq!(value["code"], "BIB_READ_ERROR");
    assert_eq!(
        value["message"],
        format!("File exists but is not valid UTF-8: {}", path.display())
    );
}

#[test]
fn cli_bib_on_bib_file_with_search() {
    let fixture = fixtures_root().join("biblioExample.bib");
    let data = bib_data(&fixture, &["--search", "Mena"]);
    assert_eq!(data.len(), 1);
    assert_eq!(data[0]["key"], "Mena2000");
}

#[test]
fn cli_bib_on_bib_file_deduplicates_keys() {
    let work = WorkDir::new();
    let fixture = write_temp_file(
        &work,
        "dedup.bib",
        concat!(
            "@ARTICLE{Dup2020,\n",
            "  author = {Alice Author},\n",
            "  title = {Duplicate key},\n",
            "  year = {2020}\n",
            "}\n",
            "@BOOK{Dup2020,\n",
            "  author = {Bob Author},\n",
            "  title = {Same key},\n",
            "  year = {2021}\n",
            "}\n",
            "@ARTICLE{Unique2022,\n",
            "  author = {Carol Author},\n",
            "  title = {Unique key},\n",
            "  year = {2022}\n",
            "}\n",
        ),
    );

    let data = bib_data(&fixture, &[]);
    let keys: Vec<&str> = data
        .iter()
        .map(|citation| citation["key"].as_str().expect("citation key"))
        .collect();
    assert_eq!(keys, ["Dup2020", "Unique2022"]);
    assert_eq!(data[0]["type"], "book");
    assert_eq!(data[0]["author"], "Bob Author");
    assert_eq!(data[0]["year"], "2021");
}

#[test]
fn cli_bib_on_bib_file_case_insensitive() {
    let work = WorkDir::new();
    let fixture = write_temp_file(
        &work,
        "case.BIB",
        concat!(
            "@ARTICLE{CaseTest2000,\n",
            "  author = {Case Author},\n",
            "  title = {Case test},\n",
            "  year = {2000}\n",
            "}\n",
        ),
    );

    let data = bib_data(&fixture, &[]);
    assert_eq!(
        data,
        [json!({
            "key": "CaseTest2000",
            "type": "article",
            "title": "Case test",
            "author": "Case Author",
            "year": "2000",
        })]
    );
}

#[test]
fn cli_bib_extra_positional_is_rejected() {
    let fixture = fixtures_root().join("my_template.lyx");
    let out = run_bib(&fixture, &["ignored-extra-positional"]);
    assert_error(
        &out,
        "INVALID_FLAG",
        "Unexpected argument 'ignored-extra-positional' for 'bib'. Run 'lq bib --help'.",
    );
}

#[test]
fn cli_bib_rejects_non_lyx_non_bib_files() {
    let out = run_cli(&["bib", "refs.txt"]);
    assert_error(
        &out,
        "INVALID_EXTENSION",
        "Target file 'refs.txt' must be a .lyx document or a .bib file. Use 'lq bib refs.bib' to parse a .bib file directly.",
    );
}

#[test]
fn cli_bib_resolves_a_parent_relative_bibfiles_reference() {
    // Keep `%26` literal: this path must not round-trip through a URL.
    let fixture = fixtures_root()
        .join("Articles")
        .join("Astronomy_%26_Astrophysics.lyx");
    let data = bib_data(&fixture, &[]);
    assert_eq!(data.len(), 15);
}

#[test]
fn cli_bib_resolves_a_reference_through_a_dotted_directory() {
    let work = WorkDir::new();
    let dotted = work.path().join("dir.with.dot");
    fs::create_dir(&dotted)
        .unwrap_or_else(|e| panic!("failed to create {}: {e}", dotted.display()));
    fs::write(
        dotted.join("refs.bib"),
        concat!(
            "@article{pathdot2024,\n",
            "  author = {P. Dot},\n",
            "  title = {Dotted directory reference},\n",
            "  year = {2024}\n",
            "}\n",
        ),
    )
    .unwrap_or_else(|e| panic!("failed to write dotted-directory bibliography: {e}"));
    let document = write_temp_file(&work, "doc.lyx", &lyx_with_bibfiles("dir.with.dot/refs"));

    let data = bib_data(&document, &[]);
    assert_eq!(data.len(), 1);
    assert_eq!(data[0]["key"], "pathdot2024");
}

#[test]
fn cli_bib_skips_a_non_bib_reference() {
    let work = WorkDir::new();
    let document = write_temp_file(&work, "non_bib.lyx", &lyx_with_bibfiles("style.bst"));
    let out = run_bib(&document, &[]);
    assert_error(
        &out,
        "NO_BIBFILE",
        "No .bib files are referenced by the bibliography inset. Add a .bib file in LyX, then rerun 'lq bib'.",
    );
}

#[test]
fn cli_bib_on_file_without_bibliography() {
    let work = WorkDir::new();
    let document = write_temp_file(
        &work,
        "no_bibliography.lyx",
        concat!(
            "#LyX 2.5 created this file.\n",
            "\\begin_document\n\\begin_header\n\\end_header\n",
            "\\begin_body\n",
            "\\begin_layout Standard\n",
            "No bibliography here.\n",
            "\\end_layout\n",
            "\\end_body\n\\end_document\n",
        ),
    );
    let out = run_bib(&document, &[]);
    assert_error(
        &out,
        "NO_BIBLIO",
        "No bibliography inset was found. Inspect the document with 'lq read <file> \"inset[CommandInset bibtex]\"' or add a bibliography in LyX, then rerun 'lq bib'.",
    );
}

#[test]
fn cli_bib_on_bib_file_succeeds_without_home() {
    let work = WorkDir::new();
    let fixture = fixtures_root().join("biblioExample.bib");
    let fixture = fixture.to_str().expect("test path must be UTF-8");
    let out = run_cli_no_home(&["bib", fixture], work.path());
    assert_eq!(
        out.code, 0,
        "stdout: {}\nstderr: {}",
        out.stdout, out.stderr
    );
    assert_eq!(
        json_stdout(&out)["data"]
            .as_array()
            .expect("citation array")
            .len(),
        15
    );
}
