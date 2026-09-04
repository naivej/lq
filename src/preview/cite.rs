//! Work-area citation chips from LyX `.citeengine` CiteFormat (053).

use super::mapping::find_property;
use crate::ast::Document;
use crate::bib::{Citation, author_surnames};
use crate::tracked_changes::get_header;
use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};

const MAX_EXPAND_PASSES: i32 = 5000;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub(crate) enum CiteEngineType {
    Default,
    Authoryear,
    Numerical,
    Notes,
}

impl CiteEngineType {
    fn parse(s: &str) -> Self {
        match s.trim().to_ascii_lowercase().as_str() {
            "authoryear" => Self::Authoryear,
            "numerical" => Self::Numerical,
            "notes" => Self::Notes,
            _ => Self::Default,
        }
    }
}

#[derive(Clone, Debug)]
pub(crate) struct CiteSettings {
    pub engine: String,
    pub engine_type: CiteEngineType,
    pub biblatex_citestyle: String,
}

impl Default for CiteSettings {
    fn default() -> Self {
        Self {
            engine: "basic".into(),
            engine_type: CiteEngineType::Default,
            biblatex_citestyle: String::new(),
        }
    }
}

#[derive(Clone, Debug, Default)]
struct FormatMaps {
    macros: HashMap<String, String>,
    styles: HashMap<String, String>,
}

#[derive(Clone, Debug)]
pub(crate) struct CiteEngine {
    max_cite_names: usize,
    aliases: HashMap<String, String>,
    qualified: HashSet<String>,
    default: FormatMaps,
    authoryear: FormatMaps,
    numerical: FormatMaps,
    notes: FormatMaps,
}

impl CiteEngine {
    fn maps(&self, ty: CiteEngineType) -> FormatMaps {
        match ty {
            CiteEngineType::Default => self.default.clone(),
            CiteEngineType::Authoryear => merge_maps(&self.default, &self.authoryear),
            CiteEngineType::Numerical => merge_maps(&self.default, &self.numerical),
            CiteEngineType::Notes => merge_maps(&self.default, &self.notes),
        }
    }
}

fn merge_maps(base: &FormatMaps, over: &FormatMaps) -> FormatMaps {
    let mut macros = base.macros.clone();
    macros.extend(over.macros.iter().map(|(k, v)| (k.clone(), v.clone())));
    let mut styles = base.styles.clone();
    styles.extend(over.styles.iter().map(|(k, v)| (k.clone(), v.clone())));
    FormatMaps { macros, styles }
}

pub(crate) fn document_cite_settings(ast: &Document) -> CiteSettings {
    let Some(header) = get_header(ast) else {
        return CiteSettings::default();
    };
    let engine = find_property(ast, header, "cite_engine").unwrap_or_else(|| "basic".into());
    let engine_type =
        find_property(ast, header, "cite_engine_type").unwrap_or_else(|| "default".into());
    let biblatex_citestyle = find_property(ast, header, "biblatex_citestyle").unwrap_or_default();
    CiteSettings {
        engine: if engine.is_empty() {
            "basic".into()
        } else {
            engine
        },
        engine_type: CiteEngineType::parse(&engine_type),
        biblatex_citestyle,
    }
}

pub(crate) fn citeengines_dir_from_layouts(layouts_dir: Option<&Path>) -> Option<PathBuf> {
    layouts_dir
        .and_then(|d| d.parent())
        .map(|p| p.join("citeengines"))
}

pub(crate) fn load_cite_engine(layouts_dir: Option<&Path>, engine: &str) -> Option<CiteEngine> {
    if !engine
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
    {
        return None;
    }
    let dir = citeengines_dir_from_layouts(layouts_dir)?;
    let path = dir.join(format!("{engine}.citeengine"));
    let text = std::fs::read_to_string(path).ok()?;
    Some(parse_cite_engine_file(&text))
}

pub(crate) fn parse_cite_engine_file(text: &str) -> CiteEngine {
    let mut engine = CiteEngine {
        max_cite_names: 2,
        aliases: HashMap::new(),
        qualified: HashSet::new(),
        default: FormatMaps::default(),
        authoryear: FormatMaps::default(),
        numerical: FormatMaps::default(),
        notes: FormatMaps::default(),
    };
    let mut lines = text.lines().peekable();
    while let Some(raw) = lines.next() {
        let line = raw.trim();
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        let (kw, rest) = split_key_rest(line);
        match kw.to_ascii_lowercase().as_str() {
            "maxcitenames" => {
                if let Ok(n) = rest.trim().parse::<usize>() {
                    engine.max_cite_names = n.max(1);
                }
            }
            "citeengine" => {
                parse_cite_engine_block(rest, &mut lines, &mut engine);
            }
            "citeformat" => {
                let ty = CiteEngineType::parse(rest);
                parse_cite_format_block(&mut lines, maps_mut(&mut engine, ty));
            }
            _ => {}
        }
    }
    engine
}

fn maps_mut(engine: &mut CiteEngine, ty: CiteEngineType) -> &mut FormatMaps {
    match ty {
        CiteEngineType::Default => &mut engine.default,
        CiteEngineType::Authoryear => &mut engine.authoryear,
        CiteEngineType::Numerical => &mut engine.numerical,
        CiteEngineType::Notes => &mut engine.notes,
    }
}

fn parse_cite_engine_block<'a>(
    _header_rest: &str,
    lines: &mut std::iter::Peekable<impl Iterator<Item = &'a str>>,
    engine: &mut CiteEngine,
) {
    for raw in lines.by_ref() {
        let line = raw.trim();
        if line.eq_ignore_ascii_case("end") {
            break;
        }
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        parse_cite_command_line(line, engine);
    }
}

fn parse_cite_command_line(line: &str, engine: &mut CiteEngine) {
    // LyX strips spaces and tabs before scanning.
    let def: String = line.chars().filter(|c| !c.is_whitespace()).collect();
    if def.is_empty() || def.starts_with('#') {
        return;
    }
    let mut mode = CmdScan::LyxName;
    let mut oldmode = CmdScan::LyxName;
    let mut lyx_cmd = String::new();
    let mut alias = String::new();
    let mut has_qualified = false;
    for ch in def.chars() {
        match ch {
            '|' => mode = CmdScan::Alias,
            '=' => mode = CmdScan::LatexCmd,
            '<' => {
                oldmode = mode;
                mode = CmdScan::StarDesc;
            }
            '>' => mode = oldmode,
            '$' => has_qualified = true,
            '*' | '[' | ']' => {}
            _ => match mode {
                CmdScan::Alias => alias.push(ch),
                CmdScan::LyxName => lyx_cmd.push(ch),
                CmdScan::LatexCmd | CmdScan::StarDesc => {}
            },
        }
    }
    if let Some((_, name)) = lyx_cmd.split_once('@') {
        lyx_cmd = name.to_string();
    }
    if let Some(first) = lyx_cmd.chars().next()
        && first.is_uppercase()
    {
        let rest: String = lyx_cmd.chars().skip(1).collect();
        lyx_cmd = format!("{}{rest}", first.to_lowercase());
    }
    if has_qualified && !lyx_cmd.is_empty() {
        engine.qualified.insert(lyx_cmd.clone());
    }
    if !alias.is_empty() {
        for a in alias.split(',') {
            let a = a.trim();
            if !a.is_empty() {
                engine.aliases.insert(a.to_string(), lyx_cmd.clone());
            }
        }
    }
}

#[derive(Clone, Copy)]
enum CmdScan {
    LyxName,
    Alias,
    LatexCmd,
    StarDesc,
}

fn parse_cite_format_block<'a>(
    lines: &mut std::iter::Peekable<impl Iterator<Item = &'a str>>,
    maps: &mut FormatMaps,
) {
    for raw in lines.by_ref() {
        let line = raw.trim_start().trim_end_matches(['\r']);
        let trimmed = line.trim();
        if trimmed.eq_ignore_ascii_case("end") {
            break;
        }
        if trimmed.is_empty() || trimmed.starts_with('#') {
            continue;
        }
        let (key, rest) = split_key_rest(line.trim_start());
        if key.is_empty() {
            continue;
        }
        if key.starts_with('!') || key.starts_with('_') || key.starts_with("B_") {
            maps.macros.insert(key.to_string(), rest.to_string());
        } else {
            maps.styles.insert(key.to_string(), rest.to_string());
        }
    }
}

/// First token, then the remainder after one separating whitespace character (LyX Lexer).
fn split_key_rest(line: &str) -> (&str, &str) {
    match line.find(|c: char| c.is_whitespace()) {
        Some(i) => {
            let key = &line[..i];
            let after = &line[i..];
            let ch = after.chars().next().map(|c| c.len_utf8()).unwrap_or(0);
            (key, &after[ch..])
        }
        None => (line, ""),
    }
}

pub(crate) struct CiteChip {
    pub command: String,
    pub keys: Vec<String>,
    pub before: String,
    pub after: String,
    pub pretextlist: String,
    pub posttextlist: String,
}

pub(crate) fn format_citation_chip(
    chip: &CiteChip,
    settings: &CiteSettings,
    engine: Option<&CiteEngine>,
    bib: &HashMap<String, Citation>,
) -> String {
    let Some(engine) = engine else {
        return fallback_author_year(&chip.command, &chip.keys, bib);
    };
    let maps = engine.maps(settings.engine_type);
    let (style, force_upper, starred) = resolve_style(&chip.command, engine, &maps);
    let Some(format) = maps
        .styles
        .get(&style)
        .cloned()
        .or_else(|| maps.styles.get("cite").cloned())
    else {
        return fallback_author_year(&chip.command, &chip.keys, bib);
    };
    if chip.keys.is_empty() {
        return "No citations selected!".into();
    }
    let qualified = engine.qualified.contains(&style)
        && (chip.keys.len() > 1 || !chip.pretextlist.is_empty() || !chip.posttextlist.is_empty());
    let item = CiteItem {
        text_before: chip.before.clone(),
        text_after: chip.after.clone(),
        force_upper,
        starred,
        is_qualified: qualified,
        pretexts: parse_qualified_list(&chip.pretextlist),
        posttexts: parse_qualified_list(&chip.posttextlist),
        biblatex_citestyle: settings.biblatex_citestyle.clone(),
        max_cite_names: engine.max_cite_names,
        macros: maps.macros,
    };
    let mut ret = format;
    let ken = chip.keys.len();
    for (i, key) in chip.keys.iter().enumerate() {
        let n = chip.keys[..=i].iter().filter(|k| *k == key).count() as i32;
        let ctx = KeyCtx {
            key,
            num_key: n,
            citation: bib.get(key),
            next: i + 1 != ken,
            second: i == 1,
        };
        ret = expand_format(&ret, &ctx, &item, 0);
        if !ctx.next && !ret.is_empty() {
            ret = process_richtext(&ret);
        }
    }
    ret
}

struct CiteItem {
    text_before: String,
    text_after: String,
    force_upper: bool,
    starred: bool,
    is_qualified: bool,
    pretexts: Vec<(String, String)>,
    posttexts: Vec<(String, String)>,
    biblatex_citestyle: String,
    max_cite_names: usize,
    macros: HashMap<String, String>,
}

struct KeyCtx<'a> {
    key: &'a str,
    num_key: i32,
    citation: Option<&'a Citation>,
    next: bool,
    second: bool,
}

fn resolve_style(command: &str, engine: &CiteEngine, maps: &FormatMaps) -> (String, bool, bool) {
    let mut style = command.trim().to_string();
    let mut force_upper = false;
    let mut starred = false;
    if let Some(first) = style.chars().next()
        && first.is_uppercase()
    {
        force_upper = true;
        let rest: String = style.chars().skip(1).collect();
        style = format!("{}{rest}", first.to_lowercase());
    }
    if style.ends_with('*') {
        starred = true;
        style.pop();
    }
    if !maps.styles.contains_key(&style)
        && let Some(alias) = engine.aliases.get(&style)
    {
        style = alias.clone();
    }
    (style, force_upper, starred)
}

fn parse_qualified_list(p: &str) -> Vec<(String, String)> {
    if p.is_empty() {
        return Vec::new();
    }
    p.split('\t')
        .filter(|s| !s.is_empty())
        .map(|s| match s.split_once(' ') {
            Some((k, v)) => (k.to_string(), v.to_string()),
            None => (s.to_string(), String::new()),
        })
        .collect()
}

fn expand_format(format: &str, ctx: &KeyCtx<'_>, item: &CiteItem, mut counter: i32) -> String {
    let mut fmt: Vec<char> = format.chars().collect();
    let mut ret = String::new();
    let mut key = String::new();
    let mut scanning_key = false;
    let mut scanning_rich = false;
    while !fmt.is_empty() {
        if counter > MAX_EXPAND_PASSES {
            return "ERROR!".into();
        }
        let thischar = fmt[0];
        if thischar == '%' {
            if scanning_key {
                scanning_key = false;
                if key.starts_with('!') {
                    let val = item.macros.get(&key).cloned().unwrap_or_default();
                    fmt.remove(0);
                    let mut prefix: Vec<char> = val.chars().collect();
                    prefix.append(&mut fmt);
                    fmt = prefix;
                    counter += 1;
                    continue;
                } else if key.starts_with("B_") || key.starts_with('_') {
                    let val = item.macros.get(&key).cloned().unwrap_or_default();
                    ret.push_str(&strip_qt_context(&val));
                } else {
                    ret.push_str(&get_value_for_key(&key, ctx, item));
                }
            } else {
                key.clear();
                scanning_key = true;
            }
        } else if thischar == '{' {
            if scanning_key {
                return "ERROR!".into();
            }
            if fmt.len() > 1 && fmt[1] == '%' {
                let s: String = fmt.iter().collect();
                let Some((optkey, ifpart, elsepart, rest)) = parse_options(&s) else {
                    return "ERROR!".into();
                };
                fmt = rest.chars().collect();
                if optkey == "next" && ctx.next {
                    ret.push_str(&ifpart);
                } else if optkey == "second" && ctx.second {
                    ret.push_str(&expand_format(&ifpart, ctx, item, 0));
                } else {
                    let val = get_value_for_key(&optkey, ctx, item);
                    if !val.is_empty() {
                        ret.push_str(&expand_format(&ifpart, ctx, item, 0));
                    } else if !elsepart.is_empty() {
                        ret.push_str(&expand_format(&elsepart, ctx, item, 0));
                    }
                }
                continue;
            }
            if fmt.len() > 1 && fmt[1] == '!' {
                scanning_rich = true;
                fmt.drain(..2);
                ret.push_str("{!");
                continue;
            }
            ret.push(thischar);
        } else if scanning_rich && thischar == '!' && fmt.len() > 1 && fmt[1] == '}' {
            scanning_rich = false;
            fmt.drain(..2);
            ret.push_str("!}");
            continue;
        } else if scanning_key {
            key.push(thischar);
        } else {
            ret.push(thischar);
        }
        fmt.remove(0);
    }
    if scanning_key || scanning_rich {
        return "ERROR!".into();
    }
    ret
}

fn parse_options(format: &str) -> Option<(String, String, String, String)> {
    let rest = format.strip_prefix("{%")?;
    let pct = rest.find('%')?;
    let optkey = rest[..pct].to_string();
    let after_key = &rest[pct + 1..];
    if !after_key.starts_with("[[") {
        return None;
    }
    let (ifpart, after_if) = get_clause(after_key)?;
    if let Some(rest) = after_if.strip_prefix('}') {
        return Some((optkey, ifpart, String::new(), rest.to_string()));
    }
    if !after_if.starts_with("[[") {
        return None;
    }
    let (elsepart, after_else) = get_clause(after_if)?;
    let rest = after_else.strip_prefix('}')?;
    Some((optkey, ifpart, elsepart, rest.to_string()))
}

fn get_clause(format: &str) -> Option<(String, &str)> {
    let mut fmt = format.strip_prefix("[[")?;
    let mut clause = String::new();
    while !fmt.is_empty() {
        if let Some(rest) = fmt.strip_prefix("]]") {
            return Some((clause, rest));
        }
        if fmt.starts_with("{%") {
            let orig_len = fmt.len();
            let (_, _, _, rest) = parse_options(fmt)?;
            let consumed = orig_len - rest.len();
            clause.push_str(&fmt[..consumed]);
            fmt = &fmt[consumed..];
        } else {
            let ch = fmt.chars().next()?;
            clause.push(ch);
            fmt = &fmt[ch.len_utf8()..];
        }
    }
    None
}

fn process_richtext(s: &str) -> String {
    let mut ret = String::new();
    let mut chars = s.chars().peekable();
    let mut scanning_rich = false;
    while let Some(ch) = chars.next() {
        if ch == '{' && chars.peek() == Some(&'!') {
            scanning_rich = true;
            chars.next();
            continue;
        }
        if scanning_rich && ch == '!' && chars.peek() == Some(&'}') {
            scanning_rich = false;
            chars.next();
            continue;
        }
        if !scanning_rich {
            ret.push(ch);
        }
    }
    ret
}

fn strip_qt_context(s: &str) -> String {
    match s.find("[[") {
        Some(i) => s[..i].to_string(),
        None => s.to_string(),
    }
}

fn get_value_for_key(oldkey: &str, ctx: &KeyCtx<'_>, item: &CiteItem) -> String {
    let mut key = oldkey;
    if let Some(rest) = key.strip_prefix("clean:") {
        key = rest;
    }
    let field = bib_field(ctx.citation, key);
    if !field.is_empty() {
        return field;
    }
    if key == "dialog" || key == "export" {
        return String::new();
    }
    if key == "ifstar" && item.starred {
        return "x".into();
    }
    if key == "ifqualified" && item.is_qualified {
        return "x".into();
    }
    if key == "key" {
        return ctx.key.to_string();
    }
    if key == "label" || key == "numericallabel" || key == "modifier" {
        return String::new();
    }
    if let Some(styles) = key.strip_prefix("ifstyle:") {
        let cs = item.biblatex_citestyle.as_str();
        if styles.split(',').any(|s| s.trim() == cs) {
            return "x".into();
        }
        return String::new();
    }
    if key.starts_with("abbrvciteauthor") {
        return cite_authors(ctx, item, false, false, key.ends_with('&'));
    }
    if key.starts_with("fullciteauthor") {
        return cite_authors(ctx, item, true, false, key.ends_with('&'));
    }
    if key.starts_with("forceabbrvciteauthor") {
        return cite_authors(ctx, item, false, true, key.ends_with('&'));
    }
    if key == "textbefore" {
        return item.text_before.clone();
    }
    if key == "textafter" {
        return item.text_after.clone();
    }
    if key == "curpretext" {
        return cur_qualified(&item.pretexts, ctx.key, ctx.num_key);
    }
    if key == "curposttext" {
        return cur_qualified(&item.posttexts, ctx.key, ctx.num_key);
    }
    if key == "year" {
        return ctx
            .citation
            .and_then(|c| c.year.clone())
            .unwrap_or_default();
    }
    if key == "title" {
        return ctx
            .citation
            .and_then(|c| c.title.clone())
            .unwrap_or_default();
    }
    String::new()
}

fn bib_field(c: Option<&Citation>, key: &str) -> String {
    let Some(c) = c else {
        return String::new();
    };
    match key {
        "author" => c.author.clone().unwrap_or_default(),
        "year" => c.year.clone().unwrap_or_default(),
        "title" => c.title.clone().unwrap_or_default(),
        "journal" => c.journal.clone().unwrap_or_default(),
        "volume" => c.volume.clone().unwrap_or_default(),
        "number" => c.number.clone().unwrap_or_default(),
        "pages" => c.pages.clone().unwrap_or_default(),
        "doi" => c.doi.clone().unwrap_or_default(),
        "publisher" => c.publisher.clone().unwrap_or_default(),
        "booktitle" => c.booktitle.clone().unwrap_or_default(),
        _ => String::new(),
    }
}

fn cur_qualified(list: &[(String, String)], key: &str, num_key: i32) -> String {
    let mut n = 1;
    for (k, v) in list {
        if k == key {
            if n == num_key {
                return v.clone();
            }
            n += 1;
        }
    }
    String::new()
}

fn cite_authors(
    ctx: &KeyCtx<'_>,
    item: &CiteItem,
    full: bool,
    forceshort: bool,
    amp: bool,
) -> String {
    let surnames = author_surnames(ctx.citation.and_then(|c| c.author.as_deref()));
    if surnames.is_empty() {
        return String::new();
    }
    let etal = strip_qt_context(
        item.macros
            .get("B_etal")
            .map(String::as_str)
            .unwrap_or(" et al."),
    );
    let namesep = strip_qt_context(
        item.macros
            .get("B_namesep")
            .map(String::as_str)
            .unwrap_or(", "),
    );
    let lastnamesep = if amp {
        strip_qt_context(
            item.macros
                .get("B_lastampnamesep")
                .map(String::as_str)
                .unwrap_or(""),
        )
    } else {
        strip_qt_context(
            item.macros
                .get("B_lastnamesep")
                .map(String::as_str)
                .unwrap_or(", and "),
        )
    };
    let pairnamesep = if amp {
        strip_qt_context(
            item.macros
                .get("B_amppairnamesep")
                .map(String::as_str)
                .unwrap_or(""),
        )
    } else {
        strip_qt_context(
            item.macros
                .get("B_pairnamesep")
                .map(String::as_str)
                .unwrap_or(" and "),
        )
    };
    let n = surnames.len();
    let collapse = (forceshort && n > 1) || (!full && n > item.max_cite_names);
    let mut ret = if collapse || surnames.iter().any(|s| s.eq_ignore_ascii_case("others")) {
        if surnames[0].eq_ignore_ascii_case("others") {
            etal.trim_start().to_string()
        } else {
            format!("{}{etal}", surnames[0])
        }
    } else {
        let mut out = String::new();
        for (i, name) in surnames.iter().enumerate() {
            if name.eq_ignore_ascii_case("others") {
                out.push_str(&etal);
                break;
            }
            if i > 0 && i + 1 == n {
                if n == 2 {
                    out.push_str(&pairnamesep);
                } else {
                    out.push_str(&lastnamesep);
                }
            } else if i > 0 {
                out.push_str(&namesep);
            }
            out.push_str(name);
        }
        out
    };
    if item.force_upper
        && let Some(c) = ret.chars().next()
        && c.is_lowercase()
    {
        let rest: String = ret.chars().skip(1).collect();
        ret = format!("{}{rest}", c.to_uppercase());
    }
    ret
}

fn fallback_author_year(command: &str, keys: &[String], bib: &HashMap<String, Citation>) -> String {
    enum Part {
        Raw(String),
        Named { who: String, year: String },
    }
    let parts: Vec<Part> = keys
        .iter()
        .map(|key| {
            let Some(c) = bib.get(key) else {
                return Part::Raw(key.clone());
            };
            let surnames = author_surnames(c.author.as_deref());
            let who = match surnames.as_slice() {
                [] => "Unknown".into(),
                [one] => one.clone(),
                [first, ..] => format!("{first} et al."),
            };
            Part::Named {
                who,
                year: c.year.clone().unwrap_or_default(),
            }
        })
        .collect();
    let parenthetical = command == "citep" || command == "parencite" || command == "cite";
    if parenthetical {
        format!(
            "({})",
            parts
                .iter()
                .map(|p| match p {
                    Part::Raw(s) => s.clone(),
                    Part::Named { who, year } => format!("{who} {year}").trim().to_string(),
                })
                .collect::<Vec<_>>()
                .join("; ")
        )
    } else {
        parts
            .iter()
            .map(|p| match p {
                Part::Raw(s) => s.clone(),
                Part::Named { who, year } => format!("{who} ({year})"),
            })
            .collect::<Vec<_>>()
            .join("; ")
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::parser::parse;
    use std::path::PathBuf;

    fn fixtures() -> PathBuf {
        PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures")
    }

    fn stock_citeengines() -> Option<PathBuf> {
        let layouts = crate::schema::get_default_layouts_dir();
        let dir = layouts.parent()?.join("citeengines");
        dir.is_dir().then_some(dir)
    }

    fn load_stock(name: &str) -> Option<CiteEngine> {
        let dir = stock_citeengines()?;
        let text = std::fs::read_to_string(dir.join(format!("{name}.citeengine"))).ok()?;
        Some(parse_cite_engine_file(&text))
    }

    fn parse_fixture(rel: &str) -> Document {
        let text = std::fs::read_to_string(fixtures().join(rel)).expect("fixture");
        parse(&text, false).expect("parse")
    }

    fn cit(key: &str, author: &str, year: &str) -> Citation {
        Citation {
            key: key.into(),
            author: Some(author.into()),
            year: Some(year.into()),
            ..Citation::default()
        }
    }

    fn bib_map(entries: &[Citation]) -> HashMap<String, Citation> {
        entries.iter().map(|c| (c.key.clone(), c.clone())).collect()
    }

    fn chip(
        engine: &CiteEngine,
        settings: &CiteSettings,
        command: &str,
        keys: &[&str],
        before: &str,
        after: &str,
        bib: &HashMap<String, Citation>,
    ) -> String {
        format_citation_chip(
            &CiteChip {
                command: command.into(),
                keys: keys.iter().map(|s| (*s).to_string()).collect(),
                before: before.into(),
                after: after.into(),
                pretextlist: String::new(),
                posttextlist: String::new(),
            },
            settings,
            Some(engine),
            bib,
        )
    }

    #[test]
    fn header_cite_engine_basic_and_biblatex() {
        let basic = document_cite_settings(&parse_fixture("Synthetic/cite_dedup.lyx"));
        assert_eq!(basic.engine, "basic");
        assert_eq!(basic.engine_type, CiteEngineType::Default);
        let biblatex = document_cite_settings(&parse_fixture("my_template.lyx"));
        assert_eq!(biblatex.engine, "biblatex");
        assert_eq!(biblatex.engine_type, CiteEngineType::Authoryear);
        assert_eq!(biblatex.biblatex_citestyle, "authoryear");
    }

    #[test]
    fn parse_stock_citeengines_and_missing_file_is_none() {
        let Some(basic) = load_stock("basic") else {
            return;
        };
        let maps = basic.maps(CiteEngineType::Default);
        assert_eq!(maps.macros.get("!open").map(String::as_str), Some("["));
        assert!(maps.styles.contains_key("cite"));
        assert!(maps.styles.contains_key("nocite"));
        assert_eq!(basic.max_cite_names, 2);

        let Some(natbib) = load_stock("natbib") else {
            return;
        };
        assert_eq!(natbib.max_cite_names, 2);
        let ay = natbib.maps(CiteEngineType::Authoryear);
        assert_eq!(ay.macros.get("!open").map(String::as_str), Some("("));
        assert!(ay.styles.contains_key("citep"));

        let Some(biblatex) = load_stock("biblatex") else {
            return;
        };
        assert_eq!(biblatex.max_cite_names, 3);
        assert_eq!(
            biblatex.aliases.get("citealt").map(String::as_str),
            Some("cite")
        );
        let by = biblatex.maps(CiteEngineType::Authoryear);
        assert!(by.styles.contains_key("citet"));
        assert!(by.styles.contains_key("citep"));

        assert!(load_cite_engine(Some(Path::new("/no/such/layouts")), "basic").is_none());
    }

    #[test]
    fn expander_six_diag_cases() {
        let alpha = cit("alpha", "Alpha Author", "2020");
        let beta = cit("beta", "Beta Author", "2019");
        let bib = bib_map(&[alpha, beta]);

        let Some(basic) = load_stock("basic") else {
            return;
        };
        let basic_set = CiteSettings {
            engine: "basic".into(),
            engine_type: CiteEngineType::Default,
            biblatex_citestyle: String::new(),
        };
        assert_eq!(
            chip(
                &basic,
                &basic_set,
                "cite",
                &["alpha", "beta", "alpha"],
                "",
                "",
                &bib
            ),
            "[#alpha, #beta, #alpha]"
        );
        assert_eq!(
            chip(
                &basic,
                &basic_set,
                "cite",
                &["alpha"],
                "",
                "Chapter 3",
                &bib
            ),
            "[#alpha, Chapter 3]"
        );
        assert_eq!(
            chip(&basic, &basic_set, "nocite", &["alpha"], "", "", &bib),
            "alpha (not cited)"
        );

        let Some(natbib) = load_stock("natbib") else {
            return;
        };
        let nat_set = CiteSettings {
            engine: "natbib".into(),
            engine_type: CiteEngineType::Authoryear,
            biblatex_citestyle: String::new(),
        };
        assert_eq!(
            chip(&natbib, &nat_set, "citep", &["beta"], "cf.", "p. 42", &bib),
            "(cf. Author, 2019, p. 42)"
        );

        let Some(biblatex) = load_stock("biblatex") else {
            return;
        };
        let bib_set = CiteSettings {
            engine: "biblatex".into(),
            engine_type: CiteEngineType::Authoryear,
            biblatex_citestyle: "authoryear".into(),
        };
        assert_eq!(
            chip(&biblatex, &bib_set, "citet", &["alpha"], "", "", &bib),
            "Author (2020)"
        );
        assert_eq!(
            chip(
                &biblatex,
                &bib_set,
                "citep",
                &["beta"],
                "cf.",
                "p. 42",
                &bib
            ),
            "(cf. Author 2019, p. 42)"
        );
    }

    #[test]
    fn missing_engine_falls_back_to_author_year() {
        let bib = bib_map(&[cit("alpha", "Alpha Author", "2020")]);
        let text = fallback_author_year("cite", &["alpha".into()], &bib);
        assert_eq!(text, "(Author 2020)");
    }
}
