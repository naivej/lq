//! Local/global `.lq` state paths (Deno `paths.ts`).

use std::collections::HashMap;
use std::io;
use std::path::{Path, PathBuf};

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum StateScope {
    Local,
    Global,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct StatePaths {
    pub scope: StateScope,
    pub root: PathBuf,
    pub config: PathBuf,
    pub cache: PathBuf,
    pub undo: PathBuf,
}

pub type EnvMap = HashMap<String, String>;

fn env_get(env: Option<&EnvMap>, name: &str) -> Option<String> {
    let raw = if let Some(env) = env {
        env.get(name).cloned()
    } else {
        std::env::var(name).ok()
    };
    raw.filter(|s| !s.is_empty())
}

/// User home as a native OS path (Git Bash `/c/Users/…` → `C:\Users\…` on Windows).
pub fn get_user_home_dir(env: Option<&EnvMap>) -> Option<PathBuf> {
    let home = env_get(env, "HOME");
    let user_profile = env_get(env, "USERPROFILE");

    if !cfg!(windows) {
        return home.or(user_profile).map(PathBuf::from);
    }

    if let Some(ref h) = home {
        if let Some(native) = msys_home_to_windows(h) {
            return Some(native);
        }
        if is_windows_drive_path(h) {
            return Some(PathBuf::from(h));
        }
    }
    user_profile.or(home).map(PathBuf::from)
}

fn msys_home_to_windows(home: &str) -> Option<PathBuf> {
    let rest = home.strip_prefix('/')?;
    let mut chars = rest.chars();
    let drive = chars.next()?;
    if !drive.is_ascii_alphabetic() {
        return None;
    }
    match chars.next() {
        None => Some(PathBuf::from(format!("{}:\\", drive.to_ascii_uppercase()))),
        Some('/') => {
            let tail = chars.as_str().replace('/', "\\");
            Some(PathBuf::from(format!(
                "{}:\\{tail}",
                drive.to_ascii_uppercase()
            )))
        }
        _ => None,
    }
}

fn is_windows_drive_path(home: &str) -> bool {
    let b = home.as_bytes();
    b.len() >= 3 && b[0].is_ascii_alphabetic() && b[1] == b':' && (b[2] == b'\\' || b[2] == b'/')
}

fn create_state_paths(scope: StateScope, root: PathBuf) -> StatePaths {
    StatePaths {
        config: root.join("config.json"),
        cache: root.join("cache"),
        undo: root.join("undo"),
        scope,
        root,
    }
}

fn is_same_path(left: &Path, right: &Path) -> bool {
    let left_n = normalize_path(left);
    let right_n = normalize_path(right);
    if cfg!(windows) {
        left_n.eq_ignore_ascii_case(&right_n)
    } else {
        left_n == right_n
    }
}

fn normalize_path(p: &Path) -> String {
    let abs = if p.is_absolute() {
        p.to_path_buf()
    } else {
        std::env::current_dir()
            .unwrap_or_else(|_| PathBuf::from("."))
            .join(p)
    };
    abs.components()
        .collect::<PathBuf>()
        .to_string_lossy()
        .replace('/', "\\")
}

fn canonical_windows_home_dir(env: Option<&EnvMap>) -> Option<PathBuf> {
    if !cfg!(windows) {
        return None;
    }
    let drive = env_get(env, "HOMEDRIVE")?;
    let home_path = env_get(env, "HOMEPATH")?;
    Some(PathBuf::from(format!("{drive}{home_path}")))
}

pub fn find_local_state_root(cwd: &Path, env: Option<&EnvMap>) -> Option<PathBuf> {
    let mut current = if cwd.is_absolute() {
        cwd.to_path_buf()
    } else {
        std::env::current_dir().ok()?.join(cwd)
    };
    let mut homes = Vec::new();
    if let Some(h) = get_user_home_dir(env) {
        homes.push(h);
    }
    if let Some(h) = get_user_home_dir(None) {
        homes.push(h);
    }
    if let Some(h) = canonical_windows_home_dir(None) {
        homes.push(h);
    }
    loop {
        let root = current.join(".lq");
        if !homes.iter().any(|home| is_same_path(&current, home)) && root.is_dir() {
            return Some(root);
        }
        let parent = current.parent()?;
        if parent == current {
            return None;
        }
        current = parent.to_path_buf();
    }
}

pub fn get_global_state_paths(env: Option<&EnvMap>) -> Option<StatePaths> {
    let home = get_user_home_dir(env)?;
    Some(create_state_paths(StateScope::Global, home.join(".lq")))
}

pub fn resolve_state_paths(cwd: &Path, env: Option<&EnvMap>) -> Option<StatePaths> {
    if let Some(local) = find_local_state_root(cwd, env) {
        return Some(create_state_paths(StateScope::Local, local));
    }
    get_global_state_paths(env)
}

pub fn resolve_init_state_paths(
    use_global: bool,
    cwd: &Path,
    env: Option<&EnvMap>,
) -> Option<StatePaths> {
    if use_global {
        return get_global_state_paths(env);
    }
    if let Some(local) = find_local_state_root(cwd, env) {
        return Some(create_state_paths(StateScope::Local, local));
    }
    let cwd_abs = if cwd.is_absolute() {
        cwd.to_path_buf()
    } else {
        std::env::current_dir().ok()?.join(cwd)
    };
    Some(create_state_paths(StateScope::Local, cwd_abs.join(".lq")))
}

/// Disk text read: I/O vs invalid UTF-8 (022). Not a process-exiting helper.
#[derive(Debug)]
pub(crate) enum TextReadError {
    Io(io::Error),
    NotUtf8,
}

impl TextReadError {
    pub(crate) fn is_not_found(&self) -> bool {
        matches!(self, TextReadError::Io(e) if e.kind() == io::ErrorKind::NotFound)
    }
}

pub(crate) fn read_text_file(path: &Path) -> Result<String, TextReadError> {
    let bytes = std::fs::read(path).map_err(TextReadError::Io)?;
    String::from_utf8(bytes).map_err(|_| TextReadError::NotUtf8)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn temp_dir(prefix: &str) -> PathBuf {
        let p = std::env::temp_dir().join(format!(
            "lq_paths_{prefix}_{}_{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        fs::create_dir_all(&p).unwrap();
        p
    }

    #[test]
    fn git_bash_home_on_windows() {
        if !cfg!(windows) {
            return;
        }
        let mut env = EnvMap::new();
        env.insert("HOME".into(), "/c/Users/example".into());
        let home = get_user_home_dir(Some(&env)).unwrap();
        assert_eq!(home, PathBuf::from(r"C:\Users\example"));
    }

    #[test]
    fn prefer_native_home_override_on_windows() {
        if !cfg!(windows) {
            return;
        }
        let mut env = EnvMap::new();
        env.insert("HOME".into(), r"D:\lq-home".into());
        env.insert("USERPROFILE".into(), r"C:\Users\Fallback".into());
        let home = get_user_home_dir(Some(&env)).unwrap();
        assert_eq!(home, PathBuf::from(r"D:\lq-home"));
    }

    #[test]
    fn nearest_local_root_wins() {
        let project = temp_dir("project");
        let nested = project.join("src").join("nested");
        fs::create_dir_all(&nested).unwrap();
        fs::create_dir_all(project.join(".lq")).unwrap();
        let mut env = EnvMap::new();
        let global_home = project.join("home");
        env.insert("HOME".into(), global_home.to_string_lossy().into());
        env.insert("USERPROFILE".into(), global_home.to_string_lossy().into());

        let local = resolve_state_paths(&nested, Some(&env)).unwrap();
        assert_eq!(local.scope, StateScope::Local);
        assert_eq!(local.root, project.join(".lq"));

        fs::create_dir_all(project.join("src").join(".lq")).unwrap();
        let nearest = find_local_state_root(&nested, Some(&env)).unwrap();
        assert_eq!(nearest, project.join("src").join(".lq"));

        let fallback = temp_dir("fallback");
        let no_local = resolve_state_paths(&fallback, Some(&env)).unwrap();
        assert_eq!(no_local.scope, StateScope::Global);
        assert_eq!(no_local.root, global_home.join(".lq"));

        let _ = fs::remove_dir_all(&project);
        let _ = fs::remove_dir_all(&fallback);
    }

    #[test]
    fn local_init_target_is_cwd_when_no_marker() {
        let project = temp_dir("init");
        let state = resolve_init_state_paths(false, &project, None).unwrap();
        assert_eq!(state.scope, StateScope::Local);
        assert_eq!(state.root, project.join(".lq"));
        assert!(get_user_home_dir(Some(&EnvMap::new())).is_none());
        let _ = fs::remove_dir_all(&project);
    }
}
