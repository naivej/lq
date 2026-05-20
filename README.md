# lq - A CLI Tool for Editing LyX documents

`lq` is a standalone CLI tool designed to parse, query, and mutate LyX (`.lyx`) documents using a lossless Virtual DOM. It allows users to target document elements using CSS-like selectors without breaking the file formatting expected by LyX.

Quick start
- Download the (fat) binary and `lq`
- Install deno, clone this repo, and `deno run -A main.ts` or `deno task build`

### Highlight
- **Cross-reference and citation** support.
- **Tracked change** support.
- CLI and skills Designed for **AI agents**.

### Limitation
- We did not try to understand LyX syntax from the source code. This tool is built by analysing all official templates (LyX -> file -> New from template...) and the author's personal LyX files.
- This tool is designed to edit existing LyX files, not to create one from scratch. It enable AI-assisted writing, not type-setting.
- May not support all LyX constructs.

### Known issue & todo
- Improve speed and token efficiency?
- Dig into LyX source code.
- [LyXServer](https://wiki.lyx.org/LyX/LyXServer#toc5) has been used by JabRef and Zotero to push citations into an open LyX document. This may allow `lq` to 
  - Navigate an open LyX window to a specific location matching a selector. `lq` would resolve the selector to a paragraph/line, then send `LYXCMD:server-goto-file-row:<file>:<row>`
  - Send mutations to a running LyX instance instead of writing to disk, letting the user see changes in real-time.

## Design Philosophy & Architecture

### Lossless Virtual DOM
`lq` is built on a "Lossless DOM" architecture. It parses LyX files into a Concrete Syntax Tree (CST) rather than an Abstract Syntax Tree (AST). This ensures that perfectly valid but idiosyncratic LyX formatting (such as trailing whitespaces in specific tags or exact newline placement) is preserved exactly. The core rule of the project is that `serialize(parse(file)) === file_text` must result in a 0-byte difference.

### Context-Aware Strict Validation
LyX documents have strict semantic rules about where certain elements can exist. `lq` enforces these rules to prevent corrupting `.lyx` files:
- **Dynamic Document Class Resolution**: Before validating any operation, `lq` queries the parsed document's header (`\textclass`) to determine the document class (e.g., `article`, `book`). It then dynamically loads the corresponding `.layout` file to know exactly which structural layouts (like `Section` or `Title`) are permitted.
- **Context Boundaries**: The `insert` command validates the *parent node* of the target. For example, it will actively reject attempts to insert a `Section` (a document layout) inside a `Footnote` (an inset), enforcing that only `Plain Layout` is used within insets.
- **Global Constructs**: While document layouts vary by template, core engine constructs (Insets like `Formula`, `Note`, or inline properties like `change_inserted`) are mapped globally within the CLI to ensure the user has a complete menu of legal operations.

### LaTeX Independence
While LyX is a frontend for LaTeX, `lq` operates entirely independently of the LaTeX layer:
- **Separation of Concerns**: The tool mutates the LyX source file format directly. It does not parse, understand, or interact with LaTeX syntax.
- **Opaque Payloads**: Any raw LaTeX existing in the document (such as within `\begin_inset Formula`, `\begin_inset ERT`, or `\begin_preamble`) is treated as opaque string data and preserved flawlessly by the lossless parser.
- **LyX as the Translator**: By strictly adhering to the schema defined in the LyX `.layout` files, `lq` ensures that the resulting `.lyx` file is structurally sound. When the user opens the file, the LyX engine handles the final translation to LaTeX.

### Git-Driven Workflow (No Dry-Run)
`lq` intentionally omits a `--dry-run` flag. It is designed under the assumption that the workspace is version-controlled via `git`. 
- To safely test the "blast radius" of a selector before modifying a file, users should use the `read` command. 
- If a destructive command (`delete`, `set`, or `insert`) modifies unintended nodes, users should rely on `git restore <file>` to undo the changes.

## How This Tool Works

At its core, `lq` operates on a simple lifecycle:
1. **Parse**: Reads a `.lyx` file and converts it into a structured Concrete Syntax Tree (CST).
2. **Query**: Uses a CSS-like selector engine to find specific nodes in the CST.
3. **Mutate**: Applies changes (insert, set, delete) to the matched nodes.
4. **Serialize**: Converts the modified CST back into a perfectly formatted `.lyx` file.

### The LyX-to-CST Mapping
To effectively use the query engine, you need to understand how LyX syntax maps to the CST nodes:
- **Block Nodes**: Structures like `\begin_layout Section` map to a `layout` tag with a `Section` argument. You select them using `layout[Section]`.
- **Insets**: Structures like `\begin_inset Formula` map to an `inset` tag with a `Formula` argument. You select them using `inset[Formula]`.
- **Property Nodes**: Single-line settings like `\textclass article` map to property nodes. 
- **Text Nodes**: The actual text content inside layouts and insets.

### Query Engine (CSS Selectors)
The query engine supports traversing the CST using standard CSS syntax:
- **Tags**: `layout`, `inset`, `property`
- **Attributes**: `layout[Section]`, `inset[Formula]`, `property[family]`
- **Descendants**: `layout[Section] inset[Formula]` (Finds a Formula inside a Section)
- **Pseudo-classes**: `:first`, `:last`, `:nth-child(an+b)` (supports `odd`/`even`)
- **Text content**: `:contains("some text")` (Recursively and case-sensitively searches node children for text)

### Safe Mutation Workflow
When modifying a document, users should follow this safe workflow:
1. **Check Schema**: Run `lq schema <file>` to know what layouts and insets are legally allowed in the specific document.
2. **Test Blast Radius**: Run `lq read <file> <selector>` to verify your selector targets exactly what you intend.
   - *Blast Radius* refers to the number of nodes a selector matches. 
   - `insert` duplicates the payload once for each matched node.
   - `set` and `delete` apply to *all* matched nodes, an overly broad selector (e.g., `layout[Standard]`) could wipe out the entire document!
   - *Warning for `set`*: The `set` command replaces **all** children of a target node. If you target a `Section` layout that contains text *and* a label inset, `set` will destroy the label inset. To preserve inner nested insets, use a more precise selector to target only the `TextNode` itself (if supported), or rebuild the structure using `--raw`.

### Cross-Referencing & Labels
To safely insert cross-references, users need to know the exact names of existing labels in the document.
You can find all defined labels by querying the `name` property inside label insets:
`lq read <file> "inset[CommandInset label] property[name]"`
This will return a JSON list of all targetable labels (e.g., `sec:Introduction`, `fig:Result`). You can then inject references to them using `--raw` (e.g., `\begin_inset CommandInset ref\nLatexCommand ref\nreference "sec:Introduction"\n\end_inset`).

### Bibliography & Citations
To correctly cite external literature, users need to know the available citation keys from the linked `.bib` files.
You can query all available citations by running:
`lq bib <file>`
This extracts the linked bibliography files, parses them, and returns a JSON array containing the `key`, `author`, `title`, and `year` for all available citations. You can then inject citations using `--raw` (e.g., `\begin_inset CommandInset citation\nLatexCommand citet\nkey "Einstein1905"\nliteral "false"\n\end_inset`).

## Commands

- **init**: `lq init [--layouts-dir <path>]`
  - Initializes the user configuration file `~/.lq/config.json`. Auto-detects the layouts directory based on your OS if `--layouts-dir` is not explicitly provided.
- **schema**: `lq schema <file> [--layouts-dir <path>]`
  - Returns a list of all semantically valid layouts for the document's class, as well as global constructs.
  - Exposes categories: `documentLayouts`, `insetLayouts`, `insets`, and `inlineProperties`.
  - Global constructs supported include:
    - **insetLayouts**: `Plain Layout`
    - **insets**: `Formula`, `Note Note`, `Note Comment`, `Float figure`, `Float table`, `Tabular`, `Foot`, `CommandInset`, `Graphics`, `Caption Standard`, `Box`, `Branch`, `ERT`, `Marginal`, `Nomenclature`, `Index`, `FloatList`, `Flex`, `Argument`, `space`, `Newline`, `Newpage`, `Quotes`, `Phantom`, `listings`, `External`, `Preview`
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
- **delete**: `lq delete <file> <selector>`
  - Safely deletes the targeted nodes from the LyX file.
- **insert**: `lq insert <file> <selector> <position> [options]`
  - Insert new blocks or properties `before`, `after`, `prepend`, or `append` to a selector.
  - Helpers (You must provide exactly one generation strategy):
    - `--layout <name> --text <content>`: The safest option. Automatically generates a valid LyX block with the specified text.
    - `--raw <string>`: The power-user option. Provide exact, raw LyX syntax (e.g., `\begin_layout Itemize\nFoo\n\end_layout`). `lq` will parse it into CST nodes. Useful for injecting complex structures like nested formulas. If the raw string is invalid LyX syntax, it will be safely rejected.
  - Options: `--track-changes <inserted|deleted>` to automatically register an author and track changes. Both modes simply wrap the inserted content in the respective tracking markers, but `inserted` is standard.
  - Validation: Pass `--validate-layouts-dir <path>` to enforce LyX schema rules. Actively rejects inserting document layouts into insets, inset layouts into the document body, or unrecognized insets.

## Development

- **Run tests:** `deno test -A` (Tests require read access to the fixtures and layout files)
- **Watch execution:** `deno task dev`
- **Build binary:** `deno task build` (or `deno task build:all` for all platforms)
- **Compatibility**: 
  - Developed and verified against **LyX 2.4 and LyX 2.5**.
  - Developed for MacOS/Linux/Windows, tested on Windows.

## License

MIT

Co-Author: GitHub Copilot powered by Gemeni 3.1 Pro
