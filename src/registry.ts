// Hardcoded registries of LyX file format elements, sourced from LyX 2.5.1 C++ source.
// These are kept here to keep lq self-contained (no LyX installation required).
//
// Sources:
//   Inset types:    src/InsetCode.h, src/Inset.cpp (insetnames table)
//   Inline props:   src/Text.cpp, src/Changes.cpp, src/Font.cpp
//   CommandInset:   src/InsetCode.h

// ── Inset types ──────────────────────────────────────────────────────────────

/** Top-level inset type names (first word after \begin_inset). */
export const KNOWN_INSET_TYPES: ReadonlySet<string> = new Set([
  // Collapsible text insets
  "Note",           // subtypes: Note, Comment, Greyedout
  "ERT",            // Evil Red Text / TeX code
  "Foot",           // Footnote
  "Marginal",       // Marginal note
  "Branch",         // Document branch
  "Box",            // Box (with subtype: Boxed, Shaded, etc.)
  "Float",          // Float (figure, table, algorithm)
  "Wrap",           // Text wrap float
  "Caption",        // Caption (Standard, etc.)
  "Flex",           // Flex inset (custom from layout modules)
  "Phantom",        // Phantom (Phantom, HPhantom, VPhantom)

  // Command insets (key-value params)
  "CommandInset",   // subtypes: citation, ref, label, bibitem, bibtex,
                    //           include, index, nomencl, href, counter,
                    //           line, toc

  // Content
  "Formula",        // Math formula (inline: $...$, display: \[...\])
  "Graphics",       // Image include
  "External",       // External material
  "Include",        // Child document include
  "listings",       // Code listing (note: lowercase in .lyx)
  "Preview",        // Instant preview

  // Tabular
  "Tabular",        // Table

  // Spacing
  "space",          // Horizontal space (note: lowercase in .lyx)
  "VSpace",         // Vertical space
  "Newline",        // Line break
  "Newpage",        // Page break
  "Separator",      // Separator line
  "Line",           // Horizontal line

  // Text formatting
  "Quotes",         // Quotation marks (subtype: sld, srd, fld, frd, etc.)
  "SpecialChar",    // Special character
  "IPA",            // IPA inset
  "IPAMacro",       // IPA macro
  "IPADeco",        // IPA decoration
  "script",         // Subscript/Superscript (note: lowercase in .lyx)

  // Misc
  "Argument",       // Layout argument
  "Info",           // Document info field
  "FloatList",      // List of floats
  "Index",          // Index entry (alternative to CommandInset index)
  "Nomenclature",   // Nomenclature entry (alternative to CommandInset nomenclature)
  "TOC",            // Table of contents
  "Ending",         // Ending
  "Accent",         // Accent

  // Note: "Text" is NOT an inset type — it's the content section marker
  // inside collapsible insets (written by InsetText::write).
  // "status" is also NOT an inset type — it's the open/collapsed marker.
]);

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
