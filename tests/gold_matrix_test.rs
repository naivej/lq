//! S12 gold matrix: spawn Rust `lq` and `LQ_DENO_BIN` on the same argv.
//! Skips when `LQ_DENO_BIN` is unset (CI).

mod common;

use common::{GoldSession, WorkDir, compare_cli, compare_lyx_files, path_arg};
use serde_json::{Value, json};

fn gold() -> Option<GoldSession> {
    GoldSession::new()
}

#[test]
fn gold_unknown_command() {
    let Some(s) = gold() else {
        return;
    };
    s.compare(&["frobnicate"], "unknown command");
}

#[test]
fn gold_init_local() {
    let Some(s) = gold() else {
        return;
    };
    let rust_cwd = WorkDir::new();
    let gold_cwd = WorkDir::new();
    let rust = s.run_rust_at(&["init"], rust_cwd.path());
    let gold_out = s.run_gold_at(&["init"], gold_cwd.path());
    assert_eq!(rust.code, gold_out.code, "init exit");
    assert_eq!(rust.stderr, gold_out.stderr, "init stderr");
    let mut rust_json: Value = serde_json::from_str(rust.stdout.trim()).unwrap();
    let mut gold_json: Value = serde_json::from_str(gold_out.stdout.trim()).unwrap();
    mask_init_config_path(&mut rust_json);
    mask_init_config_path(&mut gold_json);
    assert_eq!(rust_json, gold_json, "init JSON (configPath masked)");
}

fn mask_init_config_path(v: &mut Value) {
    if let Some(obj) = v.as_object_mut() {
        obj.insert("configPath".into(), json!("<session>"));
    }
}

#[test]
fn gold_read_path_my_template() {
    let Some(s) = gold() else {
        return;
    };
    let file = s.copy_fixture("my_template.lyx", "my_template.lyx");
    s.copy_fixture("biblioExample.bib", "biblioExample.bib");
    let p = path_arg(&file);
    s.compare(&["dump", p], "dump my_template");
    s.compare(&["dump", p, "--toc"], "dump --toc my_template");
    s.compare(&["read", p, "layout[Title]"], "read Title my_template");
    s.compare(&["schema", p], "schema my_template");
    s.compare(&["bib", p], "bib my_template");
}

#[test]
fn gold_read_path_hostile() {
    let Some(s) = gold() else {
        return;
    };
    let file = s.copy_fixture("Synthetic/hostile.lyx", "hostile.lyx");
    let p = path_arg(&file);
    s.compare(&["dump", p], "dump hostile");
    s.compare(&["dump", p, "--toc"], "dump --toc hostile");
    s.compare(
        &["read", p, "layout[Standard]:first"],
        "read Standard hostile",
    );
    s.compare(&["schema", p], "schema hostile");
    s.compare(&["bib", p], "bib hostile");
}

#[test]
fn gold_preview_my_template_and_hostile() {
    let Some(s) = gold() else {
        return;
    };
    let template = s.copy_fixture("my_template.lyx", "preview_template.lyx");
    s.compare_preview(&["preview", path_arg(&template)], "preview my_template");
    let hostile = s.copy_fixture("Synthetic/hostile.lyx", "preview_hostile.lyx");
    s.compare_preview(&["preview", path_arg(&hostile)], "preview hostile");
}

#[test]
fn gold_mutations_my_template_and_hostile() {
    let Some(s) = gold() else {
        return;
    };
    gold_set_delete_insert(&s, "my_template.lyx", "tmpl");
    gold_set_delete_insert(&s, "Synthetic/hostile.lyx", "host");
    gold_undo(&s, "my_template.lyx", "tmpl");
    gold_undo(&s, "Synthetic/hostile.lyx", "host");
}

fn gold_set_delete_insert(s: &GoldSession, fixture: &str, tag: &str) {
    mutate_pair(
        s,
        fixture,
        tag,
        "set",
        &["layout[Standard]:first", "s12-gold"],
    );
    mutate_pair(s, fixture, tag, "delete", &["layout[Standard]:first"]);
    mutate_pair(
        s,
        fixture,
        tag,
        "insert",
        &[
            "layout[Standard]:first",
            "after",
            "--layout",
            "Standard",
            "--text",
            "s12-gold-ins",
        ],
    );
}

fn mutate_pair(s: &GoldSession, fixture: &str, tag: &str, cmd: &str, rest: &[&str]) {
    let rust_file = s.copy_fixture(fixture, &format!("{tag}_{cmd}_rust.lyx"));
    let gold_file = s.copy_fixture(fixture, &format!("{tag}_{cmd}_gold.lyx"));
    let rust_path = path_arg(&rust_file);
    let gold_path = path_arg(&gold_file);
    let mut rust_args = vec![cmd, rust_path];
    rust_args.extend(rest);
    let mut gold_args = vec![cmd, gold_path];
    gold_args.extend(rest);
    let rust = s.run_rust(&rust_args);
    let gold = s.run_gold(&gold_args);
    compare_cli(&rust, &gold, &format!("{cmd} {tag}"));
    compare_lyx_files(&rust_file, &gold_file, &format!("{cmd} {tag} file"));
}

#[test]
fn gold_flag_success_argv() {
    let Some(s) = gold() else {
        return;
    };
    let file = s.copy_fixture("my_template.lyx", "flags.lyx");
    s.copy_fixture("biblioExample.bib", "biblioExample.bib");
    let p = path_arg(&file);
    s.compare(
        &["read", p, "layout[Title]", "--text-only"],
        "read --text-only",
    );
    s.compare(&["read", p, "layout[Standard]", "--count"], "read --count");
    mutate_pair(
        &s,
        "my_template.lyx",
        "find",
        "set",
        &[
            "layout[Standard]:contains('writing')",
            "text",
            "--find",
            "writing",
        ],
    );
    mutate_pair(
        &s,
        "my_template.lyx",
        "cite",
        "insert",
        &["layout[Standard]:first", "append", "--cite", "einstein"],
    );
}

#[test]
fn gold_extra_fixtures() {
    let Some(s) = gold() else {
        return;
    };
    let bullets = s.copy_fixture(
        "Graphics_and_Insets/Itemize_Bullets.lyx",
        "itemize_bullets.lyx",
    );
    s.compare_preview(&["preview", path_arg(&bullets)], "preview Itemize_Bullets");
    let tutorial = s.copy_fixture("Help/Tutorial.lyx", "tutorial.lyx");
    s.compare_preview(&["preview", path_arg(&tutorial)], "preview Tutorial");
    let intro = s.copy_fixture("Help/Intro.lyx", "intro.lyx");
    let ip = path_arg(&intro);
    s.compare(&["dump", ip, "--toc"], "dump --toc Intro");
    s.compare_preview(&["preview", ip], "preview Intro");
    let beamer = s.copy_fixture("Presentations/Beamer.lyx", "beamer.lyx");
    let bp = path_arg(&beamer);
    s.compare(&["schema", bp], "schema Beamer");
    s.compare(&["dump", bp, "--toc"], "dump --toc Beamer");
    let review = s.copy_fixture("Synthetic/review_changes.lyx", "review_changes.lyx");
    s.compare(&["dump", path_arg(&review)], "dump review_changes");
}

fn gold_undo(s: &GoldSession, fixture: &str, tag: &str) {
    // Snapshots are keyed by file-content hash in a shared IsolatedHome undo
    // dir. Run rust to completion before gold so identical post-set hashes
    // cannot overwrite each other's snapshot.
    let rust_file = s.copy_fixture(fixture, &format!("{tag}_undo_rust.lyx"));
    let rust_path = path_arg(&rust_file);
    let rust_set = s.run_rust(&["set", rust_path, "layout[Standard]:first", "s12-gold-undo"]);
    let rust = s.run_rust(&["undo", rust_path]);

    let gold_file = s.copy_fixture(fixture, &format!("{tag}_undo_gold.lyx"));
    let gold_path = path_arg(&gold_file);
    let gold_set = s.run_gold(&["set", gold_path, "layout[Standard]:first", "s12-gold-undo"]);
    let gold = s.run_gold(&["undo", gold_path]);

    compare_cli(&rust_set, &gold_set, &format!("undo-prep set {tag}"));
    compare_cli(&rust, &gold, &format!("undo {tag}"));
    compare_lyx_files(&rust_file, &gold_file, &format!("undo {tag} file"));
}
