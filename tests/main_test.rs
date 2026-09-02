//! Lossless round-trip (Deno `tests/main_test.ts`).

use std::fs;
use std::path::{Path, PathBuf};

fn fixtures_root() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures")
}

fn collect_lyx(dir: &Path, out: &mut Vec<PathBuf>) {
    let mut entries: Vec<PathBuf> = fs::read_dir(dir)
        .unwrap_or_else(|e| panic!("read_dir {}: {e}", dir.display()))
        .map(|e| e.expect("dir entry").path())
        .collect();
    entries.sort();
    for p in entries {
        if p.is_dir() {
            collect_lyx(&p, out);
        } else if p.extension().and_then(|s| s.to_str()) == Some("lyx") {
            out.push(p);
        }
    }
}

#[test]
fn lossless_round_trip_parsing() {
    let mut files = Vec::new();
    collect_lyx(&fixtures_root(), &mut files);
    assert!(
        !files.is_empty(),
        "no .lyx fixtures under {}",
        fixtures_root().display()
    );

    let mut failed: Vec<String> = Vec::new();
    for path in &files {
        let original =
            fs::read_to_string(path).unwrap_or_else(|e| panic!("read {}: {e}", path.display()));
        let normalized = original.replace("\r\n", "\n");
        match lq::parse(&normalized, false) {
            Ok(doc) => {
                let serialized = lq::serialize(&doc);
                if serialized != normalized {
                    failed.push(format!(
                        "{}: serialize mismatch (orig {} bytes, out {} bytes)",
                        path.display(),
                        normalized.len(),
                        serialized.len()
                    ));
                }
            }
            Err(e) => failed.push(format!("{}: parse: {}", path.display(), e.message)),
        }
    }
    assert!(
        failed.is_empty(),
        "round-trip failed for {} of {} fixtures:\n{}",
        failed.len(),
        files.len(),
        failed.join("\n")
    );
}
