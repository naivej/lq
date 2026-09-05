//! CLI dispatch (Deno `cli.ts`). Split by command (C2).

mod bib;
mod common;
mod delete;
mod dump;
mod init;
mod insert;
mod mutate;
mod preview;
mod read;
mod schema;
mod set;
mod table;
mod undo;

use crate::cache::{hash_text, set_max_cache_entries};
use crate::help::{find_by_alias, find_by_reach, home_page};
use crate::help_render::{RichMode, render_page};
use crate::lyxserver::RefreshMode;
use crate::parser::parse_recovering;
use crate::paths::{StateScope, resolve_state_paths};
use crate::query::{build_traversal_state_index, query};
use crate::tracked_changes::{has_layout_ancestor, is_content_node};
use common::{
    BIB_SPEC, CliError, DUMP_SPEC, EMPTY_SPEC, INIT_SPEC, INSERT_SPEC, LoadedLyx, READ_SPEC,
    SET_SPEC, TABLE_SPEC, assert_no_selector_mistakes, load_lyx_full, load_user_config,
    parse_typed, print_error, push_warning, read_utf8_file, reject_unexpected_args,
    scan_help_flags,
};
use mutate::{
    MutationEnv, blast_radius_warning, handle_refresh_pre, is_core_node, node_label,
    parse_refresh_mode,
};
use std::path::PathBuf;

const KNOWN_COMMANDS: &[&str] = &[
    "init", "dump", "bib", "schema", "read", "preview", "table", "set", "delete", "insert", "undo",
];
const MUTATION_COMMANDS: &[&str] = &["set", "delete", "insert", "undo"];
const READ_COMMANDS: &[&str] = &["dump", "bib", "schema", "read", "table"];

fn parse_rich_flag(value: Option<&str>) -> Result<RichMode, CliError> {
    match value {
        None => Ok(RichMode::Auto),
        Some("auto") => Ok(RichMode::Auto),
        Some("always") => Ok(RichMode::Always),
        Some("never") => Ok(RichMode::Never),
        Some(other) => Err(CliError::new(
            "INVALID_FLAG",
            format!("--rich must be 'auto', 'always', or 'never', got: '{other}'"),
        )),
    }
}

fn print_help_page(page: &crate::help::HelpPage, rich: RichMode) {
    // Deno `console.log` always appends a newline after the already-terminated page.
    println!("{}", render_page(page, rich));
}

fn spec_for(command: &str) -> &'static [common::FlagDef] {
    match command {
        "init" => INIT_SPEC,
        "dump" => DUMP_SPEC,
        "bib" => BIB_SPEC,
        "read" => READ_SPEC,
        "set" => SET_SPEC,
        "insert" => INSERT_SPEC,
        "table" => TABLE_SPEC,
        "schema" | "preview" | "delete" | "undo" => EMPTY_SPEC,
        _ => EMPTY_SPEC,
    }
}

pub fn run_cli(args: &[String]) {
    if let Err(err) = run_cli_inner(args) {
        print_error(err);
    }
}

fn run_cli_inner(args: &[String]) -> Result<(), CliError> {
    let scan = scan_help_flags(args)?;
    let show_help = scan.show_help;
    let command_arg = scan.remainder.first().cloned();

    if command_arg.as_deref() == Some("help") {
        reject_unexpected_args(&scan.remainder, 2, "help")?;
        let page_arg = scan.remainder.get(1).cloned();
        let rich = parse_rich_flag(scan.rich.as_deref())?;
        match page_arg {
            None => print_help_page(home_page(), rich),
            Some(page_arg) => match find_by_reach(&page_arg) {
                Some(page) => print_help_page(page, rich),
                None => {
                    return Err(CliError::new(
                        "UNKNOWN_HELP_PAGE",
                        format!("Unknown help page '{page_arg}'. Run 'lq help' for the page map."),
                    ));
                }
            },
        }
        return Ok(());
    }

    if show_help || args.is_empty() {
        let rich = parse_rich_flag(scan.rich.as_deref())?;
        let page = command_arg
            .as_deref()
            .and_then(find_by_alias)
            .unwrap_or_else(home_page);
        print_help_page(page, rich);
        return Ok(());
    }

    if let Some(ref cmd) = command_arg
        && !KNOWN_COMMANDS.contains(&cmd.as_str())
    {
        return Err(CliError::new(
            "UNKNOWN_COMMAND",
            format!("Unknown command: {cmd}. Run 'lq help' for the page map."),
        ));
    }

    let command = command_arg.as_deref().unwrap_or("");
    let parsed = parse_typed(
        scan.remainder.get(1..).unwrap_or(&[]),
        spec_for(command),
        command,
    )?;

    if command == "init" {
        reject_unexpected_args(&parsed.positional, 0, "init")?;
        init::run_init(&parsed)?;
        return Ok(());
    }

    if parsed.positional.is_empty() {
        return Err(CliError::new(
            "MISSING_ARGS",
            "Usage: lq <command> <file> [selector] [value]. Run 'lq help' for details.",
        ));
    }

    if command != "preview"
        && !READ_COMMANDS.contains(&command)
        && !MUTATION_COMMANDS.contains(&command)
    {
        return Err(CliError::new(
            "MISSING_ARGS",
            "Usage: lq <command> <file> [selector] [value]. Run 'lq help' for details.",
        ));
    }
    let file_path = parsed.positional[0].as_str();
    let selector = parsed.positional.get(1).map(String::as_str);
    let rest_args = parsed.positional.get(2..).unwrap_or(&[]);

    match command {
        "read" => reject_unexpected_args(&parsed.positional, 2, command)?,
        "dump" => {
            let skip = if parsed.bool("toc") { 1 } else { 2 };
            reject_unexpected_args(&parsed.positional, skip, command)?;
        }
        "delete" => reject_unexpected_args(&parsed.positional, 2, command)?,
        "schema" | "bib" | "preview" => reject_unexpected_args(&parsed.positional, 1, command)?,
        "insert" => {
            let skip = if rest_args.first().map(String::as_str) == Some("split-after") {
                4
            } else {
                3
            };
            reject_unexpected_args(&parsed.positional, skip, command)?;
        }
        "set" | "undo" | "init" | "table" => {}
        _ => {}
    }

    let direct_bib = command == "bib" && file_path.to_ascii_lowercase().ends_with(".bib");
    if !file_path.ends_with(".lyx") && !direct_bib {
        let message = if command == "bib" {
            format!(
                "Target file '{file_path}' must be a .lyx document or a .bib file. \
Use 'lq bib refs.bib' to parse a .bib file directly."
            )
        } else {
            format!(
                "Target file '{file_path}' must have a .lyx extension. \
Select the LyX document to edit."
            )
        };
        return Err(CliError::new("INVALID_EXTENSION", message));
    }

    if direct_bib {
        bib::run_direct_bib(file_path, &parsed)?;
        return Ok(());
    }

    let cwd = std::env::current_dir().unwrap_or_else(|_| PathBuf::from("."));
    let Some(state_paths) = resolve_state_paths(&cwd, None) else {
        return Err(CliError::new(
            "NO_HOME",
            "Could not determine a home directory for global state. Set HOME or USERPROFILE, \
or create a local .lq directory and run the command from that project.",
        ));
    };
    let loaded = load_user_config(&state_paths);
    let user_config = loaded.config;
    let max_cache_entries = user_config
        .max_cache_entries
        .map_or(50, |value| usize::try_from(value).unwrap_or(usize::MAX));
    set_max_cache_entries(max_cache_entries);

    let is_mutation = MUTATION_COMMANDS.contains(&command)
        || (command == "table" && table_has_op(&parsed.positional));
    let mut refresh_mode = RefreshMode::None;
    let mut track_changes = true;
    let mut author_name = "lq user".to_string();
    if is_mutation {
        refresh_mode = parse_refresh_mode(user_config.refresh.as_deref());
        track_changes = user_config.track_changes != Some(false);
        if let Some(ref name) = user_config.author_name
            && !name.is_empty()
        {
            author_name = name.clone();
        }
        if state_paths.scope == StateScope::Local {
            if !loaded.exists {
                push_warning(format!(
                    "Local state '{}' has no config.json — lq defaults apply \
(trackChanges on, author 'lq user'). Run 'lq init' to set this project's options explicitly.",
                    state_paths.root.display()
                ));
            } else if loaded.unreadable {
                push_warning(format!(
                    "Local config '{}' could not be read — lq defaults apply \
(trackChanges on, author 'lq user'). Fix the file or run 'lq init' to rewrite it.",
                    state_paths.config.display()
                ));
            }
        }
        if refresh_mode != RefreshMode::None {
            handle_refresh_pre(file_path, refresh_mode)?;
        }
    }

    let mut structure_recovered = false;
    let loaded = if command == "preview" {
        match load_lyx_full(file_path, &state_paths) {
            Ok(loaded) => loaded,
            Err(err) if err.code == "PARSE_ERROR" && !err.message.contains("UTF-8") => {
                let text = read_utf8_file(file_path, &format!("Could not read file: {file_path}"))?;
                let hash = hash_text(&text);
                match parse_recovering(&text) {
                    Ok(recovered) => {
                        structure_recovered = recovered.structure_recovered();
                        LoadedLyx {
                            ast: recovered.document,
                            text,
                            hash,
                        }
                    }
                    Err(parse_err) => {
                        return Err(CliError::new("PARSE_ERROR", parse_err.message));
                    }
                }
            }
            Err(err) => return Err(err),
        }
    } else {
        load_lyx_full(file_path, &state_paths)?
    };
    let mut ast = loaded.ast;

    match command {
        "dump" => {
            dump::run_dump(&ast, file_path, selector, &parsed, &user_config)?;
            return Ok(());
        }
        "bib" => {
            bib::run_document_bib(&ast, file_path, &parsed)?;
            return Ok(());
        }
        "schema" => {
            schema::run_schema(&ast, &user_config)?;
            return Ok(());
        }
        "read" => {
            read::run_read(
                &ast,
                selector,
                parsed.bool("count"),
                parsed.bool("text-only"),
            )?;
            return Ok(());
        }
        "preview" => {
            preview::run_preview(
                file_path,
                &ast,
                &loaded.text,
                &loaded.hash,
                &user_config,
                structure_recovered,
            )?;
            return Ok(());
        }
        "table" => {
            let traversal = build_traversal_state_index(&ast, ast.root());
            let table_rest = parsed.positional.get(1..).unwrap_or(&[]);
            let env = MutationEnv {
                file_path,
                selector: None,
                rest: table_rest,
                flags: &parsed,
                state: &state_paths,
                track_changes,
                author_name: &author_name,
                refresh: refresh_mode,
                traversal: &traversal,
            };
            table::run_table(&mut ast, &env)?;
            return Ok(());
        }
        _ => {}
    }

    if selector.is_none() && command != "undo" {
        return Err(CliError::new(
            "MISSING_SELECTOR",
            "A CSS selector is required for this command. Run 'lq help selectors' for selector syntax.",
        ));
    }

    let nodes = if let Some(sel) = selector {
        match query(&ast, sel) {
            Ok(n) => n,
            Err(e) => return Err(CliError::new("INVALID_SELECTOR", e.message)),
        }
    } else {
        Vec::new()
    };
    assert_no_selector_mistakes(selector)?;

    let traversal = build_traversal_state_index(&ast, ast.root());

    let unsafe_nodes = nodes.iter().any(|&n| is_core_node(&ast, n));
    if unsafe_nodes && matches!(command, "set" | "delete" | "insert") {
        return Err(CliError::new(
            "INVALID_CONTEXT",
            "Cannot mutate core document structures ('document', 'body', 'header') directly. Target specific layouts or properties instead.",
        ));
    }

    if track_changes && matches!(command, "set" | "delete") {
        tracking_target_guards(&ast, &nodes, command, file_path, selector.unwrap_or(""))?;
    }

    if matches!(command, "set" | "delete" | "insert") {
        blast_radius_warning(file_path, selector.unwrap_or(""), nodes.len());
    }

    let env = MutationEnv {
        file_path,
        selector,
        rest: rest_args,
        flags: &parsed,
        state: &state_paths,
        track_changes,
        author_name: &author_name,
        refresh: refresh_mode,
        traversal: &traversal,
    };

    match command {
        "set" => set::run_set(&mut ast, &nodes, &env)?,
        "delete" => delete::run_delete(&mut ast, &nodes, &env)?,
        "insert" => insert::run_insert(&mut ast, &nodes, &env, &user_config)?,
        "undo" => undo::run_undo(&mut ast, &nodes, &env)?,
        _ => unreachable!("invariant: mutation command checked above"),
    }
    Ok(())
}

fn table_has_op(positionals: &[String]) -> bool {
    positionals
        .get(1..)
        .unwrap_or(&[])
        .iter()
        .any(|t| crate::table::is_op(t))
}

fn tracking_target_guards(
    ast: &crate::ast::Document,
    nodes: &[crate::ast::NodeId],
    command: &str,
    file_path: &str,
    selector: &str,
) -> Result<(), CliError> {
    use crate::ast::NodeKind;
    for &node in nodes {
        match &ast.node(node).kind {
            NodeKind::Property { key, .. } => {
                if command == "delete" {
                    let in_layout = has_layout_ancestor(ast, node, ast.root());
                    let alternatives = if in_layout {
                        format!(
                            "  - Target the text the property formats, e.g. '{file_path}' \"layout[Standard] text:property({key})\"\n  - Disable tracking first ('lq init --track-changes off'), then re-run this command\n"
                        )
                    } else {
                        "  - Disable tracking first ('lq init --track-changes off'), then re-run this command to remove the property\n".into()
                    };
                    return Err(CliError::new(
                        "TRACKING_ERROR",
                        format!(
                            "LyX cannot track-delete a property node ('{}') — change tracking applies to text, not to inline properties or header values.\n\
Alternatives:\n{alternatives}Run 'lq read {file_path} \"{selector}\" --count' to verify the target.",
                            node_label(ast, node)
                        ),
                    ));
                }
                continue;
            }
            NodeKind::Block { tag, .. } if tag == "inset" => continue,
            NodeKind::Block { tag, .. } if command == "delete" && tag == "layout" => {
                if !ast
                    .node(node)
                    .children
                    .iter()
                    .any(|&c| is_content_node(ast, c))
                {
                    return Err(CliError::new(
                        "TRACKING_ERROR",
                        format!(
                            "LyX cannot track-delete a layout with no trackable content ('{}') — change markers wrap text or inset content, and this layout holds none.\n\
Alternatives:\n  - Disable tracking first ('lq init --track-changes off'), then re-run this command to remove the layout\n  - Target text inside a layout paragraph instead\n\
Run 'lq read {file_path} \"{selector}\" --count' to verify the target.",
                            node_label(ast, node)
                        ),
                    ));
                }
                if !has_layout_ancestor(ast, node, ast.root()) {
                    return Err(CliError::new(
                        "TRACKING_ERROR",
                        format!(
                            "LyX cannot track changes to '{}' — change markers are only valid inside a layout's text.\n\
Alternatives:\n  - Disable tracking first ('lq init --track-changes off'), then re-run this command\n  - Target text inside a layout paragraph instead\n\
Run 'lq read {file_path} \"{selector}\" --count' to verify the target.",
                            node_label(ast, node)
                        ),
                    ));
                }
            }
            _ => {
                if !has_layout_ancestor(ast, node, ast.root()) {
                    return Err(CliError::new(
                        "TRACKING_ERROR",
                        format!(
                            "LyX cannot track changes to '{}' — change markers are only valid inside a layout's text.\n\
Alternatives:\n  - Disable tracking first ('lq init --track-changes off'), then re-run this command\n  - Target text inside a layout paragraph instead\n\
Run 'lq read {file_path} \"{selector}\" --count' to verify the target.",
                            node_label(ast, node)
                        ),
                    ));
                }
            }
        }
    }
    Ok(())
}
