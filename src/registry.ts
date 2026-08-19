// Hardcoded registries of LyX file format elements, sourced from LyX 2.5.1 C++ source.
// These are kept here to keep lq self-contained (no LyX installation required).
//
// Sources:
//   Inset types:    src/InsetCode.h, src/Inset.cpp (insetnames table)
//   Inline props:   src/Text.cpp, src/Changes.cpp, src/Font.cpp
//   CommandInset:   src/InsetCode.h

// ── Inset types ──────────────────────────────────────────────────────────────

/**
 * CST kind of a top-level inset type (first word after \begin_inset).
 * Author-facing: how the inset is shaped in the file, not how Live HTML looks.
 */
export type InsetKind =
  | "collapsible"
  | "command"
  | "content"
  | "tabular"
  | "spacing"
  | "formatting"
  | "misc";

export interface InsetMeta {
  name: string;
  kind: InsetKind;
  /** Closed subtype list when LyX has one. Empty when the second word is open (Float, Quotes, Flex). */
  subtypes: readonly string[];
}

/** Known CommandInset subtypes (second word after \begin_inset CommandInset). */
export const KNOWN_COMMAND_INSET_TYPES: ReadonlySet<string> = new Set([
  "citation",
  "ref",
  "label",
  "bibitem",
  "bibtex",
  "include",
  "index",
  "nomencl",
  "href",
  "counter",
  "line",
  "toc",
]);

/**
 * Built-in inset catalog for `lq schema`. Names match InsetCode.h / Inset.cpp.
 * "Text" and "status" are not types — they are markers inside collapsible insets.
 */
export const INSET_CATALOG: readonly InsetMeta[] = [
  { name: "Note", kind: "collapsible", subtypes: ["Note", "Comment", "Greyedout"] },
  { name: "ERT", kind: "collapsible", subtypes: [] },
  { name: "Foot", kind: "collapsible", subtypes: [] },
  { name: "Marginal", kind: "collapsible", subtypes: [] },
  { name: "Branch", kind: "collapsible", subtypes: [] },
  { name: "Box", kind: "collapsible", subtypes: [] },
  { name: "Float", kind: "collapsible", subtypes: [] },
  { name: "Wrap", kind: "collapsible", subtypes: [] },
  { name: "Caption", kind: "collapsible", subtypes: [] },
  { name: "Flex", kind: "collapsible", subtypes: [] },
  { name: "Phantom", kind: "collapsible", subtypes: ["Phantom", "HPhantom", "VPhantom"] },
  { name: "CommandInset", kind: "command", subtypes: [...KNOWN_COMMAND_INSET_TYPES] },
  { name: "Formula", kind: "content", subtypes: [] },
  { name: "Graphics", kind: "content", subtypes: [] },
  { name: "External", kind: "content", subtypes: [] },
  { name: "Include", kind: "content", subtypes: [] },
  { name: "listings", kind: "content", subtypes: [] },
  { name: "Preview", kind: "content", subtypes: [] },
  { name: "Tabular", kind: "tabular", subtypes: [] },
  { name: "space", kind: "spacing", subtypes: [] },
  { name: "VSpace", kind: "spacing", subtypes: [] },
  { name: "Newline", kind: "spacing", subtypes: [] },
  { name: "Newpage", kind: "spacing", subtypes: [] },
  { name: "Separator", kind: "spacing", subtypes: [] },
  { name: "Line", kind: "spacing", subtypes: [] },
  { name: "Quotes", kind: "formatting", subtypes: [] },
  { name: "SpecialChar", kind: "formatting", subtypes: [] },
  { name: "IPA", kind: "formatting", subtypes: [] },
  { name: "IPAMacro", kind: "formatting", subtypes: [] },
  { name: "IPADeco", kind: "formatting", subtypes: [] },
  { name: "script", kind: "formatting", subtypes: [] },
  { name: "Argument", kind: "misc", subtypes: [] },
  { name: "Info", kind: "misc", subtypes: [] },
  { name: "FloatList", kind: "misc", subtypes: [] },
  { name: "Index", kind: "misc", subtypes: [] },
  { name: "Nomenclature", kind: "misc", subtypes: [] },
  { name: "TOC", kind: "misc", subtypes: [] },
  { name: "Ending", kind: "misc", subtypes: [] },
  { name: "Accent", kind: "misc", subtypes: [] },
];

/** Top-level inset type names (first word after \begin_inset). */
export const KNOWN_INSET_TYPES: ReadonlySet<string> = new Set(INSET_CATALOG.map((e) => e.name));

/**
 * Extracts the primary inset type from the args of a \begin_inset line.
 * e.g., "Note Note" -> "Note", "CommandInset citation" -> "CommandInset"
 */
export function getInsetType(args: string | undefined): string | null {
  if (!args) return null;
  const spaceIdx = args.indexOf(" ");
  return spaceIdx === -1 ? args : args.substring(0, spaceIdx);
}

/**
 * Check whether an inset type is known.
 * Returns a warning message if unknown, or null if valid.
 */
export function validateInsetType(args: string | undefined): string | null {
  const primaryType = getInsetType(args);
  if (!primaryType) return `Empty inset type`;
  if (KNOWN_INSET_TYPES.has(primaryType)) {
    // For CommandInset, also check the subtype
    if (primaryType === "CommandInset") {
      const subtype = args!.substring(args!.indexOf(" ") + 1).split(" ")[0];
      if (subtype && !KNOWN_COMMAND_INSET_TYPES.has(subtype)) {
        return `Unknown CommandInset subtype: '${subtype}'. Known subtypes: ${[...KNOWN_COMMAND_INSET_TYPES].join(", ")}`;
      }
    }
    return null;
  }
  return `Unknown inset type: '${primaryType}'. Known types: ${[...KNOWN_INSET_TYPES].join(", ")}`;
}

// ── Inline properties ────────────────────────────────────────────────────────

/** Inline property keys that can appear as \key value inside layout/inset content.
 *  Sourced from LyX 2.5.1: src/Text.cpp, src/Changes.cpp, src/Font.cpp */
export const INLINE_PROPERTIES: readonly string[] = [
  // Font properties (src/Font.cpp)
  "family", "series", "shape", "size", "lang", "color",
  "numeric", "nospellcheck",
  "emph", "noun", "bar",
  "strikeout", "xout", "uuline", "uwave",
  // Change tracking (src/Changes.cpp, src/Text.cpp)
  "change_inserted", "change_deleted", "change_unchanged",
  // Legacy change tracking (older .lyx format)
  "lyxadded", "lyxdeleted", "lyxobjdeleted", "lyxdisplayobjdeleted",
  "lyxudisplayobjdeleted",
];

/** Tracked-change / legacy marker keys — the change axis is served by :change(), not :property() (dev log 92 §2.2). */
export const CHANGE_AXIS_KEYS: ReadonlySet<string> = new Set([
  "change_inserted", "change_deleted", "change_unchanged",
  "lyxadded", "lyxdeleted", "lyxobjdeleted", "lyxdisplayobjdeleted", "lyxudisplayobjdeleted",
]);

/** Is a property key an inline STYLE key (not a tracked-change marker)? */
export function isInlineStyleKey(key: string): boolean {
  return INLINE_PROPERTIES.includes(key) && !CHANGE_AXIS_KEYS.has(key);
}
