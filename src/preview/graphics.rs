//! ImageMagick discovery and rasterization (DL148).

use crate::paths::{TextReadError, read_text_file};
use std::env;
use std::path::{Path, PathBuf};

/// Resolve ImageMagick (`magick`). Exported for discovery tests (DL148).
pub fn find_magick(layouts_dir: Option<&Path>) -> Option<PathBuf> {
    if let Ok(env_path) = env::var("MAGICK_BINARY") {
        let p = PathBuf::from(&env_path);
        if p.is_file() {
            return Some(p);
        }
    }
    let mut candidates: Vec<PathBuf> = Vec::new();
    if let Some(layouts_dir) = layouts_dir {
        let root = layouts_dir.join("..").join("..");
        candidates.push(root.join("imagemagick").join("magick.exe"));
        candidates.push(root.join("imagemagick").join("magick"));
    }
    if let Ok(local_app) = env::var("LOCALAPPDATA") {
        candidates.push(
            PathBuf::from(local_app)
                .join("Programs")
                .join("LyX 2.5")
                .join("imagemagick")
                .join("magick.exe"),
        );
    }
    for c in candidates {
        if c.is_file() {
            return Some(c);
        }
    }
    find_on_path("magick")
}

fn find_on_path(command: &str) -> Option<PathBuf> {
    let path_var = env::var_os("PATH")?;
    let win_exe = cfg!(windows).then(|| format!("{command}.exe"));
    let names: Vec<&str> = match win_exe.as_deref() {
        Some(exe) => vec![exe, command],
        None => vec![command],
    };
    for dir in env::split_paths(&path_var) {
        if dir.as_os_str().is_empty() {
            continue;
        }
        for name in &names {
            let candidate = dir.join(name);
            if candidate.is_file() {
                return Some(candidate);
            }
        }
    }
    None
}

/// ImageMagick argv for a first-page PNG raster (Deno `rasterizeToPngDataUri`).
pub fn raster_magick_args(path: &Path) -> [String; 4] {
    [
        "-density".into(),
        "120".into(),
        format!("{}[0]", path.to_string_lossy()),
        "png:-".into(),
    ]
}

fn ghostscript_bin_dir(magick: &Path) -> Option<PathBuf> {
    let mut candidates: Vec<PathBuf> = Vec::new();
    if let Some(im_dir) = magick.parent() {
        candidates.push(im_dir.join("..").join("ghostscript").join("bin"));
    }
    if let Ok(local_app) = env::var("LOCALAPPDATA") {
        candidates.push(
            PathBuf::from(local_app)
                .join("Programs")
                .join("LyX 2.5")
                .join("ghostscript")
                .join("bin"),
        );
    }
    for dir in candidates {
        if gs_bin_has_interpreter(&dir) {
            return Some(dir);
        }
    }
    find_on_path("gswin64c")
        .or_else(|| find_on_path("gs"))
        .and_then(|p| p.parent().map(Path::to_path_buf))
}

fn gs_bin_has_interpreter(dir: &Path) -> bool {
    dir.join("gswin64c.exe").is_file()
        || dir.join("gswin64c").is_file()
        || dir.join("gs.exe").is_file()
        || dir.join("gs").is_file()
}

fn prepend_path_dir(dir: &Path) -> Option<std::ffi::OsString> {
    let mut paths = Vec::new();
    paths.push(dir.to_path_buf());
    if let Some(existing) = env::var_os("PATH") {
        paths.extend(env::split_paths(&existing));
    }
    env::join_paths(paths).ok()
}

/// Rasterize a non-web image to a PNG data URI via ImageMagick (DL148).
pub(crate) fn rasterize_to_png_data_uri(path: &Path, magick: Option<&Path>) -> Option<String> {
    let magick = magick?;
    let args = raster_magick_args(path);
    let mut cmd = std::process::Command::new(magick);
    cmd.args(&args);
    if let Some(gs_bin) = ghostscript_bin_dir(magick)
        && let Some(path_var) = prepend_path_dir(&gs_bin)
    {
        cmd.env("PATH", path_var);
    }
    let output = cmd.output().ok()?;
    if !output.status.success() || output.stdout.is_empty() {
        return None;
    }
    Some(format!(
        "data:image/png;base64,{}",
        base64_encode(&output.stdout)
    ))
}

fn base64_encode(bytes: &[u8]) -> String {
    const T: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::new();
    let mut i = 0;
    while i + 3 <= bytes.len() {
        let n = ((bytes[i] as u32) << 16) | ((bytes[i + 1] as u32) << 8) | bytes[i + 2] as u32;
        out.push(T[((n >> 18) & 63) as usize] as char);
        out.push(T[((n >> 12) & 63) as usize] as char);
        out.push(T[((n >> 6) & 63) as usize] as char);
        out.push(T[(n & 63) as usize] as char);
        i += 3;
    }
    let rest = bytes.len() - i;
    if rest == 1 {
        let n = (bytes[i] as u32) << 16;
        out.push(T[((n >> 18) & 63) as usize] as char);
        out.push(T[((n >> 12) & 63) as usize] as char);
        out.push('=');
        out.push('=');
    } else if rest == 2 {
        let n = ((bytes[i] as u32) << 16) | ((bytes[i + 1] as u32) << 8);
        out.push(T[((n >> 18) & 63) as usize] as char);
        out.push(T[((n >> 12) & 63) as usize] as char);
        out.push(T[((n >> 6) & 63) as usize] as char);
        out.push('=');
    }
    out
}

pub(crate) fn resolved_info_icon_name(
    name: &str,
    images_dir: Option<&Path>,
    warnings: Option<&mut Vec<String>>,
) -> String {
    let trimmed = name.trim();
    if trimmed.is_empty() {
        return String::new();
    }
    let munged = munge_icon_name(trimmed);
    match images_dir {
        Some(dir) => apply_icon_aliases(&munged, dir, warnings),
        None => munged,
    }
}

pub(crate) fn resolve_info_icon_data_uri(
    name: &str,
    images_dir: Option<&Path>,
    magick_path: Option<&Path>,
    warnings: Option<&mut Vec<String>>,
) -> Option<String> {
    let images_dir = images_dir?;
    if name.is_empty() {
        return None;
    }
    let unique = icon_file_bases(name, images_dir, warnings);
    if magick_path.is_some() {
        for base in &unique {
            let svgz_candidates = [
                images_dir.join(format!("{base}.svgz")),
                images_dir.join("oxygen").join(format!("{base}.svgz")),
                images_dir.join("adwaita").join(format!("{base}.svgz")),
                images_dir.join("classic").join(format!("{base}.svgz")),
            ];
            for file in svgz_candidates {
                if let Some(uri) = rasterize_to_png_data_uri(&file, magick_path) {
                    return Some(uri);
                }
            }
        }
    }
    for base in &unique {
        let png_candidates = [
            images_dir.join("classic").join(format!("{base}.png")),
            images_dir.join(format!("{base}.png")),
        ];
        for file in png_candidates {
            if !file.is_file() {
                continue;
            }
            if let Ok(bytes) = std::fs::read(&file)
                && !bytes.is_empty()
            {
                return Some(format!("data:image/png;base64,{}", base64_encode(&bytes)));
            }
        }
    }
    None
}

fn munge_icon_name(name: &str) -> String {
    name.replace('\\', "backslash").replace([' ', ';'], "_")
}

fn load_icon_aliases(
    images_dir: &Path,
    warnings: Option<&mut Vec<String>>,
) -> Vec<(String, String)> {
    match read_text_file(&images_dir.join("icon.aliases")) {
        Ok(text) => {
            let mut pairs = Vec::new();
            for raw in text.lines() {
                let line = raw.trim();
                if line.is_empty() || line.starts_with('#') {
                    continue;
                }
                let mut parts = line.split_whitespace();
                if let (Some(from), Some(to)) = (parts.next(), parts.next()) {
                    pairs.push((from.to_string(), to.to_string()));
                }
            }
            pairs
        }
        Err(TextReadError::NotUtf8) => {
            if let Some(warnings) = warnings {
                let msg = "icon.aliases exists but is not valid UTF-8.";
                if !warnings.iter().any(|w| w == msg) {
                    warnings.push(msg.to_string());
                }
            }
            Vec::new()
        }
        Err(e) if e.is_not_found() => Vec::new(),
        Err(_) => {
            if let Some(warnings) = warnings {
                let msg = "Could not read icon.aliases.";
                if !warnings.iter().any(|w| w == msg) {
                    warnings.push(msg.to_string());
                }
            }
            Vec::new()
        }
    }
}

fn apply_icon_aliases(name: &str, images_dir: &Path, warnings: Option<&mut Vec<String>>) -> String {
    let mut out = name.to_string();
    for (from, to) in load_icon_aliases(images_dir, warnings) {
        if out.contains(&from) {
            out = out.replace(&from, &to);
        }
    }
    out
}

fn icon_file_bases(
    name: &str,
    images_dir: &Path,
    mut warnings: Option<&mut Vec<String>>,
) -> Vec<String> {
    let trimmed = name.trim();
    if trimmed.is_empty() {
        return Vec::new();
    }
    let raw = [
        munge_icon_name(trimmed),
        trimmed.split_whitespace().next().unwrap_or("").to_string(),
    ];
    let mut bases = Vec::new();
    for b in raw {
        if b.is_empty() {
            continue;
        }
        if !bases.contains(&b) {
            bases.push(b.clone());
        }
        let aliased = apply_icon_aliases(&b, images_dir, warnings.as_deref_mut());
        if aliased != b && !bases.contains(&aliased) {
            bases.push(aliased);
        }
    }
    bases
}
