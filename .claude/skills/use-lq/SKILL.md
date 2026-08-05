---
name: use-lq
description: Use lq to parse, query, and mutate LyX documents (`.lyx` files). Use the LyX CLI to create, import, or export the documents.
allowed-tools: Bash(lq *)
---
# `lq` manual

`lq` is a standalone CLI tool for parsing, querying, and mutating LyX documents (`.lyx` files).

At its core, `lq` operates on a simple lifecycle:

1. **Parse**: Reads a `.lyx` file and converts it into a structured Concrete Syntax Tree (CST). The parse is cached by file-content SHA-256 hash in the selected state scope's `cache/` directory — subsequent reads of the same file deserialize the CST from cache instead of re-parsing. After mutations, the cache is updated with the new CST (write-through), so even back-to-back edits hit the cache after the first parse.
2. **Query**: Uses a CSS-like selector engine to find specific nodes in the CST.
3. **Mutate**: Applies changes (insert, set, delete) to the matched nodes.
4. **Serialize**: Converts the modified CST back into a perfectly formatted `.lyx` file.

## The LyX-to-CST Mapping

To effectively use the query engine, Users need to understand how LyX syntax maps to the CST nodes:

- **Layout Nodes**: Structures like `\begin_layout Section` map to a `layout` tag with a `Section` argument. Users select them using `layout[Section]`.
- **Inset Nodes**: Structures like `\begin_inset Formula` map to an `inset` tag with a `Formula` argument. Users select them using `inset[Formula]`.
- **Property Nodes**: Single-line settings like `\textclass article` map to property nodes.
- **Text Nodes**: The actual text content inside layouts and insets. The parser splits text at every property boundary (`\change_deleted`, `\emph on`, `\family roman`, …), so a text node never straddles a tracked-change region or an inline-style span. Regions and style spans are therefore always **runs of whole nodes** — never sub-node ranges.
- **CST is flat**: Layouts like `Section` and `Standard` are **siblings** under the document body, not parent-child. Use a sibling range such as `layout[Section]:contains('Intro') ~ layout[Standard]:until(layout[Section])` to retrieve paragraphs following a heading.

## Query Engine

The query engine supports traversing the CST using CSS-like selector:

### One rule, two axes: visible vs private notes

Private notes (`Note Note` / `Note Comment`) are for the researcher and are **invisible to `lq` by default** — content matching sees the *visible document* unless you explicitly opt into notes. Every surface lives on exactly one axis:

| Axis | Surfaces | Default |
|---|---|---|
| **Content** — matching / extracting text | `:contains`, bare `text`, `--find`, `split-after`, `--text-only` | **visible-only**: private-note prose is excluded unless the selector is note-scoped |
| **State** — matching change regions / styles | `:change`, `:property` | **visibility-blind**: always see note prose (a deleted note's text is still `:change(deleted)`) |
| **Structure** — locating nodes / lossless views | `layout`/`inset`/`property` tags, `:first`/`:last`/`:nth-child`/`:not`/`:adjacent`/`:until`, `~`, `read`/`dump` CST, `--toc` | **lossless**: note nodes stay present; the TOC never surfaces note headings or note text |

**Default (content axis):** a phrase or text node inside a private note is invisible. To opt in, make the selector **note-scoped** — a `:note` part (`layout:note:contains('X')`, `text:note`) or an explicit `inset[Note …]` path (`inset[Note Note] layout[Plain Layout]`). Note-scope is per `,` group, so `text, text:note` is "visible text + note text". `Note Greyedout` is visible output and is never excluded. GUI-only `status open/collapsed` lines (the inset's expand/collapse state) are never matched as `text`.

- **Tag[args]** — substitute a concrete value from `lq schema <file>` (the names below are categories, not literal queries)

  - `layout[Section]` — a document layout from `documentLayouts`
  - `inset[Formula]` — an inset type from `insets`
  - `inset[CommandInset citation]` — a CommandInset subtype from `commandInsetSubtypes`
  - `property[family]` — an inline property key from `inlineProperties`
  - `text` — text nodes (the actual text content; `text` has no `[args]` — `text[...]` is rejected). GUI-only `status open/collapsed` lines inside insets are never matched as `text`.
- **Combinators**

  - Space for descendant. Example: `layout[Section] inset[Formula]` finds a Formula inside a Section.
  - `~` for sibling. Example: `layout[Section] ~ layout[Standard]` matches all Standard layouts after a Section.
  - `,` for OR group. Example: `layout[Section], inset[Foot]` matches all Section and Foot layouts.
- **Chainable Pseudo-classes** — node predicates: each is a true/false filter that keeps only nodes matching its condition. Must follow a tag (e.g. `layout:contains("text")`, `inset:first`); chain several to narrow further.

  - `:first`, `:last`, `:nth-child(an+b/even/odd)`,
  - `:contains("text")` searches recursively and case-sensitively node children for text.
  - `:not(selector)` excludes nodes that have any descendant matching the inner selector (e.g. `layout[Standard]:not(inset[Formula])` matches Standard layouts that do NOT contain a Formula).
  - `:adjacent(selector)` matches nodes whose immediately preceding sibling matches the inner selector (skips text/property nodes).
  - `:until(selector)` bounds a `~` sibling range — rejects nodes that have a sibling matching the inner selector between themselves and the anchor. Example: `layout[Section]:contains('Intro') ~ layout[Standard]:until(layout[Section])` gives all Standard paragraphs in the Introduction section. **Caution:** `:contains` is recursive (matches body/tables too), so a common heading word explodes the range — anchor on unique heading text and run `--count` first (e.g. `layout[Section]:contains('Introduction'):first`).
  - `:change(current|inserted|deleted)` matches nodes by the tracked-change region they sit in. Text nodes match by their effective region; layouts/insets match if they sit in that region of their parent OR contain text in it, recursively (so `inset:change(deleted)` and its nested `Plain Layout` prose are reachable inside a rejected run); property nodes never match. State is inherited through nested layouts/insets, while inset metadata remains opaque. Also scopes `set --find` / `split-after`.
  - `:property(key[=value])` matches nodes under an inline style state: `text:property(emph)` (emphasis active), `text:property(family=roman)` (roman-family text). Text nodes match by their effective value (case-insensitive; `key` = any non-default value, `key=value` = a specific value); layouts/insets match if they sit in the parent's style span OR contain styled text, including nested layout prose. State is inherited through nested layouts/insets, but Foot status and CommandInset parameter lines remain opaque. Property nodes never match. Change keys are excluded — use `:change()` for regions. Also scopes `set --find` / `split-after`.
  - `:note([Note|Comment])` matches nodes inside a **private** note (`Note Note` / `Note Comment`) or the note inset itself; bare `:note` = any private note, `:note(Note)` / `:note(Comment)` = a specific type, `:note(Greyedout)` is an error (Greyedout is visible output). A `:note` part (or an explicit `inset[Note …]` path like `inset[Note Note] layout[Plain Layout]`) makes the group's content matching see note prose — e.g. `layout:note:contains('X')`, `read f.lyx "text:note"`, `set f.lyx "layout:note" "new"`.
  - **Scoping**: the selector's `:change()`/`:property()` predicates scope `set --find` / `split-after` — a match must be fully inside the selector's region/style combination: `,` OR-groups give a union (e.g. `text:change(current), text:change(deleted)` = current+deleted but not inserted — a diff view/edit), `:` chaining requires every predicate. An unscoped arm makes the scope see-all.
  - Multiple pseudo-classes can be chained (e.g. `:first:contains("foo")`).

## Context-Aware Strict Validation

`lq` features strict context validation. It will actively reject mutations that target core CST boundaries like `body` or `document`. It will also reject `insert` commands if you try to put a layout like `Section` inside an inset like `Foot`, or if you use an unrecognized layout. Unknown inset types produce a warning but do NOT block the insertion.

## Commands

### Config

- State selection is per invocation. Starting at the current working directory,
  `lq` finds the nearest ancestor containing a `.lq` directory. That directory
  supplies local config, cache, and undo state. If none is found, `lq` uses the
  global `<host-native-home>/.lq` state. The global home directory is not
  treated as a local project marker.
- `lq init [--global] [--layouts-dir <path>] [--refresh <mode>] [--track-changes <on|off>] [--max-cache-entries <n>] [--author-name <name>]`
  - `lq init` selects the nearest local `.lq`; if none exists, it creates
    `<current-working-directory>/.lq` and initializes its config.
  - `lq init --global` selects only the global target. Every other init option
    works the same way for local and global configuration.
  - Without options, prints the selected config if it exists; otherwise creates
    it with built-in defaults and auto-detected layouts.
  - New config precedence is built-in defaults, then explicit options. Existing
    config precedence is existing values, then explicit options; omitted values
    persist, including `layoutsDir`.
  - Successful init responses include `scope`, `configPath`, `action` (`read`,
    `created`, or `updated`), and the configuration under `data`.
  - Local and global config, cache, and undo state are strictly isolated. A
    local cache miss or undo lookup never falls back to global state.
  - Local init and commands using an existing local `.lq` do not require a home
    environment variable. Global fallback and `--global` require a resolvable
    home directory.
  - `--layouts-dir <path>`: If not provided, auto-detects the highest installed LyX version's layouts directory.
  - `--refresh <mode>` configures automatic LyX buffer refresh in opened `.lyx` files after mutations:
    - `none` (default): No refresh. LyX detects external changes via its own polling and prompts the user to reload.
    - `reload`: Reload the buffer after `lq` writes. Fast, but discards unsaved in-LyX edits. Best-effort — warns if LyX is unreachable or the reload can't be confirmed (the file is still written).
    - `save-reload`: Save unsaved edits first, then reload. Preserves everything. Aborts only when LyX is genuinely unreachable or reports a save error. On Windows, LyXserver can lose a command's response even though the command executed: an unconfirmed save proceeds with a warning instead of aborting, since the save was almost certainly applied.
    - Setting a non-`none` mode makes `lq init` run a fast reachability probe and warn if LyXServer can't be reached (no socket found, or LyX is not accepting commands) — the warning doesn't abort init; enable LyXServer in LyX Preferences and restart LyX.
  - `--track-changes <on|off>`: Enable or disable tracked changes for all mutation commands (default on).
  - `--author-name <name>`: Set the author recorded on new tracked changes (default `"lq user"`).
  - `--max-cache-entries <n>`: Set the maximum number (default 50) of cached parse results in the selected state's `cache/` directory. `<n>` must be a complete non-negative integer; malformed numeric prefixes are rejected.

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
  - `--toc`: Output a hierarchical heading tree (table of contents) instead of the raw CST. Heading levels come from the document class's `.layout` file (LaTeX's standard hierarchy as fallback). Mutually exclusive with `<selector>`.
  - `--depth <n>`: Limit the output depth. Meaning depends on the mode:
    - Raw CST (default or `<selector>`): parse-tree nesting — `--depth 0` = root node only, `--depth 1` = direct children, `--depth N` = descend N levels; omit `--depth` for full depth.
    - With `--toc`: absolute LyX `TocLevel` up to any integer. Typically `--depth 1` = Sections in the document.
- `lq read <file> <selector> [--count] [--text-only]`
  - Read matched nodes. Default mode returns CST nodes.
  - `--count`: Return match counts by type (`{"count": {"layout[Section]": 12, "layout[Standard]": 450}}`).
  - `--text-only`: Output the text content of matched nodes with structural annotations. Each matched node gets a `tag[args]` prefix (e.g. `layout[Standard]`), and insets appear as inline markers (e.g. `inset[Foot]`).

### Mutate

- `lq set <file> <selector> <new text> [--replace-all] [--find <substring>]`
  - Default behaviour: replaces text content within the targeted nodes while preserving insets as current content. Inline properties around the replaced text are dropped when tracking is off (no dead markup).
  - `--replace-all`: Wipe all children and rebuild from scratch.
  - `--find <substring>` (Mutually exclusive with `--replace-all`): Surgical substring replacement — replace only the specified substring within the matched nodes' text. All occurrences are replaced. Scope to a tracked-change region (`:change(...)`) or inline style (`:property(...)`) via the selector; combine regions with `,` (union) and predicates with `:` chaining.
- `lq delete <file> <selector>`
  - Deletes the targeted nodes.
- `lq undo <file> <selector> [<substring>]`
  - 1-level **Snapshot restore** (default, no substring): consume the snapshot stored in the selected local or global state's `undo/` directory to revert the last (tracked or plain) mutation, even when the mutation deleted the matched nodes.
  - Unlimited-level **Replay undo**: removes only the tracked-change block containing `<substring>` and made by the current author. A paired `set` edit is not restored as one unit; use snapshot restore for that. Can be reverted by snapshot restore.
- `lq insert <file> <selector> <position> [helper]`
  - Insert new blocks or properties relative to a selector.
  - Positions:
    - `before`/`after`: insert a layout as a **sibling** of the target.
    - `prepend`/`append`: insert as **children** of the target, used for adding insets or text inside a layout.
    - `split-after <text>`: split a **block target** (such as `layout` or `inset`) right after the exact, case-sensitive substring and insert new content at that point. A direct `text` selector is not a valid target; apply `:change(...)` or `:property(...)` to the containing block instead. All text is visible by default, including `\change_deleted`; scope with `:change(...)` or `:property(...)`. Recursive `split-after` reaches prose in nested layouts inside insets but never inset metadata. Only proceeds if the match appears **exactly once** in the matched text. For prose with citations, insert a text + citation-inset payload in one pass with `--raw-file`; for complex payloads, prefer two passes (skeleton first, then populate).
  - Helpers (must provide exactly one generation strategy):
    - `--layout <name> --text <content>`: Insert a layout block with the given name and text (e.g., --layout 'Standard' --text 'Hello world'). --text requires --layout, except with 'split-after' where bare --text inserts inline text.
    - `--cite <key> [--cite-cmd <command>]`: Insert a citation inset. Valid `--cite-cmd` values: `cite`, `citet` (default), `citep`, `citeauthor`, `citeyear`, `citeyearpar`, `citebyear`, `footcite`, `autocite`, `citetitle`, `fullcite`, `footfullcite`, `nocite`, `keyonly`.
    - `--ref <label> [--ref-cmd <command>]`: Insert a cross-reference inset. Valid `--ref-cmd` values: `ref` (default), `eqref`, `pageref`, `vpageref`, `vref`, `nameref`, `formatted`, `labelonly`.
    - `--label <name>`: Insert a label inset (`CommandInset label`) with the given name.
    - `--footnote <text>`: Insert a footnote inset (`Foot`) containing a `Plain Layout` with the given text. For complex footnotes (citations, cross-refs, math), use the two-pass approach: create the skeleton with `--footnote`, then populate with `split-after` and other helpers.
    - `--raw-file <path>`: The power-user option for complex structures (e.g. nested formulas, batch insertion, non-default citation/reference params). Read raw LyX syntax from a file and parse it into CST nodes. Example: `\begin_layout Standard\nHello\n\end_layout`

## Tracked Changes

With `--track-changes on` (the default), mutations record a reviewable edit instead of silently rewriting text: old content goes in `\change_deleted`, new content in `\change_inserted`, and the header gains `\tracking_changes true` plus an `\author` entry.

**How each mutation records a change:**
- `set` — old text in `\change_deleted` + new in `\change_inserted`. On a full-text `set`, inline properties around the replaced text are kept **in place** inside `\change_deleted`, so rejecting the change restores the original formatting; insets are preserved as current content outside the change pair.
- `delete` — matched nodes wrapped in `\change_deleted`.
- `insert` — new content wrapped in `\change_inserted`.

**Selecting tracked changes:** `:contains(...)` matches text inside `\change_deleted`.

**Mutating tracked changes:** `--find` and `split-after` match `\change_deleted` as well. Editing rejected text inserts the replacement as a new tracked change adjacent to the deletion (never nested); the deleted text is preserved. Scope a find to specific regions/styles with the selector's `:change(...)`/`:property(...)` predicates (union via `,`, conjunction via `:` chaining) — e.g. `text:change(deleted), text:change(inserted)` for a diff-only view/edit.

State-scoped edits also reach prose in nested layouts inside an atomically tracked inset. The enclosing change/style state is inherited, while inset metadata such as `status`, `LatexCommand`, and citation parameters is not matchable or editable as prose.

**Viewing tracked changes:** `dump` and `read` (default) annotate text inside tracked blocks with `changeStatus` (`deleted`/`inserted`); `read --text-only` marks them inline as `\change_deleted{...}` / `\change_inserted{...}`.

# Best Practices

## Before you start

1. **Run `lq init`**: Confirm configuration is set. Only change configuration with explicit user consent.
2. **Stage before mutating**: `git stage`, then review with `git diff`. `git restore` reverts everything; Use `lq undo` for surgical restores. There is no `--dry-run` flag because git + undo cover the same need.
3. **Treat LaTeX as Opaque**: `lq` abstracts away the LaTeX layer. Raw LaTeX (like equations inside `inset[Formula]`) is pure string data. Target the `inset[Formula]` node and replace its text content.
4. **Connect LyXServer in save-reload mode**: see [`LyX_CLI.md`](LyX_CLI.md).

## Smart query

Navigate large documents strategically with a zoom-in approach with scoped queries:

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


## Safe Mutation Workflow

All mutations (`insert`, `set`, `delete`, `undo`) apply to all matched nodes of a selector. In particular,

- `insert` duplicates the payload once for each matched node.
- `set` and `delete` could wipe out the entire document with an overly broad selector (e.g., `layout[Standard]`).
- If more than 1 node matches, a warning is issued (except for `undo`).

When modifying a document, follow this safe workflow:

1. **Check Schema**: Documents vary wildly. A `Beamer` presentation allows `Frame` layouts, but an `article` does not. Run `lq schema <file>` to know what layouts and insets are legally allowed in the specific document.
2. **Test Blast Radius**: Run `lq read <file> <selector> --count` first. The subtype breakdown (e.g. `{"layout[Section]": 8, "layout[Standard]": 120}`) tells you the composition — if you meant to target sections but see 120 Standard layouts, your selector is wrong. Narrow before mutating: anchor on unique text, take one with `:first`, and prefer `layout:contains(...)` + `--text-only` inspection over `text:` selectors.
3. **Surgical edit** (typo fix, rephrase, word change): Use `lq set ... --find "old substring"`. **Keep `new_text` scoped to only the changed substring.** `--find` operates on individual text nodes; `new_text` is the literal replacement, not merged with surrounding nodes.
4. **Verify the edit**: after any mutation, `lq read <file> "<selector>" --text-only` (or `--count`) confirms the result — the no-GUI diff substitute; `git diff` remains the general answer.

## Cross-Referencing

Before inserting a cross-reference, find the exact label names. Labels are stored as text inside `CommandInset label` insets. Query all labels with:

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

## Citations

Before inserting a citation, find citation keys with:

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

## List Items (Itemize, Enumerate, Description): 

Each list item is a **separate paragraph** with the list layout. LyX uses repeated `\begin_layout Itemize` blocks (not `\item`, which is a LaTeX command LyX discards as an "Unknown token"):

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

# LyX manual

## LyX Syntax Reference

For raw inset syntax (citation params, cross-reference params, note inset subtypes), read [`LyX_syntax.md`](LyX_syntax.md). Load it when constructing `--raw-file` payloads or when you need exact parameter defaults for a citation or cross-reference inset.

## LyX CLI

See [`LyX_CLI.md`](LyX_CLI.md) for how to create, import, and export LyX documents, and open the LyX GUI to establish a LyXServer connection using the LyX CLI.
