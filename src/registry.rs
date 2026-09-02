//! Hardcoded LyX file-format registries (Deno `registry.ts`).

#[derive(Clone, Copy, Debug, Eq, PartialEq, serde::Serialize)]
#[serde(rename_all = "lowercase")]
pub enum InsetKind {
    Collapsible,
    Command,
    Content,
    Tabular,
    Spacing,
    Formatting,
    Misc,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct InsetMeta {
    pub name: &'static str,
    pub kind: InsetKind,
    pub subtypes: &'static [&'static str],
}

pub const KNOWN_COMMAND_INSET_TYPES: &[&str] = &[
    "citation", "ref", "label", "bibitem", "bibtex", "include", "index", "nomencl", "href",
    "counter", "line", "toc",
];

pub const INSET_CATALOG: &[InsetMeta] = &[
    InsetMeta {
        name: "Note",
        kind: InsetKind::Collapsible,
        subtypes: &["Note", "Comment", "Greyedout"],
    },
    InsetMeta {
        name: "ERT",
        kind: InsetKind::Collapsible,
        subtypes: &[],
    },
    InsetMeta {
        name: "Foot",
        kind: InsetKind::Collapsible,
        subtypes: &[],
    },
    InsetMeta {
        name: "Marginal",
        kind: InsetKind::Collapsible,
        subtypes: &[],
    },
    InsetMeta {
        name: "Branch",
        kind: InsetKind::Collapsible,
        subtypes: &[],
    },
    InsetMeta {
        name: "Box",
        kind: InsetKind::Collapsible,
        subtypes: &[],
    },
    InsetMeta {
        name: "Float",
        kind: InsetKind::Collapsible,
        subtypes: &[],
    },
    InsetMeta {
        name: "Wrap",
        kind: InsetKind::Collapsible,
        subtypes: &[],
    },
    InsetMeta {
        name: "Caption",
        kind: InsetKind::Collapsible,
        subtypes: &[],
    },
    InsetMeta {
        name: "Flex",
        kind: InsetKind::Collapsible,
        subtypes: &[],
    },
    InsetMeta {
        name: "Phantom",
        kind: InsetKind::Collapsible,
        subtypes: &["Phantom", "HPhantom", "VPhantom"],
    },
    InsetMeta {
        name: "CommandInset",
        kind: InsetKind::Command,
        subtypes: KNOWN_COMMAND_INSET_TYPES,
    },
    InsetMeta {
        name: "Formula",
        kind: InsetKind::Content,
        subtypes: &[],
    },
    InsetMeta {
        name: "Graphics",
        kind: InsetKind::Content,
        subtypes: &[],
    },
    InsetMeta {
        name: "External",
        kind: InsetKind::Content,
        subtypes: &[],
    },
    InsetMeta {
        name: "Include",
        kind: InsetKind::Content,
        subtypes: &[],
    },
    InsetMeta {
        name: "listings",
        kind: InsetKind::Content,
        subtypes: &[],
    },
    InsetMeta {
        name: "Preview",
        kind: InsetKind::Content,
        subtypes: &[],
    },
    InsetMeta {
        name: "Tabular",
        kind: InsetKind::Tabular,
        subtypes: &[],
    },
    InsetMeta {
        name: "space",
        kind: InsetKind::Spacing,
        subtypes: &[],
    },
    InsetMeta {
        name: "VSpace",
        kind: InsetKind::Spacing,
        subtypes: &[],
    },
    InsetMeta {
        name: "Newline",
        kind: InsetKind::Spacing,
        subtypes: &[],
    },
    InsetMeta {
        name: "Newpage",
        kind: InsetKind::Spacing,
        subtypes: &[],
    },
    InsetMeta {
        name: "Separator",
        kind: InsetKind::Spacing,
        subtypes: &[],
    },
    InsetMeta {
        name: "Line",
        kind: InsetKind::Spacing,
        subtypes: &[],
    },
    InsetMeta {
        name: "Quotes",
        kind: InsetKind::Formatting,
        subtypes: &[],
    },
    InsetMeta {
        name: "SpecialChar",
        kind: InsetKind::Formatting,
        subtypes: &[],
    },
    InsetMeta {
        name: "IPA",
        kind: InsetKind::Formatting,
        subtypes: &[],
    },
    InsetMeta {
        name: "IPAMacro",
        kind: InsetKind::Formatting,
        subtypes: &[],
    },
    InsetMeta {
        name: "IPADeco",
        kind: InsetKind::Formatting,
        subtypes: &[],
    },
    InsetMeta {
        name: "script",
        kind: InsetKind::Formatting,
        subtypes: &[],
    },
    InsetMeta {
        name: "Argument",
        kind: InsetKind::Misc,
        subtypes: &[],
    },
    InsetMeta {
        name: "Info",
        kind: InsetKind::Misc,
        subtypes: &[],
    },
    InsetMeta {
        name: "FloatList",
        kind: InsetKind::Misc,
        subtypes: &[],
    },
    InsetMeta {
        name: "Index",
        kind: InsetKind::Misc,
        subtypes: &[],
    },
    InsetMeta {
        name: "Nomenclature",
        kind: InsetKind::Misc,
        subtypes: &[],
    },
    InsetMeta {
        name: "TOC",
        kind: InsetKind::Misc,
        subtypes: &[],
    },
    InsetMeta {
        name: "Ending",
        kind: InsetKind::Misc,
        subtypes: &[],
    },
    InsetMeta {
        name: "Accent",
        kind: InsetKind::Misc,
        subtypes: &[],
    },
];

pub(crate) fn known_inset_type(name: &str) -> bool {
    INSET_CATALOG.iter().any(|e| e.name == name)
}

pub(crate) fn known_command_inset_type(name: &str) -> bool {
    KNOWN_COMMAND_INSET_TYPES.contains(&name)
}

pub fn get_inset_type(args: Option<&str>) -> Option<&str> {
    let args = args?;
    if args.is_empty() {
        return None;
    }
    Some(args.split_once(' ').map(|(a, _)| a).unwrap_or(args))
}

pub fn validate_inset_type(args: Option<&str>) -> Option<String> {
    let Some(primary) = get_inset_type(args) else {
        return Some("Empty inset type".to_string());
    };
    if known_inset_type(primary) {
        if primary == "CommandInset" {
            let args = args.unwrap_or("");
            let rest = args.find(' ').map(|i| &args[i + 1..]).unwrap_or(args);
            let subtype = rest.split(' ').next().unwrap_or("");
            if !subtype.is_empty() && !known_command_inset_type(subtype) {
                return Some(format!(
                    "Unknown CommandInset subtype: '{subtype}'. Known subtypes: {}",
                    KNOWN_COMMAND_INSET_TYPES.join(", ")
                ));
            }
        }
        return None;
    }
    Some(format!(
        "Unknown inset type: '{primary}'. Known types: {}",
        INSET_CATALOG
            .iter()
            .map(|e| e.name)
            .collect::<Vec<_>>()
            .join(", ")
    ))
}

pub const INLINE_PROPERTIES: &[&str] = &[
    "family",
    "series",
    "shape",
    "size",
    "lang",
    "color",
    "numeric",
    "nospellcheck",
    "emph",
    "noun",
    "bar",
    "strikeout",
    "xout",
    "uuline",
    "uwave",
    "change_inserted",
    "change_deleted",
    "change_unchanged",
    "lyxadded",
    "lyxdeleted",
    "lyxobjdeleted",
    "lyxdisplayobjdeleted",
    "lyxudisplayobjdeleted",
];

pub const CHANGE_AXIS_KEYS: &[&str] = &[
    "change_inserted",
    "change_deleted",
    "change_unchanged",
    "lyxadded",
    "lyxdeleted",
    "lyxobjdeleted",
    "lyxdisplayobjdeleted",
    "lyxudisplayobjdeleted",
];

pub fn is_inline_style_key(key: &str) -> bool {
    INLINE_PROPERTIES.contains(&key) && !CHANGE_AXIS_KEYS.contains(&key)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn catalog_names_and_change_axis() {
        assert!(known_inset_type("Note"));
        assert!(known_inset_type("CommandInset"));
        assert!(known_command_inset_type("citation"));
        assert!(!is_inline_style_key("change_inserted"));
        assert!(is_inline_style_key("emph"));
        assert_eq!(
            validate_inset_type(None).as_deref(),
            Some("Empty inset type")
        );
        assert!(validate_inset_type(Some("Note Note")).is_none());
        let msg = validate_inset_type(Some("Nope")).unwrap();
        assert!(msg.starts_with("Unknown inset type: 'Nope'."));
        let msg = validate_inset_type(Some("CommandInset frob")).unwrap();
        assert!(msg.starts_with("Unknown CommandInset subtype: 'frob'."));
    }
}
