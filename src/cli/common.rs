//! Typed flags, JSON envelope, selector guards.

use crate::ast::Document;
use crate::cache::{get_cached_ast, hash_text, set_cached_ast};
use crate::parser::parse;
use crate::paths::{StatePaths, TextReadError, read_text_file};
use crate::query::{Combinator, PseudoName, is_valid_nth_match_formula, parse_selector};
use crate::schema::{LayoutSearchOptions, LayoutSearchResolved, resolve_layout_search_paths};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value, json};
use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::process;
use std::sync::Mutex;

static WARNINGS: Mutex<Vec<String>> = Mutex::new(Vec::new());

/// CLI failure. `code` / `message` are the JSON envelope. `details` stays empty today.
#[must_use]
pub struct CliError {
    pub code: String,
    pub message: String,
    pub details: Map<String, Value>,
}

impl CliError {
    pub fn new(code: impl Into<String>, message: impl Into<String>) -> Self {
        Self {
            code: code.into(),
            message: message.into(),
            details: Map::new(),
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Flag {
    Bool(bool),
    Str(String),
}

#[derive(Clone, Debug, Default)]
pub struct ParsedArgs {
    pub positional: Vec<String>,
    pub flags: HashMap<String, Flag>,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UserConfig {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub layouts_dir: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub refresh: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub track_changes: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub max_cache_entries: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub author_name: Option<String>,
}

impl ParsedArgs {
    pub fn bool(&self, name: &str) -> bool {
        matches!(self.flags.get(name), Some(Flag::Bool(true)))
    }

    pub fn str(&self, name: &str) -> Option<&str> {
        match self.flags.get(name) {
            Some(Flag::Str(s)) => Some(s.as_str()),
            _ => None,
        }
    }
}

#[derive(Clone, Copy, Debug)]
pub enum FlagKind {
    Switch,
    Value,
}

#[derive(Clone, Copy, Debug)]
pub struct FlagDef {
    pub name: &'static str,
    pub kind: FlagKind,
}

pub const INIT_SPEC: &[FlagDef] = &[
    FlagDef {
        name: "global",
        kind: FlagKind::Switch,
    },
    FlagDef {
        name: "layouts-dir",
        kind: FlagKind::Value,
    },
    FlagDef {
        name: "refresh",
        kind: FlagKind::Value,
    },
    FlagDef {
        name: "track-changes",
        kind: FlagKind::Value,
    },
    FlagDef {
        name: "max-cache-entries",
        kind: FlagKind::Value,
    },
    FlagDef {
        name: "author-name",
        kind: FlagKind::Value,
    },
];

pub const DUMP_SPEC: &[FlagDef] = &[
    FlagDef {
        name: "toc",
        kind: FlagKind::Switch,
    },
    FlagDef {
        name: "depth",
        kind: FlagKind::Value,
    },
];

pub const BIB_SPEC: &[FlagDef] = &[FlagDef {
    name: "search",
    kind: FlagKind::Value,
}];

pub const READ_SPEC: &[FlagDef] = &[
    FlagDef {
        name: "count",
        kind: FlagKind::Switch,
    },
    FlagDef {
        name: "text-only",
        kind: FlagKind::Switch,
    },
];

pub const SET_SPEC: &[FlagDef] = &[
    FlagDef {
        name: "replace-all",
        kind: FlagKind::Switch,
    },
    FlagDef {
        name: "find",
        kind: FlagKind::Value,
    },
];

pub const INSERT_SPEC: &[FlagDef] = &[
    FlagDef {
        name: "layout",
        kind: FlagKind::Value,
    },
    FlagDef {
        name: "text",
        kind: FlagKind::Value,
    },
    FlagDef {
        name: "raw-file",
        kind: FlagKind::Value,
    },
    FlagDef {
        name: "cite",
        kind: FlagKind::Value,
    },
    FlagDef {
        name: "cite-cmd",
        kind: FlagKind::Value,
    },
    FlagDef {
        name: "ref",
        kind: FlagKind::Value,
    },
    FlagDef {
        name: "ref-cmd",
        kind: FlagKind::Value,
    },
    FlagDef {
        name: "label",
        kind: FlagKind::Value,
    },
    FlagDef {
        name: "footnote",
        kind: FlagKind::Value,
    },
];

pub const EMPTY_SPEC: &[FlagDef] = &[];

fn lookup_kind(spec: &[FlagDef], name: &str) -> Option<FlagKind> {
    spec.iter().find(|d| d.name == name).map(|d| d.kind)
}

fn lone_dash_dash_error(command_name: &str) -> CliError {
    CliError::new(
        "INVALID_FLAG",
        format!(
            "'--' is not valid here. Pass the selector as the next argument after the file (e.g. 'lq read FILE SELECTOR'). Run 'lq {command_name} --help'."
        ),
    )
}

fn unknown_long_flag(command_name: &str, key: &str, peeked_value: Option<&str>) -> CliError {
    if command_name != "init" && INIT_ONLY_FLAGS.contains(&key) {
        if let Some(value) = peeked_value.filter(|v| !v.is_empty() && !v.starts_with("--")) {
            return CliError::new(
                "INVALID_FLAG",
                format!(
                    "--{key} is an 'init' flag, not a '{command_name}' flag. Change it with 'lq init --{key} {value}', then re-run this command."
                ),
            );
        }
        return CliError::new(
            "INVALID_FLAG",
            format!(
                "--{key} is an 'init' flag, not a '{command_name}' flag. Change it with 'lq init --{key}', then re-run this command."
            ),
        );
    }
    CliError::new(
        "INVALID_FLAG",
        format!(
            "Unknown flag for '{command_name}': --{key}. Run 'lq {command_name} --help' to list valid flags."
        ),
    )
}

/// Typed flags (A-1 / A-3). Unknown `--name` does not consume the next token.
pub fn parse_typed(
    args: &[String],
    spec: &[FlagDef],
    command_name: &str,
) -> Result<ParsedArgs, CliError> {
    let mut out = ParsedArgs::default();
    for def in spec {
        if matches!(def.kind, FlagKind::Switch) {
            out.flags.insert(def.name.to_string(), Flag::Bool(false));
        }
    }
    let mut i = 0;
    while i < args.len() {
        let a = &args[i];
        if a == "--" {
            return Err(lone_dash_dash_error(command_name));
        }
        if let Some(rest) = a.strip_prefix("--") {
            if rest.is_empty() {
                return Err(lone_dash_dash_error(command_name));
            }
            if let Some((key, value)) = rest.split_once('=') {
                match lookup_kind(spec, key) {
                    Some(FlagKind::Switch) => {
                        return Err(CliError::new(
                            "INVALID_FLAG",
                            format!(
                                "'--{key}' does not take a value. Run 'lq {command_name} --help'."
                            ),
                        ));
                    }
                    Some(FlagKind::Value) => {
                        out.flags
                            .insert(key.to_string(), Flag::Str(value.to_string()));
                    }
                    None => return Err(unknown_long_flag(command_name, key, Some(value))),
                }
            } else {
                match lookup_kind(spec, rest) {
                    Some(FlagKind::Switch) => {
                        out.flags.insert(rest.to_string(), Flag::Bool(true));
                    }
                    Some(FlagKind::Value) => {
                        let next = args.get(i + 1);
                        if next.is_some_and(|n| !n.starts_with("--")) {
                            i += 1;
                            out.flags
                                .insert(rest.to_string(), Flag::Str(args[i].clone()));
                        } else {
                            return Err(CliError::new(
                                "INVALID_FLAG",
                                format!(
                                    "'--{rest}' requires a value. Run 'lq {command_name} --help'."
                                ),
                            ));
                        }
                    }
                    None => {
                        let peeked = args.get(i + 1).map(String::as_str);
                        return Err(unknown_long_flag(command_name, rest, peeked));
                    }
                }
            }
        } else {
            out.positional.push(a.clone());
        }
        i += 1;
    }
    Ok(out)
}

pub struct HelpScan {
    pub show_help: bool,
    pub rich: Option<String>,
    pub remainder: Vec<String>,
}

/// Pull `--help` / `-h` / `--rich` without treating other `--` tokens as unknown.
pub fn scan_help_flags(args: &[String]) -> Result<HelpScan, CliError> {
    let mut show_help = false;
    let mut rich = None;
    let mut remainder = Vec::new();
    let mut i = 0;
    while i < args.len() {
        let a = &args[i];
        if a == "--help" || a == "-h" {
            show_help = true;
        } else if a.starts_with("--help=") {
            return Err(CliError::new(
                "INVALID_FLAG",
                "'--help' does not take a value. Run 'lq --help'.",
            ));
        } else if let Some(value) = a.strip_prefix("--rich=") {
            rich = Some(value.to_string());
        } else if a == "--rich" {
            let next = args.get(i + 1);
            if next.is_some_and(|n| !n.starts_with("--")) {
                i += 1;
                rich = Some(args[i].clone());
            } else {
                return Err(CliError::new(
                    "INVALID_FLAG",
                    "'--rich' requires a value. Run 'lq --help'.",
                ));
            }
        } else {
            remainder.push(a.clone());
        }
        i += 1;
    }
    Ok(HelpScan {
        show_help,
        rich,
        remainder,
    })
}

pub fn reject_unexpected_args(
    positionals: &[String],
    skip: usize,
    command: &str,
) -> Result<(), CliError> {
    if let Some(token) = positionals.get(skip) {
        return Err(CliError::new(
            "INVALID_FLAG",
            format!("Unexpected argument '{token}' for '{command}'. Run 'lq {command} --help'."),
        ));
    }
    Ok(())
}

fn warnings_lock() -> std::sync::MutexGuard<'static, Vec<String>> {
    WARNINGS.lock().unwrap_or_else(|e| e.into_inner())
}

pub fn push_warning(message: impl Into<String>) {
    warnings_lock().push(message.into());
}

fn take_warnings() -> Vec<String> {
    std::mem::take(&mut *warnings_lock())
}

fn clear_warnings() {
    warnings_lock().clear();
}

pub fn print_json(mut data: Value) {
    let warnings = take_warnings();
    if let Value::Object(ref mut m) = data {
        m.insert("warnings".into(), json!(warnings));
    }
    println!("{}", pretty_json(&data));
}

fn pretty_json(value: &Value) -> String {
    serde_json::to_string_pretty(value).unwrap_or_else(|_| "{}".into())
}

pub fn print_error(err: CliError) -> ! {
    clear_warnings();
    let mut obj = Map::new();
    obj.insert("code".into(), json!(err.code));
    obj.insert("message".into(), json!(err.message));
    let mut details = err.details;
    obj.append(&mut details);
    print_json(Value::Object(obj));
    process::exit(1);
}

pub(crate) const INIT_ONLY_FLAGS: &[&str] = &[
    "global",
    "layouts-dir",
    "refresh",
    "track-changes",
    "max-cache-entries",
    "author-name",
];

pub fn assert_no_selector_mistakes(selector: Option<&str>) -> Result<(), CliError> {
    let Some(selector) = selector else {
        return Ok(());
    };
    let Ok(groups) = parse_selector(selector) else {
        return Ok(());
    };
    for group in groups {
        for part in group {
            if part
                .pseudos
                .iter()
                .any(|pseudo| pseudo.name == PseudoName::Until)
                && part.combinator != Some(Combinator::Sibling)
            {
                return Err(CliError::new(
                    "INVALID_SELECTOR",
                    ":until() has no effect here: it only bounds the target of a ~ sibling range. \
Move it after a ~ (e.g. 'layout[A] ~ layout[B]:until(layout[C])') or drop ':until'.",
                ));
            }
            if part.tag.as_deref() == Some("text")
                && part
                    .pseudos
                    .iter()
                    .any(|pseudo| pseudo.name == PseudoName::Contains)
            {
                return Err(CliError::new(
                    "INVALID_SELECTOR",
                    "text:contains(...) never matches — text nodes are not returned for :contains. \
Select the block instead (e.g. 'layout[Standard]:contains(foo)') or do content work \
with 'set --find' / 'insert split-after'.",
                ));
            }
            for pseudo in part.pseudos {
                if pseudo.name == PseudoName::NthMatch
                    && let Some(raw) = pseudo.arg_raw
                    && !is_valid_nth_match_formula(&raw)
                {
                    return Err(CliError::new(
                        "INVALID_SELECTOR",
                        format!(
                            ":nth-match({raw}) has an invalid formula — it would match nothing. \
Use an integer, 'odd', 'even', or a formula like '2n+1'."
                        ),
                    ));
                }
            }
        }
    }
    Ok(())
}

#[derive(Clone, Debug, Default)]
pub struct LoadedUserConfig {
    pub config: UserConfig,
    pub exists: bool,
    pub unreadable: bool,
}

pub fn load_user_config(state: &StatePaths) -> LoadedUserConfig {
    match fs::metadata(&state.config) {
        Ok(metadata) if metadata.is_file() => {}
        _ => {
            return LoadedUserConfig {
                config: UserConfig::default(),
                exists: false,
                unreadable: false,
            };
        }
    }
    match read_text_file(&state.config)
        .map_err(|_| std::io::Error::other("config unreadable"))
        .and_then(|text| serde_json::from_str::<UserConfig>(&text).map_err(std::io::Error::other))
    {
        Ok(config) => LoadedUserConfig {
            config,
            exists: true,
            unreadable: false,
        },
        Err(_) => LoadedUserConfig {
            config: UserConfig::default(),
            exists: true,
            unreadable: true,
        },
    }
}

pub fn resolve_document_layout_roots(config: &UserConfig) -> LayoutSearchResolved {
    resolve_layout_search_paths(&LayoutSearchOptions {
        overlay_layouts_dir: config.layouts_dir.as_ref().map(PathBuf::from),
        system_layouts_dir: None,
    })
}

pub struct LoadedLyx {
    pub ast: Document,
    pub text: String,
    pub hash: String,
}

/// Read a path as UTF-8. Missing/unreadable → `FILE_NOT_FOUND`. Existing but
/// not UTF-8 → `PARSE_ERROR` (intended deviation #3). Deno `readTextFile` is
/// lossy and then fails at the `#` header.
pub fn read_utf8_file(file_path: &str, missing_message: &str) -> Result<String, CliError> {
    match read_text_file(Path::new(file_path)) {
        Ok(text) => Ok(text),
        Err(TextReadError::Io(_)) => Err(CliError::new("FILE_NOT_FOUND", missing_message)),
        Err(TextReadError::NotUtf8) => Err(CliError::new(
            "PARSE_ERROR",
            format!("File exists but is not valid UTF-8: {file_path}"),
        )),
    }
}

pub fn load_lyx_full(file_path: &str, state: &StatePaths) -> Result<LoadedLyx, CliError> {
    let text = read_utf8_file(file_path, &format!("Could not read file: {file_path}"))?;
    let hash = hash_text(&text);
    if let Some(cached) = get_cached_ast(Path::new(file_path), state, Some(&hash)) {
        return Ok(LoadedLyx {
            ast: cached,
            text,
            hash,
        });
    }
    let ast = match parse(&text, false) {
        Ok(ast) => ast,
        Err(error) => return Err(CliError::new("PARSE_ERROR", error.message)),
    };
    set_cached_ast(&hash, &ast, state);
    Ok(LoadedLyx { ast, text, hash })
}
