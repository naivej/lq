//! BibTeX parse and authoryear-ish HTML (Deno `bib.ts`).

use serde::Serialize;

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize)]
pub struct Citation {
    pub key: String,
    #[serde(rename = "type", skip_serializing_if = "Option::is_none")]
    pub type_: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub author: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub year: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub journal: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub volume: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub number: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub pages: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub doi: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub publisher: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub booktitle: Option<String>,
}

fn extract_braced(body: &str, start: usize) -> Option<(String, usize)> {
    let bytes = body.as_bytes();
    if start >= bytes.len() || bytes[start] != b'{' {
        return None;
    }
    let mut depth = 0;
    for (i, &b) in bytes.iter().enumerate().skip(start) {
        if b == b'{' {
            depth += 1;
        } else if b == b'}' {
            depth -= 1;
            if depth == 0 {
                return Some((body[start + 1..i].to_string(), i + 1));
            }
        }
    }
    None
}

fn is_word_char(c: char) -> bool {
    c.is_ascii_alphanumeric() || c == '_'
}

fn extract_field(body: &str, name: &str) -> Option<String> {
    let lower_body = body.to_ascii_lowercase();
    let lower_name = name.to_ascii_lowercase();
    let mut search = 0;
    while let Some(rel) = lower_body[search..].find(&lower_name) {
        let idx = search + rel;
        let before_ok = idx == 0
            || body[..idx]
                .chars()
                .next_back()
                .is_none_or(|c| !is_word_char(c));
        let after = idx + name.len();
        if before_ok && let Some(eq_at) = find_equals(body.get(after..)?) {
            let mut i = after + eq_at + 1;
            while i < body.len() {
                let ch = body[i..].chars().next()?;
                if !ch.is_whitespace() {
                    break;
                }
                i += ch.len_utf8();
            }
            if i >= body.len() {
                return None;
            }
            let ch = body[i..].chars().next()?;
            if ch == '{' {
                return extract_braced(body, i).map(|(v, _)| v);
            }
            if ch == '"' {
                let end = body[i + 1..].find('"')?;
                return Some(body[i + 1..i + 1 + end].to_string());
            }
            let token: String = body[i..]
                .chars()
                .take_while(|c| !c.is_whitespace() && *c != ',' && *c != '}')
                .collect();
            if token.is_empty() {
                return None;
            }
            return Some(token);
        }
        search = idx + 1;
    }
    None
}

fn find_equals(after_name: &str) -> Option<usize> {
    let trimmed_off = after_name.len() - after_name.trim_start().len();
    after_name
        .get(trimmed_off..)
        .filter(|s| s.starts_with('='))
        .map(|_| trimmed_off)
}

pub(crate) fn clean_bib_text(raw: &str) -> String {
    let mut s = regex_space(raw);
    s = replace_cmd(&s, "textsc");
    s = replace_cmd(&s, "emph");
    s = s.replace("\\LaTeXe{}", "LaTeX2ε");
    s = s.replace("\\LaTeXe", "LaTeX2ε");
    s = s.replace("\\LaTeX{}", "LaTeX");
    s = s.replace("\\LaTeX", "LaTeX");
    s = s.replace("\\TeX{}", "TeX");
    s = s.replace("\\TeX", "TeX");
    s = s.replace("\\LyX{}", "LyX");
    s = s.replace("\\LyX", "LyX");
    s = s.replace("---", "—");
    s = s.replace("--", "–");
    s = s.replace('~', " ");
    s = s.replace(['{', '}'], "");
    s.trim().to_string()
}

fn regex_space(raw: &str) -> String {
    let mut out = String::new();
    let mut prev_space = false;
    for c in raw.chars() {
        if c.is_whitespace() {
            if !prev_space {
                out.push(' ');
                prev_space = true;
            }
        } else {
            prev_space = false;
            out.push(c);
        }
    }
    out
}

fn replace_cmd(s: &str, name: &str) -> String {
    // \name{...} non-nested, case-insensitive command name
    let needle = format!("\\{name}{{");
    let lower = s.to_ascii_lowercase();
    let needle_l = needle.to_ascii_lowercase();
    let mut out = String::new();
    let mut i = 0;
    while let Some(rel) = lower[i..].find(&needle_l) {
        let at = i + rel;
        out.push_str(&s[i..at]);
        let inner_start = at + needle.len();
        if let Some(end) = s[inner_start..].find('}') {
            out.push_str(&s[inner_start..inner_start + end]);
            i = inner_start + end + 1;
        } else {
            out.push_str(&s[at..]);
            return out;
        }
    }
    out.push_str(&s[i..]);
    out
}

struct Person {
    first: String,
    last: String,
}

fn parse_person(part: &str) -> Person {
    let t = part.trim();
    if let Some(comma) = t.find(',') {
        Person {
            last: t[..comma].trim().to_string(),
            first: t[comma + 1..].trim().to_string(),
        }
    } else {
        let bits: Vec<&str> = t.split_whitespace().collect();
        if bits.is_empty() {
            Person {
                first: String::new(),
                last: t.to_string(),
            }
        } else {
            Person {
                last: bits[bits.len() - 1].to_string(),
                first: bits[..bits.len() - 1].join(" "),
            }
        }
    }
}

pub(crate) fn format_bib_authors(author: Option<&str>) -> String {
    let Some(author) = author else {
        return "Unknown".to_string();
    };
    let people: Vec<Person> = split_and(author)
        .into_iter()
        .map(|p| parse_person(&p))
        .filter(|p| !p.last.is_empty())
        .collect();
    if people.is_empty() {
        return "Unknown".to_string();
    }
    let one = |p: &Person| {
        if p.first.is_empty() {
            p.last.clone()
        } else {
            format!("{}, {}", p.last, p.first)
        }
    };
    match people.len() {
        1 => one(&people[0]),
        2 => format!("{} and {}", one(&people[0]), one(&people[1])),
        _ => format!("{} et al.", one(&people[0])),
    }
}

fn split_and(author: &str) -> Vec<String> {
    // `to_ascii_lowercase` keeps byte length, so indices into `lower` are valid
    // on `author`. Walk with `find` — a byte cursor panics on names like François.
    let lower = author.to_ascii_lowercase();
    let mut parts = Vec::new();
    let mut start = 0;
    let mut from = 0;
    while let Some(rel) = lower[from..].find(" and ") {
        let i = from + rel;
        parts.push(author[start..i].to_string());
        from = i + 5;
        start = from;
    }
    parts.push(author[start..].to_string());
    parts
}

fn escape_bib_html(value: &str) -> String {
    value
        .replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
        .replace('\'', "&#39;")
}

pub fn format_bibliography_entry(c: &Citation) -> String {
    let mut bits: Vec<String> = vec![escape_bib_html(&format_bib_authors(c.author.as_deref()))];
    if let Some(year) = &c.year {
        bits.push(format!(" ({})", escape_bib_html(year)));
    }
    if let Some(title) = &c.title {
        bits.push(format!(". “{}”", escape_bib_html(&clean_bib_text(title))));
    }
    if let Some(journal) = &c.journal {
        bits.push(format!(
            ". In: <i>{}</i>",
            escape_bib_html(&clean_bib_text(journal))
        ));
    } else if let Some(booktitle) = &c.booktitle {
        bits.push(format!(
            ". In: <i>{}</i>",
            escape_bib_html(&clean_bib_text(booktitle))
        ));
    } else if let Some(publisher) = &c.publisher {
        bits.push(format!(". {}", escape_bib_html(&clean_bib_text(publisher))));
    }
    if let Some(volume) = &c.volume {
        bits.push(format!(" {}", escape_bib_html(volume)));
        if let Some(number) = &c.number {
            bits.push(format!(".{}", escape_bib_html(number)));
        }
    }
    if let Some(pages) = &c.pages {
        let collapsed: String = collapse_dashes(pages);
        bits.push(format!(", pp. {}", escape_bib_html(&collapsed)));
    }
    if let Some(doi) = &c.doi {
        bits.push(format!(". doi: {}", escape_bib_html(doi)));
    }
    bits.push(".".to_string());
    bits.join("")
}

fn collapse_dashes(pages: &str) -> String {
    // /-+/g → en-dash
    let mut out = String::new();
    let mut in_dash = false;
    for c in pages.chars() {
        if c == '-' {
            if !in_dash {
                out.push('–');
                in_dash = true;
            }
        } else {
            in_dash = false;
            out.push(c);
        }
    }
    out
}

fn field(body: &str, name: &str) -> Option<String> {
    extract_field(body, name).map(|raw| clean_bib_text(&raw))
}

pub fn parse_bibtex(content: &str) -> Vec<Citation> {
    let mut citations = Vec::new();
    let mut rest = content;
    while let Some(at) = rest.find('@') {
        rest = &rest[at + 1..];
        let type_len = rest
            .find(|c: char| !c.is_ascii_alphabetic())
            .unwrap_or(rest.len());
        if type_len == 0 {
            continue;
        }
        let type_ = rest[..type_len].to_ascii_lowercase();
        rest = rest[type_len..].trim_start();
        if !rest.starts_with('{') {
            continue;
        }
        rest = rest[1..].trim_start();
        let Some(comma) = rest.find(',') else {
            break;
        };
        let key = rest[..comma].trim().to_string();
        rest = &rest[comma + 1..];
        let Some(end) = rest.find("\n}") else {
            break;
        };
        let body = &rest[..end];
        rest = &rest[end + 2..];

        let year = field(body, "year").and_then(|y| first_year(&y));

        let mut cit = Citation {
            key,
            type_: Some(type_),
            ..Citation::default()
        };
        cit.title = field(body, "title");
        cit.author = field(body, "author");
        cit.year = year;
        cit.journal = field(body, "journal").or_else(|| field(body, "journaltitle"));
        cit.volume = field(body, "volume");
        cit.number = field(body, "number");
        cit.pages = field(body, "pages");
        cit.doi = field(body, "doi");
        cit.publisher = field(body, "publisher");
        cit.booktitle = field(body, "booktitle");
        citations.push(cit);
    }
    citations
}

fn first_year(y: &str) -> Option<String> {
    let bytes = y.as_bytes();
    bytes
        .windows(4)
        .find(|w| w.iter().all(u8::is_ascii_digit))
        .map(|w| {
            std::str::from_utf8(w)
                .expect("invariant: ascii digit window is utf-8")
                .to_string()
        })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn format_bib_authors_accepts_multibyte_names() {
        assert_eq!(
            format_bib_authors(Some("François Moreau")),
            "Moreau, François"
        );
        assert_eq!(
            format_bib_authors(Some("François Moreau and Smith, Jane")),
            "Moreau, François and Smith, Jane"
        );
    }
}
