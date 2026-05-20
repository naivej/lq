---
name: lq-use
description: Read, edit, and manipulate lyx documents (.lyx files)
---

## User Manual

`lq` is a standalone CLI tool designed to parse, query, and mutate LyX (`.lyx`) documents.

### Query Engine (CSS Selectors)
`lq` reads a `.lyx` file and converts it into a structured Concrete Syntax Tree (CST). You can targets specific nodes in the CST using the query engine, which works like CSS selectors:
- **Tags**: `layout` (e.g., standard paragraphs, sections), `inset` (e.g., formulas, footnotes, figures), `property` (e.g. `\family roman`).
- **Attributes**: Target specific names using `layout[Section]`, `inset[Formula]`, or `property[family]`.
- **Descendants**: Space-separated paths like `layout[Section] inset[Formula]` (finds a Formula inside a Section).
- **Pseudo-classes**: Target specific matches using `:first`, `:last`, `:nth-child(an+b)` (supports formulas like `2n+1`, `odd`, `even`). Multiple pseudo-classes can be chained (e.g. `:first:contains("foo")`).
- **Text Content**: Find exact strings using `:contains("specific text")`. It searches recursively through deeply nested insets and is strictly case-sensitive.

### Safe Mutation Workflow
`lq` features strict context validation. It will actively reject mutations that target core CST boundaries like `body` or `document`. It will also reject `insert` commands if you try to put a layout like `Section` inside an inset like `Foot`, or if you use an unrecognized layout. Read the errors carefully!

When modifying a document, users should follow this safe workflow:
1. **Check Schema**: Run `lq schema <file>` to know what layouts and insets are legally allowed in the specific document.
2. **Test Blast Radius**: Run `lq read <file> <selector>` to verify your selector targets exactly what you intend.
   - *Blast Radius* refers to the number of nodes a selector matches. 
   - `insert` duplicates the payload once for each matched node.
   - `set` and `delete` apply to *all* matched nodes, an overly broad selector (e.g., `layout[Standard]`) could wipe out the entire document!
   - *Warning for `set`*: The `set` command replaces **all** children of a target node. If you target a `Section` layout that contains text *and* a label inset, `set` will destroy the label inset. To preserve inner nested insets, use a more precise selector to target only the `TextNode` itself (if supported), or rebuild the structure using `--raw`.

### Commands
- **init**: `lq init [--layouts-dir <path>]`
  - Initializes the user configuration file `~/.lq/config.json`. Auto-detects the layouts directory based on your OS if `--layouts-dir` is not explicitly provided.
- **schema**: `lq schema <file> [--layouts-dir <path>]`
  - Returns a list of all semantically valid layouts for the document's class, as well as global constructs.
  - Exposes categories: `documentLayouts`, `insetLayouts`, `insets`, and `inlineProperties`.
  - Global constructs supported include:
    - **insetLayouts**: `Plain Layout`
    - **insets**: `Note`, `ERT`, `Foot`, `Marginal`, `Branch`, `Box`, `Float`, `Wrap`, `Caption`, `Flex`, `Phantom`, `CommandInset`, `Formula`, `Graphics`, `External`, `Include`, `listings`, `Preview`, `Tabular`, `space`, `VSpace`, `Newline`, `Newpage`, `Separator`, `Line`, `Quotes`, `SpecialChar`, `IPA`, `IPAMacro`, `IPADeco`, `script`, `Argument`, `Info`, `FloatList`, `Index`, `Nomenclature`, `TOC`, `Ending`, `Accent`
    - **inlineProperties**: `change_inserted`, `change_deleted`, `change_unchanged`
- **bib**: `lq bib <file>`
  - Extracts available citation keys from linked bibliography files and outputs them as JSON.
- **dump**: `lq dump <file>`
  - Outputs the full CST as a massive JSON document.
- **read**: `lq read <file> <selector>`
  - Outputs matching nodes and text content as JSON.
- **set**: `lq set <file> <selector> <new text> [options]`
  - Overwrites the targeted nodes with new text content.
  - Options: `--track-changes <inserted|deleted>`. In `inserted` mode, replaces the old text and wraps the new text in `\change_inserted`. In `deleted` mode (standard track-changes), preserves the old text wrapped in `\change_deleted` and appends the new text wrapped in `\change_inserted`.
- **delete**: `lq delete <file> <selector> [options]`
  - Safely deletes the targeted nodes from the `.lyx` file.
  - Options: `--track-changes <inserted|deleted>`. Instead of removing nodes, wraps them in `\change_deleted` markers to perform a tracked deletion. Both modes behave identically since there is no replacement content for a pure deletion. Use this for collaborative editing workflows.
- **insert**: `lq insert <file> <selector> <position> [options]`
  - Insert new blocks or properties `before`, `after`, `prepend`, or `append` to a selector.
  - Helpers (You must provide exactly one generation strategy):
    - `--layout <name> --text <content>`: The safest option. Automatically generates a valid LyX block with the specified text.
    - `--raw <string>`: The power-user option. Provide exact, raw LyX syntax (e.g., `\begin_layout Itemize\nFoo\n\end_layout`). `lq` will parse it into CST nodes. Useful for injecting complex structures like nested formulas. If the raw string is invalid LyX syntax, it will be safely rejected.
    - `--raw-file <path>`: Same as `--raw`, but reads the raw LyX string from a file. Use this to avoid shell escaping issues with complex LyX markup.
  - Options: `--track-changes <inserted|deleted>` to automatically register an author and track changes. Both modes simply wrap the inserted content in the respective tracking markers, but `inserted` is standard.
  - Validation: Pass `--validate-layouts-dir <path>` to enforce LyX schema rules. Actively rejects inserting document layouts into insets, inset layouts into the document body, or unrecognized insets. If the path is invalid and was explicitly provided, produces a hard error; if auto-detected, warns on stderr.

## Best Practices

1. **Test Your Blast Radius**: `lq` intentionally lacks a `--dry-run` flag. Commands like `delete layout[Standard]` will delete *every single standard paragraph in the document*. **Always run `read` first** to ensure you matches the exact node(s) you intend to mutate.
2. **Consult the Schema**: Documents vary wildly. A `Beamer` presentation allows `Frame` layouts, but an `article` does not. Before inserting new layouts into an unfamiliar document, run the `schema` command to see the legal menu of options.
3. **Embrace the Git Workflow**: You are working in a version-controlled workspace. If you accidentally execute a destructive command that corrupts the file or modifies the wrong text, immediately run `git restore <file>` to undo your changes.
4. **Treat LaTeX as Opaque**: `lq` abstracts away the LaTeX layer. Any raw LaTeX (like equations inside `inset[Formula]`) is treated as pure string data. Do not try to parse the LaTeX syntax itself; simply target the `inset[Formula]` node and replace its text content.
5. **Use `:contains` for Precision**: If structural selectors like `:nth-child(5)` feel brittle, use `:contains("unique phrase")` to precisely target the paragraph or inset you want to edit.
6. **Cross-Referencing**: Before inserting a cross-reference, find the exact label names by querying `lq read <file> "inset[CommandInset label] property[name]"`. This returns all valid targets (e.g., `sec:Intro`, `fig:1`). You can insert references to these using the `--raw` payload.