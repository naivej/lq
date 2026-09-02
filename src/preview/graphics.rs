//! ImageMagick discovery and rasterization (DL148). Info icons (031).

use crate::cache::{hash_file, max_cache_entries, prune_raster_dir};
use crate::paths::{TextReadError, read_text_file};
use flate2::read::GzDecoder;
use std::env;
use std::fs;
use std::io::{Read, Write};
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

const RASTER_RECIPE: &str = "d120-p0";

/// Magick PNG on disk for a non-web figure (031). `None` if Magick skipped or failed.
pub(crate) fn ensure_raster_png(
    source: &Path,
    magick: Option<&Path>,
    raster_dir: Option<&Path>,
) -> Option<PathBuf> {
    if !source.is_file() {
        return None;
    }
    let dest = raster_dest(source, raster_dir)?;
    if dest.is_file() {
        return Some(dest);
    }
    let png = magick_png_bytes(source, magick)?;
    if max_cache_entries() == 0 {
        return None;
    }
    fs::create_dir_all(dest.parent()?).ok()?;
    let tmp = dest.with_extension("png.tmp");
    fs::write(&tmp, &png).ok()?;
    if dest.exists() {
        let _ = fs::remove_file(&dest);
    }
    fs::rename(&tmp, &dest).ok()?;
    if let Some(dir) = dest.parent() {
        prune_raster_dir(dir);
    }
    Some(dest)
}

fn raster_dest(source: &Path, raster_dir: Option<&Path>) -> Option<PathBuf> {
    let dir = raster_dir?;
    if max_cache_entries() == 0 {
        return None;
    }
    let hash = hash_file(source).ok()?;
    Some(dir.join(format!("{hash}-{RASTER_RECIPE}.png")))
}

fn magick_png_bytes(path: &Path, magick: Option<&Path>) -> Option<Vec<u8>> {
    if !path.is_file() {
        return None;
    }
    let magick = magick?;
    record_magick_spawn();
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
    Some(output.stdout)
}

fn record_magick_spawn() {
    let Ok(log) = env::var("LQ_MAGICK_CALL_LOG") else {
        return;
    };
    if log.is_empty() {
        return;
    }
    if let Ok(mut f) = fs::OpenOptions::new().create(true).append(true).open(log) {
        let _ = f.write_all(b"1\n");
    }
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
        Some(dir) => {
            let aliases = load_icon_aliases(dir, warnings);
            apply_icon_aliases(&munged, &aliases)
        }
        None => munged,
    }
}

pub(crate) fn resolve_info_icon_data_uri(
    name: &str,
    images_dir: Option<&Path>,
    magick_path: Option<&Path>,
    aliases: &[(String, String)],
    memo: &mut std::collections::HashMap<String, Option<String>>,
) -> Option<String> {
    if name.is_empty() {
        return None;
    }
    if let Some(hit) = memo.get(name) {
        return hit.clone();
    }
    let uri = resolve_info_icon_uncached(name, images_dir, magick_path, aliases);
    memo.insert(name.to_string(), uri.clone());
    uri
}

fn resolve_info_icon_uncached(
    name: &str,
    images_dir: Option<&Path>,
    magick_path: Option<&Path>,
    aliases: &[(String, String)],
) -> Option<String> {
    let images_dir = images_dir?;
    let unique = icon_file_bases(name, aliases);
    for base in &unique {
        for file in svgz_paths(images_dir, base) {
            if let Some(uri) = svgz_to_svg_data_uri(&file) {
                return Some(uri);
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
            if let Ok(bytes) = fs::read(&file)
                && !bytes.is_empty()
            {
                return Some(format!("data:image/png;base64,{}", base64_encode(&bytes)));
            }
        }
    }
    if magick_path.is_some() {
        for base in &unique {
            for file in svgz_paths(images_dir, base) {
                if !file.is_file() {
                    continue;
                }
                if let Some(png) = magick_png_bytes(&file, magick_path) {
                    return Some(format!("data:image/png;base64,{}", base64_encode(&png)));
                }
            }
        }
    }
    None
}

fn svgz_paths(images_dir: &Path, base: &str) -> [PathBuf; 4] {
    [
        images_dir.join(format!("{base}.svgz")),
        images_dir.join("oxygen").join(format!("{base}.svgz")),
        images_dir.join("adwaita").join(format!("{base}.svgz")),
        images_dir.join("classic").join(format!("{base}.svgz")),
    ]
}

fn svgz_to_svg_data_uri(path: &Path) -> Option<String> {
    if !path.is_file() {
        return None;
    }
    let file = fs::File::open(path).ok()?;
    let mut decoder = GzDecoder::new(file);
    let mut svg = String::new();
    decoder.read_to_string(&mut svg).ok()?;
    if !svg.to_ascii_lowercase().contains("<svg") {
        return None;
    }
    Some(format!(
        "data:image/svg+xml;base64,{}",
        base64_encode(svg.as_bytes())
    ))
}

fn munge_icon_name(name: &str) -> String {
    name.replace('\\', "backslash").replace([' ', ';'], "_")
}

pub(crate) fn load_icon_aliases(
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

fn apply_icon_aliases(name: &str, aliases: &[(String, String)]) -> String {
    let mut out = name.to_string();
    for (from, to) in aliases {
        if out.contains(from.as_str()) {
            out = out.replace(from, to);
        }
    }
    out
}

fn icon_file_bases(name: &str, aliases: &[(String, String)]) -> Vec<String> {
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
        let aliased = apply_icon_aliases(&b, aliases);
        if aliased != b && !bases.contains(&aliased) {
            bases.push(aliased);
        }
    }
    bases
}

#[cfg(test)]
mod tests {
    use super::*;
    use flate2::Compression;
    use flate2::write::GzEncoder;
    use std::collections::HashMap;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn temp_dir(prefix: &str) -> PathBuf {
        let p = std::env::temp_dir().join(format!(
            "lq_g_{prefix}_{}_{}",
            std::process::id(),
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        fs::create_dir_all(&p).unwrap();
        p
    }

    #[test]
    fn missing_source_does_not_spawn_magick() {
        let dir = temp_dir("miss");
        let log = dir.join("calls.txt");
        unsafe {
            env::set_var("LQ_MAGICK_CALL_LOG", &log);
        }
        let fake_magick = dir.join("magick.exe");
        fs::write(&fake_magick, b"x").unwrap();
        let missing = dir.join("nope.pdf");
        assert!(
            ensure_raster_png(&missing, Some(&fake_magick), Some(&dir.join("raster"))).is_none()
        );
        unsafe {
            env::remove_var("LQ_MAGICK_CALL_LOG");
        }
        assert!(!log.exists() || fs::read_to_string(&log).unwrap().is_empty());
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn existing_raster_skips_magick() {
        let dir = temp_dir("hit");
        let src = dir.join("fig.pdf");
        fs::write(&src, b"%PDF-1.4 fake").unwrap();
        let raster = dir.join("raster");
        fs::create_dir_all(&raster).unwrap();
        let dest = raster_dest(&src, Some(&raster)).unwrap();
        fs::write(&dest, b"png-bytes").unwrap();
        let log = dir.join("calls.txt");
        unsafe {
            env::set_var("LQ_MAGICK_CALL_LOG", &log);
        }
        let fake_magick = dir.join("magick.exe");
        fs::write(&fake_magick, b"x").unwrap();
        let got = ensure_raster_png(&src, Some(&fake_magick), Some(&raster)).unwrap();
        unsafe {
            env::remove_var("LQ_MAGICK_CALL_LOG");
        }
        assert_eq!(got, dest);
        assert!(!log.exists() || fs::read_to_string(&log).unwrap().is_empty());
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn svgz_becomes_svg_data_uri_and_memos() {
        let dir = temp_dir("svgz");
        let svg = "<svg xmlns='http://www.w3.org/2000/svg'></svg>";
        let mut enc = GzEncoder::new(Vec::new(), Compression::default());
        enc.write_all(svg.as_bytes()).unwrap();
        let gz = enc.finish().unwrap();
        fs::write(dir.join("foo.svgz"), gz).unwrap();
        let mut memo = HashMap::new();
        let uri = resolve_info_icon_data_uri("foo", Some(&dir), None, &[], &mut memo).unwrap();
        assert!(uri.starts_with("data:image/svg+xml;base64,"));
        let again = resolve_info_icon_data_uri("foo", Some(&dir), None, &[], &mut memo).unwrap();
        assert_eq!(uri, again);
        assert_eq!(memo.len(), 1);
        let _ = fs::remove_dir_all(&dir);
    }
}
