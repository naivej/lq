---
name: use-lq
description: Read, edit, and manipulate lyx documents (.lyx files)
allowed-tools: Bash(lq *)
---
# User Manual

`lq` is a standalone CLI tool designed to parse, query, and mutate LyX (`.lyx`) documents.

At its core, `lq` operates on a simple lifecycle:

1. **Parse**: Reads a `.lyx` file and converts it into a structured Concrete Syntax Tree (CST). The parse is cached by file-content SHA-256 hash in `~/.lq/cache/` — subsequent reads of the same file deserialize the CST from cache instead of re-parsing. After mutations, the cache is updated with the new CST (write-through), so even back-to-back edits hit the cache after the first parse.
2. **Query**: Uses a CSS-like selector engine to find specific nodes in the CST.
3. **Mutate**: Applies changes (insert, set, delete) to the matched nodes.
4. **Serialize**: Converts the modified CST back into a perfectly formatted `.lyx` file.

## The LyX-to-CST Mapping

To effectively use the query engine, Users need to understand how LyX syntax maps to the CST nodes:

- **Layout Nodes**: Structures like `\begin_layout Section` map to a `layout` tag with a `Section` argument. Users select them using `layout[Section]`.
- **Inset Nodes**: Structures like `\begin_inset Formula` map to an `inset` tag with a `Formula` argument. Users select them using `inset[Formula]`.
- **Property Nodes**: Single-line settings like `\textclass article` map to property nodes.
- **Text Nodes**: The actual text content inside layouts and insets.
- **CST is flat**: Layouts like `Section` and `Standard` are **siblings** under the document body, not parent-child.

## Query Engine

The query engine supports traversing the CST using CSS-like syntax:

- **Tags**: `layout` (e.g., standard paragraphs, sections), `inset` (e.g., formulas, footnotes, figures), `property` (e.g. `\family roman`).
- **Attributes**: `layout[Section]`, `inset[Formula]`, `property[family]`.
- **Combinators**
  - Descendant (` `): Finds descendants with space-separated paths. Example: `layout[Section] inset[Formula]` finds a Formula inside a Section.
  - Sibling (` ~ `): Finds following siblings. Example: `layout[Section] ~ layout[Standard]` matches all Standard layouts after a Section.
- **Pseudo-classes** (must follow a tag e.g., `layout:contains("text")`, `inset:first`):
  - `:first`, `:last`, `:nth-child(an+b)` (supports formulas like `2n+1`, `odd`, `even`).
  - `:not(selector)` excludes nodes that have any descendant matching the inner selector (e.g. `layout[Standard]:not(inset[Formula])` matches Standard layouts that do NOT contain a Formula).
  - `:adjacent(selector)` matches nodes whose immediately preceding sibling matches the inner selector (skips text/property nodes).
  - `:until(selector)` bounds a `~` sibling range — rejects nodes that have a sibling matching the inner selector between themselves and the anchor. Example: `layout[Section]:contains('Intro') ~ layout[Standard]:until(layout[Section])` gives all Standard paragraphs in the Introduction section.
  - `:contains("text")` searches recursively and case-sensitively node children for text.
  - Multiple pseudo-classes can be chained (e.g. `:first:contains("foo")`).

## Context-Aware Strict Validation

`lq` features strict context validation. It will actively reject mutations that target core CST boundaries like `body` or `document`. It will also reject `insert` commands if you try to put a layout like `Section` inside an inset like `Foot`, or if you use an unrecognized layout. Unknown inset types produce a warning but do NOT block the insertion.

## Commands

### Config

- `lq init [--layouts-dir <path>] [--refresh <mode>] [--track-changes <on|off>] [--max-cache-entries <n>] [--author-name <name>]`
  - Without flags
    - Initializes the user configuration file `~/.lq/config.json` with default options.
    - Or prints the current configuration if it exists.
  - `--layouts-dir <path>`: If not provided, auto-detects the highest installed LyX version's layouts directory.
  - `--refresh <mode>` configures automatic LyX buffer refresh in opened `.lyx` files after mutations:
    - `none` (default): No refresh. LyX detects external changes via its own polling and prompts the user to reload.
    - `reload`: Reload the buffer after `lq` writes, fail silently if LyXserver disconnects. Fast, but discards unsaved in-LyX edits.
    - `save-reload`: Save unsaved edits first, then reload. Preserves everything. Throw an error and abort if LyXserver disconnects
  - `--track-changes <on|off>`: Enable or disable tracked changes for all mutation commands. It's on by default, which sets `\tracking_changes true` and add an `\author` entry in the document header.
    - Set preserves old text in `\change_deleted` + new in `\change_inserted`
    - Delete wraps removed nodes in `\change_deleted`
    - Insert wraps new content in `\change_inserted`
  - `--max-cache-entries <n>`: Set the maximum number (default 50) of cached parse results in `~/.lq/cache/`.
  - `--author-name <name>`: Set the author name used in tracked changes. Default: `"lq user"`.

### Query

- `lq schema <file>`
  - Returns all valid elements for the document's class across 6 categories:
    - `documentLayouts` — Styles valid for this class (e.g. Section, Standard)
    - `insetLayouts` — Layouts valid inside insets (e.g. Plain Layout)
    - `insets` — Valid inset types (e.g. Formula, Foot, CommandInset)
    - `commandInsetSubtypes` — Valid CommandInset subtypes (citation, ref, label, etc.)
    - `inlineProperties` — Valid inline property keys (family, lang, change_inserted, etc.)
    - `headingHierarchy` — Heading layouts with TocLevel
- `lq bib <file> [--search <text>]`
  - Extracts available citation keys from linked `.bib` bibliography files and outputs them as JSON.
  - Each citation includes `key`, `author`, `title`, and `year`.
  - `--search <text>`: Filters citations by a case-insensitive substring match across all fields. Multiple words are AND'd. Use this to find the right key from a human description without dumping the entire `.bib` file.
- `lq dump <file> [<selector>] [--depth <n>] [--toc]`
  - Outputs the CST as a JSON document.
  - Selector: Scope the dump to matching nodes. Omit to dump the whole document.
  - Depth: `--depth 0` shows only the root node; `--depth 1` shows direct children; `--depth N` descend N levels from root; omit `--depth` for the full CST.
  - `--toc` (Mutually exclusive with selector): Output a hierarchical heading tree (table of contents) instead of raw CST. Heading levels are read from the document class's `.layout` file with LaTeX's standard hierarchy as the fallback. Combined with `--depth` to limit TOC nesting depth (1 = top-level sections only).
- `lq read <file> <selector> [--count] [--text-only]`
  - Read matched nodes.
  - `--count`: Return match counts by type (`{"count": {"layout[Section]": 12, "layout[Standard]": 450}}`).
  - `--text-only`: Output the text content of matched nodes with structural annotations. Each matched node gets a `tag[args]` prefix (e.g. `layout[Standard]`), and insets appear as inline markers (e.g. `inset[Foot]`). Tracked changes appear as `\change_deleted{...}` and `\change_inserted{...}` inline markers. Double newline between nodes.

### Mutate

- `lq set <file> <selector> <new text> [--replace-all] [--find <substring>]`
  - Default behaviour: replaces text content within the targeted nodes while preserves non-text children (insets, properties).
  - `--replace-all`: Wipe all children and rebuild from scratch.
  - `--find <substring>` (Mutually exclusive with `--replace-all`): Surgical substring replacement — replace only the specified substring within the matched nodes' text. All occurrences are replaced.
- `lq delete <file> <selector>`
  - Deletes the targeted nodes.
- `lq undo <file> <selector> [<substring>]`
  - Requires `trackChanges: on`.
  - Reverts tracked changes in matched nodes: `change_deleted` blocks are restored (marker removed, text kept); `change_inserted` blocks are discarded (marker and text removed).
  - Each marker is undone independently — to fully revert a `set`, run undo twice (once for the deleted text, once for the inserted text).
  - `<substring>`: Text inside the `change_deleted` or `change_inserted` block to revert. Omit to revert ALL tracked changes in matched nodes.
- `lq insert <file> <selector> <position> [helper]`
  - Insert new blocks or properties relative to a selector.
  - Positions:
    - `before`/`after`: insert a layout as a **sibling** of the target.
    - `prepend`/`append`: insert as **children** of the target, used for adding insets or text inside a layout.
    - `split-after <text>`: split a text node right after the exact, case-sensitive substring and insert new content at that point. Only proceeds if the match appears **exactly once** in current text (text inside `\change_deleted` blocks is skipped — those represent old/replaced content, not valid targets for new insertions).
  - Helpers (must provide exactly one generation strategy):
    - `--layout <name> --text <content>`: The safest option. Automatically generates a valid LyX block with the specified text.
    - `--cite <key> [--cite-cmd <command>]`: Insert a citation inset. Valid `--cite-cmd` values: `cite`, `citet` (default), `citep`, `citeauthor`, `citeyear`, `citeyearpar`, `citebyear`, `footcite`, `autocite`, `citetitle`, `fullcite`, `footfullcite`, `nocite`, `keyonly`.
    - `--ref <label> [--ref-cmd <command>]`: Insert a cross-reference inset. Valid `--ref-cmd` values: `ref` (default), `eqref`, `pageref`, `vpageref`, `vref`, `nameref`, `formatted`, `labelonly`.
    - `--label <name>`: Insert a label inset (`CommandInset label`) with the given name.
    - `--footnote <text>`: Insert a footnote inset (`Foot`) containing a `Plain Layout` with the given text. For complex footnotes (citations, cross-refs, math), use the two-pass approach: create the skeleton with `--footnote`, then populate with `split-after` and other helpers.
    - `--raw-file <path>`: The power-user option for complex structures (e.g. nested formulas, batch insertion, non-default citation/reference params). Read raw LyX syntax from a file and parse it into CST nodes.

# Best Practices

## Before you start

1. **Make sure `lq` is configured**: Always run `lq init` first to set up / confirm configeration. But **NEVER change configreation** without clear instructions or consent from the user.
2. **Embrace the Git Workflow**: Work in a version-controlled workspace. `git stage` before mutating, then review with `git diff`. If you don't like the result, `git restore` reverts everything — or `lq undo` reverts individual tracked changes without touching other edits. There is no `--dry-run` flag because git + undo cover the same need.
3. **Treat LaTeX as Opaque**: `lq` abstracts away the LaTeX layer. Any raw LaTeX (like equations inside `inset[Formula]`) is treated as pure string data. Do not try to parse the LaTeX syntax itself; simply target the `inset[Formula]` node and replace its text content.
4. **Stop for LyXServer errors**: If `lq` cannot connect LyXServer, stop immediately and ask the user to turn on LyXServer or turn off auto refresh.

## Smart query

Navigate large documents strategically with a zoom-in approach:

| You want to…                              | Use this                                                                                                                             |
| ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------ |
| See the document outline                   | `lq dump <file> --toc`                                                                                                             |
| Get just section headings                  | `lq read <file> "layout[Section]" --text-only`                                                                                     |
| Read body text under a section             | `lq read <file> "layout[Section]:contains('Theory') ~ layout:until(layout[Section])" --text-only`                                  |
| Read all body text under a section (broad) | `lq read <file> "layout[Section]:contains('Theory') ~ layout:until(layout[Section])" --count --text-only`                          |
| Find a specific paragraph by content       | `lq read <file> "layout:contains('unique phrase')" --text-only`                                                                    |
| Find a paragraph by multiple keywords      | `lq read <file> "layout:contains('climate'):contains('policy')" --text-only`                                                       |
| Get first paragraph of a section           | `lq read <file> "layout[Section]:contains('Intro') ~ layout[Standard]:until(layout[Section]):first" --text-only`                   |
| Get body under a subsection (multi-hop ~)  | `lq read <file> "layout[Section] ~ layout[Subsection]:contains('Methods') ~ layout[Standard]:until(layout[Section])" --text-only`  |
| Body text without footnotes in a section   | `lq read <file> "layout[Section] ~ layout[Standard]:not(inset[Foot]):until(layout[Section])" --text-only`                          |
| Paragraph after a Quote, within a section  | `lq read <file> "layout[Section]:contains('Intro') ~ layout[Standard]:until(layout[Section]):adjacent(layout[Quote])" --text-only` |
| Check selector blast radius & composition  | `lq read <file> "<selector>" --count`                                                                                              |
| Inspect a specific node's CST              | `lq read <file> "<precise selector>"`                                                                                              |
| Deep-debug a node's children               | `lq dump <file> "<selector>"`                                                                                                      |
| Find a citation key                        | `lq bib <file> --search "keyword"`                                                                                                 |
| Revert a tracked change                    | `lq undo <file> "<selector>" "bad text"`                                                                                           |

**Never:** read the whole document at once, bare `lq dump`, bare `lq read "layout"` without `--text-only`, or bare `lq bib`.

## Safe Mutation Workflow

All mutations (`insert`, `set`, `delete`, `undo`) apply to all matched nodes of a selector. In particular,

- `insert` duplicates the payload once for each matched node.
- `set` and `delete` could wipe out the entire document with an overly broad selector (e.g., `layout[Standard]`).
- If more than 1 node matches, a warning is issued (except for `undo`).

When modifying a document, follow this safe workflow:

1. **Check Schema**: Documents vary wildly. A `Beamer` presentation allows `Frame` layouts, but an `article` does not. Run `lq schema <file>` to know what layouts and insets are legally allowed in the specific document.
2. **Test Blast Radius**: Run `lq read <file> <selector> --count` first. The subtype breakdown (e.g. `{"layout[Section]": 8, "layout[Standard]": 120}`) tells you the composition — if you meant to target sections but see 120 Standard layouts, your selector is wrong. Narrow before mutating.
3. **Surgical edit** (typo fix, rephrase, word change): Use `lq set ... --find "old substring"`. **Keep `new_text` scoped to only the changed substring.** `--find` operates on individual text nodes; `new_text` is the literal replacement, not merged with surrounding nodes.
4. **Tracked changes**: Undo un-wanted changes before appling new changes. Re-editing a node that already has pending tracked changes produces a warning, because the new edit will nest inside existing markers (double-wrap).

## HOW-TO

1. **Cross-Referencing**: Before inserting a cross-reference, find the exact label names. Labels are stored as text inside `CommandInset label` insets. Query all labels with:

   ```bash
   lq read <file> "inset[CommandInset label]"
   ```

   To filter by prefix (e.g., all section labels):

   ```bash
   lq read <file> "inset[CommandInset label]:contains('sec:')"
   ```

   **Complex references via `--raw-file`**: When you need non-default params (`plural`, `caps`, `noprefix`, `nolink`, `tuple`), write the full inset to a temp file:

   ```
   \begin_inset CommandInset ref
   LatexCommand vref
   reference "sec:Section_label"
   plural "true"
   caps "false"
   noprefix "false"
   nolink "false"
   tuple "range"
   \end_inset
   ```

   See the reference syntax table below for all param defaults.
2. **Citations**: Before inserting a citation, find citation keys with:

   ```bash
   lq bib <file> --search "author name"
   ```

   **Complex citations via `--raw-file`**: When you need `before`/`after` text, multi-citation lists, or `literal` mode, write the full inset to a temp file:

   ```
   \begin_inset CommandInset citation
   LatexCommand citet
   key "Einstein1905"
   literal "false"
   after "p. 42"
   \end_inset
   ```

   See the citation syntax table below for all param defaults.
3. **List Items (Itemize, Enumerate, Description)**: Do NOT use `\item` — it is a LaTeX command, not a `.lyx` file format token. LyX never writes `\item` to `.lyx` files and would discard it as an "Unknown token". Instead, each list item is a **separate paragraph** with the list layout:

   ```
   \begin_layout Itemize
   First bullet point.
   \end_layout
   \begin_layout Itemize
   Second bullet point.
   \end_layout
   ```

   To insert multiple list items at once with `--raw-file`:

   ```bash
   lq insert file.lyx "layout[Standard]:last" after --raw-file /tmp/items.raw
   ```

   For nested lists, use `\begin_deeper` / `\end_deeper` around the nested items. For enumerated lists, use `\begin_layout Enumerate` instead. For description lists, use `\begin_layout Description`.

# LyX Syntax Reference

## Citation Inset (`CommandInset citation`)

```
\begin_inset CommandInset citation
LatexCommand citet
key "Einstein1905"
literal "false"
after ""
before ""
\end_inset
```

| Param            | Default        | Notes                                      |
| ---------------- | -------------- | ------------------------------------------ |
| `key`          | *(required)* | BibTeX citation key                        |
| `literal`      | `"false"`    | `"true"` bypasses cite engine formatting |
| `after`        | `""`         | Text after citation, e.g.`"p. 42"`       |
| `before`       | `""`         | Text before citation, e.g.`"see "`       |
| `pretextlist`  | `""`         | Multi-citation preamble                    |
| `posttextlist` | `""`         | Multi-citation postamble                   |

Omit params that use the default — LyX only writes non-default values.

## Cross-Reference Inset (`CommandInset ref`)

```
\begin_inset CommandInset ref
LatexCommand ref
reference "sec:Section_label"
plural "false"
caps "false"
noprefix "false"
nolink "false"
tuple "list"
\end_inset
```

| Param         | Default        | Notes                                    |
| ------------- | -------------- | ---------------------------------------- |
| `reference` | *(required)* | Label name                               |
| `plural`    | `"false"`    | "Section" → "Sections"                  |
| `caps`      | `"false"`    | Capitalize prefix                        |
| `noprefix`  | `"false"`    | Hide "Section"/"Figure" prefix           |
| `nolink`    | `"false"`    | No hyperlink                             |
| `tuple`     | `"list"`     | `"list"` or `"range"` for multi-refs |

The `plural`/`caps`/`noprefix`/`nolink`/`tuple` params are LyX-internal — they affect GUI display, not LaTeX output.

## Note Insets

The `Note` inset family has three subtypes. All use `\begin_inset Note <subtype>`:

| Syntax                          | LyX UI Name          | Output                                                         |
| ------------------------------- | -------------------- | -------------------------------------------------------------- |
| `\begin_inset Note Note`      | **LyX Note**   | Internal notes that will not appear in LaTex or PDF output     |
| `\begin_inset Note Comment`   | **Comment**    | Internal notes that will appear in LaTex but not in PDF output |
| `\begin_inset Note Greyedout` | **Greyed Out** | This note will appear in the output as text in a color         |

You should skip these notes when reading the LyX document, and MUST NOT edit existing ones. You can add new notes to store metadata or comments.

## More Examples

Use official templates at `path/to/lyx/templates/**/*.lyx` and official help files at `path/to/lyx/Resources/doc/*.lyx` to understand more about LyX syntax.
