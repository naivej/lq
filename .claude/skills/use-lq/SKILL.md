---
name: use-lq
description: Read, edit, and manipulate lyx documents (.lyx files)
---

# User Manual

`lq` is a standalone CLI tool designed to parse, query, and mutate LyX (`.lyx`) documents.

## Query Engine (CSS Selectors)

`lq` reads a `.lyx` file and converts it into a structured Concrete Syntax Tree (CST). 
- **CST is flat**: Layouts like `Section` and `Standard` are **siblings** under the document body, not parent-child. `layout[Section] layout[Standard]` returns nothing — Standard paragraphs don't live inside Section blocks. Use `:contains()` or positional selectors (`:first`, `:nth-child`) to navigate instead.
- **No sibling combinators**: `~` and `+` are not supported. Use `:nth-child()` or multiple `read` commands to find adjacent nodes.

You can targets specific nodes in the CST using the query engine, which works like CSS selectors:
- **Tags**: `layout` (e.g., standard paragraphs, sections), `inset` (e.g., formulas, footnotes, figures), `property` (e.g. `\family roman`).
- **Attributes**: Target specific names using `layout[Section]`, `inset[Formula]`, or `property[family]`.
- **Descendants**: Space-separated paths like `layout[Section] inset[Formula]` (finds a Formula inside a Section).
- **Pseudo-classes**: Target specific matches using `:first`, `:last`, `:nth-child(an+b)` (supports formulas like `2n+1`, `odd`, `even`). `:not(selector)` excludes nodes that have any descendant matching the inner selector (e.g. `layout[Standard]:not(inset[Formula])` matches Standard layouts that do NOT contain a Formula). Multiple pseudo-classes can be chained (e.g. `:first:contains("foo")`).
- **Text Content**: Find exact strings using `:contains("text")`. It searches recursively through deeply nested insets and is strictly case-sensitive.

## Context-Aware Strict Validation

`lq` features strict context validation. It will actively reject mutations that target core CST boundaries like `body` or `document`. It will also reject `insert` commands if you try to put a layout like `Section` inside an inset like `Foot`, or if you use an unrecognized layout. Unknown inset types produce a warning to stderr but do NOT block the insertion. Always check both stdout (for errors) and stderr (for warnings).

## Commands

### Config
- `lq init [--layouts-dir <path>] [--refresh <mode>] [--track-changes <on|off>]`
  - Without flags
    - Initializes the user configuration file `~/.lq/config.json` with default options. 
    - Or prints the current configuration if it exists.
  - `--layouts-dir <path>`: If not provided, auto-detects the highest installed LyX version's layouts directory.
  - `--refresh <mode>` configures automatic LyX buffer refresh in opened `.lyx` files after mutations:
    - `none` (default): No refresh. LyX detects external changes via its own polling and prompts the user to reload.
    - `reload`: Reload the buffer after `lq` writes, fail silently if LyXserver disconnects. Fast, but discards unsaved in-LyX edits.
    - `save-reload`: Save unsaved edits first, then reload. Preserves everything. Throw an error and abort if LyXserver disconnects
  - `--track-changes <on|off>`: Enable or disable (default) tracked changes for all mutation commands. When on, set preserves old text in `\change_deleted` + new in `\change_inserted`, delete wraps removed nodes in `\change_deleted`, insert wraps new content in `\change_inserted`.

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
- `lq read <file> <selector> [--count]`
  - Outputs matching nodes and text content as JSON.
  - `--count`: Return only the match count (`{"count": N}`), omitting the data array. Useful for checking blast radius before mutations.

### Mutate
- `lq set <file> <selector> <new text> [--replace-all]`
  - Replaces text content within the targeted nodes. By default, preserves non-text children (insets, properties) — use `--replace-all` to wipe all children and rebuild from scratch.
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

1. **Embrace the Git Workflow**: You are working in a version-controlled workspace. If you accidentally execute a destructive command that corrupts the file or modifies the wrong text, immediately run `git restore <file>` to undo your changes.
2. **Treat LaTeX as Opaque**: `lq` abstracts away the LaTeX layer. Any raw LaTeX (like equations inside `inset[Formula]`) is treated as pure string data. Do not try to parse the LaTeX syntax itself; simply target the `inset[Formula]` node and replace its text content.
3. **Use `:contains` for Precision**: If structural selectors like `:nth-child(5)` feel brittle, use `:contains("unique phrase")` to precisely target the paragraph or inset you want to edit.
4. **Be Token-Efficient**: `lq` operates on files that can be tens of thousands of lines long.
   - **Use `dump --depth n`** instead of bare `dump`. A full CST dump can consume hundreds of thousands of tokens; depth-limited output gives you the document outline without the noise.
   - **Always use `bib --search`** instead of bare `bib`. A `.bib` file can contain thousands of entries; `--search` filters server-side so only matching citations are returned.
   - **Use `lq read --count` first** — `layout[Standard]` matches every standard paragraph. Check the count before reading full data or mutating.
5. **Make sure `lq` is configured**: Always run `lq init` first to set up / confirm configeration. But **NEVER change configreation** without clear instructions or consent from the user.
6. **Stop for LyXServer errors**: If `lq` cannot connect LyXServer, stop immediately and ask the user to turn on LyXServer or turn off auto refresh.

## Safe Mutation Workflow

Mutations apply to all matched nodes of a selector. Specifically,
   - `insert` duplicates the payload once for each matched node.
   - `set` and `delete` apply to *all* matched nodes — an overly broad selector (e.g., `layout[Standard]`) could wipe out the entire document!
   - If there are more than 1 match, a warning is emitted to stderr with the count.

When modifying a document, users should follow this safe workflow:
1. **Check Schema**: Documents vary wildly. A `Beamer` presentation allows `Frame` layouts, but an `article` does not. Run `lq schema <file>` to know what layouts and insets are legally allowed in the specific document.
2. **Test Blast Radius (i.e. the number of nodes a selector matches)**: Run `lq read --count <file> <selector>` to verify how many nodes the selector matches. Then `lq read <file> <selector>` to verify selector targets exactly what's intended.

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

## More Examples
Use `lq init` to auto-detect LyX installation's layouts directory. The official templates are at `../templates/**/*.lyx` relative to the layouts directory. Read them to see real-world examples of LyX syntax for different constructs.