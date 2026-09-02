//! Query engine (Deno `tests/query_test.ts`).

use lq::{Document, NodeId, NodeKind, PseudoName, parse, parse_selector, query};

fn fixture() -> Document {
    let path =
        std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/my_template.lyx");
    let text = std::fs::read_to_string(path).unwrap();
    parse(&text, false).unwrap()
}

fn parse_lyx(body: &str) -> Document {
    parse(body, false).unwrap()
}

fn q(doc: &Document, sel: &str) -> Vec<NodeId> {
    query(doc, sel).unwrap()
}

fn q_err(doc: &Document, sel: &str) -> String {
    query(doc, sel).unwrap_err().message
}

fn parse_err(sel: &str) -> String {
    parse_selector(sel).unwrap_err().message
}

fn is_property(doc: &Document, id: NodeId) -> bool {
    matches!(doc.node(id).kind, NodeKind::Property { .. })
}

fn is_block(doc: &Document, id: NodeId) -> bool {
    matches!(doc.node(id).kind, NodeKind::Block { .. })
}

fn is_text(doc: &Document, id: NodeId) -> bool {
    matches!(doc.node(id).kind, NodeKind::Text { .. })
}

fn prop_value(doc: &Document, id: NodeId) -> Option<&str> {
    match &doc.node(id).kind {
        NodeKind::Property { value, .. } => value.as_deref(),
        _ => None,
    }
}

fn block_tag(doc: &Document, id: NodeId) -> Option<&str> {
    match &doc.node(id).kind {
        NodeKind::Block { tag, .. } => Some(tag.as_str()),
        _ => None,
    }
}

fn block_args(doc: &Document, id: NodeId) -> Option<&str> {
    match &doc.node(id).kind {
        NodeKind::Block { args, .. } => args.as_deref(),
        _ => None,
    }
}

fn text_of(doc: &Document, id: NodeId) -> Option<&str> {
    match &doc.node(id).kind {
        NodeKind::Text { text } => Some(text.as_str()),
        _ => None,
    }
}

fn texts<'a>(doc: &'a Document, ids: &[NodeId]) -> Vec<&'a str> {
    ids.iter().filter_map(|&id| text_of(doc, id)).collect()
}

fn args_list(doc: &Document, ids: &[NodeId]) -> Vec<String> {
    ids.iter()
        .filter(|id| is_block(doc, **id))
        .map(|id| block_args(doc, *id).unwrap_or("").to_string())
        .collect()
}

const TRACKED_QUERY_BODY: &str = "#LyX 2.5 created this file.\n\
\\begin_document\n\
\\begin_header\n\
\\author 1 \"Alice\"\n\
\\end_header\n\
\\begin_body\n\
\\begin_layout Standard\n\
current words here\n\
\\change_inserted 1 1700000000\n\
inserted words\n\
\\change_unchanged\n\
\\change_deleted 1 1700000001\n\
deleted words\n\
\\change_unchanged\n\
more current\n\
\\end_layout\n\
\\begin_layout Section\n\
plain section text\n\
\\end_layout\n\
\\end_body\n\
\\end_document\n";

const STYLE_QUERY_BODY: &str = "#LyX 2.5 created this file.\n\
\\begin_document\n\
\\begin_header\n\
\\textclass article\n\
\\end_header\n\
\\begin_body\n\
\\begin_layout Standard\n\
This is \n\
\\emph on\n\
emphasized text\n\
\\emph default\n\
and \n\
\\series bold\n\
bold text\n\
\\series default\n\
here.\n\
\\end_layout\n\
\\begin_layout Section\n\
plain section\n\
\\end_layout\n\
\\end_body\n\
\\end_document\n";

const INSET_STYLE_BODY: &str = "#LyX 2.5 created this file.\n\
\\begin_document\n\
\\begin_header\n\
\\textclass article\n\
\\end_header\n\
\\begin_body\n\
\\begin_layout Standard\n\
\\emph on\n\
before \n\
\\begin_inset Foot\n\
status open\n\
\n\
\\begin_layout Plain Layout\n\
foot content\n\
\\end_layout\n\
\n\
\\end_inset\n\
\n\
 after\n\
\\emph default\n\
\\end_layout\n\
\\end_body\n\
\\end_document\n";

const TRACKED_STYLE_BODY: &str = "#LyX 2.5 created this file.\n\
\\begin_document\n\
\\begin_header\n\
\\textclass article\n\
\\author 1 \"Alice\"\n\
\\end_header\n\
\\begin_body\n\
\\begin_layout Standard\n\
\\emph on\n\
\\change_deleted 1 1700000000\n\
rejected emph\n\
\\change_unchanged\n\
\\change_inserted 1 1700000001\n\
accepted\n\
\\change_unchanged\n\
\\emph default\n\
current plain\n\
\\end_layout\n\
\\end_body\n\
\\end_document\n";

const INSET_DELETED_BODY: &str = "#LyX 2.5 created this file.\n\
\\begin_document\n\
\\begin_header\n\
\\textclass article\n\
\\author 1 \"Alice\"\n\
\\end_header\n\
\\begin_body\n\
\\begin_layout Standard\n\
\\change_deleted 1 1700000000\n\
rejected \n\
\\begin_inset Foot\n\
status open\n\
\n\
\\begin_layout Plain Layout\n\
foot body\n\
\\end_layout\n\
\n\
\\end_inset\n\
\n\
\\change_unchanged\n\
current\n\
\\end_layout\n\
\\end_body\n\
\\end_document\n";

const DL99_BODY: &str = "\\begin_layout Section\n\
Section One\n\
\\end_layout\n\
\n\
\\begin_layout Standard\n\
Visible alpha.\n\
\\begin_inset Note Note\n\
status collapsed\n\
\n\
\\begin_layout Plain Layout\n\
PRIVATE SECRET note\n\
\\end_layout\n\
\n\
\\end_inset\n\
\n\
Visible beta.\n\
\\end_layout\n\
\n\
\\begin_layout Standard\n\
\\begin_inset Note Comment\n\
status collapsed\n\
\n\
\\begin_layout Plain Layout\n\
COMMENT SECRET\n\
\\end_layout\n\
\n\
\\end_inset\n\
\n\
\\end_layout\n\
\n\
\\begin_layout Standard\n\
\\begin_inset Note Greyedout\n\
status collapsed\n\
\n\
\\begin_layout Plain Layout\n\
GREY VISIBLE\n\
\\end_layout\n\
\n\
\\end_inset\n\
\n\
\\end_layout\n";

fn dl99_ast() -> Document {
    parse_lyx(&format!(
        "#LyX 2.5 created this file.\n\\begin_document\n\\begin_header\n\\textclass article\n\\end_header\n\\begin_body\n{DL99_BODY}\\end_body\n\\end_document\n"
    ))
}

fn dl99_text(doc: &Document, ids: &[NodeId]) -> String {
    texts(doc, ids).join("|")
}

const DL104_BODY: &str = "\\begin_layout Section\n\
First Section\n\
\\end_layout\n\
\n\
\\begin_layout Standard\n\
Before one\n\
\\end_layout\n\
\n\
\\begin_layout Subsection\n\
First Subsection\n\
\\end_layout\n\
\n\
\\begin_layout Standard\n\
Before two\n\
\\end_layout\n\
\n\
\\begin_layout Subsection\n\
Second Subsection\n\
\\end_layout\n\
\n\
\\begin_layout Standard\n\
After subsection\n\
\\end_layout\n\
\n\
\\begin_layout Section\n\
Second Section\n\
\\begin_inset Float table\n\
status open\n\
\n\
\\begin_layout Plain Layout\n\
Inside table\n\
\\end_layout\n\
\n\
\\end_inset\n\
\n\
\\end_layout\n\
\n\
\\begin_layout Standard\n\
After boundary\n\
\\end_layout\n";

fn dl104_ast() -> Document {
    parse_lyx(&format!(
        "#LyX 2.5 created this file.\n\\begin_document\n\\begin_header\n\\textclass article\n\\end_header\n\\begin_body\n{DL104_BODY}\\end_body\n\\end_document\n"
    ))
}

const DL119_BODY: &str = "\\begin_layout Standard\n\
Anchor A\n\
\\end_layout\n\
\n\
\\begin_layout Section\n\
Cut here\n\
\\end_layout\n\
\n\
\\begin_layout Standard\n\
Before float\n\
\\begin_inset Float table\n\
status open\n\
\n\
\\begin_layout Plain Layout\n\
Nested N1\n\
\\end_layout\n\
\n\
\\begin_layout Plain Layout\n\
Nested N2\n\
\\end_layout\n\
\n\
\\end_inset\n\
\n\
\\end_layout\n";

fn dl119_ast() -> Document {
    parse_lyx(&format!(
        "#LyX 2.5 created this file.\n\\begin_document\n\\begin_header\n\\textclass article\n\\end_header\n\\begin_body\n{DL119_BODY}\\end_body\n\\end_document\n"
    ))
}

#[test]
fn selector_parsing() {
    let parsed7 = parse_selector("layout:contains('hello, world')").unwrap();
    assert_eq!(parsed7.len(), 1);
    assert_eq!(
        parsed7[0][0].pseudos[0].arg_raw.as_deref(),
        Some("'hello, world'")
    );

    let parsed8 = parse_selector("layout[A], layout[B]").unwrap();
    assert_eq!(parsed8.len(), 2);

    for sel in [":contains(\"text\")", ":first"] {
        let bare_err = parse_err(sel);
        assert!(bare_err.contains("must follow a tag"), "{sel}: {bare_err}");
    }
}

#[test]
fn query_engine_on_lyx_document() {
    let ast = fixture();

    let class_node = q(&ast, "textclass");
    assert_eq!(class_node.len(), 1);
    assert!(is_property(&ast, class_node[0]));
    assert_eq!(prop_value(&ast, class_node[0]), Some("article"));

    let sections = q(&ast, "layout[Section]");
    assert_eq!(sections.len(), 2);

    let formulas = q(&ast, "layout inset[Formula]");
    assert_eq!(formulas.len(), 2);

    let first_section = q(&ast, "layout[Section]:first");
    assert_eq!(first_section.len(), 1);
    if is_block(&ast, first_section[0]) {
        let child = ast.node(first_section[0]).children[0];
        if is_text(&ast, child) {
            assert_eq!(text_of(&ast, child), Some("Section "));
        }
    }

    let second_section = q(&ast, "layout[Section]:nth-match(2)");
    assert_eq!(second_section.len(), 1);

    let all_sections = q(&ast, "layout[Section]");
    let odd_sections = q(&ast, "layout[Section]:nth-match(odd)");
    let even_sections = q(&ast, "layout[Section]:nth-match(even)");
    assert_eq!(odd_sections.len() + even_sections.len(), all_sections.len());
    if all_sections.len() >= 2 {
        assert_eq!(odd_sections[0], all_sections[0]);
        assert_eq!(even_sections[0], all_sections[1]);
    }

    let chained = q(&ast, "layout[Section]:first:contains(\"Section\")");
    assert_eq!(chained.len(), 1);

    let headings = q(&ast, "layout[Title], layout[Author]");
    assert_eq!(headings.len(), 2);

    let res1 = q(&ast, "layout[Section]:first");
    assert_eq!(res1.len(), 1);
    assert_eq!(block_args(&ast, res1[0]), Some("Section"));

    let res2 = q(&ast, "inset[Formula]");
    assert_eq!(res2.len(), 2);

    assert_eq!(q(&ast, "layout[Standard]:contains(\"GDP\")").len(), 0);
    let res4 = q(&ast, "layout[Standard]:contains(\"tracked changes\")");
    assert_eq!(res4.len(), 1);
    assert_eq!(block_tag(&ast, res4[0]), Some("layout"));

    assert_eq!(q(&ast, "layout:contains(\"tracked changes\")").len(), 1);
    assert_eq!(q(&ast, "layout:contains(\"nickel(0)\")").len(), 0);
    assert_eq!(q(&ast, "layout:contains(\"a)b)c\")").len(), 0);

    let all_std = q(&ast, "layout[Standard]");
    let std_no_formula = q(&ast, "layout[Standard]:not(inset[Formula])");
    assert_eq!(all_std.len(), 12);
    assert_eq!(std_no_formula.len(), 11);
    assert_eq!(
        q(&ast, "layout[Standard]:not(inset[Nonexistent])").len(),
        all_std.len()
    );

    assert_eq!(
        q(&ast, "layout[Standard]:adjacent(layout[Section])").len(),
        2
    );
    assert_eq!(q(&ast, "layout[Section]:adjacent(layout[Title])").len(), 0);
    assert_eq!(
        q(&ast, "layout[Section]:adjacent(layout[Section])").len(),
        0
    );
    assert_eq!(
        q(&ast, "layout[Standard]:adjacent(layout[Section]):first").len(),
        1
    );

    assert!(parse_selector("layout:adjacent()").is_err());

    assert_eq!(q(&ast, "layout:not(:contains(\"Section\"))").len(), 58);
    assert_eq!(q(&ast, "layout:adjacent(:contains(\"Section\"))").len(), 2);
    assert_eq!(
        q(&ast, "layout[Standard]:not(:contains(\"tracked changes\"))").len(),
        11
    );

    assert_eq!(
        q(
            &ast,
            "layout[Standard]:contains('writing'):contains('paper')"
        )
        .len(),
        1
    );
    assert_eq!(q(&ast, "layout[Standard]:contains('writing')").len(), 1);
    assert_eq!(q(&ast, "layout[Standard]:contains('paper')").len(), 1);
    let dual = parse_selector("layout[Standard]:contains('writing'):contains('paper')").unwrap();
    assert_eq!(dual[0][0].pseudos.len(), 2);
    assert_eq!(dual[0][0].pseudos[0].name, PseudoName::Contains);
    assert_eq!(dual[0][0].pseudos[1].name, PseudoName::Contains);
}

#[test]
fn dl115_contains_not_contains_partition_own_text_included() {
    let ast = fixture();
    let all_layouts = q(&ast, "layout");
    for phrase in [
        "tracked changes",
        "Section",
        "sec:Section_label",
        "GDP",
        "nickel(0)",
    ] {
        let pos = q(&ast, &format!("layout:contains(\"{phrase}\")"));
        let neg = q(&ast, &format!("layout:not(:contains(\"{phrase}\"))"));
        assert_eq!(
            pos.len() + neg.len(),
            all_layouts.len(),
            "partition size for {phrase}"
        );
        let pos_set: std::collections::HashSet<_> = pos.iter().copied().collect();
        assert!(
            !neg.iter().any(|n| pos_set.contains(n)),
            "overlap for {phrase}"
        );
    }

    let note_phrase = "I like to use lyx note";
    assert_eq!(
        q(&ast, &format!("layout:contains(\"{note_phrase}\")")).len(),
        0
    );
    let neg_note = q(&ast, &format!("layout:not(:contains(\"{note_phrase}\"))"));
    let own_text_holders: Vec<_> = neg_note
        .iter()
        .copied()
        .filter(|&n| {
            is_block(&ast, n)
                && ast
                    .node(n)
                    .children
                    .iter()
                    .any(|&c| text_of(&ast, c).is_some_and(|t| t.contains(note_phrase)))
        })
        .collect();
    assert_eq!(own_text_holders.len(), 1);
}

#[test]
fn dl90_change_selects_text_nodes_by_region() {
    let ast = parse_lyx(TRACKED_QUERY_BODY);
    let deleted = q(&ast, "text:change(deleted)");
    assert_eq!(deleted.len(), 1);
    assert_eq!(text_of(&ast, deleted[0]), Some("deleted words"));
    let inserted = q(&ast, "text:change(inserted)");
    assert_eq!(inserted.len(), 1);
    assert_eq!(text_of(&ast, inserted[0]), Some("inserted words"));
    let current = q(&ast, "text:change(current)");
    let cur_texts = texts(&ast, &current);
    assert!(cur_texts.contains(&"current words here"));
    assert!(cur_texts.contains(&"more current"));
    assert!(cur_texts.contains(&"plain section text"));
    assert!(!cur_texts.contains(&"inserted words"));
    assert!(!cur_texts.contains(&"deleted words"));
}

#[test]
fn dl90_change_on_layouts_selects_region_bearing_layouts() {
    let ast = parse_lyx(TRACKED_QUERY_BODY);
    let del_layouts = q(&ast, "layout:change(deleted)");
    assert_eq!(del_layouts.len(), 1);
    assert_eq!(block_tag(&ast, del_layouts[0]), Some("layout"));
    assert_eq!(q(&ast, "layout:change(inserted)").len(), 1);
    assert_eq!(
        q(&ast, "layout:change(current)").len(),
        2,
        "Standard + Section both contain current text"
    );
}

#[test]
fn dl90_change_rejects_invalid_or_missing_arguments() {
    let ast = parse_lyx(TRACKED_QUERY_BODY);
    let err = q_err(&ast, "text:change(bogus)");
    assert!(err.contains("Invalid :change() argument"), "{err}");
    let err = q_err(&ast, "text:change()");
    assert!(err.contains("requires an argument"), "{err}");
}

#[test]
fn dl127_f3_empty_or_whitespace_nth_match_requires_an_argument() {
    let ast = parse_lyx(TRACKED_QUERY_BODY);
    for sel in [
        "layout[Standard]:nth-match()",
        "layout[Standard]:nth-match( )",
        "layout[Standard]:nth-match(  )",
    ] {
        let err = q_err(&ast, sel);
        assert!(err.contains("requires an argument"), "{sel} -> {err}");
    }
    let sections = q(&ast, "layout:nth-match(2n + 1)");
    assert!(!sections.is_empty(), "2n + 1 formula still works");
}

#[test]
fn dl91_text_arg_hard_errors_instead_of_silently_matching_all() {
    let ast = parse_lyx(TRACKED_QUERY_BODY);
    let direct_err = parse_err("text[foo]");
    assert!(
        direct_err.contains("text nodes have no [args]"),
        "{direct_err}"
    );

    let nested_err = parse_err("layout:not(text[foo])");
    assert!(
        nested_err.contains("Invalid selector inside :not()"),
        "{nested_err}"
    );

    for sel in ["text[changeStatus=inserted]", "text[foo]"] {
        let err = q_err(&ast, sel);
        assert!(err.contains("text nodes have no [args]"), "{sel} -> {err}");
        assert!(
            err.contains("layout:contains"),
            "{sel} points to content selection"
        );
        assert!(
            !err.contains("text:contains"),
            "{sel} must not recommend text:contains"
        );
        assert!(
            err.contains("text:change"),
            "{sel} points to region selection"
        );
    }
    assert!(
        !q(&ast, "text").is_empty(),
        "bare 'text' selector still matches"
    );
}

#[test]
fn dl92_property_selects_text_by_active_inline_style() {
    let ast = parse_lyx(STYLE_QUERY_BODY);
    let emph = q(&ast, "text:property(emph)");
    assert_eq!(emph.len(), 1);
    assert_eq!(text_of(&ast, emph[0]), Some("emphasized text"));
    let bold = q(&ast, "text:property(series=bold)");
    assert_eq!(bold.len(), 1);
    assert_eq!(text_of(&ast, bold[0]), Some("bold text"));
    let upper = q(&ast, "text:property(series=BOLD)");
    assert_eq!(upper.len(), 1);
    assert_eq!(text_of(&ast, upper[0]), Some("bold text"));
    let texts_active = texts(&ast, &q(&ast, "text:property(emph)"));
    assert!(
        !texts_active.contains(&"and "),
        "emph=default must not match :property(emph)"
    );
    let def_texts = texts(&ast, &q(&ast, "text:property(emph=default)"));
    assert!(def_texts.contains(&"and "));
    assert!(def_texts.contains(&"here."));
}

#[test]
fn dl92_property_on_blocks_selects_containers_of_styled_text() {
    let ast = parse_lyx(STYLE_QUERY_BODY);
    let layouts = q(&ast, "layout:property(emph)");
    assert_eq!(layouts.len(), 1);
    assert_eq!(block_tag(&ast, layouts[0]), Some("layout"));
    assert_eq!(q(&ast, "layout[Section]:property(emph)").len(), 0);
}

#[test]
fn dl92_property_validation_rejects_missing_unknown_change_keys() {
    let ast = parse_lyx(STYLE_QUERY_BODY);
    let err = q_err(&ast, "text:property()");
    assert!(err.contains("requires an argument"), "{err}");
    let err = q_err(&ast, "text:property(bogus)");
    assert!(err.contains("Invalid :property() key: 'bogus'"), "{err}");
    assert!(err.contains("Valid inline style keys are"), "{err}");
    let err = q_err(&ast, "text:property(change_deleted)");
    assert!(
        err.contains("Invalid :property() key: 'change_deleted'"),
        "{err}"
    );
    assert!(err.contains(":change(current|inserted|deleted)"), "{err}");
}

#[test]
fn dl92_property_on_a_block_sitting_inside_a_parent_style_span_matches() {
    let ast = parse_lyx(INSET_STYLE_BODY);
    let insets = q(&ast, "inset:property(emph)");
    assert_eq!(insets.len(), 1);
    assert_eq!(block_tag(&ast, insets[0]), Some("inset"));
}

#[test]
fn dl92_property_chains_with_change_as_a_conjunction() {
    let ast = parse_lyx(TRACKED_STYLE_BODY);
    let both = q(&ast, "text:property(emph):change(deleted)");
    assert_eq!(both.len(), 1);
    assert_eq!(text_of(&ast, both[0]), Some("rejected emph"));
    let emph_texts = texts(&ast, &q(&ast, "text:property(emph)"));
    assert!(emph_texts.contains(&"rejected emph"));
    assert!(emph_texts.contains(&"accepted"));
}

#[test]
fn dl92_change_block_matches_an_inset_sitting_inside_a_deleted_region() {
    let ast = parse_lyx(INSET_DELETED_BODY);
    let insets = q(&ast, "inset:change(deleted)");
    assert_eq!(insets.len(), 1);
    assert_eq!(block_tag(&ast, insets[0]), Some("inset"));
    let nested_text = q(&ast, "text:change(deleted)");
    assert!(
        nested_text
            .iter()
            .any(|&n| text_of(&ast, n) == Some("foot body"))
    );
    assert_eq!(q(&ast, "layout[Plain Layout]:change(deleted)").len(), 1);
    assert_eq!(q(&ast, "layout:change(deleted)").len(), 2);
}

#[test]
fn report_42_f2_inherited_style_state_reaches_nested_inset_prose() {
    let ast = parse_lyx(INSET_STYLE_BODY);
    let nested_text = q(&ast, "text:property(emph)");
    assert!(
        nested_text
            .iter()
            .any(|&n| text_of(&ast, n) == Some("foot content"))
    );
    assert_eq!(q(&ast, "layout[Plain Layout]:property(emph)").len(), 1);
}

#[test]
fn dl99_bare_contains_excludes_private_note_prose() {
    let ast = dl99_ast();
    assert_eq!(q(&ast, "layout:contains('PRIVATE SECRET')").len(), 0);
    assert_eq!(q(&ast, "layout:contains('COMMENT SECRET')").len(), 0);
}

#[test]
fn dl99_note_and_explicit_note_path_reach_note_prose() {
    let ast = dl99_ast();
    assert_eq!(q(&ast, "layout:note:contains('PRIVATE SECRET')").len(), 1);
    assert_eq!(
        q(
            &ast,
            "inset[Note Note] layout[Plain Layout]:contains('PRIVATE SECRET')"
        )
        .len(),
        1
    );
    assert_eq!(
        q(
            &ast,
            "inset[Note Note] layout[Plain Layout]:contains('COMMENT SECRET')"
        )
        .len(),
        0
    );
}

#[test]
fn dl99_bare_text_excludes_notes_note_and_explicit_path_include_them() {
    let ast = dl99_ast();
    let bare = dl99_text(&ast, &q(&ast, "text"));
    assert!(!bare.contains("PRIVATE SECRET"));
    assert!(!bare.contains("COMMENT SECRET"));
    let note_text = dl99_text(&ast, &q(&ast, "text:note"));
    assert!(note_text.contains("PRIVATE SECRET"));
    assert!(note_text.contains("COMMENT SECRET"));
    assert!(!note_text.contains("GREY VISIBLE"));
    let descendant = dl99_text(&ast, &q(&ast, "layout[Standard] text"));
    assert!(!descendant.contains("PRIVATE SECRET"));
    let explicit = dl99_text(&ast, &q(&ast, "layout[Standard] inset[Note Note] text"));
    assert!(explicit.contains("PRIVATE SECRET"));
}

#[test]
fn dl99_union_is_per_group() {
    let ast = dl99_ast();
    let bare_count = q(&ast, "text").len();
    let note_count = q(&ast, "text:note").len();
    let union = q(&ast, "text, text:note");
    assert_eq!(union.len(), bare_count + note_count);
}

#[test]
fn dl99_state_axis_still_sees_note_prose() {
    let ast = parse_lyx(
        "#LyX 2.5 created this file.\n\\begin_document\n\\begin_header\n\\textclass article\n\\end_header\n\\begin_body\n\
\\begin_layout Standard\n\
\\change_deleted 1 1700000000\n\
deleted visible\n\
\\begin_inset Note Note\n\
status collapsed\n\
\n\
\\begin_layout Plain Layout\n\
DELETED NOTE SECRET\n\
\\end_layout\n\
\n\
\\end_inset\n\
\\change_unchanged\n\
\\end_layout\n\
\\end_body\n\\end_document\n",
    );
    let del = dl99_text(&ast, &q(&ast, "text:change(deleted)"));
    assert!(del.contains("DELETED NOTE SECRET"));
    let note_del = dl99_text(&ast, &q(&ast, "text:note:change(deleted)"));
    assert!(note_del.contains("DELETED NOTE SECRET"));
    assert!(!note_del.contains("deleted visible"));
    let deleted_layouts = q(&ast, "layout:change(deleted)");
    assert!(
        deleted_layouts
            .iter()
            .any(|&n| block_args(&ast, n) == Some("Plain Layout"))
    );
}

#[test]
fn dl99_not_inset_note_and_not_note_still_work() {
    let ast = dl99_ast();
    assert_eq!(q(&ast, "layout[Standard]:not(inset[Note Note])").len(), 2);
    assert!(!q(&ast, "layout:not(:note)").is_empty());
}

#[test]
fn dl99_greyedout_stays_visible_note_greyedout_errors() {
    let ast = dl99_ast();
    assert_eq!(
        q(&ast, "layout[Plain Layout]:contains('GREY VISIBLE')").len(),
        1
    );
    let err = q_err(&ast, "layout:note(Greyedout)");
    assert!(err.contains("Invalid :note() argument"));
    assert!(!q(&ast, "layout:note(Comment)").is_empty());
}

#[test]
fn dl99_note_note_note_comment_filter_by_note_type() {
    let ast = dl99_ast();
    let note = q(&ast, "text:note");
    assert!(
        note.iter()
            .any(|&n| text_of(&ast, n).is_some_and(|t| t.contains("PRIVATE SECRET")))
    );
    assert!(
        note.iter()
            .any(|&n| text_of(&ast, n).is_some_and(|t| t.contains("COMMENT SECRET")))
    );
    let only_note = q(&ast, "text:note(Note)");
    assert!(
        only_note
            .iter()
            .any(|&n| text_of(&ast, n).is_some_and(|t| t.contains("PRIVATE SECRET")))
    );
    assert!(
        !only_note
            .iter()
            .any(|&n| text_of(&ast, n).is_some_and(|t| t.contains("COMMENT SECRET")))
    );
    let only_comment = q(&ast, "text:note(Comment)");
    assert!(
        only_comment
            .iter()
            .any(|&n| text_of(&ast, n).is_some_and(|t| t.contains("COMMENT SECRET")))
    );
    assert!(
        !only_comment
            .iter()
            .any(|&n| text_of(&ast, n).is_some_and(|t| t.contains("PRIVATE SECRET")))
    );
    assert_eq!(q(&ast, "inset[Note Note]:note(Note)").len(), 1);
    assert_eq!(q(&ast, "inset[Note Note]:note(Comment)").len(), 0);
    assert_eq!(q(&ast, "inset[Note Comment]:note(Comment)").len(), 1);
    assert_eq!(
        q(&ast, "layout:note(Comment):contains('COMMENT SECRET')").len(),
        1
    );
    assert_eq!(
        q(&ast, "layout:note(Comment):contains('PRIVATE SECRET')").len(),
        0
    );
}

#[test]
fn dl99_sibling_with_a_note_in_a_following_siblings_descendants() {
    let ast = dl99_ast();
    let sib_text = dl99_text(&ast, &q(&ast, "layout[Section] ~ layout[Standard] text"));
    assert!(!sib_text.contains("PRIVATE SECRET"));
    assert!(sib_text.contains("Visible alpha"));
}

#[test]
fn dl104_bare_until_excludes_boundary_node_and_its_descendants() {
    let ast = dl104_ast();
    let res = q(
        &ast,
        "layout[Section]:first ~ layout:until(layout[Section])",
    );
    let args = args_list(&ast, &res);
    assert_eq!(args.iter().filter(|a| *a == "Section").count(), 0);
    assert_eq!(args.iter().filter(|a| *a == "Plain Layout").count(), 0);
    assert_eq!(args.len(), 5);
    assert_eq!(args.iter().filter(|a| *a == "Standard").count(), 3);
    assert_eq!(args.iter().filter(|a| *a == "Subsection").count(), 2);
}

#[test]
fn dl104_scoped_until_counts_unchanged() {
    let ast = dl104_ast();
    let res = q(
        &ast,
        "layout[Section]:first ~ layout[Standard]:until(layout[Section])",
    );
    let args = args_list(&ast, &res);
    assert_eq!(args.len(), 3);
    assert_eq!(args[0], "Standard");
    assert_eq!(args[1], "Standard");
    assert_eq!(args[2], "Standard");
}

#[test]
fn dl104_multi_hop_until_unchanged() {
    let ast = dl104_ast();
    let res = q(
        &ast,
        "layout[Section]:first ~ layout[Subsection] ~ layout[Standard]:until(layout[Subsection])",
    );
    let args = args_list(&ast, &res);
    assert_eq!(args.len(), 3);
    assert_eq!(args[0], "Standard");
    assert_eq!(args[1], "Standard");
    assert_eq!(args[2], "Standard");
}

#[test]
fn dl104_until_contains_boundary_found_via_descendant_text() {
    let ast = dl104_ast();
    let res = q(
        &ast,
        "layout[Section]:first ~ layout[Standard]:until(layout:contains('Inside table'))",
    );
    let args = args_list(&ast, &res);
    assert_eq!(args.len(), 3);
}

#[test]
fn dl104_until_without_tilde_is_a_no_op() {
    let ast = dl104_ast();
    let all = q(&ast, "layout[Standard]").len();
    let res = q(&ast, "layout[Standard]:until(layout[Section])");
    assert_eq!(res.len(), all);
}

#[test]
fn dl119_bare_multi_depth_anchor_boundary_reopens_the_range() {
    let ast = dl119_ast();
    let res = q(&ast, "layout ~ layout:until(layout[Section])");
    let args = args_list(&ast, &res);
    assert_eq!(args.iter().filter(|a| *a == "Section").count(), 0);
    assert_eq!(args.iter().filter(|a| *a == "Plain Layout").count(), 2);
}

#[test]
fn dl119_single_level_anchor_nested_candidates_are_cut() {
    let ast = dl119_ast();
    let res = q(
        &ast,
        "layout[Standard]:contains('Anchor A'):first ~ layout:until(layout[Section])",
    );
    let args = args_list(&ast, &res);
    assert_eq!(args.iter().filter(|a| *a == "Section").count(), 0);
    assert_eq!(args.iter().filter(|a| *a == "Plain Layout").count(), 0);
}

#[test]
fn dl105_f1_candidate_before_a_nested_formula_boundary_is_kept() {
    let ast = parse_lyx(
        "#LyX 2.5 created this file.\n\
\\begin_document\n\\begin_header\n\\textclass article\n\\end_header\n\\begin_body\n\
\\begin_layout Section\nFirst Section\n\\end_layout\n\n\
\\begin_layout Standard\nContainer\n\
\\begin_inset Float table\nstatus open\n\n\
\\begin_layout Plain Layout\nCell before\n\\end_layout\n\n\
\\end_inset\n\n\
\\begin_inset Formula\nx^2\n\\end_inset\n\
\\end_layout\n\n\
\\begin_layout Standard\nAfter container\n\\end_layout\n\
\\end_body\n\\end_document\n",
    );
    let res = q(
        &ast,
        "layout[Section]:first ~ layout[Plain Layout]:until(inset[Formula])",
    );
    let args = args_list(&ast, &res);
    assert_eq!(args.len(), 1);
    assert_eq!(args[0], "Plain Layout");
}

#[test]
fn dl105_f1_contains_inner_matching_the_container_rejects_descendants() {
    let ast = parse_lyx(
        "#LyX 2.5 created this file.\n\
\\begin_document\n\\begin_header\n\\textclass article\n\\end_header\n\\begin_body\n\
\\begin_layout Section\nFirst Section\n\\end_layout\n\n\
\\begin_layout Standard\nContainer\n\
\\begin_inset Float table\nstatus open\n\n\
\\begin_layout Plain Layout\nCell A\n\\end_layout\n\n\
\\begin_layout Plain Layout\nCell B with X\n\\end_layout\n\n\
\\end_inset\n\\end_layout\n\n\
\\begin_layout Standard\nAfter\n\\end_layout\n\
\\end_body\n\\end_document\n",
    );
    let res = q(
        &ast,
        "layout[Section]:first ~ layout[Plain Layout]:until(layout:contains('X'))",
    );
    assert_eq!(res.len(), 0);
}

#[test]
fn dl99_parser_note_without_tag_errors_bare_note_in_not_parses() {
    let e1 = parse_err(":note");
    assert!(e1.contains("must follow a tag"));
    parse_selector("layout:not(:note)").unwrap();
}
