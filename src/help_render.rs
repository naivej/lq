//! Help page renderers (Deno `help_render.ts`).

use crate::help::{HelpPage, grouped_pages, reach_of};
use std::io::IsTerminal;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum RichMode {
    Auto,
    Always,
    Never,
}

const ANSI_RESET: &str = "\x1b[0m";
const ANSI_HEADING: &str = "\x1b[1;36m";
const ANSI_CODE: &str = "\x1b[36m";
const ANSI_SAFETY: &str = "\x1b[1;33m";

const SAFETY_TERMS: &[&str] = &[
    "rejected",
    "hard error",
    "writes nothing",
    "cannot",
    "never",
];

const SPLASH: &str = concat!(
    "\n",
    "  \x1b[38;2;194;65;12m❯\x1b[0m\x1b[38;2;255;255;0m❯\x1b[0m \x1b[38;2;247;244;236mlq\x1b[0m\x1b[38;2;31;111;235m ▉\x1b[0m\n",
    "\n",
);

pub fn render_page(page: &HelpPage, rich: RichMode) -> String {
    render_page_tty(page, rich, std::io::stdout().is_terminal())
}

pub fn render_page_tty(page: &HelpPage, rich: RichMode, stdout_is_terminal: bool) -> String {
    let rich_on = match rich {
        RichMode::Always => true,
        RichMode::Never => false,
        RichMode::Auto => stdout_is_terminal,
    };
    if rich_on {
        render_page_rich(page)
    } else {
        render_page_text(page)
    }
}

pub fn render_page_text(page: &HelpPage) -> String {
    let mut out: Vec<String> = Vec::new();
    if page.id != "home" {
        out.push(page.title.to_string());
        out.push("=".repeat(page.title.len()));
    }
    for (i, section) in page.sections.iter().enumerate() {
        if !(page.id == "home" && i == 0) {
            out.push(String::new());
        }
        if !section.heading.is_empty() {
            out.push(section.heading.to_string());
            out.push("-".repeat(section.heading.len()));
        }
        out.push(to_plain_text(section.body));
    }
    if page.id == "home" {
        append_home_map(&mut out, |line| line.to_string(), |line| line.to_string());
    }
    append_further_reading(
        &mut out,
        page,
        |line| line.to_string(),
        |line| line.to_string(),
    );
    out.join("\n") + "\n"
}

pub fn render_page_rich(page: &HelpPage) -> String {
    let mut out: Vec<String> = Vec::new();
    if page.id == "home" {
        out.push(SPLASH.to_string());
    }
    if page.id != "home" {
        out.push(format!("{ANSI_HEADING}{}{ANSI_RESET}", page.title));
        out.push("=".repeat(page.title.len()));
    }
    for (i, section) in page.sections.iter().enumerate() {
        if !(page.id == "home" && i == 0) {
            out.push(String::new());
        }
        if !section.heading.is_empty() {
            out.push(format!("{ANSI_HEADING}{}{ANSI_RESET}", section.heading));
            out.push("-".repeat(section.heading.len()));
        }
        out.push(to_styled_text(section.body));
    }
    if page.id == "home" {
        append_home_map(&mut out, style_code_span, style_heading);
    }
    append_further_reading(&mut out, page, style_code_span, style_heading);
    out.join("\n") + "\n"
}

fn append_home_map(
    out: &mut Vec<String>,
    emit: fn(&str) -> String,
    emit_heading: fn(&str) -> String,
) {
    out.push(String::new());
    out.push(emit_heading("Pages"));
    out.push("-".repeat("Pages".len()));
    let groups = grouped_pages();
    let max_reach = groups
        .iter()
        .flat_map(|g| g.pages.iter().map(|p| reach_of(p.id).len()))
        .max()
        .unwrap_or(0);
    for group in groups {
        out.push(emit(&format!("{}/", group.group.as_str())));
        for p in group.pages {
            let reach = reach_of(p.id);
            out.push(emit(&format!("  {reach:<max_reach$}    lq help {reach}")));
        }
    }
}

fn append_further_reading(
    out: &mut Vec<String>,
    page: &HelpPage,
    emit: fn(&str) -> String,
    emit_heading: fn(&str) -> String,
) {
    if page.further_reading.is_empty() {
        return;
    }
    out.push(String::new());
    out.push(emit_heading("Further reading"));
    out.push("-".repeat("Further reading".len()));
    for link in page.further_reading {
        out.push(emit(&format!(
            "  lq help {} - {}",
            reach_of(link.page),
            link.hint
        )));
    }
}

fn to_plain_text(body: &str) -> String {
    body.split('\n')
        .filter(|line| !is_fence(line))
        .collect::<Vec<_>>()
        .join("\n")
        .replace('`', "")
}

fn is_fence(line: &str) -> bool {
    line.trim_start().starts_with("```")
}

fn to_styled_text(body: &str) -> String {
    let mut out = Vec::new();
    let mut in_block = false;
    for raw_line in body.split('\n') {
        if is_fence(raw_line) {
            in_block = !in_block;
            continue;
        }
        if in_block {
            out.push(format!("{ANSI_CODE}{raw_line}{ANSI_RESET}"));
        } else {
            out.push(style_inline(raw_line));
        }
    }
    out.join("\n")
}

fn style_inline(line: &str) -> String {
    let parts: Vec<&str> = line.split('`').collect();
    let mut out = String::new();
    for (i, part) in parts.iter().enumerate() {
        if i % 2 == 1 {
            out.push_str(ANSI_CODE);
            out.push_str(part);
            out.push_str(ANSI_RESET);
        } else {
            out.push_str(&emphasize_safety(part));
        }
    }
    out
}

fn emphasize_safety(text: &str) -> String {
    let mut out = text.to_string();
    for term in SAFETY_TERMS {
        if out.contains(term) {
            out = out.replace(term, &format!("{ANSI_SAFETY}{term}{ANSI_RESET}"));
        }
    }
    out
}

fn style_code_span(line: &str) -> String {
    let mut out = String::new();
    let mut rest = line;
    while let Some(idx) = rest.find("lq help ") {
        out.push_str(&rest[..idx]);
        let after = &rest[idx + "lq help ".len()..];
        let token_len = after.find(char::is_whitespace).unwrap_or(after.len());
        let frag = &rest[idx..idx + "lq help ".len() + token_len];
        out.push_str(ANSI_CODE);
        out.push_str(frag);
        out.push_str(ANSI_RESET);
        rest = &rest[idx + frag.len()..];
    }
    out.push_str(rest);
    out
}

fn style_heading(line: &str) -> String {
    format!("{ANSI_HEADING}{line}{ANSI_RESET}")
}
