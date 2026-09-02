//! Project state CLI (Deno `tests/project_state_test.ts` init cases).

mod common;

use common::{
    IsolatedHome, WorkDir, fixtures_root, json_stdout, parse_cli_json, path_arg, run_cli_no_home,
    run_cli_with,
};
use std::fs;

#[test]
fn cli_local_init_creates_local_config_without_copying_global_values() {
    let project = WorkDir::new();
    fs::create_dir_all(project.path().join(".lq")).unwrap();
    fs::create_dir_all(project.path().join("src")).unwrap();
    let home = IsolatedHome::new();
    let layouts = WorkDir::new();
    fs::write(
        home.path().join(".lq/config.json"),
        serde_json::json!({
            "layoutsDir": layouts.path().to_string_lossy(),
            "refresh": "reload",
            "trackChanges": false,
            "maxCacheEntries": 7,
            "authorName": "global user",
        })
        .to_string(),
    )
    .unwrap();

    let created = run_cli_with(
        &["init", "--layouts-dir", layouts.path().to_str().unwrap()],
        &home,
        project.path(),
    );
    assert_eq!(created.code, 0, "{}", created.stdout);
    let v = json_stdout(&created);
    assert_eq!(v["scope"], "local");
    assert_eq!(v["action"], "created");
    assert_eq!(v["data"]["trackChanges"], true);
    assert_eq!(v["data"]["refresh"], "none");
    assert_eq!(v["data"]["authorName"], "lq user");
    assert_eq!(v["data"]["maxCacheEntries"], 50);

    let global: serde_json::Value =
        serde_json::from_str(&fs::read_to_string(home.path().join(".lq/config.json")).unwrap())
            .unwrap();
    assert_eq!(global["trackChanges"], false);
    assert_eq!(global["authorName"], "global user");

    let read = run_cli_with(&["init"], &home, &project.path().join("src"));
    let rv = json_stdout(&read);
    assert_eq!(rv["scope"], "local");
    assert_eq!(rv["action"], "read");
    assert_eq!(rv["data"]["trackChanges"], true);

    let updated = run_cli_with(&["init", "--track-changes", "off"], &home, project.path());
    let uv = json_stdout(&updated);
    assert_eq!(uv["action"], "updated");
    assert_eq!(uv["data"]["trackChanges"], false);
    assert_eq!(
        uv["data"]["layoutsDir"].as_str().unwrap(),
        layouts.path().to_str().unwrap()
    );
}

#[test]
fn cli_global_init_applies_options_and_ignores_local_target() {
    let project = WorkDir::new();
    fs::create_dir_all(project.path().join(".lq")).unwrap();
    let home = IsolatedHome::new();
    let layouts = WorkDir::new();
    fs::write(
        home.path().join(".lq/config.json"),
        serde_json::json!({
            "layoutsDir": layouts.path().to_string_lossy(),
            "refresh": "reload",
            "trackChanges": false,
            "maxCacheEntries": 7,
            "authorName": "old global user",
        })
        .to_string(),
    )
    .unwrap();

    let out = run_cli_with(
        &[
            "init",
            "--global",
            "--track-changes",
            "on",
            "--author-name",
            "new global user",
        ],
        &home,
        project.path(),
    );
    assert_eq!(out.code, 0, "{}", out.stdout);
    let v = json_stdout(&out);
    assert_eq!(v["scope"], "global");
    assert_eq!(v["action"], "updated");
    let config: serde_json::Value =
        serde_json::from_str(&fs::read_to_string(home.path().join(".lq/config.json")).unwrap())
            .unwrap();
    assert_eq!(config["trackChanges"], true);
    assert_eq!(config["authorName"], "new global user");
    assert_eq!(config["refresh"], "reload");
    assert_eq!(config["maxCacheEntries"], 7);
    assert!(!project.path().join(".lq/config.json").is_file());
}

#[test]
fn cli_local_init_works_without_a_home_directory() {
    let project = WorkDir::new();
    fs::create_dir_all(project.path().join(".lq")).unwrap();
    let layouts = WorkDir::new();
    let out = run_cli_no_home(
        &["init", "--layouts-dir", layouts.path().to_str().unwrap()],
        project.path(),
    );
    assert_eq!(out.code, 0, "{}", out.stdout);
    let v = json_stdout(&out);
    assert_eq!(v["scope"], "local");
    assert_eq!(v["action"], "created");
    assert_eq!(
        v["data"]["layoutsDir"].as_str().unwrap(),
        layouts.path().to_str().unwrap()
    );
}

#[test]
fn dl127_f5b_init_in_a_config_less_local_scope_does_not_warn() {
    let project = WorkDir::new();
    fs::create_dir_all(project.path().join(".lq")).unwrap();
    let home = IsolatedHome::new();
    let out = run_cli_with(&["init"], &home, project.path());
    assert_eq!(out.code, 0, "{}", out.stdout);
    let v = json_stdout(&out);
    assert_eq!(v["action"], "created");
    let warnings = v["warnings"].as_array().cloned().unwrap_or_default();
    assert!(
        !warnings
            .iter()
            .any(|w| w.as_str().unwrap_or("").contains("config.json")),
        "{warnings:?}"
    );
}

#[test]
fn cli_local_cache_and_undo_stay_isolated_from_global_state() {
    let project = WorkDir::new();
    fs::create_dir_all(project.path().join(".lq")).unwrap();
    fs::write(
        project.path().join(".lq/config.json"),
        serde_json::json!({
            "refresh": "none",
            "trackChanges": false,
            "maxCacheEntries": 50
        })
        .to_string(),
    )
    .unwrap();
    let home = IsolatedHome::new();
    fs::write(
        home.path().join(".lq/config.json"),
        serde_json::json!({
            "refresh": "none",
            "trackChanges": true,
            "maxCacheEntries": 50
        })
        .to_string(),
    )
    .unwrap();
    let files = WorkDir::new();
    let file = files.path().join("scope.lyx");
    fs::copy(fixtures_root().join("my_template.lyx"), &file).unwrap();

    let read = run_cli_with(
        &["read", path_arg(&file), "layout[Title]"],
        &home,
        project.path(),
    );
    assert_eq!(read.code, 0, "{}", read.stdout);

    let local_cache = project.path().join(".lq/cache");
    let cst: Vec<_> = fs::read_dir(&local_cache)
        .unwrap()
        .filter(|e| {
            e.as_ref()
                .ok()
                .and_then(|e| e.path().extension().map(|x| x == "cst"))
                .unwrap_or(false)
        })
        .collect();
    assert_eq!(cst.len(), 1, "local cache should have one .cst");
    assert!(
        !home.path().join(".lq/cache").is_dir(),
        "global cache must not be created"
    );

    let set = run_cli_with(
        &["set", path_arg(&file), "layout[Title]", "Local edit"],
        &home,
        project.path(),
    );
    assert_eq!(set.code, 0, "{}", set.stdout);
    let after = parse_cli_json(&run_cli_with(
        &["read", path_arg(&file), "layout[Title]", "--text-only"],
        &home,
        project.path(),
    ));
    let text = after["text"].as_str().unwrap_or("");
    assert!(text.contains("layout[Title] Local edit"), "{text}");
    assert!(!text.contains("\\change_deleted"), "{text}");

    let undone = parse_cli_json(&run_cli_with(
        &["undo", path_arg(&file)],
        &home,
        project.path(),
    ));
    assert_eq!(undone["method"], serde_json::json!("snapshot"));
    assert!(
        fs::read_to_string(&file).unwrap().contains("\nTitle\n"),
        "title restored"
    );
}
