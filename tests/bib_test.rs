use lq::{format_bibliography_entry, parse_bibtex};

#[test]
fn parse_bibtex_authoryear_abernethy2003() {
    let path = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("tests/fixtures/biblioExample.bib");
    let raw = std::fs::read_to_string(&path).unwrap();
    let cit = parse_bibtex(&raw)
        .into_iter()
        .find(|c| c.key == "Abernethy2003")
        .expect("Abernethy2003 missing");
    let html = format_bibliography_entry(&cit);
    assert!(html.contains("Abernethy, Colin D. et al. (2003)"), "{html}");
    assert!(
        html.contains("“A highly stable N-heterocyclic carbene"),
        "{html}"
    );
    assert!(html.contains("Cl—C(carbene)"), "{html}");
    assert!(html.contains("<i>J. Am. Chem. Soc.</i>"), "{html}");
    assert!(html.contains("125.5"), "{html}");
    assert!(html.contains("pp. 1128–1129"), "{html}");
    assert!(html.contains("doi: 10.1021/ja0276321"), "{html}");
}

#[test]
fn format_bibliography_entry_does_not_panic_on_multibyte_authors() {
    let cit = lq::Citation {
        key: "moreau".into(),
        author: Some("François Moreau".into()),
        year: Some("2020".into()),
        title: Some("A paper".into()),
        ..lq::Citation::default()
    };
    let html = format_bibliography_entry(&cit);
    assert!(html.contains("Moreau, François"), "{html}");
    assert!(html.contains("(2020)"), "{html}");
}
