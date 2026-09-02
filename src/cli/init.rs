//! `lq init` (Deno `cli.ts` init branch).

use super::common::{CliError, ParsedArgs, UserConfig, load_user_config, print_json, push_warning};
use crate::lyxserver::check_lyx_server_available;
use crate::paths::{StatePaths, StateScope, resolve_init_state_paths};
use crate::schema::{LayoutSearchOptions, resolve_layout_search_paths};
use serde_json::{Value, json};
use std::fs;
use std::path::Path;

fn config_file_exists(state: &StatePaths) -> bool {
    fs::metadata(&state.config).is_ok_and(|m| m.is_file())
}

fn path_json(p: &Path) -> Value {
    json!(p.to_string_lossy().into_owned())
}

pub fn run_init(flags: &ParsedArgs) -> Result<(), CliError> {
    let has_flags = flags.str("layouts-dir").is_some()
        || flags.str("refresh").is_some()
        || flags.str("track-changes").is_some()
        || flags.str("max-cache-entries").is_some()
        || flags.str("author-name").is_some();
    let use_global = flags.bool("global");
    let dir_flag = flags.str("layouts-dir").map(str::to_string);
    let refresh = flags.str("refresh").map(str::to_string);
    let track_changes_flag = flags.str("track-changes").map(str::to_string);
    let max_cache_entries_str = flags.str("max-cache-entries").map(str::to_string);
    let author_name_flag = flags.str("author-name").map(str::to_string);

    if let Some(ref refresh) = refresh
        && refresh != "none"
        && refresh != "reload"
        && refresh != "save-reload"
    {
        return Err(CliError::new(
            "INVALID_FLAG",
            format!("--refresh must be 'none', 'reload', or 'save-reload', got: '{refresh}'"),
        ));
    }
    if let Some(ref track) = track_changes_flag
        && track != "on"
        && track != "off"
    {
        return Err(CliError::new(
            "INVALID_FLAG",
            format!("--track-changes must be 'on' or 'off', got: '{track}'"),
        ));
    }

    let mut max_cache_entries: Option<u64> = None;
    if let Some(ref s) = max_cache_entries_str {
        if !s.chars().all(|c| c.is_ascii_digit()) || s.is_empty() {
            return Err(CliError::new(
                "INVALID_FLAG",
                format!("--max-cache-entries must be a non-negative integer, got: '{s}'"),
            ));
        }
        match s.parse::<u64>() {
            Ok(n) => max_cache_entries = Some(n),
            Err(_) => {
                return Err(CliError::new(
                    "INVALID_FLAG",
                    format!("--max-cache-entries must be a non-negative integer, got: '{s}'"),
                ));
            }
        }
    }

    if let Some(ref name) = author_name_flag
        && name.trim().is_empty()
    {
        return Err(CliError::new(
            "INVALID_FLAG",
            "--author-name must be a non-empty string.",
        ));
    }

    let cwd = std::env::current_dir().unwrap_or_else(|_| Path::new(".").to_path_buf());
    let Some(state_paths) = resolve_init_state_paths(use_global, &cwd, None) else {
        return Err(CliError::new(
            "NO_HOME",
            "Could not determine a home directory for global state. Set HOME or USERPROFILE, or run 'lq init' from a project directory for local state.",
        ));
    };
    let config_exists = config_file_exists(&state_paths);
    let existing = load_user_config(&state_paths).config;

    if !has_flags && config_exists {
        print_json(json!({
            "scope": scope_str(state_paths.scope),
            "configPath": path_json(&state_paths.config),
            "action": "read",
            "data": existing,
        }));
        return Ok(());
    }

    if let Some(ref dir) = dir_flag {
        match fs::metadata(dir) {
            Ok(m) if m.is_dir() => {}
            Ok(_) => {
                return Err(CliError::new(
                    "INVALID_DIR",
                    format!(
                        "The path '{dir}' is not a directory. Please provide a valid --layouts-dir."
                    ),
                ));
            }
            Err(_) => {
                return Err(CliError::new(
                    "DIR_NOT_FOUND",
                    format!(
                        "Could not find layouts directory at '{dir}'. Please provide it manually via --layouts-dir."
                    ),
                ));
            }
        }
    }

    let mut config = UserConfig {
        refresh: Some(
            refresh
                .clone()
                .or(existing.refresh)
                .unwrap_or_else(|| "none".into()),
        ),
        track_changes: Some(match track_changes_flag.as_deref() {
            Some("on") => true,
            Some("off") => false,
            _ => existing.track_changes.unwrap_or(true),
        }),
        max_cache_entries: Some(
            max_cache_entries
                .or(existing.max_cache_entries)
                .unwrap_or(50),
        ),
        author_name: Some(
            author_name_flag
                .or(existing.author_name)
                .unwrap_or_else(|| "lq user".into()),
        ),
        layouts_dir: None,
    };
    if let Some(d) = dir_flag {
        config.layouts_dir = Some(d);
    } else if existing.layouts_dir.is_some() {
        config.layouts_dir = existing.layouts_dir;
    }

    if config.refresh.as_deref().is_some_and(|r| r != "none") {
        let available = check_lyx_server_available();
        if !available {
            let mode = config.refresh.as_deref().unwrap_or("none");
            push_warning(format!(
                "Refresh mode '{mode}' requires a running LyX instance with LyXServer enabled, \
but the server could not be reached (no socket found, or LyX is not accepting commands). \
Enable LyXServer in LyX Preferences and restart LyX."
            ));
        }
    }

    let roots = resolve_layout_search_paths(&LayoutSearchOptions {
        overlay_layouts_dir: config.layouts_dir.as_ref().map(|s| s.into()),
        system_layouts_dir: None,
    });
    let layout_search = if config.layouts_dir.is_some() {
        "overlay → user → system → LocalLayout"
    } else {
        "user → system → LocalLayout"
    };

    if let Err(e) = (|| -> std::io::Result<()> {
        fs::create_dir_all(&state_paths.root)?;
        let text = serde_json::to_string_pretty(&config).map_err(std::io::Error::other)?;
        fs::write(&state_paths.config, text)?;
        Ok(())
    })() {
        return Err(CliError::new(
            "WRITE_ERROR",
            format!("Failed to write config file: {e}"),
        ));
    }

    print_json(json!({
        "scope": scope_str(state_paths.scope),
        "configPath": path_json(&state_paths.config),
        "action": if config_exists { "updated" } else { "created" },
        "data": config,
        "layoutSearch": layout_search,
        "layoutRoots": {
            "overlay": roots.overlay.as_ref().map(|p| path_json(p)).unwrap_or(Value::Null),
            "user": roots.user.as_ref().map(|p| path_json(p)).unwrap_or(Value::Null),
            "system": path_json(&roots.system),
        },
    }));
    Ok(())
}

fn scope_str(scope: StateScope) -> &'static str {
    match scope {
        StateScope::Local => "local",
        StateScope::Global => "global",
    }
}
