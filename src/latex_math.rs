//! TeX-to-MathML for Live formula insets (Deno `latex_math.ts`).

use crate::html_escape::escape_live_html;
use crate::math_alphanum::{MathAlphanumVariant, math_alphanum};
use std::collections::HashMap;

const MAX_MACRO_EXPANSION_DEPTH: usize = 64;

include!(concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/src/generated/latex_syms.rs"
));

fn math_color(name: &str) -> String {
    lookup_math_color(&name.to_ascii_lowercase())
        .unwrap_or(name)
        .to_string()
}

fn fence_mo(delim: &str) -> String {
    if delim.is_empty() {
        String::new()
    } else {
        format!("<mo>{}</mo>", escape_live_html(delim))
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum MathFamily {
    Normal,
    Script,
    Fraktur,
    DoubleStruck,
    Sans,
    Mono,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum MathSeries {
    Medium,
    Bold,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum MathShape {
    Italic,
    Up,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct MathFontState {
    family: MathFamily,
    series: MathSeries,
    shape: MathShape,
}

const DEFAULT_MATH_FONT: MathFontState = MathFontState {
    family: MathFamily::Normal,
    series: MathSeries::Medium,
    shape: MathShape::Italic,
};

#[derive(Clone, Copy, Default)]
struct FontPatch {
    family: Option<MathFamily>,
    series: Option<MathSeries>,
    shape: Option<MathShape>,
}

fn math_font_cmd(name: &str) -> Option<FontPatch> {
    Some(match name {
        "mathbf" => FontPatch {
            series: Some(MathSeries::Bold),
            shape: Some(MathShape::Up),
            ..FontPatch::default()
        },
        "boldsymbol" => FontPatch {
            series: Some(MathSeries::Bold),
            shape: Some(MathShape::Italic),
            ..FontPatch::default()
        },
        "mathit" => FontPatch {
            shape: Some(MathShape::Italic),
            ..FontPatch::default()
        },
        "mathsf" => FontPatch {
            family: Some(MathFamily::Sans),
            shape: Some(MathShape::Up),
            ..FontPatch::default()
        },
        "mathtt" => FontPatch {
            family: Some(MathFamily::Mono),
            shape: Some(MathShape::Up),
            ..FontPatch::default()
        },
        "mathbb" | "mathds" => FontPatch {
            family: Some(MathFamily::DoubleStruck),
            shape: Some(MathShape::Up),
            ..FontPatch::default()
        },
        "mathfrak" => FontPatch {
            family: Some(MathFamily::Fraktur),
            shape: Some(MathShape::Up),
            ..FontPatch::default()
        },
        "mathcal" | "mathscr" => FontPatch {
            family: Some(MathFamily::Script),
            shape: Some(MathShape::Up),
            ..FontPatch::default()
        },
        "mathrm" => FontPatch {
            family: Some(MathFamily::Normal),
            series: Some(MathSeries::Medium),
            shape: Some(MathShape::Up),
        },
        "mathnormal" => FontPatch {
            family: Some(MathFamily::Normal),
            series: Some(MathSeries::Medium),
            shape: Some(MathShape::Italic),
        },
        _ => return None,
    })
}

fn text_font_style(name: &str) -> Option<&'static str> {
    match name {
        "textbf" => Some("font-weight:bold"),
        "textit" | "textsl" => Some("font-style:italic"),
        "textsf" => Some("font-family:sans-serif"),
        "texttt" => Some("font-family:monospace"),
        "textsc" => Some("font-variant:small-caps"),
        _ => None,
    }
}

fn is_text_plain(name: &str) -> bool {
    matches!(
        name,
        "text" | "textrm" | "textnormal" | "textup" | "textmd" | "operatorname"
    )
}

fn is_default_font(font: MathFontState) -> bool {
    font.family == MathFamily::Normal
        && font.series == MathSeries::Medium
        && font.shape == MathShape::Italic
}

fn needs_upright_mi(font: MathFontState) -> bool {
    font.family == MathFamily::Normal
        && font.series == MathSeries::Medium
        && font.shape == MathShape::Up
}

fn styled_alphanum(ch: &str, font: MathFontState) -> String {
    let Some(row) = math_alphanum(ch) else {
        return ch.to_string();
    };
    let pick =
        |keys: &[MathAlphanumVariant]| keys.iter().find_map(|k| row.get(*k)).map(str::to_string);
    let fallback = || ch.to_string();
    match font.family {
        MathFamily::DoubleStruck => {
            pick(&[MathAlphanumVariant::DoubleStruck]).unwrap_or_else(fallback)
        }
        MathFamily::Script => {
            if font.series == MathSeries::Bold {
                pick(&[MathAlphanumVariant::BoldScript, MathAlphanumVariant::Script])
                    .unwrap_or_else(fallback)
            } else {
                pick(&[MathAlphanumVariant::Script]).unwrap_or_else(fallback)
            }
        }
        MathFamily::Fraktur => {
            if font.series == MathSeries::Bold {
                pick(&[
                    MathAlphanumVariant::BoldFraktur,
                    MathAlphanumVariant::Fraktur,
                ])
                .unwrap_or_else(fallback)
            } else {
                pick(&[MathAlphanumVariant::Fraktur]).unwrap_or_else(fallback)
            }
        }
        MathFamily::Sans => {
            if font.series == MathSeries::Bold && font.shape == MathShape::Italic {
                pick(&[
                    MathAlphanumVariant::BoldItalicSans,
                    MathAlphanumVariant::BoldSans,
                    MathAlphanumVariant::ItalicSans,
                    MathAlphanumVariant::Sans,
                ])
                .unwrap_or_else(fallback)
            } else if font.series == MathSeries::Bold {
                pick(&[MathAlphanumVariant::BoldSans, MathAlphanumVariant::Sans])
                    .unwrap_or_else(fallback)
            } else if font.shape == MathShape::Italic {
                pick(&[MathAlphanumVariant::ItalicSans, MathAlphanumVariant::Sans])
                    .unwrap_or_else(fallback)
            } else {
                pick(&[MathAlphanumVariant::Sans, MathAlphanumVariant::BoldSans])
                    .unwrap_or_else(fallback)
            }
        }
        MathFamily::Mono => pick(&[MathAlphanumVariant::Monospace]).unwrap_or_else(fallback),
        MathFamily::Normal => {
            if font.shape == MathShape::Up {
                if font.series == MathSeries::Bold {
                    pick(&[MathAlphanumVariant::Bold]).unwrap_or_else(fallback)
                } else {
                    fallback()
                }
            } else if font.series == MathSeries::Bold {
                pick(&[MathAlphanumVariant::BoldItalic, MathAlphanumVariant::Bold])
                    .unwrap_or_else(fallback)
            } else {
                pick(&[MathAlphanumVariant::Italic]).unwrap_or_else(fallback)
            }
        }
    }
}

fn is_formula_env(env: &str) -> bool {
    matches!(
        env,
        "equation"
            | "equation*"
            | "align"
            | "align*"
            | "alignat"
            | "alignat*"
            | "flalign"
            | "flalign*"
            | "displaymath"
            | "multline"
            | "multline*"
            | "gather"
            | "gather*"
            | "eqnarray"
            | "eqnarray*"
    )
}

fn is_numbered_env(env: &str) -> bool {
    matches!(
        env,
        "equation" | "align" | "alignat" | "flalign" | "multline" | "gather" | "eqnarray"
    )
}

fn is_multi_line_env(env: &str) -> bool {
    matches!(
        env,
        "align"
            | "align*"
            | "alignat"
            | "alignat*"
            | "flalign"
            | "flalign*"
            | "gather"
            | "gather*"
            | "multline"
            | "multline*"
            | "eqnarray"
            | "eqnarray*"
    )
}

fn matrix_fences(env: &str) -> Option<(&'static str, &'static str)> {
    Some(match env {
        "matrix" | "smallmatrix" => ("", ""),
        "pmatrix" => ("(", ")"),
        "bmatrix" => ("[", "]"),
        "Bmatrix" => ("{", "}"),
        "vmatrix" => ("|", "|"),
        "Vmatrix" => ("∥", "∥"),
        "cases" => ("{", ""),
        "array" | "aligned" | "alignedat" | "gathered" | "split" | "subarray" => ("", ""),
        _ => return None,
    })
}

fn largeop_char(name: &str) -> Option<&'static str> {
    Some(match name {
        "sum" => "∑",
        "prod" => "∏",
        "int" => "∫",
        "oint" => "∮",
        "iint" => "∬",
        "iiint" => "∭",
        "iiiint" => "⨌",
        "bigcap" => "⋂",
        "bigcup" => "⋃",
        "bigvee" => "⋁",
        "bigwedge" => "⋀",
        "bigodot" => "⨀",
        "bigoplus" => "⨁",
        "bigotimes" => "⨂",
        "bigsqcup" => "⨆",
        "biguplus" => "⨄",
        "coprod" => "∐",
        "oiint" => "∯",
        "sqint" | "sqiint" => "∰",
        "fint" => "⨏",
        "dotsint" => "∫⋯",
        "ointclockwise" => "∲",
        "ointctrclockwise" => "∳",
        "landupint" | "landdownint" => "∫",
        _ => return None,
    })
}

fn is_opname(name: &str) -> bool {
    matches!(
        name,
        "sin"
            | "cos"
            | "tan"
            | "cot"
            | "sec"
            | "csc"
            | "arcsin"
            | "arccos"
            | "arctan"
            | "sinh"
            | "cosh"
            | "tanh"
            | "ln"
            | "log"
            | "lg"
            | "exp"
            | "lim"
            | "limsup"
            | "liminf"
            | "max"
            | "min"
            | "sup"
            | "inf"
            | "det"
            | "dim"
            | "ker"
            | "hom"
            | "arg"
            | "deg"
            | "gcd"
            | "Pr"
            | "mod"
            | "bmod"
            | "sgn"
    )
}

fn is_skip_next(name: &str) -> bool {
    matches!(
        name,
        "limits" | "nolimits" | "nonumber" | "notag" | "mathop"
    )
}

fn is_skip_group(name: &str) -> bool {
    matches!(
        name,
        "tag" | "label" | "hspace" | "vspace" | "rule" | "leftroot" | "uproot" | "adjustlimits"
    )
}

fn is_big_cmd(name: &str) -> bool {
    if name == "middle" {
        return true;
    }
    let b = name.as_bytes();
    if b.len() < 3 {
        return false;
    }
    if b[0] != b'b' && b[0] != b'B' {
        return false;
    }
    if b[1] != b'i' {
        return false;
    }
    let mut i = 2;
    if i >= b.len() || b[i] != b'g' {
        return false;
    }
    while i < b.len() && b[i] == b'g' {
        i += 1;
    }
    if i == b.len() {
        return true;
    }
    i == b.len() - 1 && matches!(b[i], b'l' | b'r' | b'm')
}

#[derive(Clone, Debug)]
pub struct MathMacro {
    pub nargs: usize,
    pub optional_default: Option<String>,
    pub body: String,
}

pub type MathMacroMap = HashMap<String, MathMacro>;

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct UnwrappedLatex {
    pub display: bool,
    pub numbered: bool,
    pub env: String,
    pub body: String,
}

#[derive(Clone, Debug)]
pub(crate) struct FormulaLine {
    pub tex: String,
    pub consumes_number: bool,
    pub labels: Vec<String>,
    pub tag: Option<FormulaTag>,
}

#[derive(Clone, Debug)]
pub(crate) struct FormulaTag {
    pub star: bool,
    pub text: String,
}

#[derive(Clone, Debug)]
pub(crate) struct FormulaLinePlan {
    pub display: bool,
    #[allow(dead_code)] // Deno plan; render uses peeled + lines/display
    pub numbered: bool,
    #[allow(dead_code)] // Deno plan; render uses peeled + lines/display
    pub env: String,
    pub lines: Vec<FormulaLine>,
}

struct Peeled {
    display: bool,
    numbered: bool,
    env: String,
    raw_body: String,
}

fn peel_latex_source(source: &str) -> Peeled {
    let s = source.trim();
    if let Some((env_name, body)) = match_display_env(s) {
        return Peeled {
            display: true,
            numbered: is_numbered_env(env_name),
            env: env_name.to_string(),
            raw_body: body.trim().to_string(),
        };
    }
    if s.starts_with("$$") && s.ends_with("$$") {
        return Peeled {
            display: true,
            numbered: false,
            env: "$$".into(),
            raw_body: s[2..s.len() - 2].trim().to_string(),
        };
    }
    if s.starts_with("\\[") && s.ends_with("\\]") {
        return Peeled {
            display: true,
            numbered: false,
            env: "[".into(),
            raw_body: s[2..s.len() - 2].trim().to_string(),
        };
    }
    if s.starts_with('$') && s.ends_with('$') && s.len() >= 2 {
        return Peeled {
            display: false,
            numbered: false,
            env: "$".into(),
            raw_body: s[1..s.len() - 1].trim().to_string(),
        };
    }
    Peeled {
        display: false,
        numbered: false,
        env: String::new(),
        raw_body: s.to_string(),
    }
}

fn match_display_env(s: &str) -> Option<(&str, &str)> {
    let rest = s.strip_prefix("\\begin{")?;
    let close = rest.find('}')?;
    let env = &rest[..close];
    if !is_formula_env(env) {
        return None;
    }
    let mut after = &rest[close + 1..];
    if after.starts_with('{') {
        let inner_end = after.find('}')?;
        after = &after[inner_end + 1..];
    }
    let end_tag = format!("\\end{{{env}}}");
    let body = after.strip_suffix(&end_tag)?;
    Some((env, body))
}

fn strip_labels(s: &str) -> String {
    let mut out = String::new();
    let mut rest = s;
    while let Some(idx) = rest.find("\\label{") {
        out.push_str(&rest[..idx]);
        rest = &rest[idx + "\\label{".len()..];
        if let Some(end) = rest.find('}') {
            rest = &rest[end + 1..];
        } else {
            break;
        }
    }
    out.push_str(rest);
    out
}

pub fn unwrap_latex_source(source: &str) -> UnwrappedLatex {
    let peeled = peel_latex_source(source);
    UnwrappedLatex {
        display: peeled.display,
        numbered: peeled.numbered,
        env: peeled.env,
        body: strip_labels(&peeled.raw_body).trim().to_string(),
    }
}

fn extract_tag(body: &str) -> Option<FormulaTag> {
    let idx = body.find("\\tag")?;
    let after = &body[idx + 4..];
    let (star, after) = if let Some(rest) = after.strip_prefix('*') {
        (true, rest)
    } else {
        (false, after)
    };
    let after = after.strip_prefix('{')?;
    let end = after.find('}')?;
    if after[..end].contains('{') {
        return None;
    }
    Some(FormulaTag {
        star,
        text: after[..end].to_string(),
    })
}

fn split_top_level(s: &str, sep: &str) -> Vec<String> {
    let mut parts = Vec::new();
    let mut start = 0;
    let mut brace = 0i32;
    let mut env_depth = 0i32;
    let bytes = s.as_bytes();
    let mut i = 0;
    while i < bytes.len() {
        let ch = bytes[i] as char;
        if ch == '{' {
            brace += 1;
        } else if ch == '}' && brace > 0 {
            brace -= 1;
        } else if ch == '\\' && brace == 0 {
            if s[i..].starts_with("\\begin{") {
                env_depth += 1;
            } else if s[i..].starts_with("\\end{") {
                env_depth = (env_depth - 1).max(0);
            } else if sep == "\\\\"
                && env_depth == 0
                && i + 1 < bytes.len()
                && bytes[i + 1] == b'\\'
            {
                parts.push(s[start..i].to_string());
                i += 1;
                if i + 1 < bytes.len() && bytes[i + 1] == b'*' {
                    i += 1;
                }
                if i + 1 < bytes.len()
                    && bytes[i + 1] == b'['
                    && let Some(rel) = s[i + 2..].find(']')
                {
                    i = i + 2 + rel;
                }
                start = i + 1;
            }
        } else if sep == "&" && ch == '&' && brace == 0 && env_depth == 0 {
            parts.push(s[start..i].to_string());
            start = i + 1;
        }
        i += 1;
    }
    parts.push(s[start..].to_string());
    if sep == "&" {
        parts.into_iter().map(|p| p.trim().to_string()).collect()
    } else {
        parts
            .into_iter()
            .map(|p| p.trim().to_string())
            .filter(|p| !p.is_empty())
            .collect()
    }
}

fn collect_labels(tex: &str) -> Vec<String> {
    let mut labels = Vec::new();
    let mut rest = tex;
    while let Some(idx) = rest.find("\\label{") {
        rest = &rest[idx + "\\label{".len()..];
        if let Some(end) = rest.find('}') {
            labels.push(rest[..end].to_string());
            rest = &rest[end + 1..];
        } else {
            break;
        }
    }
    labels
}

fn has_nonumber(tex: &str) -> bool {
    contains_cmd(tex, "nonumber") || contains_cmd(tex, "notag")
}

fn contains_cmd(tex: &str, name: &str) -> bool {
    let mut rest = tex;
    let needle = format!("\\{name}");
    while let Some(idx) = rest.find(&needle) {
        let after = &rest[idx + needle.len()..];
        let ok = after
            .chars()
            .next()
            .is_none_or(|c| !c.is_ascii_alphabetic());
        if ok {
            return true;
        }
        rest = &rest[idx + 1..];
    }
    false
}

pub(crate) fn plan_formula_lines(source: &str) -> FormulaLinePlan {
    let peeled = peel_latex_source(source);
    let chunks = if is_multi_line_env(&peeled.env) {
        split_top_level(&peeled.raw_body, "\\\\")
    } else {
        vec![peeled.raw_body.clone()]
    };
    let chunks = if chunks.is_empty() {
        vec![String::new()]
    } else {
        chunks
    };
    let n = chunks.len();
    let lines = chunks
        .into_iter()
        .enumerate()
        .map(|(i, tex)| {
            let labels = collect_labels(&tex);
            let tag = extract_tag(&tex);
            let skip = has_nonumber(&tex);
            let consumes_number = if peeled.numbered && !skip {
                if peeled.env == "multline" {
                    i == n - 1
                } else {
                    true
                }
            } else {
                false
            };
            FormulaLine {
                tex,
                consumes_number,
                labels,
                tag,
            }
        })
        .collect();
    FormulaLinePlan {
        display: peeled.display,
        numbered: peeled.numbered,
        env: peeled.env,
        lines,
    }
}

fn strip_line_commands(tex: &str) -> String {
    let mut s = strip_labels(tex);
    s = strip_tag(&s);
    s = strip_cmd_word(&s, "nonumber");
    s = strip_cmd_word(&s, "notag");
    s.trim().to_string()
}

fn strip_tag(s: &str) -> String {
    let mut out = String::new();
    let mut rest = s;
    while let Some(idx) = rest.find("\\tag") {
        out.push_str(&rest[..idx]);
        rest = &rest[idx + 4..];
        if let Some(r) = rest.strip_prefix('*') {
            rest = r;
        }
        if let Some(r) = rest.strip_prefix('{')
            && let Some(end) = r.find('}')
            && !r[..end].contains('{')
        {
            rest = &r[end + 1..];
            continue;
        }
        out.push_str("\\tag");
        break;
    }
    out.push_str(rest);
    out
}

fn strip_cmd_word(s: &str, name: &str) -> String {
    let needle = format!("\\{name}");
    let mut out = String::new();
    let mut rest = s;
    while let Some(idx) = rest.find(&needle) {
        let after = &rest[idx + needle.len()..];
        let ok = after
            .chars()
            .next()
            .is_none_or(|c| !c.is_ascii_alphabetic());
        if ok {
            out.push_str(&rest[..idx]);
            rest = after;
        } else {
            out.push_str(&rest[..=idx]);
            rest = &rest[idx + 1..];
        }
    }
    out.push_str(rest);
    out
}

fn line_to_mathml(tex: &str, macros: Option<&MathMacroMap>) -> String {
    let clean = strip_line_commands(tex);
    if clean.contains('&') {
        let cells: Vec<String> = split_top_level(&clean, "&")
            .into_iter()
            .map(|c| {
                let inner = latex_to_mathml(&c, macros, 0);
                let inner = if inner.is_empty() {
                    "<mrow/>".into()
                } else {
                    inner
                };
                format!("<mtd>{inner}</mtd>")
            })
            .collect();
        format!("<mtable><mtr>{}</mtr></mtable>", cells.join(""))
    } else {
        latex_to_mathml(&clean, macros, 0)
    }
}

fn math_html(inner: &str, body: &str, display: bool) -> String {
    let display_attr = if display { " display=\"block\"" } else { "" };
    format!(
        "<math xmlns=\"http://www.w3.org/1998/Math/MathML\"{display_attr}><semantics>{inner}<annotation encoding=\"application/x-tex\">{}</annotation></semantics></math>",
        escape_live_html(body)
    )
}

fn line_eqno_html(line: &FormulaLine, no: Option<&str>) -> String {
    if let Some(tag) = &line.tag {
        return if tag.star {
            format!(
                "<span class=\"eqno\">{}</span>",
                escape_live_html(&tag.text)
            )
        } else {
            format!(
                "<span class=\"eqno\">({})</span>",
                escape_live_html(&tag.text)
            )
        };
    }
    if line.consumes_number
        && let Some(no) = no
    {
        return format!("<span class=\"eqno\">({no})</span>");
    }
    String::new()
}

pub fn render_formula_html(
    source: &str,
    equation_no: &[Option<&str>],
    macros: Option<&MathMacroMap>,
) -> String {
    let plan = plan_formula_lines(source);
    if plan.lines.len() > 1 {
        let rows: Vec<String> = plan
            .lines
            .iter()
            .enumerate()
            .map(|(i, line)| {
                let body = strip_line_commands(&line.tex);
                let math = math_html(&line_to_mathml(&line.tex, macros), &body, true);
                format!(
                    "<span class=\"formula-row\">{math}{}</span>",
                    line_eqno_html(line, equation_no.get(i).copied().flatten())
                )
            })
            .collect();
        return format!("<span class=\"formula\">{}</span>", rows.join(""));
    }
    let empty = FormulaLine {
        tex: String::new(),
        consumes_number: false,
        labels: vec![],
        tag: None,
    };
    let line = plan.lines.first().unwrap_or(&empty);
    let body = strip_line_commands(&line.tex);
    let inner = latex_to_mathml(&body, macros, 0);
    format!(
        "<span class=\"formula\">{}{}</span>",
        math_html(&inner, &body, plan.display),
        line_eqno_html(line, equation_no.first().copied().flatten())
    )
}

pub fn latex_to_mathml(source: &str, macros: Option<&MathMacroMap>, macro_depth: usize) -> String {
    let mut p = Parser::new(source, macros, macro_depth);
    let body = p.parse_expr();
    if body.is_empty() {
        format!("<mtext>{}</mtext>", escape_live_html(source))
    } else {
        body
    }
}

pub fn parse_newcommands(preamble: &str) -> MathMacroMap {
    let mut out = MathMacroMap::new();
    let mut rest = preamble;
    while let Some(idx) = rest.find("\\newcommand") {
        rest = &rest[idx + "\\newcommand".len()..];
        if let Some(r) = rest.strip_prefix('*') {
            rest = r;
        }
        let Some(r) = rest.strip_prefix("{\\") else {
            continue;
        };
        let Some(name_end) = r.find('}') else {
            break;
        };
        let name = &r[..name_end];
        if !name.chars().all(|c| c.is_ascii_alphabetic()) {
            rest = &r[name_end..];
            continue;
        }
        rest = &r[name_end + 1..];
        let mut nargs = 0usize;
        let mut optional_default = None;
        if let Some(r) = rest.strip_prefix('[')
            && let Some(end) = r.find(']')
        {
            nargs = r[..end].parse().unwrap_or(0);
            rest = &r[end + 1..];
        }
        if let Some(r) = rest.strip_prefix('[')
            && let Some(end) = r.find(']')
        {
            optional_default = Some(r[..end].to_string());
            rest = &r[end + 1..];
        }
        let Some(r) = rest.strip_prefix('{') else {
            continue;
        };
        let mut depth = 1i32;
        let mut i = 0usize;
        let bytes = r.as_bytes();
        while i < bytes.len() && depth > 0 {
            if bytes[i] == b'{' {
                depth += 1;
            } else if bytes[i] == b'}' {
                depth -= 1;
            }
            i += 1;
        }
        let body = r[..i.saturating_sub(1)].to_string();
        rest = &r[i..];
        out.insert(
            name.to_string(),
            MathMacro {
                nargs,
                optional_default,
                body,
            },
        );
    }
    out
}

include!(concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/src/generated/latex_parser.rs"
));
