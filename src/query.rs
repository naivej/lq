//! Selector parse + match (Deno `query.ts`).

use crate::ast::{Document, NodeId, NodeKind};
use crate::registry::{INLINE_PROPERTIES, is_inline_style_key};
use crate::text_utils::{
    ConcatOpts, TextRegion, TraversalState, clone_traversal_state, concatenate_text_nodes,
    create_traversal_state, enter_traversal_state, invisible_inset_type, is_invisible_inset,
    traversal_region,
};
use std::collections::{HashMap, HashSet};
use std::fmt;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct QueryError {
    pub message: String,
}

impl fmt::Display for QueryError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.message)
    }
}

impl std::error::Error for QueryError {}

fn err(message: impl Into<String>) -> QueryError {
    QueryError {
        message: message.into(),
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum PseudoName {
    First,
    Last,
    Contains,
    NthMatch,
    Not,
    Adjacent,
    Until,
    Change,
    Property,
    Note,
}

impl PseudoName {
    fn parse(name: &str) -> Option<Self> {
        match name {
            "first" => Some(Self::First),
            "last" => Some(Self::Last),
            "contains" => Some(Self::Contains),
            "nth-match" => Some(Self::NthMatch),
            "not" => Some(Self::Not),
            "adjacent" => Some(Self::Adjacent),
            "until" => Some(Self::Until),
            "change" => Some(Self::Change),
            "property" => Some(Self::Property),
            "note" => Some(Self::Note),
            _ => None,
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PseudoClass {
    pub name: PseudoName,
    pub arg_raw: Option<String>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Combinator {
    Descendant,
    Sibling,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SelectorPart {
    pub tag: Option<String>,
    pub arg_exact: Option<String>,
    pub pseudos: Vec<PseudoClass>,
    pub combinator: Option<Combinator>,
}

pub type Selector = Vec<Vec<SelectorPart>>;

fn parse_pseudo_classes(suffix: &str) -> Result<Vec<PseudoClass>, QueryError> {
    let mut pseudos = Vec::new();
    if suffix.is_empty() {
        return Ok(pseudos);
    }
    let mut i = 0;
    let bytes = suffix.as_bytes();
    while i < suffix.len() {
        if bytes[i] != b':' {
            return Err(err(format!("Invalid pseudo-class syntax: {suffix}")));
        }
        i += 1;
        let name_start = i;
        while i < suffix.len()
            && (bytes[i].is_ascii_alphanumeric() || bytes[i] == b'_' || bytes[i] == b'-')
        {
            i += 1;
        }
        if i == name_start {
            return Err(err(format!("Invalid pseudo-class syntax: {suffix}")));
        }
        let p_name = &suffix[name_start..i];
        let mut p_arg: Option<String> = None;
        if i < suffix.len() && bytes[i] == b'(' {
            i += 1;
            let arg_start = i;
            i = consume_pseudo_arg_body(suffix, i)?;
            if i >= suffix.len() || suffix.as_bytes()[i] != b')' {
                return Err(err(format!("Invalid pseudo-class syntax: {suffix}")));
            }
            let raw = suffix[arg_start..i].trim().to_string();
            p_arg = if raw.is_empty() { None } else { Some(raw) };
            i += 1;
        }

        let Some(name) = PseudoName::parse(p_name) else {
            return Err(err(format!("Unsupported pseudo-class: :{p_name}")));
        };

        if name == PseudoName::Change && p_arg.is_none() {
            return Err(err(
                ":change() requires an argument, e.g. :change(current|inserted|deleted)",
            ));
        }
        if name == PseudoName::Property && p_arg.is_none() {
            return Err(err(
                ":property() requires an argument, e.g. :property(emph) or :property(family=roman)",
            ));
        }
        if name == PseudoName::NthMatch && p_arg.is_none() {
            return Err(err(
                ":nth-match() requires an argument, e.g. :nth-match(2n+1)",
            ));
        }
        if name == PseudoName::Note
            && let Some(ref arg) = p_arg
        {
            let note_type = unquote_once(arg);
            if note_type != "Note" && note_type != "Comment" {
                return Err(err(format!(
                    "Invalid :note() argument: '{note_type}'. Valid private note types: Note, Comment. Greyedout is visible output and is not excluded."
                )));
            }
        }
        if matches!(
            name,
            PseudoName::Not | PseudoName::Adjacent | PseudoName::Until
        ) {
            let Some(ref arg) = p_arg else {
                return Err(err(format!(
                    ":{p_name}() requires a selector argument, e.g. :{p_name}(layout[Section])"
                )));
            };
            if parse_selector_part(arg, true).is_err() {
                return Err(err(format!("Invalid selector inside :{p_name}(): {arg}")));
            }
        }

        pseudos.push(PseudoClass {
            name,
            arg_raw: p_arg,
        });
    }
    Ok(pseudos)
}

/// Inner of `:name(…)` — one nesting level of parens, quotes (Deno pseudo regex).
fn consume_pseudo_arg_body(s: &str, mut i: usize) -> Result<usize, QueryError> {
    let bytes = s.as_bytes();
    while i < s.len() {
        let ch = bytes[i];
        if ch == b')' {
            return Ok(i);
        }
        if ch == b'"' {
            i += 1;
            while i < s.len() && bytes[i] != b'"' {
                i += 1;
            }
            if i >= s.len() {
                return Err(err(format!("Invalid pseudo-class syntax: {s}")));
            }
            i += 1;
            continue;
        }
        if ch == b'\'' {
            i += 1;
            while i < s.len() && bytes[i] != b'\'' {
                i += 1;
            }
            if i >= s.len() {
                return Err(err(format!("Invalid pseudo-class syntax: {s}")));
            }
            i += 1;
            continue;
        }
        if ch == b'(' {
            i += 1;
            while i < s.len() {
                let c = bytes[i];
                if c == b')' {
                    i += 1;
                    break;
                }
                if c == b'"' {
                    i += 1;
                    while i < s.len() && bytes[i] != b'"' {
                        i += 1;
                    }
                    if i >= s.len() {
                        return Err(err(format!("Invalid pseudo-class syntax: {s}")));
                    }
                    i += 1;
                    continue;
                }
                if c == b'\'' {
                    i += 1;
                    while i < s.len() && bytes[i] != b'\'' {
                        i += 1;
                    }
                    if i >= s.len() {
                        return Err(err(format!("Invalid pseudo-class syntax: {s}")));
                    }
                    i += 1;
                    continue;
                }
                if c == b'(' {
                    return Err(err(format!("Invalid pseudo-class syntax: {s}")));
                }
                i += 1;
            }
            continue;
        }
        i += 1;
    }
    Err(err(format!("Invalid pseudo-class syntax: {s}")))
}

fn parse_selector_part(raw: &str, allow_bare_pseudo: bool) -> Result<SelectorPart, QueryError> {
    let bytes = raw.as_bytes();
    let mut i = 0;
    while i < raw.len()
        && (bytes[i].is_ascii_alphanumeric() || bytes[i] == b'_' || bytes[i] == b'-')
    {
        i += 1;
    }
    let tag = if i > 0 {
        Some(raw[..i].to_string())
    } else {
        None
    };

    let mut raw_arg: Option<String> = None;
    if i < raw.len()
        && bytes[i] == b'['
        && let Some(rel) = raw[i + 1..].find(']')
    {
        raw_arg = Some(raw[i + 1..i + 1 + rel].to_string());
        i = i + 1 + rel + 1;
    }

    if tag.as_deref() == Some("text")
        && let Some(ref arg) = raw_arg
        && !arg.is_empty()
    {
        return Err(err(format!(
            "Invalid selector: text nodes have no [args] ('{arg}' selects layout/inset/property identity). Select text by content (layout:contains('...')) or by tracked-change region (text:change(current|inserted|deleted))."
        )));
    }

    let arg_exact = raw_arg.as_ref().map(|a| parse_arg_exact(a));
    let pseudo_string = &raw[i..];
    let pseudos = parse_pseudo_classes(pseudo_string)?;

    if !pseudos.is_empty() && tag.is_none() && !allow_bare_pseudo {
        return Err(err(
            "Pseudo-classes must follow a tag. Use layout, inset, or property before pseudo-classes.",
        ));
    }

    Ok(SelectorPart {
        tag,
        arg_exact,
        pseudos,
        combinator: None,
    })
}

fn parse_arg_exact(raw_arg: &str) -> String {
    let bytes = raw_arg.as_bytes();
    let mut i = 0;
    while i < raw_arg.len()
        && (bytes[i].is_ascii_alphanumeric() || bytes[i] == b'_' || bytes[i] == b'-')
    {
        i += 1;
    }
    if i > 0 && i < raw_arg.len() && bytes[i] == b'=' {
        let mut rest = &raw_arg[i + 1..];
        if rest.starts_with(['\'', '"']) {
            rest = &rest[1..];
        }
        let mut val = rest;
        if val.ends_with(['\'', '"']) && !val.is_empty() {
            val = &val[..val.len() - 1];
        }
        if !val.contains(['\'', '"']) && !val.is_empty() {
            return val.to_string();
        }
    }
    let mut s = raw_arg;
    if s.starts_with(['\'', '"']) {
        s = &s[1..];
    }
    if s.ends_with(['\'', '"']) && !s.is_empty() {
        s = &s[..s.len() - 1];
    }
    if !s.contains(['\'', '"']) && !s.is_empty() {
        return s.to_string();
    }
    raw_arg.to_string()
}

fn split_respecting_delimiters(s: &str, sep: char) -> Vec<String> {
    let mut parts = Vec::new();
    let mut current = String::new();
    let mut paren_depth = 0i32;
    let mut in_bracket = false;
    let mut in_double_quote = false;
    let mut in_single_quote = false;
    for ch in s.chars() {
        if in_double_quote {
            current.push(ch);
            if ch == '"' {
                in_double_quote = false;
            }
        } else if in_single_quote {
            current.push(ch);
            if ch == '\'' {
                in_single_quote = false;
            }
        } else if ch == '"' {
            current.push(ch);
            in_double_quote = true;
        } else if ch == '\'' {
            current.push(ch);
            in_single_quote = true;
        } else if ch == '[' {
            current.push(ch);
            in_bracket = true;
        } else if ch == ']' {
            current.push(ch);
            in_bracket = false;
        } else if ch == '(' {
            current.push(ch);
            paren_depth += 1;
        } else if ch == ')' {
            current.push(ch);
            paren_depth -= 1;
        } else if ch == sep {
            if paren_depth == 0 && !in_bracket {
                if !current.is_empty() {
                    parts.push(std::mem::take(&mut current));
                }
            } else {
                current.push(ch);
            }
        } else {
            current.push(ch);
        }
    }
    if !current.is_empty() {
        parts.push(current);
    }
    parts
}

fn split_selector_by_whitespace(sel: &str) -> Vec<String> {
    let mut result = Vec::new();
    for part in split_respecting_delimiters(sel, ' ') {
        for sub in split_respecting_delimiters(&part, '\t') {
            for sub2 in split_respecting_delimiters(&sub, '\n') {
                if !sub2.is_empty() {
                    result.push(sub2);
                }
            }
        }
    }
    result
}

fn strip_quoted(sel: &str) -> String {
    let mut out = String::new();
    let mut chars = sel.chars();
    while let Some(ch) = chars.next() {
        if ch == '"' {
            for c in chars.by_ref() {
                if c == '"' {
                    break;
                }
            }
        } else if ch == '\'' {
            for c in chars.by_ref() {
                if c == '\'' {
                    break;
                }
            }
        } else {
            out.push(ch);
        }
    }
    out
}

pub fn parse_selector(selector: &str) -> Result<Selector, QueryError> {
    split_respecting_delimiters(selector, ',')
        .into_iter()
        .map(|sel| {
            let unquoted = strip_quoted(&sel);
            let opens = unquoted.chars().filter(|&c| c == '[').count();
            let closes = unquoted.chars().filter(|&c| c == ']').count();
            if opens != closes {
                return Err(err(format!("Unclosed bracket in selector part: {sel}")));
            }
            let tilde_groups = split_respecting_delimiters(sel.trim(), '~');
            let mut all_parts: Vec<SelectorPart> = Vec::new();
            for (gi, group) in tilde_groups.iter().enumerate() {
                let group_parts = split_selector_by_whitespace(group.trim());
                for (pi, part) in group_parts.iter().enumerate() {
                    let mut parsed = parse_selector_part(part, false)?;
                    if gi > 0 && pi == 0 {
                        parsed.combinator = Some(Combinator::Sibling);
                    }
                    all_parts.push(parsed);
                }
            }
            Ok(all_parts)
        })
        .collect()
}

fn unquote_once(s: &str) -> String {
    let t = s.trim();
    if t.len() >= 2
        && ((t.starts_with('"') && t.ends_with('"')) || (t.starts_with('\'') && t.ends_with('\'')))
    {
        t[1..t.len() - 1].to_string()
    } else {
        t.to_string()
    }
}

fn is_block(doc: &Document, id: NodeId) -> bool {
    matches!(doc.node(id).kind, NodeKind::Block { .. })
}

fn node_contains_text(doc: &Document, node: NodeId, search: &str, note_scope: bool) -> bool {
    match &doc.node(node).kind {
        NodeKind::Text { text } => text.contains(search),
        NodeKind::Block { .. } => {
            let opts = ConcatOpts {
                include_deleted: true,
                ..ConcatOpts::default()
            };
            let (_, full) = concatenate_text_nodes(doc, node, &opts);
            if full.contains(search) {
                return true;
            }
            for &child in &doc.node(node).children {
                if let NodeKind::Block { tag, args, .. } = &doc.node(child).kind {
                    if !note_scope && is_invisible_inset(tag, args.as_deref()) {
                        continue;
                    }
                    if node_contains_text(doc, child, search, note_scope) {
                        return true;
                    }
                }
            }
            false
        }
        _ => false,
    }
}

pub fn build_traversal_state_index(
    doc: &Document,
    root: NodeId,
) -> HashMap<NodeId, TraversalState> {
    let mut index = HashMap::new();
    fn walk(
        doc: &Document,
        list: &[NodeId],
        inherited: &TraversalState,
        collect_text: bool,
        index: &mut HashMap<NodeId, TraversalState>,
    ) {
        let mut state = enter_traversal_state(inherited);
        for &node in list {
            if !matches!(doc.node(node).kind, NodeKind::Text { .. }) || collect_text {
                index.insert(node, clone_traversal_state(&state));
            }
            if let NodeKind::Block { tag, .. } = &doc.node(node).kind {
                let child_collect = if tag == "layout" {
                    true
                } else if tag == "inset" {
                    false
                } else {
                    collect_text
                };
                let children = doc.node(node).children.clone();
                walk(doc, &children, &state, child_collect, index);
            }
            if let NodeKind::Property { key, value } = &doc.node(node).kind {
                crate::text_utils::advance_traversal_state(&mut state, key, value.as_deref());
            }
        }
    }
    let children = doc.node(root).children.clone();
    walk(doc, &children, &create_traversal_state(), false, &mut index);
    index
}

const INACTIVE_PROPERTY_VALUES: &[&str] = &["default", "off", "no", "inherit"];

struct PropertyArg {
    key: String,
    value: Option<String>,
}

fn parse_property_arg(raw: &str) -> Result<PropertyArg, QueryError> {
    let arg = unquote_once(raw);
    let (key_raw, value) = arg.find('=').map_or_else(
        || (arg.trim().to_string(), None),
        |i| {
            (
                arg[..i].trim().to_string(),
                Some(arg[i + 1..].trim().to_string()),
            )
        },
    );
    if key_raw.is_empty() {
        return Err(err(
            ":property() requires a key, e.g. :property(emph) or :property(family=roman)",
        ));
    }
    if !is_inline_style_key(&key_raw) {
        let valid = INLINE_PROPERTIES
            .iter()
            .copied()
            .filter(|k| is_inline_style_key(k))
            .collect::<Vec<_>>()
            .join(", ");
        return Err(err(format!(
            "Invalid :property() key: '{key_raw}'. Valid inline style keys are: {valid}. Tracked-change regions are selected with :change(current|inserted|deleted)."
        )));
    }
    Ok(PropertyArg {
        key: key_raw,
        value,
    })
}

fn matches_property(active: Option<&str>, prop: &PropertyArg) -> bool {
    let Some(a) = active else {
        return false;
    };
    let a = a.to_lowercase();
    if let Some(ref want) = prop.value {
        return a == want.to_lowercase();
    }
    !INACTIVE_PROPERTY_VALUES.contains(&a.as_str())
}

pub fn property_state_at(
    doc: &Document,
    parent: NodeId,
    index: usize,
) -> HashMap<String, Option<String>> {
    let mut state = HashMap::new();
    let children = &doc.node(parent).children;
    for &id in children.iter().take(index) {
        if let NodeKind::Property { key, value } = &doc.node(id).kind
            && is_inline_style_key(key)
        {
            state.insert(key.clone(), value.clone());
        }
    }
    state
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ScopeState {
    Current,
    Inserted,
    Deleted,
}

impl ScopeState {
    fn as_region(self) -> TextRegion {
        match self {
            Self::Current => TextRegion::Current,
            Self::Inserted => TextRegion::Inserted,
            Self::Deleted => TextRegion::Deleted,
        }
    }
}

pub fn parse_change_arg(raw: &str) -> Result<ScopeState, QueryError> {
    let want = unquote_once(raw);
    match want.as_str() {
        "current" => Ok(ScopeState::Current),
        "inserted" => Ok(ScopeState::Inserted),
        "deleted" => Ok(ScopeState::Deleted),
        _ => Err(err(format!(
            "Invalid :change() argument: {want}. Expected current, inserted, or deleted."
        ))),
    }
}

fn js_parse_int(s: &str) -> Option<i32> {
    let s = s.trim_start();
    if s.is_empty() {
        return None;
    }
    let bytes = s.as_bytes();
    let mut i = 0;
    let mut neg = false;
    if bytes[0] == b'+' {
        i = 1;
    } else if bytes[0] == b'-' {
        neg = true;
        i = 1;
    }
    if i >= bytes.len() || !bytes[i].is_ascii_digit() {
        return None;
    }
    let start = i;
    while i < bytes.len() && bytes[i].is_ascii_digit() {
        i += 1;
    }
    let n: i32 = s[start..i].parse().ok()?;
    Some(if neg { -n } else { n })
}

fn parse_nth_match_formula(raw: &str) -> Option<(i32, i32)> {
    let mut formula = raw.to_string();
    if formula == "odd" {
        formula = "2n+1".into();
    }
    if formula == "even" {
        formula = "2n".into();
    }
    let compact: String = formula.chars().filter(|c| !c.is_whitespace()).collect();
    if compact.is_empty() {
        return None;
    }
    if !formula.contains('n')
        && let Some(num) = js_parse_int(&formula)
    {
        return Some((0, num));
    }
    parse_an_plus_b(&compact)
}

fn parse_an_plus_b(s: &str) -> Option<(i32, i32)> {
    // /^(?:([-+]?\d*)n)?([-+]\d+)?$/
    let n_pos = s.find('n')?;
    let a_raw = &s[..n_pos];
    let a = if a_raw == "-" || a_raw == "+" {
        if a_raw == "-" { -1 } else { 1 }
    } else if a_raw.is_empty() {
        1
    } else {
        if a_raw
            .as_bytes()
            .iter()
            .any(|c| !c.is_ascii_digit() && *c != b'+' && *c != b'-')
        {
            return None;
        }
        js_parse_int(a_raw)?
    };
    let rest = &s[n_pos + 1..];
    let b = if rest.is_empty() {
        0
    } else {
        if rest.len() < 2 {
            return None;
        }
        let sign = rest.as_bytes()[0];
        if sign != b'+' && sign != b'-' {
            return None;
        }
        let digits = &rest[1..];
        if digits.is_empty() || !digits.bytes().all(|c| c.is_ascii_digit()) {
            return None;
        }
        js_parse_int(rest)?
    };
    Some((a, b))
}

pub fn is_valid_nth_match_formula(raw: &str) -> bool {
    parse_nth_match_formula(raw).is_some()
}

enum StatePred {
    Change(ScopeState),
    Property(PropertyArg),
}

pub struct ScopePredicate {
    groups: Vec<Vec<StatePred>>,
}

impl ScopePredicate {
    pub fn matches(&self, region: ScopeState, props: &HashMap<String, Option<String>>) -> bool {
        self.groups.iter().any(|g| {
            g.iter().all(|p| match p {
                StatePred::Change(want) => region == *want,
                StatePred::Property(prop) => {
                    let active = props.get(&prop.key).and_then(|v| v.as_deref());
                    matches_property(active, prop)
                }
            })
        })
    }
}

pub fn build_scope_predicate(selector_str: &str) -> Result<Option<ScopePredicate>, QueryError> {
    let groups = parse_selector(selector_str)?;
    let mut group_preds: Vec<Vec<StatePred>> = Vec::new();
    let mut has_state = false;
    for group in groups {
        let mut part_preds = Vec::new();
        for part in group {
            for p in part.pseudos {
                if p.name == PseudoName::Change
                    && let Some(ref arg) = p.arg_raw
                {
                    has_state = true;
                    part_preds.push(StatePred::Change(parse_change_arg(arg)?));
                } else if p.name == PseudoName::Property
                    && let Some(ref arg) = p.arg_raw
                {
                    has_state = true;
                    part_preds.push(StatePred::Property(parse_property_arg(arg)?));
                }
            }
        }
        group_preds.push(part_preds);
    }
    if !has_state {
        return Ok(None);
    }
    Ok(Some(ScopePredicate {
        groups: group_preds,
    }))
}

pub fn selector_note_scope(selector_str: &str) -> Result<bool, QueryError> {
    let groups = parse_selector(selector_str)?;
    Ok(groups.iter().any(|group| {
        group.iter().any(|part| {
            part.pseudos.iter().any(|p| p.name == PseudoName::Note)
                || (part.tag.as_deref() == Some("inset")
                    && part
                        .arg_exact
                        .as_deref()
                        .is_some_and(|a| a.trim().split(' ').next() == Some("Note")))
        })
    }))
}

fn group_note_scope(group: &[SelectorPart]) -> bool {
    group.iter().any(|part| {
        part.pseudos.iter().any(|p| p.name == PseudoName::Note)
            || (part.tag.as_deref() == Some("inset")
                && part
                    .arg_exact
                    .as_deref()
                    .is_some_and(|a| a.trim().split(' ').next() == Some("Note")))
    })
}

fn build_inside_note_map(doc: &Document, root: NodeId) -> HashMap<NodeId, Option<String>> {
    let mut map = HashMap::new();
    fn walk(
        doc: &Document,
        children: &[NodeId],
        inside: Option<&str>,
        map: &mut HashMap<NodeId, Option<String>>,
    ) {
        for &c in children {
            map.insert(c, inside.map(str::to_string));
            if let NodeKind::Block { tag, args, .. } = &doc.node(c).kind {
                let next = invisible_inset_type(tag, args.as_deref()).or(inside);
                let kids = doc.node(c).children.clone();
                walk(doc, &kids, next, map);
            }
        }
    }
    let children = doc.node(root).children.clone();
    walk(doc, &children, None, &mut map);
    map
}

fn prop_from_state<'a>(state: &'a TraversalState, key: &str) -> Option<&'a str> {
    state.properties.get(key).and_then(|v| v.as_deref())
}

fn block_contains_property(
    doc: &Document,
    node: NodeId,
    prop: &PropertyArg,
    state_index: &HashMap<NodeId, TraversalState>,
) -> bool {
    fn walk(
        doc: &Document,
        list: &[NodeId],
        prop: &PropertyArg,
        state_index: &HashMap<NodeId, TraversalState>,
    ) -> bool {
        for &c in list {
            match &doc.node(c).kind {
                NodeKind::Text { .. } => {
                    if let Some(state) = state_index.get(&c)
                        && matches_property(prop_from_state(state, &prop.key), prop)
                    {
                        return true;
                    }
                }
                NodeKind::Block { .. } if walk(doc, &doc.node(c).children, prop, state_index) => {
                    return true;
                }
                _ => {}
            }
        }
        false
    }
    walk(doc, &doc.node(node).children, prop, state_index)
}

fn block_contains_region(
    doc: &Document,
    node: NodeId,
    want: TextRegion,
    state_index: &HashMap<NodeId, TraversalState>,
) -> bool {
    fn walk(
        doc: &Document,
        list: &[NodeId],
        want: TextRegion,
        state_index: &HashMap<NodeId, TraversalState>,
    ) -> bool {
        for &c in list {
            match &doc.node(c).kind {
                NodeKind::Text { .. } => {
                    if let Some(state) = state_index.get(&c)
                        && traversal_region(state) == want
                    {
                        return true;
                    }
                }
                NodeKind::Block { .. } if walk(doc, &doc.node(c).children, want, state_index) => {
                    return true;
                }
                _ => {}
            }
        }
        false
    }
    walk(doc, &doc.node(node).children, want, state_index)
}

fn region_of(state: &TraversalState) -> TextRegion {
    traversal_region(state)
}

#[allow(clippy::too_many_arguments)] // Deno matchNode extras (indexes + note scope)
fn match_node(
    doc: &Document,
    node: NodeId,
    part: &SelectorPart,
    region: TextRegion,
    prop_state: &HashMap<String, Option<String>>,
    state_index: &HashMap<NodeId, TraversalState>,
    inside_note_index: &HashMap<NodeId, Option<String>>,
    note_scope: bool,
) -> Result<bool, QueryError> {
    match &doc.node(node).kind {
        NodeKind::Property { key, .. } if part.tag.as_deref() == Some("property") => {
            if let Some(ref want) = part.arg_exact
                && key != want
            {
                return Ok(false);
            }
        }
        _ if part.tag.as_deref() == Some("property") => return Ok(false),
        kind => {
            let node_tag = match kind {
                NodeKind::Block { tag, .. } => tag.as_str(),
                NodeKind::Property { key, .. } => key.as_str(),
                NodeKind::Text { .. } => "text",
                NodeKind::Document => "",
            };
            if let Some(ref tag) = part.tag
                && node_tag != tag
            {
                return Ok(false);
            }
            if let Some(ref want) = part.arg_exact
                && let NodeKind::Block { args, .. } = kind
            {
                let Some(args) = args else {
                    return Ok(false);
                };
                let trimmed = args.trim();
                let node_arg_name = trimmed.split(' ').next().unwrap_or("");
                if trimmed != want && node_arg_name != want {
                    return Ok(false);
                }
            }
        }
    }

    if part.tag.as_deref() == Some("text") && matches!(doc.node(node).kind, NodeKind::Text { .. }) {
        let has_state = part
            .pseudos
            .iter()
            .any(|p| p.name == PseudoName::Change || p.name == PseudoName::Property);
        if !has_state {
            let has_note = part.pseudos.iter().any(|p| p.name == PseudoName::Note);
            if !has_note {
                let inside = inside_note_index
                    .get(&node)
                    .and_then(|v| v.as_ref())
                    .is_some();
                if inside && !note_scope {
                    return Ok(false);
                }
            }
        }
    }

    for p in &part.pseudos {
        if p.name == PseudoName::Contains
            && let Some(ref arg) = p.arg_raw
        {
            let val = unquote_once(arg);
            if val.is_empty() {
                return Err(err("Empty string not allowed in :contains()"));
            }
            match &doc.node(node).kind {
                NodeKind::Text { .. } => return Ok(false),
                NodeKind::Block { .. } => {
                    if !note_scope {
                        let has_note = part.pseudos.iter().any(|pp| pp.name == PseudoName::Note);
                        let inside = inside_note_index
                            .get(&node)
                            .and_then(|v| v.as_ref())
                            .is_some();
                        if !has_note && inside {
                            return Ok(false);
                        }
                    }
                    if !node_contains_text(doc, node, &val, note_scope) {
                        return Ok(false);
                    }
                }
                _ => return Ok(false),
            }
        }

        if p.name == PseudoName::Not
            && let Some(ref arg) = p.arg_raw
        {
            let inner = parse_selector_part(arg, true)?;
            if is_block(doc, node) {
                let matches = find_descendants(
                    doc,
                    &doc.node(node).children.clone(),
                    &inner,
                    state_index,
                    inside_note_index,
                    note_scope,
                )?;
                if !matches.is_empty() {
                    return Ok(false);
                }
                let has_contains = inner
                    .pseudos
                    .iter()
                    .any(|pp| pp.name == PseudoName::Contains);
                if has_contains
                    && match_node(
                        doc,
                        node,
                        &inner,
                        region,
                        prop_state,
                        state_index,
                        inside_note_index,
                        note_scope,
                    )?
                {
                    return Ok(false);
                }
            }
        }

        if p.name == PseudoName::Change
            && let Some(ref arg) = p.arg_raw
        {
            let want = parse_change_arg(arg)?.as_region();
            match &doc.node(node).kind {
                NodeKind::Text { .. } => {
                    if region != want {
                        return Ok(false);
                    }
                }
                NodeKind::Block { .. } => {
                    let sits = region == want;
                    if !sits && !block_contains_region(doc, node, want, state_index) {
                        return Ok(false);
                    }
                }
                _ => return Ok(false),
            }
        }

        if p.name == PseudoName::Property
            && let Some(ref arg) = p.arg_raw
        {
            let prop = parse_property_arg(arg)?;
            match &doc.node(node).kind {
                NodeKind::Text { .. } => {
                    let active = prop_state.get(&prop.key).and_then(|v| v.as_deref());
                    if !matches_property(active, &prop) {
                        return Ok(false);
                    }
                }
                NodeKind::Block { .. } => {
                    let sits = matches_property(
                        prop_state.get(&prop.key).and_then(|v| v.as_deref()),
                        &prop,
                    );
                    if !sits && !block_contains_property(doc, node, &prop, state_index) {
                        return Ok(false);
                    }
                }
                _ => return Ok(false),
            }
        }

        if p.name == PseudoName::Note {
            let note_type = if let NodeKind::Block { tag, args, .. } = &doc.node(node).kind {
                invisible_inset_type(tag, args.as_deref())
                    .map(str::to_string)
                    .or_else(|| inside_note_index.get(&node).and_then(Option::clone))
            } else {
                inside_note_index.get(&node).and_then(Option::clone)
            };
            let Some(note_type) = note_type else {
                return Ok(false);
            };
            if let Some(ref arg) = p.arg_raw {
                let want = unquote_once(arg);
                if note_type != want {
                    return Ok(false);
                }
            }
        }
    }

    Ok(true)
}

fn find_descendants(
    doc: &Document,
    nodes: &[NodeId],
    part: &SelectorPart,
    state_index: &HashMap<NodeId, TraversalState>,
    inside_note_index: &HashMap<NodeId, Option<String>>,
    note_scope: bool,
) -> Result<Vec<NodeId>, QueryError> {
    let mut results = Vec::new();
    find_descendants_into(
        doc,
        nodes,
        part,
        &mut results,
        state_index,
        inside_note_index,
        note_scope,
    )?;
    Ok(results)
}

fn find_descendants_into(
    doc: &Document,
    nodes: &[NodeId],
    part: &SelectorPart,
    results: &mut Vec<NodeId>,
    state_index: &HashMap<NodeId, TraversalState>,
    inside_note_index: &HashMap<NodeId, Option<String>>,
    note_scope: bool,
) -> Result<(), QueryError> {
    for &node in nodes {
        let default_state = create_traversal_state();
        let state = state_index.get(&node).unwrap_or(&default_state);
        if matches!(doc.node(node).kind, NodeKind::Text { .. })
            && !state_index.contains_key(&node)
            && part
                .pseudos
                .iter()
                .any(|p| p.name == PseudoName::Change || p.name == PseudoName::Property)
        {
            continue;
        }
        if match_node(
            doc,
            node,
            part,
            region_of(state),
            &state.properties,
            state_index,
            inside_note_index,
            note_scope,
        )? {
            results.push(node);
        }
        if is_block(doc, node) {
            let children = doc.node(node).children.clone();
            find_descendants_into(
                doc,
                &children,
                part,
                results,
                state_index,
                inside_note_index,
                note_scope,
            )?;
        }
    }
    Ok(())
}

#[derive(Clone, Copy)]
struct SiblingCtx {
    parent: NodeId,
    index: usize,
}

fn get_sibling_context(doc: &Document, node: NodeId, parent: NodeId) -> Option<SiblingCtx> {
    let children = doc.node(parent).children.clone();
    for (i, &c) in children.iter().enumerate() {
        if c == node {
            return Some(SiblingCtx { parent, index: i });
        }
        if is_block(doc, c)
            && let Some(r) = get_sibling_context(doc, node, c)
        {
            return Some(r);
        }
    }
    None
}

fn get_sibling_context_fast(
    doc: &Document,
    node: NodeId,
    root: NodeId,
    parent_index: Option<&HashMap<NodeId, SiblingCtx>>,
) -> Option<SiblingCtx> {
    if let Some(idx) = parent_index {
        return idx.get(&node).copied();
    }
    get_sibling_context(doc, node, root)
}

fn build_parent_index(doc: &Document, root: NodeId) -> HashMap<NodeId, SiblingCtx> {
    let mut map = HashMap::new();
    fn walk(doc: &Document, parent: NodeId, map: &mut HashMap<NodeId, SiblingCtx>) {
        let children = doc.node(parent).children.clone();
        for (i, &n) in children.iter().enumerate() {
            map.insert(n, SiblingCtx { parent, index: i });
            if is_block(doc, n) {
                walk(doc, n, map);
            }
        }
    }
    walk(doc, root, &mut map);
    map
}

fn build_parent_map(doc: &Document, root: NodeId) -> HashMap<NodeId, Option<NodeId>> {
    let mut map = HashMap::new();
    fn walk(
        doc: &Document,
        children: &[NodeId],
        parent: Option<NodeId>,
        map: &mut HashMap<NodeId, Option<NodeId>>,
    ) {
        for &n in children {
            map.insert(n, parent);
            if is_block(doc, n) {
                let kids = doc.node(n).children.clone();
                walk(doc, &kids, Some(n), map);
            }
        }
    }
    let children = doc.node(root).children.clone();
    walk(doc, &children, None, &mut map);
    map
}

#[allow(clippy::too_many_arguments)] // Deno :adjacent previous-sibling scan
fn adjacent_matches(
    doc: &Document,
    n: NodeId,
    root: NodeId,
    inner: &SelectorPart,
    parent_index: Option<&HashMap<NodeId, SiblingCtx>>,
    state_index: &HashMap<NodeId, TraversalState>,
    inside_note_index: &HashMap<NodeId, Option<String>>,
    note_scope: bool,
    default_state: &TraversalState,
) -> Result<bool, QueryError> {
    let Some(ctx) = get_sibling_context_fast(doc, n, root, parent_index) else {
        return Ok(false);
    };
    if ctx.index == 0 {
        return Ok(false);
    }
    let siblings = &doc.node(ctx.parent).children;
    for si in (0..ctx.index).rev() {
        let prev = siblings[si];
        match &doc.node(prev).kind {
            NodeKind::Text { .. } | NodeKind::Property { .. } => {}
            _ => {
                let state = state_index.get(&prev).unwrap_or(default_state);
                return match_node(
                    doc,
                    prev,
                    inner,
                    region_of(state),
                    &state.properties,
                    state_index,
                    inside_note_index,
                    note_scope,
                );
            }
        }
    }
    Ok(false)
}

#[allow(clippy::too_many_arguments)] // Deno findFollowingSiblings extras
fn find_following_siblings(
    doc: &Document,
    anchor: NodeId,
    root: NodeId,
    part: &SelectorPart,
    parent_index: Option<&HashMap<NodeId, SiblingCtx>>,
    state_index: &HashMap<NodeId, TraversalState>,
    inside_note_index: &HashMap<NodeId, Option<String>>,
    note_scope: bool,
) -> Result<Vec<NodeId>, QueryError> {
    let Some(ctx) = get_sibling_context_fast(doc, anchor, root, parent_index) else {
        return Ok(Vec::new());
    };
    let mut results = Vec::new();
    let siblings = doc.node(ctx.parent).children.clone();
    let default_state = create_traversal_state();
    for &sibling in siblings.iter().skip(ctx.index + 1) {
        let state = state_index.get(&sibling).unwrap_or(&default_state);
        if match_node(
            doc,
            sibling,
            part,
            region_of(state),
            &state.properties,
            state_index,
            inside_note_index,
            note_scope,
        )? {
            results.push(sibling);
        }
        if is_block(doc, sibling) {
            let children = doc.node(sibling).children.clone();
            find_descendants_into(
                doc,
                &children,
                part,
                &mut results,
                state_index,
                inside_note_index,
                note_scope,
            )?;
        }
    }
    Ok(results)
}

#[derive(Clone, Copy)]
enum SpanHit {
    Match,
    Miss,
    Reached,
}

fn subtree_has_match_before_or_at(
    doc: &Document,
    block: NodeId,
    target: NodeId,
    inner: &SelectorPart,
    state_index: &HashMap<NodeId, TraversalState>,
    inside_note_index: &HashMap<NodeId, Option<String>>,
    note_scope: bool,
) -> Result<SpanHit, QueryError> {
    let default_state = create_traversal_state();
    for &child in &doc.node(block).children.clone() {
        if child == target {
            let state = state_index.get(&child).unwrap_or(&default_state);
            return if match_node(
                doc,
                child,
                inner,
                region_of(state),
                &state.properties,
                state_index,
                inside_note_index,
                note_scope,
            )? {
                Ok(SpanHit::Match)
            } else {
                Ok(SpanHit::Reached)
            };
        }
        let state = state_index.get(&child).unwrap_or(&default_state);
        if match_node(
            doc,
            child,
            inner,
            region_of(state),
            &state.properties,
            state_index,
            inside_note_index,
            note_scope,
        )? {
            return Ok(SpanHit::Match);
        }
        if is_block(doc, child) {
            let sub = subtree_has_match_before_or_at(
                doc,
                child,
                target,
                inner,
                state_index,
                inside_note_index,
                note_scope,
            )?;
            if !matches!(sub, SpanHit::Miss) {
                return Ok(sub);
            }
        }
    }
    Ok(SpanHit::Miss)
}

struct AnchorEntry {
    index: usize,
    first_boundary: usize,
}

pub fn query(doc: &Document, selector_str: &str) -> Result<Vec<NodeId>, QueryError> {
    let groups = parse_selector(selector_str)?;
    let root = doc.root();
    let root_children = doc.node(root).children.clone();
    let state_index = build_traversal_state_index(doc, root);
    let inside_note_index = build_inside_note_map(doc, root);

    let needs_index = groups.iter().any(|g| {
        g.iter().any(|p| {
            p.combinator == Some(Combinator::Sibling)
                || p.pseudos
                    .iter()
                    .any(|ps| ps.name == PseudoName::Adjacent || ps.name == PseudoName::Until)
        })
    });
    let parent_index = if needs_index {
        Some(build_parent_index(doc, root))
    } else {
        None
    };
    let parent_map = if groups.iter().any(|g| {
        g.iter()
            .any(|p| p.pseudos.iter().any(|ps| ps.name == PseudoName::Until))
    }) {
        Some(build_parent_map(doc, root))
    } else {
        None
    };

    let mut final_results: Vec<NodeId> = Vec::new();
    let mut seen: HashSet<NodeId> = HashSet::new();

    for group in &groups {
        let mut current_nodes: Vec<NodeId> = root_children.clone();
        let mut sibling_anchors: Vec<NodeId> = Vec::new();
        let note_scope = group_note_scope(group);

        for (i, part) in group.iter().enumerate() {
            let mut next_nodes: Vec<NodeId> = Vec::new();

            if part.combinator == Some(Combinator::Sibling) {
                for &cn in &current_nodes {
                    next_nodes.extend(find_following_siblings(
                        doc,
                        cn,
                        root,
                        part,
                        parent_index.as_ref(),
                        &state_index,
                        &inside_note_index,
                        note_scope,
                    )?);
                }
                sibling_anchors.clone_from(&current_nodes);
            } else if i == 0 {
                next_nodes = find_descendants(
                    doc,
                    &current_nodes,
                    part,
                    &state_index,
                    &inside_note_index,
                    note_scope,
                )?;
            } else {
                for &cn in &current_nodes {
                    if is_block(doc, cn) {
                        next_nodes.extend(find_descendants(
                            doc,
                            &doc.node(cn).children.clone(),
                            part,
                            &state_index,
                            &inside_note_index,
                            note_scope,
                        )?);
                    }
                }
            }

            for p in &part.pseudos {
                if p.name == PseudoName::First && !next_nodes.is_empty() {
                    next_nodes = vec![next_nodes[0]];
                } else if p.name == PseudoName::Last && !next_nodes.is_empty() {
                    let last = next_nodes[next_nodes.len() - 1];
                    next_nodes = vec![last];
                } else if p.name == PseudoName::NthMatch
                    && let Some(ref arg) = p.arg_raw
                {
                    if let Some((a, b)) = parse_nth_match_formula(arg) {
                        next_nodes = next_nodes
                            .into_iter()
                            .enumerate()
                            .filter(|(idx, _)| {
                                let n = (*idx as i32) + 1;
                                if a == 0 {
                                    n == b
                                } else {
                                    (n - b) % a == 0 && (n - b) as f64 / a as f64 >= 0.0
                                }
                            })
                            .map(|(_, id)| id)
                            .collect();
                    } else {
                        next_nodes.clear();
                    }
                } else if p.name == PseudoName::Adjacent
                    && let Some(ref arg) = p.arg_raw
                {
                    let inner = parse_selector_part(arg, true)?;
                    let default_state = create_traversal_state();
                    let mut kept = Vec::new();
                    for &n in &next_nodes {
                        if adjacent_matches(
                            doc,
                            n,
                            root,
                            &inner,
                            parent_index.as_ref(),
                            &state_index,
                            &inside_note_index,
                            note_scope,
                            &default_state,
                        )? {
                            kept.push(n);
                        }
                    }
                    next_nodes = kept;
                } else if p.name == PseudoName::Until
                    && let Some(ref arg) = p.arg_raw
                {
                    let inner = parse_selector_part(arg, true)?;
                    if !sibling_anchors.is_empty()
                        && let Some(ref pmap) = parent_map
                    {
                        let mut anchor_groups: HashMap<NodeId, Vec<AnchorEntry>> = HashMap::new();
                        for &anchor in &sibling_anchors {
                            if let Some(a_ctx) =
                                get_sibling_context_fast(doc, anchor, root, parent_index.as_ref())
                            {
                                anchor_groups
                                    .entry(a_ctx.parent)
                                    .or_default()
                                    .push(AnchorEntry {
                                        index: a_ctx.index,
                                        first_boundary: usize::MAX,
                                    });
                            }
                        }
                        for list in anchor_groups.values_mut() {
                            list.sort_by_key(|e| e.index);
                        }
                        let default_state = create_traversal_state();
                        for (parent, list) in anchor_groups.iter_mut() {
                            let pc = doc.node(*parent).children.clone();
                            let mut is_b = vec![false; pc.len()];
                            for (ii, &sib) in pc.iter().enumerate() {
                                let st = state_index.get(&sib).unwrap_or(&default_state);
                                if match_node(
                                    doc,
                                    sib,
                                    &inner,
                                    region_of(st),
                                    &st.properties,
                                    &state_index,
                                    &inside_note_index,
                                    note_scope,
                                )? {
                                    is_b[ii] = true;
                                    continue;
                                }
                                if is_block(doc, sib)
                                    && !find_descendants(
                                        doc,
                                        &doc.node(sib).children.clone(),
                                        &inner,
                                        &state_index,
                                        &inside_note_index,
                                        note_scope,
                                    )?
                                    .is_empty()
                                {
                                    is_b[ii] = true;
                                }
                            }
                            let mut next_b = usize::MAX;
                            for i in (0..pc.len()).rev() {
                                if let Some(entry) = list.iter_mut().find(|e| e.index == i) {
                                    entry.first_boundary = next_b;
                                }
                                if is_b[i] {
                                    next_b = i;
                                }
                            }
                        }
                        let mut kept = Vec::new();
                        for &n in &next_nodes {
                            if until_keep(
                                doc,
                                n,
                                root,
                                &inner,
                                &anchor_groups,
                                pmap,
                                parent_index.as_ref(),
                                &state_index,
                                &inside_note_index,
                                note_scope,
                            )? {
                                kept.push(n);
                            }
                        }
                        next_nodes = kept;
                    }
                }
            }

            current_nodes = next_nodes;
            if current_nodes.is_empty() {
                break;
            }
        }

        for node in current_nodes {
            if seen.insert(node) {
                final_results.push(node);
            }
        }
    }

    Ok(final_results)
}

#[allow(clippy::too_many_arguments)] // Deno :until nearest-anchor walk
fn until_keep(
    doc: &Document,
    n: NodeId,
    root: NodeId,
    inner: &SelectorPart,
    anchor_groups: &HashMap<NodeId, Vec<AnchorEntry>>,
    parent_map: &HashMap<NodeId, Option<NodeId>>,
    parent_index: Option<&HashMap<NodeId, SiblingCtx>>,
    state_index: &HashMap<NodeId, TraversalState>,
    inside_note_index: &HashMap<NodeId, Option<String>>,
    note_scope: bool,
) -> Result<bool, QueryError> {
    let mut cur = n;
    let default_state = create_traversal_state();
    loop {
        let parent = parent_map.get(&cur).copied().flatten();
        let Some(parent) = parent else {
            break;
        };
        if let Some(list) = anchor_groups.get(&parent)
            && let Some(cur_ctx) = get_sibling_context_fast(doc, cur, root, parent_index)
        {
            let mut lo = 0isize;
            let mut hi = list.len() as isize - 1;
            let mut best = -1isize;
            while lo <= hi {
                let mid = (lo + hi) >> 1;
                if list[mid as usize].index < cur_ctx.index {
                    best = mid;
                    lo = mid + 1;
                } else {
                    hi = mid - 1;
                }
            }
            if best != -1 {
                let entry = &list[best as usize];
                if entry.first_boundary < cur_ctx.index {
                    return Ok(false);
                }
                let c_state = state_index.get(&cur).unwrap_or(&default_state);
                if match_node(
                    doc,
                    cur,
                    inner,
                    region_of(c_state),
                    &c_state.properties,
                    state_index,
                    inside_note_index,
                    note_scope,
                )? {
                    return Ok(false);
                }
                if cur != n
                    && matches!(
                        subtree_has_match_before_or_at(
                            doc,
                            cur,
                            n,
                            inner,
                            state_index,
                            inside_note_index,
                            note_scope,
                        )?,
                        SpanHit::Match
                    )
                {
                    return Ok(false);
                }
                return Ok(true);
            }
        }
        cur = parent;
    }
    Ok(true)
}
