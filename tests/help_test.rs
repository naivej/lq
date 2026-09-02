//! Help catalog and renderer (Deno `tests/help_test.ts`).

use lq::{
    HELP_PAGES, HelpPage, PageGroup, RichMode, alias_of, find_by_alias, find_by_reach, find_page,
    group_of, grouped_pages, reach_of, render_page_rich, render_page_text, render_page_tty,
};

const EXPECTED_IDS: &[&str] = &[
    "home",
    "model/cst",
    "model/guarantees",
    "concepts/state-scope",
    "concepts/private-notes",
    "concepts/insets",
    "concepts/selectors",
    "concepts/mutations",
    "concepts/tracked-changes",
    "commands/init",
    "commands/schema",
    "commands/dump",
    "commands/preview",
    "commands/read",
    "commands/bib",
    "commands/set",
    "commands/delete",
    "commands/insert",
    "commands/undo",
];

fn strip_ansi(s: &str) -> String {
    let mut out = String::new();
    let mut rest = s;
    while let Some(idx) = rest.find('\u{1b}') {
        out.push_str(&rest[..idx]);
        rest = &rest[idx + 1..];
        if rest.starts_with('[')
            && let Some(end) = rest.find('m')
        {
            rest = &rest[end + 1..];
            continue;
        }
        out.push('\u{1b}');
    }
    out.push_str(rest);
    out
}

#[test]
fn page_map_matches_the_draft() {
    let mut ids: Vec<&str> = HELP_PAGES.iter().map(|p| p.id).collect();
    ids.sort_unstable();
    let mut expected = EXPECTED_IDS.to_vec();
    expected.sort_unstable();
    assert_eq!(ids, expected);
}

#[test]
fn page_ids_are_unique() {
    let ids: Vec<&str> = HELP_PAGES.iter().map(|p| p.id).collect();
    let mut uniq = ids.clone();
    uniq.sort_unstable();
    uniq.dedup();
    assert_eq!(uniq.len(), ids.len());
}

#[test]
fn reaches_are_unique() {
    let reaches: Vec<&str> = HELP_PAGES.iter().map(|p| reach_of(p.id)).collect();
    let mut uniq = reaches.clone();
    uniq.sort_unstable();
    uniq.dedup();
    assert_eq!(uniq.len(), reaches.len());
}

#[test]
fn command_aliases_are_unique_and_only_on_command_pages() {
    let aliases: Vec<&str> = HELP_PAGES.iter().filter_map(|p| alias_of(p.id)).collect();
    let mut uniq = aliases.clone();
    uniq.sort_unstable();
    uniq.dedup();
    assert_eq!(uniq.len(), aliases.len());
    assert_eq!(aliases.len(), 10);
}

#[test]
fn preview_help_lists_utf8_warning_classes() {
    let page = find_page("commands/preview").expect("preview page");
    let output = page
        .sections
        .iter()
        .find(|s| s.heading == "Output")
        .expect("Output")
        .body;
    assert!(output.contains("warnings"), "{output}");
    assert!(output.contains("UTF-8"), "{output}");
    assert!(output.contains("include"), "{output}");
}

#[test]
fn every_page_has_a_non_empty_title() {
    for p in HELP_PAGES {
        assert!(!p.title.is_empty(), "{}", p.id);
    }
}

#[test]
fn group_reach_alias_derived_from_id() {
    assert_eq!(reach_of("commands/read"), "read");
    assert_eq!(reach_of("model/cst"), "cst");
    assert_eq!(reach_of("home"), "home");
    assert_eq!(group_of("commands/read"), Some(PageGroup::Commands));
    assert_eq!(group_of("concepts/insets"), Some(PageGroup::Concepts));
    assert_eq!(group_of("model/guarantees"), Some(PageGroup::Model));
    assert_eq!(group_of("home"), None);
    assert_eq!(alias_of("commands/read"), Some("read"));
    assert_eq!(alias_of("model/cst"), None);
    assert_eq!(alias_of("home"), None);
}

#[test]
fn lookups_resolve() {
    assert_eq!(find_by_reach("read").map(|p| p.id), Some("commands/read"));
    assert_eq!(find_by_reach("cst").map(|p| p.id), Some("model/cst"));
    assert_eq!(find_by_alias("read").map(|p| p.id), Some("commands/read"));
    assert!(find_by_alias("cst").is_none());
    assert_eq!(
        find_page("concepts/selectors").map(|p| p.id),
        Some("concepts/selectors")
    );
    assert_eq!(find_page("home").map(|p| p.id), Some("home"));
    assert!(find_by_reach("nope").is_none());
    assert!(find_by_alias("nope").is_none());
    assert!(find_page("nope/nope").is_none());
}

#[test]
fn grouped_map_covers_non_home() {
    let grouped = grouped_pages();
    let groups: Vec<PageGroup> = grouped.iter().map(|g| g.group).collect();
    assert_eq!(
        groups,
        vec![PageGroup::Model, PageGroup::Concepts, PageGroup::Commands]
    );
    let total: usize = grouped.iter().map(|g| g.pages.len()).sum();
    assert_eq!(total, HELP_PAGES.len() - 1);
    assert_eq!(grouped[0].pages.len(), 2);
    assert_eq!(grouped[1].pages.len(), 6);
    assert_eq!(grouped[2].pages.len(), 10);
}

#[test]
fn further_reading_targets_resolve() {
    for p in HELP_PAGES {
        for link in p.further_reading {
            assert!(
                find_page(link.page).is_some(),
                "{} links to unknown page '{}'",
                p.id,
                link.page
            );
            assert!(!link.hint.is_empty());
        }
    }
}

#[test]
fn every_page_has_a_non_empty_section() {
    for p in HELP_PAGES {
        assert!(!p.sections.is_empty(), "{} has no sections", p.id);
        for s in p.sections {
            assert!(!s.body.is_empty());
            if s.heading.is_empty() {
                assert_eq!(p.id, "home", "{} has an empty section heading", p.id);
            }
        }
    }
}

#[test]
fn further_reading_never_links_to_self() {
    for p in HELP_PAGES {
        for link in p.further_reading {
            assert_ne!(link.page, p.id, "{} links to itself", p.id);
        }
    }
}

fn all_pages() -> impl Iterator<Item = &'static HelpPage> {
    HELP_PAGES.iter()
}

#[test]
fn text_is_deterministic_marker_free_non_empty() {
    for p in all_pages() {
        let text = render_page_text(p);
        assert!(!text.is_empty(), "{} renders empty", p.id);
        assert!(!text.contains("\x1b["), "{} has ANSI", p.id);
        assert!(!text.contains('`'), "{} has stray backticks", p.id);
    }
}

#[test]
fn rich_never_and_auto_non_tty_equal_text() {
    for p in all_pages() {
        assert_eq!(
            render_page_tty(p, RichMode::Never, false),
            render_page_text(p),
            "{} never != text",
            p.id
        );
        assert_eq!(
            render_page_tty(p, RichMode::Auto, false),
            render_page_text(p),
            "{} auto (non-TTY) != text",
            p.id
        );
    }
}

#[test]
fn rich_always_ansi_stripped_equals_text() {
    for p in all_pages() {
        if p.id == "home" {
            assert!(
                render_page_rich(p).contains("\x1b["),
                "home rich has no ANSI"
            );
            continue;
        }
        let rich = render_page_rich(p);
        assert!(rich.contains("\x1b["), "{} has no ANSI", p.id);
        assert_eq!(
            strip_ansi(&rich),
            render_page_text(p),
            "{} rich != text after strip",
            p.id
        );
        let escapes = collect_escapes(&rich);
        for i in 0..escapes.len() {
            if escapes[i] != "\x1b[0m" {
                assert_eq!(
                    escapes.get(i + 1).map(String::as_str),
                    Some("\x1b[0m"),
                    "{}: unbalanced ANSI after {}",
                    p.id,
                    escapes[i]
                );
            }
        }
    }
}

fn collect_escapes(s: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut rest = s;
    while let Some(idx) = rest.find('\u{1b}') {
        rest = &rest[idx..];
        if rest.starts_with("\x1b[")
            && let Some(end) = rest.find('m')
        {
            out.push(rest[..=end].to_string());
            rest = &rest[end + 1..];
            continue;
        }
        rest = &rest[1..];
    }
    out
}

#[test]
fn state_scope_help_names_undo_snapshot_warning() {
    let page = find_page("concepts/state-scope").expect("state-scope page");
    let body: String = page.sections.iter().map(|s| s.body).collect();
    assert!(
        body.contains(
            "When the snapshot cannot be saved, that mutation's JSON includes a warning."
        ),
        "{body}"
    );
}
