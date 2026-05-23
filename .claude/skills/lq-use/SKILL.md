---
name: lq-use
description: Read, edit, and manipulate lyx documents (.lyx files)
---

# User Manual

`lq` is a standalone CLI tool designed to parse, query, and mutate LyX (`.lyx`) documents.

## Query Engine (CSS Selectors)

`lq` reads a `.lyx` file and converts it into a structured Concrete Syntax Tree (CST). You can targets specific nodes in the CST using the query engine, which works like CSS selectors:
- **Tags**: `layout` (e.g., standard paragraphs, sections), `inset` (e.g., formulas, footnotes, figures), `property` (e.g. `\family roman`).
- **Attributes**: Target specific names using `layout[Section]`, `inset[Formula]`, or `property[family]`.
- **Descendants**: Space-separated paths like `layout[Section] inset[Formula]` (finds a Formula inside a Section).
- **Pseudo-classes**: Target specific matches using `:first`, `:last`, `:nth-child(an+b)` (supports formulas like `2n+1`, `odd`, `even`). Multiple pseudo-classes can be chained (e.g. `:first:contains("foo")`).
- **Text Content**: Find exact strings using `:contains("specific text")`. It searches recursively through deeply nested insets and is strictly case-sensitive.

## Context-Aware Strict Validation

`lq` features strict context validation. It will actively reject mutations that target core CST boundaries like `body` or `document`. It will also reject `insert` commands if you try to put a layout like `Section` inside an inset like `Foot`, or if you use an unrecognized layout. Unknown inset types in `--raw` content produce a warning to stderr but do NOT block the insertion — match LyX's permissive read path. Always check both stdout (for errors) and stderr (for warnings).

## Commands

### Config
- `lq init [--layouts-dir <path>] [--refresh <mode>] [--track-changes <on|off>]`
  - Without flags
    - Initializes the user configuration file `~/.lq/config.json` with default options. 
    - Or prints the current configuration if it exists.
  - `--layouts-dir <path>`: If not provided, auto-detects the highest installed LyX version's layouts directory.
  - `--refresh <mode>` configures automatic LyX buffer refresh in opened `.lyx` files after mutations:
    - `none` (default): No refresh. LyX detects external changes via its own polling and prompts the user to reload.
    - `reload`: Reload the buffer after `lq` writes. Fast, but discards unsaved in-LyX edits.
    - `save-reload`: Save unsaved edits first, then reload. Preserves everything.
  - `--track-changes <on|off>`: Enable or disable tracked changes for all mutation commands. When on, set preserves old text in `\change_deleted` + new in `\change_inserted`, delete wraps removed nodes in `\change_deleted`, insert wraps new content in `\change_inserted`.

### Query
- `lq schema <file> [--layouts-dir <path>]`
  - Returns a list of all semantically valid layouts for the document's class, as well as global constructs.
  - Exposes categories: `documentLayouts`, `insetLayouts`, `insets`, and `inlineProperties`.
  - Global constructs supported include:
    - **insetLayouts**: `Plain Layout`
    - **insets**: `Note`, `ERT`, `Foot`, `Marginal`, `Branch`, `Box`, `Float`, `Wrap`, `Caption`, `Flex`, `Phantom`, `CommandInset`, `Formula`, `Graphics`, `External`, `Include`, `listings`, `Preview`, `Tabular`, `space`, `VSpace`, `Newline`, `Newpage`, `Separator`, `Line`, `Quotes`, `SpecialChar`, `IPA`, `IPAMacro`, `IPADeco`, `script`, `Argument`, `Info`, `FloatList`, `Index`, `Nomenclature`, `TOC`, `Ending`, `Accent`
    - **inlineProperties**: `change_inserted`, `change_deleted`, `change_unchanged`
- `lq bib <file> [options]`
  - Extracts available citation keys from linked `.bib` bibliography files and outputs them as JSON.
  - Only `.bib` files are supported — other file types (e.g. `.bst`) are ignored.
  - Each citation includes `key`, `author`, `title`, and `year`.
  - `--search <term>`: Filters citations by a case-insensitive substring match across all fields. Multiple words are AND'd. Use this to find the right key from a human description without dumping the entire `.bib` file.
- `lq dump <file>`
  - Outputs the full CST as a massive JSON document.
- `lq read <file> <selector> [options]`
  - Outputs matching nodes and text content as JSON.
  - Options:
    - `--count`: Return only the match count (`{"count": N}`), omitting the data array. Useful for checking blast radius before mutations.

### Mutate
- `lq set <file> <selector> <new text>`
  - Overwrites the targeted nodes with new text content. No structure change (layouts, insets, properties).
- `lq delete <file> <selector>`
  - Safely deletes the targeted nodes from the `.lyx` file.
- `lq insert <file> <selector> <position> [options]`
  - Insert new blocks or properties `before`, `after`, `prepend`, or `append` to a selector. `prepend`/`append` insert as **children** of the target, used for adding insets or text inside a layout. `before`/`after` insert a layout as a **sibling** of the target. Inserting a layout inside another layout via `prepend`/`append` is rejected.
  - Helpers (must provide exactly one generation strategy):
    - `--layout <name> --text <content>`: The safest option. Automatically generates a valid LyX block with the specified text.
    - `--raw-file <path>`: The power-user option. Read raw LyX syntax from a file (e.g., `\begin_layout Itemize\nFoo\n\end_layout`). `lq` will parse it into CST nodes. Useful for injecting complex structures like nested formulas and batch insertion. Avoids shell escaping issues. If the content is invalid LyX syntax, it will be safely rejected. Unknown inset types produce a warning to stderr but do not block the insertion — this matches LyX's own permissive read path.

# Best Practices

1. **Embrace the Git Workflow**: You are working in a version-controlled workspace. If you accidentally execute a destructive command that corrupts the file or modifies the wrong text, immediately run `git restore <file>` to undo your changes.
2. **Treat LaTeX as Opaque**: `lq` abstracts away the LaTeX layer. Any raw LaTeX (like equations inside `inset[Formula]`) is treated as pure string data. Do not try to parse the LaTeX syntax itself; simply target the `inset[Formula]` node and replace its text content.
3. **Use `:contains` for Precision**: If structural selectors like `:nth-child(5)` feel brittle, use `:contains("unique phrase")` to precisely target the paragraph or inset you want to edit.
4. **Be Token-Efficient**: `lq` operates on files that can be tens of thousands of lines long.
   - **use `dump` VERY carefully** — it serializes the entire CST as JSON, which can consume hundreds of thousands of tokens.
   - **Always use `bib --search`** instead of bare `bib`. A `.bib` file can contain thousands of entries; `--search` filters server-side so only matching citations are returned.
   - **Use `read` with precise selectors** — `layout[Standard]` matches every standard paragraph. Narrow it down with `:contains`, `:first`, or `:nth-child`.
5. **Make sure `lq` is configured**: Always run `lq init` first to set up / confirm configeration. But **NEVER change configreation** without clear instructions or consent from the user.
6. **Stop for LyXServer errors**: If `lq` cannot connect LyXServer, stop immediately and ask the user to turn on LyXServer or turn off auto refresh.

## Safe Mutation Workflow

Mutations apply to all matched nodes of a selector. Specifically,
   - `insert` duplicates the payload once for each matched node.
   - `set` and `delete` apply to *all* matched nodes — an overly broad selector (e.g., `layout[Standard]`) could wipe out the entire document!
   - The `set` command replaces **all** children of a target node. If you target a `Section` layout that contains text *and* a label inset, `set` will destroy the label inset. To preserve inner nested insets, use a more precise selector or rebuild the structure using `--raw`.
   - If there are more than 1 match, a warning is emitted to stderr. Use `lq read --count <file> <selector>` before mutating to check how many nodes will be affected.

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
   Extract the label name from the returned JSON's `children` text nodes. Insert references using `--raw` with the correct label name.
2. **List Items (Itemize, Enumerate, Description)**: Do NOT use `\item` — it is a LaTeX command, not a `.lyx` file format token. LyX never writes `\item` to `.lyx` files and would discard it as an "Unknown token". Instead, each list item is a **separate paragraph** with the list layout:

   ```
   \begin_layout Itemize
   First bullet point.
   \end_layout
   \begin_layout Itemize
   Second bullet point.
   \end_layout
   ```

   To insert multiple list items at once with `--raw`:
   ```bash
   lq insert file.lyx "layout[Standard]:last" after --raw "
   \begin_layout Itemize
   First bullet point.
   \end_layout
   \begin_layout Itemize
   Second bullet point.
   \end_layout
   "
   ```

   For nested lists, use `\begin_deeper` / `\end_deeper` around the nested items. For enumerated lists, use `\begin_layout Enumerate` instead. For description lists, use `\begin_layout Description`.