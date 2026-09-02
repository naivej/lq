use std::path::PathBuf;

fn fixtures_root() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures")
}

#[test]
fn synthetic_hostile_fixture_is_readable() {
    let path = fixtures_root().join("Synthetic/hostile.lyx");
    let content = std::fs::read_to_string(&path)
        .unwrap_or_else(|e| panic!("failed to read {}: {e}", path.display()));
    assert!(
        content.contains(r"\lyxformat"),
        "expected LyX format marker in {}",
        path.display()
    );
}
