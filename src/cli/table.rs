//! `lq table` — catalog and grid edits.

use super::common::{CliError, ParsedArgs, print_json, push_warning};
use super::mutate::{MutationEnv, assert_tracking_header, commit_and_refresh, now_ts};
use crate::ast::Document;
use crate::query::query;
use crate::table::{
    self, CatalogRow, TableError, is_op, parse_index_token, pick_by_n, resolve_to_tables,
};
use crate::tracked_changes::{ensure_tracking_changes_in_header, resolve_author_id};
use crate::undo::{SnapshotMode, collect_snapshots};
use serde_json::{Value, json};

pub fn run_table(doc: &mut Document, env: &MutationEnv<'_>) -> Result<(), CliError> {
    let tokens = env.rest;
    let (picker, op) = parse_picker_op(tokens)?;
    let traversal = env.traversal.clone();

    let tabulars = match picker {
        Picker::None => {
            if op.is_some() {
                unique_or_err(doc, env.file_path)?
            } else {
                let ids = table::list_tabulars(doc);
                if ids.is_empty() {
                    return Err(map_err(TableError::new(
                        "NO_MATCH",
                        "No tables in this file. Insert one with 'lq insert FILE <selector> after --table \"...\"'.",
                    )));
                }
                ids
            }
        }
        Picker::N(n) => vec![pick_by_n(doc, n).map_err(map_err)?],
        Picker::Selector(sel) => {
            let nodes =
                query(doc, sel).map_err(|e| CliError::new("INVALID_SELECTOR", e.message))?;
            super::common::assert_no_selector_mistakes(Some(sel))?;
            let ids = resolve_to_tables(doc, &nodes);
            if ids.is_empty() {
                return Err(CliError::new(
                    "NO_MATCH",
                    format!(
                        "Selector matched no table. Run 'lq table {}' to list indexes.",
                        env.file_path
                    ),
                ));
            }
            ids
        }
    };

    let Some(op) = op else {
        let (rows, warnings) = table::catalog_of(doc, &tabulars, &traversal).map_err(map_err)?;
        for w in warnings {
            push_warning(w);
        }
        print_catalog(&rows);
        return Ok(());
    };

    if tabulars.len() != 1 {
        return Err(CliError::new(
            "INVALID_CONTEXT",
            format!(
                "This operation needs one table. Run 'lq table {}' and pick an index n.",
                env.file_path
            ),
        ));
    }
    let tabular = tabulars[0];
    let flags = env.flags;
    reject_unused_flags(op, flags)?;

    assert_tracking_header(doc, env.track_changes)?;
    if env.track_changes {
        ensure_tracking_changes_in_header(doc);
    }
    let aid = if env.track_changes {
        resolve_author_id(doc, env.author_name)
    } else {
        0
    };
    let ts = if env.track_changes {
        now_ts()
    } else {
        String::new()
    };
    let pre = collect_snapshots(doc, &[tabular], SnapshotMode::OnNode);

    let result = match op {
        "set" => {
            let data = flags.str("data").ok_or_else(|| {
                CliError::new(
                    "MISSING_CONTENT",
                    "set requires --data with the full table rectangle.",
                )
            })?;
            if data.is_empty() {
                return Err(CliError::new(
                    "MISSING_CONTENT",
                    "set requires --data with the full table rectangle.",
                ));
            }
            let r = table::set_table_data(doc, tabular, data, env.track_changes, aid, &ts)
                .map_err(map_err)?;
            json!({ "op": "set", "rows": r.rows, "columns": r.columns })
        }
        "add-row" => {
            let index = parse_index_flag(flags.str("index"))?;
            let r = table::add_row(
                doc,
                tabular,
                index,
                flags.str("data"),
                env.track_changes,
                aid,
                &ts,
            )
            .map_err(map_err)?;
            json!({ "op": "add-row", "rows": r.rows, "columns": r.columns, "index": r.index })
        }
        "add-column" => {
            let index = parse_index_flag(flags.str("index"))?;
            let r = table::add_column(
                doc,
                tabular,
                index,
                flags.str("data"),
                env.track_changes,
                aid,
                &ts,
            )
            .map_err(map_err)?;
            json!({ "op": "add-column", "rows": r.rows, "columns": r.columns, "index": r.index })
        }
        "delete-row" => {
            let index = require_index(flags.str("index"))?;
            let r = table::delete_row(doc, tabular, index, env.track_changes, aid, &ts)
                .map_err(map_err)?;
            warn_delete(&r, "row");
            json!({ "op": "delete-row", "rows": r.rows, "columns": r.columns, "index": r.index })
        }
        "delete-column" => {
            let index = require_index(flags.str("index"))?;
            let r = table::delete_column(doc, tabular, index, env.track_changes, aid, &ts)
                .map_err(map_err)?;
            warn_delete(&r, "column");
            json!({ "op": "delete-column", "rows": r.rows, "columns": r.columns, "index": r.index })
        }
        _ => unreachable!("op names checked in parse_picker_op"),
    };

    commit_and_refresh(doc, env.file_path, &pre, env.state, env.refresh)?;
    print_json(result);
    Ok(())
}

enum Picker<'a> {
    None,
    N(usize),
    Selector(&'a str),
}

fn parse_picker_op(tokens: &[String]) -> Result<(Picker<'_>, Option<&str>), CliError> {
    match tokens {
        [] => Ok((Picker::None, None)),
        [a] if is_op(a) => Ok((Picker::None, Some(a.as_str()))),
        [a] => Ok((parse_picker(a)?, None)),
        [a, b] if is_op(b) => Ok((parse_picker(a)?, Some(b.as_str()))),
        [a, b] if is_op(a) => Err(CliError::new(
            "INVALID_FLAG",
            format!("Unexpected argument '{b}' for 'table'. Run 'lq table --help'."),
        )),
        [_, b, ..] => Err(CliError::new(
            "INVALID_FLAG",
            format!("Unexpected argument '{b}' for 'table'. Run 'lq table --help'."),
        )),
    }
}

fn parse_picker(token: &str) -> Result<Picker<'_>, CliError> {
    if let Some(n) = parse_index_token(token) {
        return Ok(Picker::N(n));
    }
    Ok(Picker::Selector(token))
}

fn unique_or_err(doc: &Document, file_path: &str) -> Result<Vec<crate::ast::NodeId>, CliError> {
    let ids = table::list_tabulars(doc);
    match ids.len() {
        0 => Err(map_err(TableError::new(
            "NO_MATCH",
            "No tables in this file. Insert one with 'lq insert FILE <selector> after --table \"...\"'.",
        ))),
        1 => Ok(ids),
        _ => Err(CliError::new(
            "INVALID_CONTEXT",
            format!(
                "This file has more than one table. Run 'lq table {file_path}' and pick an index n."
            ),
        )),
    }
}

fn parse_index_flag(raw: Option<&str>) -> Result<Option<usize>, CliError> {
    let Some(raw) = raw else {
        return Ok(None);
    };
    parse_index_token(raw)
        .filter(|&n| n >= 1)
        .map(Some)
        .ok_or_else(|| {
            CliError::new(
                "INVALID_FLAG",
                format!("--index must be an integer ≥ 1, got: '{raw}'."),
            )
        })
}

fn require_index(raw: Option<&str>) -> Result<usize, CliError> {
    parse_index_flag(raw)?.ok_or_else(|| {
        CliError::new(
            "MISSING_ARGS",
            "delete-row and delete-column require --index N.",
        )
    })
}

fn reject_unused_flags(op: &str, flags: &ParsedArgs) -> Result<(), CliError> {
    match op {
        "set" => {
            if flags.str("index").is_some() {
                return Err(CliError::new(
                    "INVALID_FLAG",
                    "--index is for add-row, add-column, delete-row, and delete-column.",
                ));
            }
        }
        "delete-row" | "delete-column" if flags.str("data").is_some() => {
            return Err(CliError::new(
                "INVALID_FLAG",
                format!("{op} does not take --data."),
            ));
        }
        _ => {}
    }
    Ok(())
}

fn warn_delete(r: &table::LineOpResult, what: &str) {
    if r.already_deleted {
        push_warning(format!(
            "That {what} is already marked deleted. Nothing changed."
        ));
    } else if r.pending {
        push_warning(format!(
            "That {what} already has a pending change= mark. The delete still ran."
        ));
    }
}

fn print_catalog(rows: &[CatalogRow]) {
    print_json(json!({ "tables": rows }));
}

fn map_err(err: TableError) -> CliError {
    let mut e = CliError::new(err.code, err.message);
    if let (Some(r), Some(c)) = (err.rows, err.columns) {
        e.details.insert("rows".into(), Value::from(r));
        e.details.insert("columns".into(), Value::from(c));
    }
    e
}
