//! LyX `.bind` loader for Live Info shortcuts (Deno `bind.ts`).

use crate::paths::{TextReadError, read_text_file};
use std::collections::HashSet;
use std::fs;
use std::path::{Path, PathBuf};

pub type ShortcutMap = std::collections::HashMap<String, Vec<String>>;

pub fn format_bind_sequence(portable: &str) -> String {
    portable
        .split_whitespace()
        .filter(|s| !s.is_empty())
        .map(format_bind_key)
        .collect::<Vec<_>>()
        .join(" ")
}

fn format_bind_key(portable: &str) -> String {
    let mut mods: Vec<String> = Vec::new();
    let mut key = String::new();
    for part in portable.split('-') {
        if part == "C" {
            mods.push("Ctrl".into());
        } else if part == "M" {
            mods.push("Alt".into());
        } else if part == "S" {
            mods.push("Shift".into());
        } else if part == "~S" {
            continue;
        } else if !part.is_empty() {
            key = if part.len() == 1 {
                part.to_uppercase()
            } else {
                part.strip_prefix("KP_").unwrap_or(part).to_string()
            };
        }
    }
    mods.push(key);
    mods.into_iter()
        .filter(|s| !s.is_empty())
        .collect::<Vec<_>>()
        .join("+")
}

pub(crate) fn bind_dir_from_layouts(layouts_dir: Option<&Path>) -> Option<PathBuf> {
    layouts_dir.and_then(|d| d.parent()).map(|p| p.join("bind"))
}

pub(crate) fn images_dir_from_layouts(layouts_dir: Option<&Path>) -> Option<PathBuf> {
    layouts_dir
        .and_then(|d| d.parent())
        .map(|p| p.join("images"))
}

pub(crate) fn load_shortcut_map(bind_dir: Option<&Path>) -> (ShortcutMap, Vec<String>) {
    let mut out = ShortcutMap::new();
    let mut warnings = Vec::new();
    let Some(bind_dir) = bind_dir else {
        return (out, warnings);
    };
    if !bind_dir.is_dir() {
        return (out, warnings);
    }
    let mut visited = HashSet::new();
    load_bind_file(
        &bind_dir.join("cua.bind"),
        bind_dir,
        &mut out,
        &mut visited,
        &mut warnings,
    );
    (out, warnings)
}

pub(crate) fn load_shortcut_map_merged(
    system_bind_dir: Option<&Path>,
    user_bind_dir: Option<&Path>,
) -> (ShortcutMap, Vec<String>) {
    let (mut map, mut warnings) = load_shortcut_map(system_bind_dir);
    let Some(user_bind_dir) = user_bind_dir else {
        return (map, warnings);
    };
    if system_bind_dir.is_some_and(|s| s == user_bind_dir) {
        return (map, warnings);
    }
    let (user, user_warnings) = load_shortcut_map(Some(user_bind_dir));
    warnings.extend(user_warnings);
    for (lfun, keys) in user {
        let existing = map.remove(&lfun).unwrap_or_default();
        let mut merged = Vec::new();
        for k in keys {
            if !merged.contains(&k) {
                merged.push(k);
            }
        }
        for k in existing {
            if !merged.contains(&k) {
                merged.push(k);
            }
        }
        map.insert(lfun, merged);
    }
    (map, warnings)
}

fn load_bind_file(
    file_path: &Path,
    bind_dir: &Path,
    out: &mut ShortcutMap,
    visited: &mut HashSet<PathBuf>,
    warnings: &mut Vec<String>,
) {
    let resolved = fs::canonicalize(file_path).unwrap_or_else(|_| file_path.to_path_buf());
    if !visited.insert(resolved.clone()) {
        return;
    }
    let name = file_path
        .file_name()
        .and_then(|s| s.to_str())
        .unwrap_or("bind");
    let text = match read_text_file(&resolved) {
        Ok(text) => text,
        Err(TextReadError::NotUtf8) => {
            warnings.push(format!("Bind file '{name}' exists but is not valid UTF-8."));
            return;
        }
        Err(e) if e.is_not_found() => return,
        Err(_) => {
            warnings.push(format!("Could not read bind file '{name}'."));
            return;
        }
    };
    for raw in text.split('\n') {
        let mut line = raw.trim();
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        if let Some(hash) = line.find('#')
            && hash > 0
        {
            line = line[..hash].trim();
        }
        if let Some(name) = parse_bind_file(line) {
            let name = name.trim_matches('"');
            load_bind_file(&bind_dir.join(name), bind_dir, out, visited, warnings);
            continue;
        }
        let Some((seq, lfun_full)) = parse_bind_line(line) else {
            continue;
        };
        let keys = format_bind_sequence(seq);
        let lfun_full = lfun_full.trim();
        if keys.is_empty() || lfun_full.is_empty() {
            continue;
        }
        let lfun = lfun_full.split_whitespace().next().unwrap_or(lfun_full);
        push_key(out, lfun, &keys);
        if lfun_full != lfun {
            push_key(out, lfun_full, &keys);
        }
    }
}

fn push_key(out: &mut ShortcutMap, lfun: &str, keys: &str) {
    let list = out.entry(lfun.to_string()).or_default();
    if !list.iter().any(|k| k == keys) {
        list.push(keys.to_string());
    }
}

fn parse_bind_file(line: &str) -> Option<&str> {
    let rest = line.strip_prefix("\\bind_file")?;
    let rest = rest.trim_start();
    if rest.is_empty() {
        return None;
    }
    Some(rest.split_whitespace().next().unwrap_or(rest))
}

fn parse_bind_line(line: &str) -> Option<(&str, &str)> {
    let rest = line.strip_prefix("\\bind")?;
    let rest = rest.trim_start();
    if !rest.starts_with('"') {
        return None;
    }
    let rest = &rest[1..];
    let end1 = rest.find('"')?;
    let seq = &rest[..end1];
    let rest = rest[end1 + 1..].trim_start();
    if !rest.starts_with('"') {
        return None;
    }
    let rest = &rest[1..];
    let end2 = rest.find('"')?;
    Some((seq, &rest[..end2]))
}

pub fn lookup_shortcut(map: Option<&ShortcutMap>, arg: &str, all: bool) -> Option<String> {
    let map = map?;
    if map.is_empty() || arg.is_empty() {
        return None;
    }
    let keys = map.get(arg).or_else(|| {
        arg.split_whitespace()
            .next()
            .and_then(|first| map.get(first))
    })?;
    if keys.is_empty() {
        return None;
    }
    Some(if all {
        keys.join(", ")
    } else {
        keys[0].clone()
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn format_bind_sequence_cua() {
        assert_eq!(format_bind_sequence("C-m"), "Ctrl+M");
        assert_eq!(format_bind_sequence("C-S-v"), "Ctrl+Shift+V");
        assert_eq!(format_bind_sequence("M-m m"), "Alt+M M");
        assert_eq!(format_bind_sequence("C-Insert"), "Ctrl+Insert");
    }

    #[test]
    fn lookup_empty() {
        assert_eq!(
            lookup_shortcut(Some(&ShortcutMap::new()), "math-mode", false),
            None
        );
        assert_eq!(lookup_shortcut(None, "math-mode", false), None);
    }

    #[test]
    fn load_and_merge_user_prepends() {
        let system = std::env::temp_dir().join(format!(
            "lq_bind_sys_{}_{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let user = std::env::temp_dir().join(format!(
            "lq_bind_user_{}_{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&system).unwrap();
        std::fs::create_dir_all(&user).unwrap();
        std::fs::write(
            system.join("cua.bind"),
            "\\bind \"C-m\" \"math-mode\"\n\\bind \"C-n\" \"buffer-new\"\n",
        )
        .unwrap();
        std::fs::write(user.join("cua.bind"), "\\bind \"C-F12\" \"math-mode\"\n").unwrap();
        let (map, _) = load_shortcut_map(Some(&system));
        assert_eq!(
            lookup_shortcut(Some(&map), "buffer-new", false).as_deref(),
            Some("Ctrl+N")
        );
        assert_eq!(
            lookup_shortcut(Some(&map), "math-mode", false).as_deref(),
            Some("Ctrl+M")
        );
        let all = lookup_shortcut(Some(&map), "math-mode", true).unwrap();
        assert!(all.contains("Ctrl+M"), "{all}");
        let (merged, _) = load_shortcut_map_merged(Some(&system), Some(&user));
        assert_eq!(
            lookup_shortcut(Some(&merged), "math-mode", false).as_deref(),
            Some("Ctrl+F12")
        );
        let all = lookup_shortcut(Some(&merged), "math-mode", true).unwrap();
        assert!(all.contains("Ctrl+M"), "{all}");
        let _ = std::fs::remove_dir_all(&system);
        let _ = std::fs::remove_dir_all(&user);
    }
}
