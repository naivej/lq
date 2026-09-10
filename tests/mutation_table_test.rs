//! Table helper: `insert --table` and `lq table`.

mod common;

use common::{MutationSession, json_warnings, path_arg};
use lq::{parse, query};
use serde_json::{Value, json};
use std::fs;
use std::path::Path;

const HEADER: &str = "\\textclass article\n";
const AUTHOR_ALICE: &str = "\\author 1 \"Alice\"\n\\change_tracking true\n";

const PARA: &str = r"\begin_layout Standard
Hello
\end_layout
";

fn code(v: &Value) -> &str {
    v["code"].as_str().unwrap_or("")
}

fn read_file(path: &Path) -> String {
    fs::read_to_string(path).unwrap()
}

fn cell(text: &str) -> String {
    format!(
        "<cell alignment=\"left\" valignment=\"top\" usebox=\"none\">\n\
         \\begin_inset Text\n\
         \n\
         \\begin_layout Plain Layout\n\
         {text}\n\
         \\end_layout\n\
         \n\
         \\end_inset\n\
         </cell>\n"
    )
}

fn one_cell_tabular(text: &str) -> String {
    format!(
        "<lyxtabular version=\"3\" rows=\"1\" columns=\"1\">\n\
         <features tabularvalignment=\"middle\">\n\
         <column alignment=\"left\" valignment=\"top\">\n\
         <row>\n\
         {}\
         </row>\n\
         </lyxtabular>\n",
        cell(text)
    )
}

fn two_tables_one_para() -> String {
    format!(
        "\\begin_layout Standard\n\
         \\begin_inset Tabular\n\
         {}\
         \\end_inset\n\
         \\begin_inset Tabular\n\
         {}\
         \\end_inset\n\
         \n\
         \\end_layout\n",
        one_cell_tabular("A"),
        one_cell_tabular("B")
    )
}

fn note_table() -> String {
    format!(
        "\\begin_layout Standard\n\
         \\begin_inset Note Note\n\
         status collapsed\n\
         \n\
         \\begin_layout Plain Layout\n\
         \\begin_inset Tabular\n\
         <lyxtabular version=\"3\" rows=\"1\" columns=\"2\">\n\
         <features tabularvalignment=\"middle\">\n\
         <column alignment=\"left\" valignment=\"top\">\n\
         <column alignment=\"left\" valignment=\"top\">\n\
         <row>\n\
         {}\
         {}\
         </row>\n\
         </lyxtabular>\n\
         \\end_inset\n\
         \n\
         \\end_layout\n\
         \n\
         \\end_inset\n\
         \n\
         \\end_layout\n",
        cell("x"),
        cell("y")
    )
}

fn longtable_with_caption() -> String {
    format!(
        "\\begin_layout Standard\n\
         \\begin_inset Tabular\n\
         <lyxtabular version=\"3\" rows=\"2\" columns=\"1\">\n\
         <features islongtable=\"true\" tabularvalignment=\"middle\">\n\
         <column alignment=\"left\" valignment=\"top\">\n\
         <row>\n\
         <cell alignment=\"left\" valignment=\"top\" usebox=\"none\">\n\
         \\begin_inset Text\n\
         \n\
         \\begin_layout Plain Layout\n\
         \\begin_inset Caption Standard\n\
         \n\
         \\begin_layout Plain Layout\n\
         Data\n\
         \\begin_inset CommandInset label\n\
         LatexCommand label\n\
         name \"tab:data\"\n\
         \n\
         \\end_inset\n\
         \n\
         \\end_layout\n\
         \n\
         \\end_inset\n\
         \n\
         \\end_layout\n\
         \n\
         \\end_inset\n\
         </cell>\n\
         </row>\n\
         <row>\n\
         {}\
         </row>\n\
         </lyxtabular>\n\
         \\end_inset\n\
         \n\
         \\end_layout\n",
        cell("1")
    )
}

fn merge_header_table() -> String {
    format!(
        "\\begin_layout Standard\n\
         \\begin_inset Tabular\n\
         <lyxtabular version=\"3\" rows=\"2\" columns=\"2\">\n\
         <features tabularvalignment=\"middle\">\n\
         <column alignment=\"left\" valignment=\"top\">\n\
         <column alignment=\"left\" valignment=\"top\">\n\
         <row>\n\
         <cell multicolumn=\"1\" alignment=\"left\" valignment=\"top\" usebox=\"none\">\n\
         \\begin_inset Text\n\
         \n\
         \\begin_layout Plain Layout\n\
         Head\n\
         \\end_layout\n\
         \n\
         \\end_inset\n\
         </cell>\n\
         <cell multicolumn=\"2\" alignment=\"left\" valignment=\"top\" usebox=\"none\">\n\
         \\begin_inset Text\n\
         \n\
         \\begin_layout Plain Layout\n\
         \n\
         \\end_layout\n\
         \n\
         \\end_inset\n\
         </cell>\n\
         </row>\n\
         <row>\n\
         {}\
         {}\
         </row>\n\
         </lyxtabular>\n\
         \\end_inset\n\
         \n\
         \\end_layout\n",
        cell("a"),
        cell("b")
    )
}

fn formula_table() -> String {
    format!(
        "\\begin_layout Standard\n\
         \\begin_inset Tabular\n\
         <lyxtabular version=\"3\" rows=\"1\" columns=\"2\">\n\
         <features tabularvalignment=\"middle\">\n\
         <column alignment=\"left\" valignment=\"top\">\n\
         <column alignment=\"left\" valignment=\"top\">\n\
         <row>\n\
         {}\
         <cell alignment=\"left\" valignment=\"top\" usebox=\"none\">\n\
         \\begin_inset Text\n\
         \n\
         \\begin_layout Plain Layout\n\
         \\begin_inset Formula $x$\n\
         \n\
         \\end_inset\n\
         \n\
         \\end_layout\n\
         \n\
         \\end_inset\n\
         </cell>\n\
         </row>\n\
         </lyxtabular>\n\
         \\end_inset\n\
         \n\
         \\end_layout\n",
        cell("n")
    )
}

fn wrap_tabular(inner: &str) -> String {
    format!(
        "\\begin_layout Standard\n\
         \\begin_inset Tabular\n\
         {inner}\
         \\end_inset\n\
         \n\
         \\end_layout\n"
    )
}

fn figure_hosted_table() -> String {
    format!(
        "\\begin_layout Standard\n\
         \\begin_inset Float figure\n\
         placement document\n\
         alignment document\n\
         wide false\n\
         sideways false\n\
         status open\n\
         \n\
         \\begin_layout Plain Layout\n\
         \\begin_inset Tabular\n\
         {}\
         \\end_inset\n\
         \n\
         \\end_layout\n\
         \n\
         \\end_inset\n\
         \n\
         \\end_layout\n",
        one_cell_tabular("in-figure")
    )
}

fn ab_cd_table() -> String {
    wrap_tabular(&format!(
        "<lyxtabular version=\"3\" rows=\"2\" columns=\"2\">\n\
         <features tabularvalignment=\"middle\">\n\
         <column alignment=\"left\" valignment=\"top\">\n\
         <column alignment=\"left\" valignment=\"top\">\n\
         <row>\n\
         {}\
         {}\
         </row>\n\
         <row>\n\
         {}\
         {}\
         </row>\n\
         </lyxtabular>\n",
        cell("A"),
        cell("B"),
        cell("C"),
        cell("D"),
    ))
}

fn plain_layout_bodies(text: &str) -> Vec<String> {
    text.split("\\begin_layout Plain Layout\n")
        .skip(1)
        .filter_map(|chunk| chunk.split("\\end_layout").next().map(str::to_string))
        .collect()
}

fn cell_is_insert_only(text: &str, prose: &str) -> bool {
    plain_layout_bodies(text).iter().any(|body| {
        body.contains("\\change_inserted")
            && body.contains(prose)
            && !body.contains("\\change_deleted")
    })
}

fn has_unmarked_empty_cell(text: &str) -> bool {
    plain_layout_bodies(text)
        .iter()
        .any(|body| body.trim().is_empty())
}

fn multirow_table() -> String {
    wrap_tabular(
        "<lyxtabular version=\"3\" rows=\"2\" columns=\"1\">\n\
         <features tabularvalignment=\"middle\">\n\
         <column alignment=\"left\" valignment=\"top\">\n\
         <row>\n\
         <cell multirow=\"3\" alignment=\"left\" valignment=\"top\" usebox=\"none\">\n\
         \\begin_inset Text\n\
         \n\
         \\begin_layout Plain Layout\n\
         Head\n\
         \\end_layout\n\
         \n\
         \\end_inset\n\
         </cell>\n\
         </row>\n\
         <row>\n\
         <cell multirow=\"4\" alignment=\"left\" valignment=\"top\" usebox=\"none\">\n\
         \\begin_inset Text\n\
         \n\
         \\begin_layout Plain Layout\n\
         \n\
         \\end_layout\n\
         \n\
         \\end_inset\n\
         </cell>\n\
         </row>\n\
         </lyxtabular>\n",
    )
}

fn booktabs_table() -> String {
    wrap_tabular(
        "<lyxtabular version=\"3\" rows=\"2\" columns=\"2\">\n\
         <features booktabs=\"true\" tabularvalignment=\"middle\">\n\
         <column alignment=\"left\" valignment=\"top\">\n\
         <column alignment=\"left\" valignment=\"top\">\n\
         <row>\n\
         <cell alignment=\"left\" valignment=\"top\" topline=\"true\" usebox=\"none\">\n\
         \\begin_inset Text\n\
         \n\
         \\begin_layout Plain Layout\n\
         A\n\
         \\end_layout\n\
         \n\
         \\end_inset\n\
         </cell>\n\
         <cell alignment=\"left\" valignment=\"top\" topline=\"true\" usebox=\"none\">\n\
         \\begin_inset Text\n\
         \n\
         \\begin_layout Plain Layout\n\
         B\n\
         \\end_layout\n\
         \n\
         \\end_inset\n\
         </cell>\n\
         </row>\n\
         <row>\n\
         <cell alignment=\"left\" valignment=\"top\" bottomline=\"true\" usebox=\"none\">\n\
         \\begin_inset Text\n\
         \n\
         \\begin_layout Plain Layout\n\
         C\n\
         \\end_layout\n\
         \n\
         \\end_inset\n\
         </cell>\n\
         <cell alignment=\"left\" valignment=\"top\" bottomline=\"true\" usebox=\"none\">\n\
         \\begin_inset Text\n\
         \n\
         \\begin_layout Plain Layout\n\
         D\n\
         \\end_layout\n\
         \n\
         \\end_inset\n\
         </cell>\n\
         </row>\n\
         </lyxtabular>\n",
    )
}

fn longtable_standard_and_unnumbered() -> String {
    wrap_tabular(
        "<lyxtabular version=\"3\" rows=\"2\" columns=\"1\">\n\
         <features islongtable=\"true\" tabularvalignment=\"middle\">\n\
         <column alignment=\"left\" valignment=\"top\">\n\
         <row>\n\
         <cell alignment=\"left\" valignment=\"top\" usebox=\"none\">\n\
         \\begin_inset Text\n\
         \n\
         \\begin_layout Plain Layout\n\
         \\begin_inset Caption Unnumbered\n\
         \n\
         \\begin_layout Plain Layout\n\
         continued\n\
         \\end_layout\n\
         \n\
         \\end_inset\n\
         \n\
         \\end_layout\n\
         \n\
         \\end_inset\n\
         </cell>\n\
         </row>\n\
         <row>\n\
         <cell alignment=\"left\" valignment=\"top\" usebox=\"none\">\n\
         \\begin_inset Text\n\
         \n\
         \\begin_layout Plain Layout\n\
         \\begin_inset Caption Standard\n\
         \n\
         \\begin_layout Plain Layout\n\
         Data\n\
         \\end_layout\n\
         \n\
         \\end_inset\n\
         \n\
         \\end_layout\n\
         \n\
         \\end_inset\n\
         </cell>\n\
         </row>\n\
         </lyxtabular>\n",
    )
}

fn one_row_inserted_table() -> String {
    wrap_tabular(&format!(
        "<lyxtabular version=\"3\" rows=\"1\" columns=\"2\">\n\
         <features tabularvalignment=\"middle\">\n\
         <column alignment=\"left\" valignment=\"top\">\n\
         <column alignment=\"left\" valignment=\"top\">\n\
         <row change=\"inserted 1 1\">\n\
         {}\
         {}\
         </row>\n\
         </lyxtabular>\n",
        cell("A"),
        cell("B"),
    ))
}

fn other_author_inserted_row() -> String {
    wrap_tabular(
        "<lyxtabular version=\"3\" rows=\"2\" columns=\"1\">\n\
         <features tabularvalignment=\"middle\">\n\
         <column alignment=\"left\" valignment=\"top\">\n\
         <row change=\"inserted 2 1\">\n\
         <cell alignment=\"left\" valignment=\"top\" usebox=\"none\">\n\
         \\begin_inset Text\n\
         \n\
         \\begin_layout Plain Layout\n\
         A\n\
         \\end_layout\n\
         \n\
         \\end_inset\n\
         </cell>\n\
         </row>\n\
         <row>\n\
         <cell alignment=\"left\" valignment=\"top\" usebox=\"none\">\n\
         \\begin_inset Text\n\
         \n\
         \\begin_layout Plain Layout\n\
         B\n\
         \\end_layout\n\
         \n\
         \\end_inset\n\
         </cell>\n\
         </row>\n\
         </lyxtabular>\n",
    )
}

#[test]
fn insert_table_two_row_is_float_shell() {
    let env = MutationSession::new();
    let file = env.write_lyx("t.lyx", PARA, HEADER);
    let result = env.run(&[
        "insert",
        path_arg(&file),
        "layout[Standard]:last",
        "after",
        "--table",
        "Year,GDP\n2020,1.2\n2021,1.4",
    ]);
    assert_eq!(result["matched_nodes"], json!(1), "{result}");
    let text = read_file(&file);
    assert!(text.contains("\\begin_inset Float table"), "{text}");
    assert!(text.contains("\\begin_inset Caption Standard"), "{text}");
    assert!(text.contains("\\begin_inset Tabular"), "{text}");
    assert!(text.contains("Year"), "{text}");
    assert!(text.contains("1.4"), "{text}");
    assert!(!text.contains("topline"), "{text}");
}

#[test]
fn insert_table_empty_grid_is_two_by_three() {
    let env = MutationSession::new();
    let file = env.write_lyx("t.lyx", PARA, HEADER);
    env.run(&[
        "insert",
        path_arg(&file),
        "layout[Standard]:last",
        "after",
        "--table",
        ",,\n,,",
    ]);
    let cat = env.run(&["table", path_arg(&file)]);
    assert_eq!(cat["tables"][0]["data"], json!(",,\n,,"));
}

#[test]
fn insert_table_empty_string_is_missing_content() {
    let env = MutationSession::new();
    let file = env.write_lyx("t.lyx", PARA, HEADER);
    let result = env.run(&[
        "insert",
        path_arg(&file),
        "layout[Standard]:last",
        "after",
        "--table",
        "",
    ]);
    assert_eq!(code(&result), "MISSING_CONTENT");
}

#[test]
fn insert_table_path_like_string_is_text() {
    let env = MutationSession::new();
    let file = env.write_lyx("t.lyx", PARA, HEADER);
    env.run(&[
        "insert",
        path_arg(&file),
        "layout[Standard]:last",
        "after",
        "--table",
        "a/b.csv,x",
    ]);
    let cat = env.run(&["table", path_arg(&file)]);
    assert_eq!(cat["tables"][0]["data"], json!("a/b.csv,x"));
}

#[test]
fn insert_table_quoted_comma_round_trips() {
    let env = MutationSession::new();
    let file = env.write_lyx("t.lyx", PARA, HEADER);
    env.run(&[
        "insert",
        path_arg(&file),
        "layout[Standard]:last",
        "after",
        "--table",
        "\"a,b\",c\n1,2",
    ]);
    let cat = env.run(&["table", path_arg(&file)]);
    assert_eq!(cat["tables"][0]["data"], json!("\"a,b\",c\n1,2"));
}

#[test]
fn insert_table_tab_is_not_two_columns() {
    let env = MutationSession::new();
    let file = env.write_lyx("t.lyx", PARA, HEADER);
    env.run(&[
        "insert",
        path_arg(&file),
        "layout[Standard]:last",
        "after",
        "--table",
        "a\tb,c",
    ]);
    let cat = env.run(&["table", path_arg(&file)]);
    assert_eq!(cat["tables"][0]["data"], json!("a\tb,c"));
}

#[test]
fn insert_table_conflicts_with_cite() {
    let env = MutationSession::new();
    let file = env.write_lyx("t.lyx", PARA, HEADER);
    let result = env.run(&[
        "insert",
        path_arg(&file),
        "layout[Standard]:last",
        "after",
        "--table",
        "a,b",
        "--cite",
        "x",
    ]);
    assert_eq!(code(&result), "FLAG_CONFLICT");
}

#[test]
fn insert_table_append_is_invalid_position() {
    let env = MutationSession::new();
    let file = env.write_lyx("t.lyx", PARA, HEADER);
    let result = env.run(&[
        "insert",
        path_arg(&file),
        "layout[Standard]:last",
        "append",
        "--table",
        "a,b",
    ]);
    assert_eq!(code(&result), "INVALID_POSITION");
}

#[test]
fn insert_table_inside_note_is_invalid_context() {
    let env = MutationSession::new();
    let file = env.write_lyx("t.lyx", &note_table(), HEADER);
    let result = env.run(&[
        "insert",
        path_arg(&file),
        "inset[Note Note] layout[Plain Layout]",
        "after",
        "--table",
        "a,b",
    ]);
    assert_eq!(code(&result), "INVALID_CONTEXT");
}

#[test]
fn insert_table_tracking_wraps_new_layout() {
    let env = MutationSession::tracked("Alice");
    let file = env.write_lyx("t.lyx", PARA, &format!("{HEADER}{AUTHOR_ALICE}"));
    env.run(&[
        "insert",
        path_arg(&file),
        "layout[Standard]:last",
        "after",
        "--table",
        "a,b",
    ]);
    let text = read_file(&file);
    assert!(text.contains("\\change_inserted"), "{text}");
}

#[test]
fn catalog_wraps_one_table_and_lists_two() {
    let env = MutationSession::new();
    let file = env.write_lyx("t.lyx", PARA, HEADER);
    env.run(&[
        "insert",
        path_arg(&file),
        "layout[Standard]:last",
        "after",
        "--table",
        "A,B\nC,D",
    ]);
    env.run(&[
        "insert",
        path_arg(&file),
        "layout[Standard]:last",
        "after",
        "--table",
        "E,F",
    ]);
    let cat = env.run(&["table", path_arg(&file)]);
    assert_eq!(cat["tables"].as_array().unwrap().len(), 2);
    assert!(cat["tables"][0]["data"].as_str().is_some());
    assert!(cat["tables"][0].get("cells").is_none());
    assert!(cat["tables"][0].get("rows").is_none());
    assert_eq!(cat["tables"][0]["kind"], json!("float"));
    assert!(cat["tables"][0].get("row_changes").is_none());
    assert!(cat["tables"][0].get("column_changes").is_none());
    assert!(cat["tables"][0].get("cell_changes").is_none());
    let one = env.run(&["table", path_arg(&file), "2"]);
    assert_eq!(one["tables"].as_array().unwrap().len(), 1);
    assert_eq!(one["tables"][0]["n"], json!(2));
    let zero = env.run(&["table", path_arg(&file), "0"]);
    assert_eq!(code(&zero), "NO_MATCH");
}

#[test]
fn catalog_at_is_host_plus_tabular_and_query_hits() {
    let env = MutationSession::new();
    let file = env.write_lyx("t.lyx", PARA, HEADER);
    env.run(&[
        "insert",
        path_arg(&file),
        "layout[Standard]:last",
        "after",
        "--table",
        "A,B",
    ]);
    let cat = env.run(&["table", path_arg(&file)]);
    let at = cat["tables"][0]["at"].as_str().unwrap();
    assert!(at.starts_with("layout[Standard]:nth-match("), "{at}");
    assert!(at.ends_with("inset[Tabular]"), "{at}");
    let slice = env.run(&["table", path_arg(&file), at]);
    assert_eq!(slice["tables"].as_array().unwrap().len(), 1);
    let doc = parse(&read_file(&file), false).unwrap();
    let hits = query(&doc, at).unwrap();
    assert_eq!(hits.len(), 1);
}

#[test]
fn catalog_note_hosted_at_uses_note_prefix() {
    let env = MutationSession::new();
    let file = env.write_lyx("t.lyx", &note_table(), HEADER);
    let cat = env.run(&["table", path_arg(&file)]);
    let at = cat["tables"][0]["at"].as_str().unwrap();
    assert!(at.contains("inset[Note Note]"), "{at}");
    assert!(at.contains("layout[Plain Layout]"), "{at}");
    assert!(at.ends_with("inset[Tabular]"), "{at}");
    assert!(!at.starts_with("layout[Standard]"), "{at}");
}

#[test]
fn two_tables_in_one_host_get_distinct_nth_match() {
    let env = MutationSession::new();
    let file = env.write_lyx("t.lyx", &two_tables_one_para(), HEADER);
    let cat = env.run(&["table", path_arg(&file)]);
    let a = cat["tables"][0]["at"].as_str().unwrap();
    let b = cat["tables"][1]["at"].as_str().unwrap();
    assert!(a.contains("nth-match(1)"), "{a}");
    assert!(b.contains("nth-match(2)"), "{b}");
    assert_ne!(a, b);
}

#[test]
fn selector_resolves_from_float_cell_and_caption() {
    let env = MutationSession::new();
    let file = env.write_lyx("t.lyx", PARA, HEADER);
    env.run(&[
        "insert",
        path_arg(&file),
        "layout[Standard]:last",
        "after",
        "--table",
        "Year,GDP\n2020,1.2",
    ]);
    env.run(&[
        "set",
        path_arg(&file),
        "inset[Float table]:last inset[Caption Standard] layout[Plain Layout]",
        "Results",
    ]);
    let from_cap = env.run(&[
        "table",
        path_arg(&file),
        "inset[Caption Standard]:contains(Results)",
    ]);
    assert_eq!(from_cap["tables"].as_array().unwrap().len(), 1);
    let from_float = env.run(&["table", path_arg(&file), "inset[Float table]:last"]);
    assert_eq!(from_float["tables"].as_array().unwrap().len(), 1);
    let from_cell = env.run(&[
        "table",
        path_arg(&file),
        "inset[Tabular]:last inset[Text]:nth-match(1)",
    ]);
    assert_eq!(from_cell["tables"].as_array().unwrap().len(), 1);
}

#[test]
fn set_without_picker_errors_when_two_tables() {
    let env = MutationSession::new();
    let file = env.write_lyx("t.lyx", PARA, HEADER);
    env.run(&[
        "insert",
        path_arg(&file),
        "layout[Standard]:last",
        "after",
        "--table",
        "A,B",
    ]);
    env.run(&[
        "insert",
        path_arg(&file),
        "layout[Standard]:last",
        "after",
        "--table",
        "C,D",
    ]);
    let result = env.run(&["table", path_arg(&file), "set", "--data", "A,B"]);
    assert_eq!(code(&result), "INVALID_CONTEXT");
}

#[test]
fn set_round_trip_and_dimension_mismatch() {
    let env = MutationSession::new();
    let file = env.write_lyx("t.lyx", PARA, HEADER);
    env.run(&[
        "insert",
        path_arg(&file),
        "layout[Standard]:last",
        "after",
        "--table",
        "Year,GDP\n2020,1.2",
    ]);
    let cat = env.run(&["table", path_arg(&file)]);
    let data = cat["tables"][0]["data"].as_str().unwrap();
    let ok = env.run(&["table", path_arg(&file), "1", "set", "--data", data]);
    assert_eq!(ok["op"], json!("set"));
    let bad = env.run(&["table", path_arg(&file), "1", "set", "--data", "only"]);
    assert_eq!(code(&bad), "INVALID_FLAG");
    assert_eq!(bad["rows"], json!(2));
    assert_eq!(bad["columns"], json!(2));
}

#[test]
fn set_preserves_formula_and_skips_unchanged() {
    let env = MutationSession::tracked("Alice");
    let file = env.write_lyx(
        "t.lyx",
        &formula_table(),
        &format!("{HEADER}{AUTHOR_ALICE}"),
    );
    let cat = env.run(&["table", path_arg(&file)]);
    assert_eq!(cat["tables"][0]["data"], json!("n,"));
    env.run(&[
        "table",
        path_arg(&file),
        "1",
        "set",
        "--data",
        cat["tables"][0]["data"].as_str().unwrap(),
    ]);
    let after = read_file(&file);
    assert!(
        !after.contains("\\change_inserted") && !after.contains("\\change_deleted"),
        "{after}"
    );
    env.run(&["table", path_arg(&file), "1", "set", "--data", "m,"]);
    let text = read_file(&file);
    assert!(text.contains("$x$"), "{text}");
    assert!(text.contains("m"), "{text}");
}

#[test]
fn longtable_reports_caption_not_unnumbered() {
    let env = MutationSession::new();
    let file = env.write_lyx("t.lyx", &longtable_with_caption(), HEADER);
    let cat = env.run(&["table", path_arg(&file)]);
    assert_eq!(cat["tables"][0]["kind"], json!("longtable"));
    assert_eq!(cat["tables"][0]["caption"], json!("Data"));
    assert_eq!(cat["tables"][0]["label"], json!("tab:data"));
}

#[test]
fn catalog_figure_hosted_tabular_is_inline() {
    let env = MutationSession::new();
    let file = env.write_lyx("t.lyx", &figure_hosted_table(), HEADER);
    let cat = env.run(&["table", path_arg(&file)]);
    assert_eq!(cat["tables"][0]["kind"], json!("inline"));
    assert_eq!(cat["tables"][0]["data"], json!("in-figure"));
}

#[test]
fn add_row_and_delete_row() {
    let env = MutationSession::new();
    let file = env.write_lyx("t.lyx", PARA, HEADER);
    env.run(&[
        "insert",
        path_arg(&file),
        "layout[Standard]:last",
        "after",
        "--table",
        "A,B\nC,D",
    ]);
    let added = env.run(&["table", path_arg(&file), "1", "add-row", "--data", "E,F"]);
    assert_eq!(added["op"], json!("add-row"));
    assert_eq!(added["index"], json!(3));
    let cat = env.run(&["table", path_arg(&file), "1"]);
    assert_eq!(cat["tables"][0]["data"], json!("A,B\nC,D\nE,F"));
    let text = read_file(&file);
    assert!(
        !text.contains("change=\"inserted"),
        "untracked add-row must not mark the line: {text}"
    );
    assert!(
        !text.contains("\\change_inserted"),
        "untracked --data must not mark cells: {text}"
    );
    env.run(&["table", path_arg(&file), "1", "delete-row", "--index", "2"]);
    let cat = env.run(&["table", path_arg(&file), "1"]);
    assert_eq!(cat["tables"][0]["data"], json!("A,B\nE,F"));
}

#[test]
fn add_row_index_1_prepends() {
    let env = MutationSession::new();
    let file = env.write_lyx("t.lyx", PARA, HEADER);
    env.run(&[
        "insert",
        path_arg(&file),
        "layout[Standard]:last",
        "after",
        "--table",
        "A,B\nC,D",
    ]);
    env.run(&[
        "table",
        path_arg(&file),
        "1",
        "add-row",
        "--index",
        "1",
        "--data",
        "E,F",
    ]);
    let cat = env.run(&["table", path_arg(&file), "1"]);
    assert_eq!(cat["tables"][0]["data"], json!("E,F\nA,B\nC,D"));
}

#[test]
fn add_column_index_1_prepends() {
    let env = MutationSession::new();
    let file = env.write_lyx("t.lyx", PARA, HEADER);
    env.run(&[
        "insert",
        path_arg(&file),
        "layout[Standard]:last",
        "after",
        "--table",
        "A,B\nC,D",
    ]);
    env.run(&[
        "table",
        path_arg(&file),
        "1",
        "add-column",
        "--index",
        "1",
        "--data",
        "x,y",
    ]);
    let cat = env.run(&["table", path_arg(&file), "1"]);
    assert_eq!(cat["tables"][0]["data"], json!("x,A,B\ny,C,D"));
}

#[test]
fn add_row_tracked_and_hard_delete_own() {
    let env = MutationSession::tracked("Alice");
    let file = env.write_lyx("t.lyx", PARA, &format!("{HEADER}{AUTHOR_ALICE}"));
    env.run(&[
        "insert",
        path_arg(&file),
        "layout[Standard]:last",
        "after",
        "--table",
        "A,B\nC,D",
    ]);
    env.run(&["table", path_arg(&file), "1", "add-row"]);
    let text = read_file(&file);
    assert!(text.contains("change=\"inserted"), "{text}");
    env.run(&["table", path_arg(&file), "1", "delete-row", "--index", "3"]);
    let text = read_file(&file);
    assert!(!text.contains("change=\"deleted"), "{text}");
}

#[test]
fn add_row_tracked_without_data_has_no_cell_insert() {
    let env = MutationSession::tracked("Alice");
    let file = env.write_lyx("t.lyx", &ab_cd_table(), &format!("{HEADER}{AUTHOR_ALICE}"));
    env.run(&["table", path_arg(&file), "1", "add-row"]);
    let text = read_file(&file);
    assert!(text.contains("change=\"inserted"), "{text}");
    assert!(
        !text.contains("\\change_inserted"),
        "blank add-row must not mark cell text: {text}"
    );
}

#[test]
fn add_row_data_tracked_marks_cells_insert_only() {
    let env = MutationSession::tracked("Alice");
    let file = env.write_lyx("t.lyx", &ab_cd_table(), &format!("{HEADER}{AUTHOR_ALICE}"));
    env.run(&["table", path_arg(&file), "1", "add-row", "--data", "E,F"]);
    let text = read_file(&file);
    assert!(text.contains("change=\"inserted"), "{text}");
    assert!(cell_is_insert_only(&text, "E"), "{text}");
    assert!(cell_is_insert_only(&text, "F"), "{text}");
    assert!(!text.contains("\\change_deleted"), "{text}");
    let cat = env.run(&["table", path_arg(&file), "1"]);
    assert_eq!(cat["tables"][0]["data"], json!("A,B\nC,D\nE,F"));
}

#[test]
fn catalog_tracked_delete_row_lists_row_changes_only() {
    let env = MutationSession::tracked("Alice");
    let file = env.write_lyx("t.lyx", &ab_cd_table(), &format!("{HEADER}{AUTHOR_ALICE}"));
    env.run(&["table", path_arg(&file), "1", "delete-row", "--index", "2"]);
    let cat = env.run(&["table", path_arg(&file), "1"]);
    assert_eq!(cat["tables"][0]["data"], json!("A,B\nC,D"));
    assert_eq!(
        cat["tables"][0]["row_changes"],
        json!([{"index": 2, "region": "deleted"}])
    );
    assert!(cat["tables"][0].get("cell_changes").is_none());
    assert!(cat["tables"][0].get("column_changes").is_none());
}

#[test]
fn catalog_tracked_add_row_blank_lists_row_changes_only() {
    let env = MutationSession::tracked("Alice");
    let file = env.write_lyx("t.lyx", &ab_cd_table(), &format!("{HEADER}{AUTHOR_ALICE}"));
    env.run(&["table", path_arg(&file), "1", "add-row"]);
    let cat = env.run(&["table", path_arg(&file), "1"]);
    assert_eq!(
        cat["tables"][0]["row_changes"],
        json!([{"index": 3, "region": "inserted"}])
    );
    assert!(cat["tables"][0].get("cell_changes").is_none());
}

#[test]
fn catalog_tracked_add_row_data_lists_row_and_cell_inserts() {
    let env = MutationSession::tracked("Alice");
    let file = env.write_lyx("t.lyx", &ab_cd_table(), &format!("{HEADER}{AUTHOR_ALICE}"));
    env.run(&["table", path_arg(&file), "1", "add-row", "--data", "E,F"]);
    let cat = env.run(&["table", path_arg(&file), "1"]);
    assert_eq!(cat["tables"][0]["data"], json!("A,B\nC,D\nE,F"));
    assert_eq!(
        cat["tables"][0]["row_changes"],
        json!([{"index": 3, "region": "inserted"}])
    );
    assert_eq!(
        cat["tables"][0]["cell_changes"],
        json!([
            {"r": 3, "c": 1, "inserted": "E"},
            {"r": 3, "c": 2, "inserted": "F"}
        ])
    );
}

#[test]
fn catalog_tracked_cell_set_lists_deleted_and_inserted() {
    let env = MutationSession::tracked("Alice");
    let file = env.write_lyx("t.lyx", &ab_cd_table(), &format!("{HEADER}{AUTHOR_ALICE}"));
    env.run(&["table", path_arg(&file), "1", "set", "--data", "A,Bee\nC,D"]);
    let cat = env.run(&["table", path_arg(&file), "1"]);
    assert_eq!(cat["tables"][0]["data"], json!("A,Bee\nC,D"));
    assert!(cat["tables"][0].get("row_changes").is_none());
    assert_eq!(
        cat["tables"][0]["cell_changes"],
        json!([{"r": 1, "c": 2, "deleted": "B", "inserted": "Bee"}])
    );
}

#[test]
fn catalog_tracked_add_column_lists_column_changes() {
    let env = MutationSession::tracked("Alice");
    let file = env.write_lyx("t.lyx", &ab_cd_table(), &format!("{HEADER}{AUTHOR_ALICE}"));
    env.run(&["table", path_arg(&file), "1", "add-column", "--data", "x,y"]);
    let cat = env.run(&["table", path_arg(&file), "1"]);
    assert_eq!(
        cat["tables"][0]["column_changes"],
        json!([{"index": 3, "region": "inserted"}])
    );
    assert_eq!(
        cat["tables"][0]["cell_changes"],
        json!([
            {"r": 1, "c": 3, "inserted": "x"},
            {"r": 2, "c": 3, "inserted": "y"}
        ])
    );
}

#[test]
fn catalog_nested_inset_warning_named_for_one_table() {
    let env = MutationSession::new();
    let file = env.write_lyx("t.lyx", &formula_table(), HEADER);
    let cat = env.run(&["table", path_arg(&file)]);
    let warnings = json_warnings(&cat);
    assert_eq!(warnings.len(), 1, "{warnings:?}");
    assert!(
        warnings[0].starts_with("Table 1 has nested insets"),
        "{warnings:?}"
    );
}

#[test]
fn catalog_nested_inset_warnings_collapse_when_several() {
    let env = MutationSession::new();
    let file = env.write_lyx(
        "t.lyx",
        &format!("{}{}", formula_table(), formula_table()),
        HEADER,
    );
    let cat = env.run(&["table", path_arg(&file)]);
    assert_eq!(cat["tables"].as_array().unwrap().len(), 2);
    let warnings = json_warnings(&cat);
    assert_eq!(warnings.len(), 1, "{warnings:?}");
    assert!(
        warnings[0].starts_with("2 tables have nested insets"),
        "{warnings:?}"
    );
    assert!(warnings[0].contains("Slice with n"), "{warnings:?}");
    let one = env.run(&["table", path_arg(&file), "1"]);
    let one_w = json_warnings(&one);
    assert_eq!(one_w.len(), 1, "{one_w:?}");
    assert!(
        one_w[0].starts_with("Table 1 has nested insets"),
        "{one_w:?}"
    );
}

#[test]
fn add_row_data_empty_field_stays_unmarked() {
    let env = MutationSession::tracked("Alice");
    let file = env.write_lyx("t.lyx", &ab_cd_table(), &format!("{HEADER}{AUTHOR_ALICE}"));
    env.run(&["table", path_arg(&file), "1", "add-row", "--data", "E,"]);
    let text = read_file(&file);
    assert!(text.contains("change=\"inserted"), "{text}");
    assert!(cell_is_insert_only(&text, "E"), "{text}");
    assert!(
        has_unmarked_empty_cell(&text),
        "empty --data field must stay unmarked: {text}"
    );
}

#[test]
fn add_column_data_empty_field_stays_unmarked() {
    let env = MutationSession::tracked("Alice");
    let file = env.write_lyx("t.lyx", &ab_cd_table(), &format!("{HEADER}{AUTHOR_ALICE}"));
    env.run(&["table", path_arg(&file), "1", "add-column", "--data", "x,"]);
    let text = read_file(&file);
    assert!(text.contains("change=\"inserted"), "{text}");
    assert!(cell_is_insert_only(&text, "x"), "{text}");
    assert!(
        has_unmarked_empty_cell(&text),
        "empty --data field must stay unmarked: {text}"
    );
}

#[test]
fn add_column_data_tracked_marks_cells_insert_only() {
    let env = MutationSession::tracked("Alice");
    let file = env.write_lyx("t.lyx", &ab_cd_table(), &format!("{HEADER}{AUTHOR_ALICE}"));
    env.run(&["table", path_arg(&file), "1", "add-column", "--data", "x,y"]);
    let text = read_file(&file);
    assert!(text.contains("change=\"inserted"), "{text}");
    assert!(cell_is_insert_only(&text, "x"), "{text}");
    assert!(cell_is_insert_only(&text, "y"), "{text}");
    assert!(!text.contains("\\change_deleted"), "{text}");
    let cat = env.run(&["table", path_arg(&file), "1"]);
    assert_eq!(cat["tables"][0]["data"], json!("A,B,x\nC,D,y"));
}

#[test]
fn add_row_data_replay_undo_keeps_row_change() {
    let env = MutationSession::tracked("Alice");
    let file = env.write_lyx("t.lyx", &ab_cd_table(), &format!("{HEADER}{AUTHOR_ALICE}"));
    env.run(&["table", path_arg(&file), "1", "add-row", "--data", "E,F"]);
    let undone = env.run(&[
        "undo",
        path_arg(&file),
        "inset[Tabular] layout[Plain Layout]",
    ]);
    assert_eq!(undone["method"], json!("replay"));
    let text = read_file(&file);
    assert!(
        text.contains("change=\"inserted"),
        "replay must leave the line mark: {text}"
    );
    assert!(
        !cell_is_insert_only(&text, "E"),
        "replay must drop --data marks: {text}"
    );
    let cat = env.run(&["table", path_arg(&file), "1"]);
    assert_eq!(cat["tables"][0]["data"], json!("A,B\nC,D\n,"));
}

#[test]
fn table_replay_drops_inserted_row_and_line_mark() {
    let env = MutationSession::tracked("Alice");
    let file = env.write_lyx("t.lyx", &ab_cd_table(), &format!("{HEADER}{AUTHOR_ALICE}"));
    env.run(&["table", path_arg(&file), "1", "add-row", "--data", "E,F"]);
    let undone = env.run(&["undo", path_arg(&file), "inset[Tabular]"]);
    assert_eq!(undone["method"], json!("replay"));
    assert!(undone["undone_changes"].as_u64().unwrap() >= 1, "{undone}");
    let warnings = json_warnings(&undone);
    assert!(
        !warnings
            .iter()
            .any(|w| w.contains("No tracked changes found")),
        "{warnings:?}"
    );
    let cat = env.run(&["table", path_arg(&file), "1"]);
    assert_eq!(cat["tables"][0]["data"], json!("A,B\nC,D"));
    let text = read_file(&file);
    assert!(!text.contains("change=\"inserted"), "{text}");
    let labels: Vec<&str> = undone["changes"]
        .as_array()
        .unwrap()
        .iter()
        .filter_map(|c| c["label"].as_str())
        .collect();
    assert!(
        labels
            .iter()
            .any(|l| l.starts_with("row_inserted{") && l.contains("E,F")),
        "{labels:?}"
    );
}

#[test]
fn table_replay_via_catalog_at() {
    let env = MutationSession::tracked("Alice");
    let file = env.write_lyx("t.lyx", &ab_cd_table(), &format!("{HEADER}{AUTHOR_ALICE}"));
    env.run(&["table", path_arg(&file), "1", "add-row", "--data", "E,F"]);
    let cat = env.run(&["table", path_arg(&file), "1"]);
    let at = cat["tables"][0]["at"].as_str().unwrap().to_string();
    let undone = env.run(&["undo", path_arg(&file), &at]);
    assert_eq!(undone["method"], json!("replay"));
    let cat = env.run(&["table", path_arg(&file), "1"]);
    assert_eq!(cat["tables"][0]["data"], json!("A,B\nC,D"));
}

#[test]
fn table_replay_drops_inserted_column() {
    let env = MutationSession::tracked("Alice");
    let file = env.write_lyx("t.lyx", &ab_cd_table(), &format!("{HEADER}{AUTHOR_ALICE}"));
    env.run(&["table", path_arg(&file), "1", "add-column", "--data", "x,y"]);
    let undone = env.run(&["undo", path_arg(&file), "inset[Tabular]"]);
    assert_eq!(undone["method"], json!("replay"));
    let cat = env.run(&["table", path_arg(&file), "1"]);
    assert_eq!(cat["tables"][0]["data"], json!("A,B\nC,D"));
    let text = read_file(&file);
    assert!(!text.contains("change=\"inserted"), "{text}");
}

#[test]
fn table_replay_substring_picks_one_axis() {
    let env = MutationSession::tracked("Alice");
    let file = env.write_lyx("t.lyx", &ab_cd_table(), &format!("{HEADER}{AUTHOR_ALICE}"));
    env.run(&["table", path_arg(&file), "1", "add-row", "--data", "E,F"]);
    env.run(&[
        "table",
        path_arg(&file),
        "1",
        "add-column",
        "--data",
        "x,y,z",
    ]);
    let row_only = env.run(&["undo", path_arg(&file), "inset[Tabular]", "E"]);
    assert_eq!(row_only["method"], json!("replay"));
    assert!(
        row_only["undone_changes"].as_u64().unwrap() >= 1,
        "{row_only}"
    );
    let cat = env.run(&["table", path_arg(&file), "1"]);
    assert_eq!(cat["tables"][0]["data"], json!("A,B,x\nC,D,y"));

    env.run(&["table", path_arg(&file), "1", "add-row", "--data", "E,F,z"]);
    let col_only = env.run(&["undo", path_arg(&file), "inset[Tabular]", "x"]);
    assert!(
        col_only["undone_changes"].as_u64().unwrap() >= 1,
        "{col_only}"
    );
    let cat = env.run(&["table", path_arg(&file), "1"]);
    assert_eq!(cat["tables"][0]["data"], json!("A,B\nC,D\nE,F"));
}

#[test]
fn table_replay_mixed_axis_substring_reverts_nothing() {
    let env = MutationSession::tracked("Alice");
    let file = env.write_lyx("t.lyx", &ab_cd_table(), &format!("{HEADER}{AUTHOR_ALICE}"));
    env.run(&["table", path_arg(&file), "1", "add-row", "--data", "E,F"]);
    env.run(&[
        "table",
        path_arg(&file),
        "1",
        "add-column",
        "--data",
        "x,y,z",
    ]);
    let before = read_file(&file);
    let undone = env.run(&["undo", path_arg(&file), "inset[Tabular]", "z"]);
    assert_eq!(undone["undone_changes"], json!(0));
    let warnings = json_warnings(&undone);
    assert!(
        warnings
            .iter()
            .any(|w| w.contains("both a marked row") && w.contains("marked column")),
        "{warnings:?}"
    );
    assert!(
        !warnings
            .iter()
            .any(|w| w.contains("No tracked change matching")),
        "{warnings:?}"
    );
    assert_eq!(read_file(&file), before);
}

#[test]
fn table_replay_two_inserted_rows_both_drop() {
    let env = MutationSession::tracked("Alice");
    let file = env.write_lyx("t.lyx", &ab_cd_table(), &format!("{HEADER}{AUTHOR_ALICE}"));
    env.run(&["table", path_arg(&file), "1", "add-row", "--data", "E,1"]);
    env.run(&["table", path_arg(&file), "1", "add-row", "--data", "E,2"]);
    let undone = env.run(&["undo", path_arg(&file), "inset[Tabular]", "E"]);
    assert_eq!(undone["undone_changes"], json!(2));
    let cat = env.run(&["table", path_arg(&file), "1"]);
    assert_eq!(cat["tables"][0]["data"], json!("A,B\nC,D"));
}

#[test]
fn table_replay_skips_other_author_line() {
    let env = MutationSession::tracked("Alice");
    let file = env.write_lyx(
        "t.lyx",
        &other_author_inserted_row(),
        &format!("{HEADER}{AUTHOR_ALICE}"),
    );
    let undone = env.run(&["undo", path_arg(&file), "inset[Tabular]"]);
    assert_eq!(undone["undone_changes"], json!(0));
    let warnings = json_warnings(&undone);
    assert!(
        warnings.iter().any(|w| w.contains("none belong to author")),
        "{warnings:?}"
    );
    let text = read_file(&file);
    assert!(text.contains("change=\"inserted"), "{text}");
}

#[test]
fn table_replay_unmarks_deleted_row_keeps_cell_markers() {
    let env = MutationSession::tracked("Alice");
    let file = env.write_lyx("t.lyx", &ab_cd_table(), &format!("{HEADER}{AUTHOR_ALICE}"));
    env.run(&["table", path_arg(&file), "1", "set", "--data", "X,B\nC,D"]);
    env.run(&["table", path_arg(&file), "1", "delete-row", "--index", "1"]);
    let undone = env.run(&["undo", path_arg(&file), "inset[Tabular]"]);
    assert_eq!(undone["method"], json!("replay"));
    assert!(undone["undone_changes"].as_u64().unwrap() >= 1, "{undone}");
    let text = read_file(&file);
    assert!(!text.contains("change=\"deleted"), "{text}");
    assert!(
        text.contains("\\change_deleted") || text.contains("\\change_inserted"),
        "cell markers must survive restoring the line: {text}"
    );
    let cat = env.run(&["table", path_arg(&file), "1"]);
    assert_eq!(
        cat["tables"][0]["data"].as_str().unwrap().lines().count(),
        2
    );
}

#[test]
fn table_replay_last_line_warns_and_keeps_table() {
    let env = MutationSession::tracked("Alice");
    let file = env.write_lyx(
        "t.lyx",
        &one_row_inserted_table(),
        &format!("{HEADER}{AUTHOR_ALICE}"),
    );
    let undone = env.run(&["undo", path_arg(&file), "inset[Tabular]"]);
    assert_eq!(undone["undone_changes"], json!(0));
    let warnings = json_warnings(&undone);
    assert!(
        warnings.iter().any(|w| w.contains("last remaining")),
        "{warnings:?}"
    );
    assert!(
        !warnings
            .iter()
            .any(|w| w.contains("No tracked changes found")),
        "{warnings:?}"
    );
    let cat = env.run(&["table", path_arg(&file), "1"]);
    assert_eq!(cat["tables"][0]["data"], json!("A,B"));
    let text = read_file(&file);
    assert!(text.contains("change=\"inserted"), "{text}");
}

#[test]
fn table_selector_cell_only_nested_warning() {
    let env = MutationSession::tracked("Alice");
    let file = env.write_lyx("t.lyx", &ab_cd_table(), &format!("{HEADER}{AUTHOR_ALICE}"));
    env.run(&["table", path_arg(&file), "1", "set", "--data", "X,B\nC,D"]);
    let before = read_file(&file);
    let undone = env.run(&["undo", path_arg(&file), "inset[Tabular]"]);
    assert_eq!(undone["undone_changes"], json!(0));
    let warnings = json_warnings(&undone);
    assert!(
        warnings.iter().any(|w| w.contains("nested inside")),
        "{warnings:?}"
    );
    assert_eq!(read_file(&file), before);
}

#[test]
fn host_paragraph_replay_does_not_drop_table_line() {
    let env = MutationSession::tracked("Alice");
    let file = env.write_lyx("t.lyx", &ab_cd_table(), &format!("{HEADER}{AUTHOR_ALICE}"));
    env.run(&["table", path_arg(&file), "1", "add-row", "--data", "E,F"]);
    let undone = env.run(&["undo", path_arg(&file), "layout[Standard]"]);
    assert_eq!(undone["undone_changes"], json!(0));
    let cat = env.run(&["table", path_arg(&file), "1"]);
    assert_eq!(cat["tables"][0]["data"], json!("A,B\nC,D\nE,F"));
    let text = read_file(&file);
    assert!(text.contains("change=\"inserted"), "{text}");
}

#[test]
fn snapshot_fallback_with_only_table_change_is_not_stale() {
    let env = MutationSession::tracked("Alice");
    let file = env.write_lyx(
        "t.lyx",
        &one_row_inserted_table(),
        &format!("{HEADER}{AUTHOR_ALICE}"),
    );
    let result = env.run(&["undo", path_arg(&file)]);
    assert_eq!(code(&result), "UNDO_SNAPSHOT_UNAVAILABLE");
    assert!(
        result["message"]
            .as_str()
            .unwrap_or("")
            .contains("inset[Tabular]"),
        "{result}"
    );
}

#[test]
fn delete_row_last_line_still_refused() {
    let env = MutationSession::new();
    let file = env.write_lyx("t.lyx", &ab_cd_table(), HEADER);
    env.run(&["table", path_arg(&file), "1", "delete-row", "--index", "2"]);
    let last = env.run(&["table", path_arg(&file), "1", "delete-row", "--index", "1"]);
    assert_eq!(code(&last), "INVALID_FLAG");
    let cat = env.run(&["table", path_arg(&file), "1"]);
    assert_eq!(cat["tables"][0]["data"], json!("A,B"));
}

#[test]
fn add_row_data_snapshot_undo_restores() {
    let env = MutationSession::tracked("Alice");
    let file = env.write_lyx("t.lyx", &ab_cd_table(), &format!("{HEADER}{AUTHOR_ALICE}"));
    env.run(&["table", path_arg(&file), "1", "add-row", "--data", "E,F"]);
    let undone = env.run(&["undo", path_arg(&file)]);
    assert_eq!(undone["method"], json!("snapshot"));
    let cat = env.run(&["table", path_arg(&file), "1"]);
    assert_eq!(cat["tables"][0]["data"], json!("A,B\nC,D"));
    let text = read_file(&file);
    assert!(!text.contains("change=\"inserted"), "{text}");
    assert!(!text.contains("\\change_inserted"), "{text}");
}

#[test]
fn merge_part_empty_and_add_row_extends() {
    let env = MutationSession::new();
    let file = env.write_lyx("t.lyx", &merge_header_table(), HEADER);
    let cat = env.run(&["table", path_arg(&file)]);
    assert_eq!(cat["tables"][0]["data"], json!("Head,\na,b"));
    let merges = &cat["tables"][0]["merges"];
    assert_eq!(merges[0]["r"], json!(1));
    assert_eq!(merges[0]["c"], json!(1));
    assert_eq!(merges[0]["colspan"], json!(2));
    let bad = env.run(&[
        "table",
        path_arg(&file),
        "1",
        "set",
        "--data",
        "Head,x\na,b",
    ]);
    assert_eq!(code(&bad), "INVALID_FLAG");
    env.run(&["table", path_arg(&file), "1", "add-row", "--index", "2"]);
    let cat = env.run(&["table", path_arg(&file), "1"]);
    assert_eq!(cat["tables"][0]["data"], json!("Head,\n,\na,b"));
    assert_eq!(cat["tables"][0]["merges"][0]["r"], json!(1));
    let text = read_file(&file);
    assert_eq!(
        text.matches("multicolumn=\"1\"").count(),
        1,
        "new row must not copy the header colspan: {text}"
    );
}

#[test]
fn add_row_under_multirow_begin_marks_part() {
    let env = MutationSession::new();
    let file = env.write_lyx("t.lyx", &multirow_table(), HEADER);
    env.run(&["table", path_arg(&file), "1", "add-row", "--index", "2"]);
    let cat = env.run(&["table", path_arg(&file), "1"]);
    assert_eq!(cat["tables"][0]["data"], json!("Head\n\n"));
    assert_eq!(cat["tables"][0]["merges"][0]["rowspan"], json!(3));
    let text = read_file(&file);
    assert_eq!(text.matches("multirow=\"4\"").count(), 2, "{text}");
}

#[test]
fn add_column_and_delete_column() {
    let env = MutationSession::new();
    let file = env.write_lyx("t.lyx", PARA, HEADER);
    env.run(&[
        "insert",
        path_arg(&file),
        "layout[Standard]:last",
        "after",
        "--table",
        "A,B\nC,D",
    ]);
    let added = env.run(&["table", path_arg(&file), "1", "add-column", "--data", "x,y"]);
    assert_eq!(added["op"], json!("add-column"));
    assert_eq!(added["index"], json!(3));
    let cat = env.run(&["table", path_arg(&file), "1"]);
    assert_eq!(cat["tables"][0]["data"], json!("A,B,x\nC,D,y"));
    env.run(&[
        "table",
        path_arg(&file),
        "1",
        "delete-column",
        "--index",
        "2",
    ]);
    let cat = env.run(&["table", path_arg(&file), "1"]);
    assert_eq!(cat["tables"][0]["data"], json!("A,x\nC,y"));
}

#[test]
fn add_column_rejects_vertical_data() {
    let env = MutationSession::new();
    let file = env.write_lyx("t.lyx", PARA, HEADER);
    env.run(&[
        "insert",
        path_arg(&file),
        "layout[Standard]:last",
        "after",
        "--table",
        "A,B\nC,D",
    ]);
    let result = env.run(&[
        "table",
        path_arg(&file),
        "1",
        "add-column",
        "--data",
        "x\ny",
    ]);
    assert_eq!(code(&result), "INVALID_FLAG");
}

#[test]
fn unused_flags_are_rejected() {
    let env = MutationSession::new();
    let file = env.write_lyx("t.lyx", PARA, HEADER);
    env.run(&[
        "insert",
        path_arg(&file),
        "layout[Standard]:last",
        "after",
        "--table",
        "A,B\nC,D",
    ]);
    let set = env.run(&[
        "table",
        path_arg(&file),
        "1",
        "set",
        "--data",
        "A,B\nC,D",
        "--index",
        "1",
    ]);
    assert_eq!(code(&set), "INVALID_FLAG");
    let del = env.run(&[
        "table",
        path_arg(&file),
        "1",
        "delete-row",
        "--index",
        "1",
        "--data",
        "x",
    ]);
    assert_eq!(code(&del), "INVALID_FLAG");
}

#[test]
fn delete_already_deleted_is_noop_warning() {
    let env = MutationSession::tracked("Alice");
    let file = env.write_lyx("t.lyx", PARA, &format!("{HEADER}{AUTHOR_ALICE}"));
    env.run(&[
        "insert",
        path_arg(&file),
        "layout[Standard]:last",
        "after",
        "--table",
        "A,B\nC,D",
    ]);
    env.run(&["table", path_arg(&file), "1", "delete-row", "--index", "1"]);
    let again = env.run(&["table", path_arg(&file), "1", "delete-row", "--index", "1"]);
    assert_eq!(again["op"], json!("delete-row"));
    let warnings = json_warnings(&again);
    assert!(
        warnings
            .iter()
            .any(|w| w.contains("already") && w.contains("deleted")),
        "{warnings:?}"
    );
    let cat = env.run(&["table", path_arg(&file), "1"]);
    assert_eq!(
        cat["tables"][0]["data"].as_str().unwrap().lines().count(),
        2
    );
}

#[test]
fn delete_pending_change_warns_and_proceeds() {
    let env = MutationSession::tracked("Alice");
    let file = env.write_lyx(
        "t.lyx",
        &other_author_inserted_row(),
        &format!("{HEADER}{AUTHOR_ALICE}"),
    );
    let result = env.run(&["table", path_arg(&file), "1", "delete-row", "--index", "1"]);
    assert_eq!(result["op"], json!("delete-row"));
    let warnings = json_warnings(&result);
    assert!(
        warnings.iter().any(|w| w.contains("pending")),
        "{warnings:?}"
    );
    let text = read_file(&file);
    assert!(text.contains("change=\"deleted"), "{text}");
}

#[test]
fn set_keeps_booktabs_and_topline() {
    let env = MutationSession::new();
    let file = env.write_lyx("t.lyx", &booktabs_table(), HEADER);
    env.run(&["table", path_arg(&file), "1", "set", "--data", "E,F\nG,H"]);
    let text = read_file(&file);
    assert!(text.contains("booktabs=\"true\""), "{text}");
    assert!(text.contains("topline=\"true\""), "{text}");
    assert!(text.contains("bottomline=\"true\""), "{text}");
    let cat = env.run(&["table", path_arg(&file), "1"]);
    assert_eq!(cat["tables"][0]["data"], json!("E,F\nG,H"));
}

#[test]
fn caption_unnumbered_is_ignored_when_standard_exists() {
    let env = MutationSession::new();
    let file = env.write_lyx("t.lyx", &longtable_standard_and_unnumbered(), HEADER);
    let cat = env.run(&["table", path_arg(&file)]);
    assert_eq!(cat["tables"][0]["caption"], json!("Data"));
    assert_ne!(cat["tables"][0]["caption"], json!("continued"));
}

#[test]
fn one_cell_is_lq_set_not_one_by_one_table_set() {
    let env = MutationSession::new();
    let file = env.write_lyx("t.lyx", PARA, HEADER);
    env.run(&[
        "insert",
        path_arg(&file),
        "layout[Standard]:last",
        "after",
        "--table",
        "A,B\nC,D",
    ]);
    let cat = env.run(&["table", path_arg(&file)]);
    let at = cat["tables"][0]["at"].as_str().unwrap();
    let cell_sel = format!("{at} inset[Text]:nth-match(2) layout[Plain Layout]");
    let set_r = env.run(&["set", path_arg(&file), &cell_sel, "Bee"]);
    assert!(set_r.get("code").is_none(), "{set_r}");
    let cat = env.run(&["table", path_arg(&file)]);
    assert_eq!(cat["tables"][0]["data"], json!("A,Bee\nC,D"));
}
