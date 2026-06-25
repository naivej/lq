---
name: use-lq
description: Read, edit, and manipulate lyx documents (.lyx files)
allowed-tools: Bash(lq *)
---

# User Manual

`lq` is a standalone CLI tool designed to parse, query, and mutate LyX (`.lyx`) documents.

## Query Engine (CSS Selectors)

`lq` reads a `.lyx` file and converts it into a structured Concrete Syntax Tree (CST). 
- **CST is flat**: Layouts like `Section` and `Standard` are **siblings** under the document body, not parent-child. `layout[Section] layout[Standard]` returns nothing — Standard paragraphs don't live inside Section blocks.

You can targets specific nodes in the CST using the query engine, which works like CSS selectors:
- **Tags**: `layout` (e.g., standard paragraphs, sections), `inset` (e.g., formulas, footnotes, figures), `property` (e.g. `\family roman`).
- **Attributes**: Target specific names using `layout[Section]`, `inset[Formula]`, or `property[family]`.
- **Descendants**: Space-separated paths like `layout[Section] inset[Formula]` (finds a Formula inside a Section).
- **Pseudo-classes** to target specific matches (must follow a tag e.g., `layout:contains("text")`, `inset:first`):
  - `:first`, `:last`, `:nth-child(an+b)` (supports formulas like `2n+1`, `odd`, `even`).
  - `:not(selector)` excludes nodes that have any descendant matching the inner selector (e.g. `layout[Standard]:not(inset[Formula])` matches Standard layouts that do NOT contain a Formula).
  - `:adjacent(selector)` matches nodes whose immediately preceding sibling matches the inner selector (skips text/property nodes).
  - `:contains("text")` searches recursively and case-sensitively node children for text.
  - Multiple pseudo-classes can be chained (e.g. `:first:contains("foo")`).

## Context-Aware Strict Validation

`lq` features strict context validation. It will actively reject mutations that target core CST boundaries like `body` or `document`. It will also reject `insert` commands if you try to put a layout like `Section` inside an inset like `Foot`, or if you use an unrecognized layout. Unknown inset types produce a warning to stderr but do NOT block the insertion. Always check both stdout (for errors) and stderr (for warnings).

## Commands

### Config
- `lq init [--layouts-dir <path>] [--refresh <mode>] [--track-changes <on|off>] [--max-cache-entries <n>]`
  - Without flags
    - Initializes the user configuration file `~/.lq/config.json` with default options. 
    - Or prints the current configuration if it exists.
  - `--layouts-dir <path>`: If not provided, auto-detects the highest installed LyX version's layouts directory.
  - `--refresh <mode>` configures automatic LyX buffer refresh in opened `.lyx` files after mutations:
    - `none` (default): No refresh. LyX detects external changes via its own polling and prompts the user to reload.
    - `reload`: Reload the buffer after `lq` writes, fail silently if LyXserver disconnects. Fast, but discards unsaved in-LyX edits.
    - `save-reload`: Save unsaved edits first, then reload. Preserves everything. Throw an error and abort if LyXserver disconnects
  - `--track-changes <on|off>`: Enable or disable (default) tracked changes for all mutation commands. When on, set `\tracking_changes true` and add an `\author` entry in the document header. 
    - Set preserves old text in `\change_deleted` + new in `\change_inserted`
    - Delete wraps removed nodes in `\change_deleted`
    - Insert wraps new content in `\change_inserted`
  - `--max-cache-entries <n>`: Set the maximum number of cached parse results in `~/.lq/cache/`. Default: 50.

### Query
- `lq schema <file> [--layouts-dir <path>]`
  - Returns a list of all semantically valid layouts for the document's class, as well as global constructs, across 4 categories: `documentLayouts`, `insetLayouts`, `insets`, and `inlineProperties`. Global constructs include:
    - **insetLayouts**: `Plain Layout`
    - **insets**: `Note`, `ERT`, `Foot`, `Marginal`, `Branch`, `Box`, `Float`, `Wrap`, `Caption`, `Flex`, `Phantom`, `CommandInset`, `Formula`, `Graphics`, `External`, `Include`, `listings`, `Preview`, `Tabular`, `space`, `VSpace`, `Newline`, `Newpage`, `Separator`, `Line`, `Quotes`, `SpecialChar`, `IPA`, `IPAMacro`, `IPADeco`, `script`, `Argument`, `Info`, `FloatList`, `Index`, `Nomenclature`, `TOC`, `Ending`, `Accent`
    - **inlineProperties**: `change_inserted`, `change_deleted`, `change_unchanged`
  - `--layouts-dir <path>`: overrides the config.
- `lq bib <file> [--search <text>]`
  - Extracts available citation keys from linked `.bib` bibliography files and outputs them as JSON.
  - Only `.bib` files are supported — other file types (e.g. `.bst`) are ignored.
  - Each citation includes `key`, `author`, `title`, and `year`.
  - `--search <text>`: Filters citations by a case-insensitive substring match across all fields. Multiple words are AND'd. Use this to find the right key from a human description without dumping the entire `.bib` file.
- `lq dump <file> [<selector>] [--depth <n>]`
  - Outputs the CST as a JSON document.
  - Selector: Scope the dump to matching nodes. Omit to dump the whole document.
  - Depth: `--depth 0` shows only the root node; `--depth 1` shows direct children; `--depth N` descend N levels from root; omit `--depth` for the full CST.
- `lq read <file> <selector> [--count] [--text-only]`
  - Outputs matching nodes and text content as JSON.
  - `--count`: Return only the match count (`{"count": N}`), omitting the data array. Useful for checking blast radius before mutations.
  - `--text-only` (Mutually exclusive with `--count`): Output the text content of matched nodes as plain text with structural annotations. Each matched node gets a `tag[args]` prefix (e.g. `layout[Standard]`), and insets appear as inline markers (e.g. `inset[Foot]`). Double newline between nodes.

### Mutate
- `lq set <file> <selector> <new text> [--replace-all] [--find <substring>]`
  - Replaces text content within the targeted nodes while preserves non-text children (insets, properties) by default. 
  - `--replace-all`: Wipe all children and rebuild from scratch.
  - `--find <substring>` (Mutually exclusive with `--replace-all`): Surgical substring replacement — replace only the specified substring within the matched nodes' text. All occurrences are replaced; a count is emitted to stderr.
- `lq delete <file> <selector>`
  - Deletes the targeted nodes.
- `lq insert <file> <selector> <position> [helper]`
  - Insert new blocks or properties relative to a selector.
  - Positions:
    - `before`/`after`: insert a layout as a **sibling** of the target.
    - `prepend`/`append`: insert as **children** of the target, used for adding insets or text inside a layout.
    - `split-after <text>`: split a text node right after the exact, case-sensitive substring and insert new content at that point. Only proceeds if the match appears **exactly once** in the target block.
  - Helpers (must provide exactly one generation strategy):
    - `--layout <name> --text <content>`: The safest option. Automatically generates a valid LyX block with the specified text.
    - `--cite <key> [--cite-cmd <command>]`: Insert a citation inset. Valid `--cite-cmd` values: `cite`, `citet` (default), `citep`, `citeauthor`, `citeyear`, `citeyearpar`, `citebyear`, `footcite`, `autocite`, `citetitle`, `fullcite`, `footfullcite`, `nocite`, `keyonly`.
    - `--ref <label> [--ref-cmd <command>]`: Insert a cross-reference inset. Valid `--ref-cmd` values: `ref` (default), `eqref`, `pageref`, `vpageref`, `vref`, `nameref`, `formatted`, `labelonly`.
    - `--label <name>`: Insert a label inset (`CommandInset label`) with the given name.
    - `--footnote <text>`: Insert a footnote inset (`Foot`) containing a `Plain Layout` with the given text. For complex footnotes (citations, cross-refs, math), use the two-pass approach: create the skeleton with `--footnote`, then populate with `split-after` and other helpers.
    - `--raw-file <path>`: The power-user option for complex structures (e.g. nested formulas, batch insertion, non-default citation/reference params). Read raw LyX syntax from a file and parse it into CST nodes.

# Best Practices

1. **Embrace the Git Workflow**: You should work in a version-controlled workspace. `git stage` and `git restore` is essentially the dry run. `git commit` for checkpoints / milestones so you can undo unwanted changes.
2. **Treat LaTeX as Opaque**: `lq` abstracts away the LaTeX layer. Any raw LaTeX (like equations inside `inset[Formula]`) is treated as pure string data. Do not try to parse the LaTeX syntax itself; simply target the `inset[Formula]` node and replace its text content.
3. **Match the query tool to the task** — `lq` operates on files that can be tens of thousands of lines. Using the wrong command wastes tokens and hides the information you need.

   | You want to… | Use this |
   |---|---|
   | See the document outline | `lq dump <file> --depth 2` |
   | Scan all body text | `lq read <file> "layout" --text-only` |
   | Get just section headings | `lq read <file> "layout[Section]" --text-only` |
   | Find a specific paragraph by content | `lq read <file> "layout:contains('unique phrase')" --text-only` |
   | Check how many nodes a selector matches | `lq read <file> "<selector>" --count` |
   | Inspect a specific node's CST | `lq read <file> "<precise selector>"` |
   | Deep-debug a node's children | `lq dump <file> "<selector>"` |
   | Find a citation key | `lq bib <file> --search "keyword"` |

   **Never:** bare `lq dump` (100K+ tokens), bare `lq bib` (thousands of entries), or `lq read "layout"` without `--text-only` (full JSON for every paragraph).
4. **Make sure `lq` is configured**: Always run `lq init` first to set up / confirm configeration. But **NEVER change configreation** without clear instructions or consent from the user.
5. **Stop for LyXServer errors**: If `lq` cannot connect LyXServer, stop immediately and ask the user to turn on LyXServer or turn off auto refresh.

## Safe Mutation Workflow

Mutations apply to all matched nodes of a selector. Specifically,
   - `insert` duplicates the payload once for each matched node.
   - `set` and `delete` apply to *all* matched nodes — an overly broad selector (e.g., `layout[Standard]`) could wipe out the entire document!
   - If there are more than 1 match, a warning is emitted to stderr with the count.

When modifying a document, follow this safe workflow:
1. **Check Schema**: Documents vary wildly. A `Beamer` presentation allows `Frame` layouts, but an `article` does not. Run `lq schema <file>` to know what layouts and insets are legally allowed in the specific document.
2. **Test Blast Radius (i.e. the number of nodes a selector matches)**: Run `lq read --count <file> <selector>` to verify how many nodes the selector matches. Then `lq read <file> <selector>` to verify selector targets exactly what's intended.
3. **Choose the right mutation strategy**:
   - **Surgical edit** (typo fix, rephrase, word change): Use `lq set ... --find "old substring"`.
   - **Full replacement** (title change, rewrite paragraph): Use plain `lq set` or `lq set --replace-all`.
   - **Structural change** (add/remove/move sections): Use `lq insert` / `lq delete`.

## HOW-TO
1. **Cross-Referencing**: Before inserting a cross-reference, find the exact label names. Labels are stored as text inside `CommandInset label` insets. Query all labels with:
   ```bash
   lq read <file> "inset[CommandInset label]"
   ```
   To filter by prefix (e.g., all section labels): 
   ```bash
   lq read <file> "inset[CommandInset label]:contains('sec:')"
   ```
   Extract the label name from the returned JSON's `children` text nodes.

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

| Param | Default | Notes |
|-------|---------|-------|
| `key` | *(required)* | BibTeX citation key |
| `literal` | `"false"` | `"true"` bypasses cite engine formatting |
| `after` | `""` | Text after citation, e.g. `"p. 42"` |
| `before` | `""` | Text before citation, e.g. `"see "` |
| `pretextlist` | `""` | Multi-citation preamble |
| `posttextlist` | `""` | Multi-citation postamble |

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

| Param | Default | Notes |
|-------|---------|-------|
| `reference` | *(required)* | Label name |
| `plural` | `"false"` | "Section" → "Sections" |
| `caps` | `"false"` | Capitalize prefix |
| `noprefix` | `"false"` | Hide "Section"/"Figure" prefix |
| `nolink` | `"false"` | No hyperlink |
| `tuple` | `"list"` | `"list"` or `"range"` for multi-refs |

The `plural`/`caps`/`noprefix`/`nolink`/`tuple` params are LyX-internal — they affect GUI display, not LaTeX output.

## Note Insets

The `Note` inset family has three subtypes. All use `\begin_inset Note <subtype>`:

| Syntax | LyX UI Name | Output |
|---|---|---|
| `\begin_inset Note Note` | **LyX Note** | Internal notes that will not appear in LaTex or PDF output |
| `\begin_inset Note Comment` | **Comment** | Internal notes that will appear in LaTex but not in PDF output |
| `\begin_inset Note Greyedout` | **Greyed Out** | This note will appear in the output as text in a color |

You should skip these notes when reading the LyX document, and MUST NOT edit existing ones. You can add new notes to store metadata or comments.

## More Examples
Use official templates at `path/to/lyx/templates/**/*.lyx` and official help files at `path/to/lyx/Resources/doc/*.lyx` to understand more about LyX syntax.
