---
name: lq-use
description: Read, edit, and manipulate lyx documents (.lyx files)
---

## User Manual

`lq` is a standalone CLI tool designed to parse, query, and mutate LyX (`.lyx`) documents. `lq` operates on a simple lifecycle:
1. **Parse**: Reads a `.lyx` file and converts it into a structured Concrete Syntax Tree (CST).
2. **Query**: Uses a CSS-like selector engine to find specific nodes in the CST.
3. **Mutate**: Applies changes (insert, set, delete) to the matched nodes.
4. **Serialize**: Converts the modified CST back into a perfectly formatted `.lyx` file.

### The Query Engine (CSS Selectors)
The core of `lq` is its query engine, which targets specific nodes in the Concrete Syntax Tree (CST):
- **Tags**: `layout` (e.g., standard paragraphs, sections), `inset` (e.g., formulas, footnotes, figures), `property` (e.g. `\family roman`).
- **Attributes**: Target specific names using `layout[Section]`, `inset[Formula]`, or `property[family]`.
- **Descendants**: Space-separated paths like `layout[Section] inset[Formula]` (finds a Formula inside a Section).
- **Pseudo-classes**: Target specific matches using `:first`, `:last`, `:nth-child(an+b)` (supports formulas like `2n+1`, `odd`, `even`). Multiple pseudo-classes can be chained (e.g. `:first:contains("foo")`).
- **Text Content**: Find exact strings using `:contains("specific text")`. It searches recursively through deeply nested insets and is strictly case-sensitive.

### Core Commands
- **`schema <file>`**: Returns a JSON list of all legally allowed layouts and insets for the document's class.
- **`read <file> <selector>`**: Outputs the matching nodes as JSON. Crucial for verifying what your selector targets.
- **`insert <file> <selector> <position> [options]`**: Inserts new content `before`, `after`, `prepend`, or `append` relative to the selector.
  - *Example*: `insert file.lyx "layout[Section]:first" after --layout "Standard" --text "New text"`
  - *Helpers*: Use exactly one of `--layout <name> --text <text>`, or `--raw <string>`.
  - *Tracking*: Add `--track-changes <inserted|deleted>` to automatically register the author in the LyX header and track your edits. Both modes simply wrap the inserted content in tracking markers, but `inserted` is standard for new text.
- **`set <file> <selector> <new text> [options]`**: Overwrites the text content of the targeted nodes.
  - *Tracking*: Add `--track-changes <inserted|deleted>` to mark the text replacement. In `inserted` mode, it deletes the old text permanently and marks the new text as inserted. In `deleted` mode, it preserves the old text as `deleted` and appends the new text as `inserted` (this provides the standard WYSIWYM track-changes behavior).
  - *Warning*: `set` replaces *all* children of the matched node. If you target a `Section` layout that contains text *and* a label inset, `set` will destroy the label inset. To preserve inner nested insets, use a more precise selector to target only the `TextNode` itself (if supported), or rebuild the structure using `--raw`. 
- **`delete <file> <selector>`**: Deletes the targeted nodes completely.
- **`init [--layouts-dir <path>]`**: Initializes the `~/.lq/config.json` file.
- **`lq bib <file>`**: Finds literature to cite. This command parses the linked `.bib` files and returns a JSON list of all available citation keys, authors, titles, and years. You can then insert citations using the `--raw` payload.

*(Note: `lq` features strict context validation. It will actively reject mutations that target core CST boundaries like `body` or `document`. It will also reject `insert` commands if you try to put a layout like `Section` inside an inset like `Foot`, or if you use an unrecognized layout. Read the errors carefully!)*

## Best Practices

1. **Test Your Blast Radius**: `lq` intentionally lacks a `--dry-run` flag. Commands like `delete layout[Standard]` will delete *every single standard paragraph in the document*. **Always run `read` first** to ensure your CSS selector matches the exact node(s) you intend to mutate.
2. **Consult the Schema**: Documents vary wildly. A `Beamer` presentation allows `Frame` layouts, but an `article` does not. Before inserting new layouts into an unfamiliar document, run the `schema` command to see the legal menu of options.
3. **Embrace the Git Workflow**: You are working in a version-controlled workspace. If you accidentally execute a destructive command that corrupts the file or modifies the wrong text, immediately run `git restore <file>` to undo your changes.
4. **Treat LaTeX as Opaque**: `lq` abstracts away the LaTeX layer. Any raw LaTeX (like equations inside `inset[Formula]`) is treated as pure string data. Do not try to parse the LaTeX syntax itself; simply target the `inset[Formula]` node and replace its text content.
5. **Use `:contains` for Precision**: If structural selectors like `:nth-child(5)` feel brittle, use `:contains("unique phrase")` to precisely target the paragraph or inset you want to edit.
6. **Cross-Referencing**: Before inserting a cross-reference, find the exact label names by querying `lq read <file> "inset[CommandInset label] property[name]"`. This returns all valid targets (e.g., `sec:Intro`, `fig:1`). You can insert references to these using the `--raw` payload.

