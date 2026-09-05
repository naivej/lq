//! Harness tests for S0 (isolated HOME/cwd, optional gold binary).

mod common;

use std::path::PathBuf;

fn crate_root() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
}

fn parent_repo_root() -> PathBuf {
    crate_root()
        .parent()
        .expect("lq crate is a subdirectory of the parent repo")
        .to_path_buf()
}

#[test]
fn run_cli_does_not_create_lq_marker_in_repo() {
    let crate_marker = crate_root().join(".lq");
    let parent_marker = parent_repo_root().join(".lq");
    let crate_had = crate_marker.exists();
    let parent_had = parent_marker.exists();

    let out = common::run_cli(&[]);
    assert_eq!(out.code, 0, "stderr: {}", out.stderr);
    let home = common::run_cli(&["help"]);
    assert_eq!(out.stdout, home.stdout, "bare lq prints the home help page");

    assert_eq!(
        crate_marker.exists(),
        crate_had,
        "run_cli must not create {} (lessons §5 / DL102)",
        crate_marker.display()
    );
    assert_eq!(
        parent_marker.exists(),
        parent_had,
        "run_cli must not create {} (lessons §5 / DL102)",
        parent_marker.display()
    );
}

#[test]
fn isolated_home_has_lq_dir() {
    let home = common::IsolatedHome::new();
    assert!(
        home.path().join(".lq").is_dir(),
        "IsolatedHome must create {}/.lq",
        home.path().display()
    );
}

#[test]
fn temp_lyx_copies_fixture_into_work_dir() {
    let work = common::WorkDir::new();
    let dest = common::temp_lyx(&work, "my_template.lyx");
    assert!(dest.exists(), "missing {}", dest.display());
    let text = std::fs::read_to_string(&dest).unwrap();
    assert!(
        text.contains(r"\lyxformat"),
        "copied fixture is not a LyX file: {}",
        dest.display()
    );
}

#[test]
fn gold_helper_is_none_when_lq_deno_bin_unset() {
    match common::deno_bin() {
        None => assert!(
            common::run_gold(&[]).is_none(),
            "run_gold must be None when LQ_DENO_BIN is unset"
        ),
        Some(bin) => {
            let out = common::run_gold(&[]).unwrap_or_else(|| {
                panic!(
                    "LQ_DENO_BIN is set ({}) but run_gold returned None",
                    bin.display()
                );
            });
            let _ = out.code;
        }
    }
}
