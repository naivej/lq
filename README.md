# lq - A CLI Tool for Editing LyX documents

`lq` is a standalone CLI tool designed to parse, query, and mutate LyX documents  (`.lyx` files) using a lossless Virtual DOM. It allows users to target document elements using CSS-like selectors without breaking the file formatting expected by LyX.

Quick start
- Download the (fat) binary, then run `lq`
- Or install deno, clone this repo, then run `deno run -A main.ts` or build the binary for your platform `deno task build`

### Highlight
- `lq` mutates `.lyx` files in the same way as LyX (verified by LyX source code).
- CLI + skills designed for **AI agents**.
- **Cross-reference and citation** support.
- **Tracked change** support.
- **Auto refresh** `lq` mutations in opened `.lyx` files using [LyXServer](https://wiki.lyx.org/LyX/LyXServer).

### Limitation
- `lq` is designed to edit existing LyX documents, not to create one from scratch. It enables AI-assisted writing, not type-setting. That said, all LyX syntax is supported, so typesetting with `lq` is possible in principle.
- **Windows auto-refresh**: Before auto-refresh, we use LyX function `buffer-switch` to ensure that mutations are reloaded into the correct target file, rather than the one that users are working on in the GUI. This however does not work on Windows, because LyXServer uses a named pipe protocol that delimits messages with `:`, which conflicts with the drive letter in Windows absolute paths (e.g. `C:\...`). As a result, `buffer-switch` cannot be sent through the pipe, and auto-refresh operates on LyX's active buffer rather than switching to the target file first. **Windows users are advised to open only one `.lyx` file while using `lq`.**
- LyXServer currently can not report cursor location in an opened `.lyx` file. Thus it might be difficult to communicate with AI agent about exactly what you want to edit. The best way for now is probably using `:contains("some text")`.

### Known issue & todo
- Helpers for cross-references and citations (especially multiple citations)?
- Some LyX's serialization conventions (500-char column limit, punctuation newlines, font/change delta optimization) are not enforced by `lq`. Those are purely cosmetic and LyX reads files fine without them. As a result, open a `lq` edited file in LyX can cause formatting-only diffs.

## Design Philosophy & Architecture

### Lossless Virtual DOM
`lq` is built on a "Lossless DOM" architecture. It parses `.lyx` files into a Concrete Syntax Tree (CST) rather than an Abstract Syntax Tree (AST). This ensures that perfectly valid but idiosyncratic LyX formatting (such as trailing whitespaces in specific tags or exact newline placement) is preserved exactly. The core rule of the project is that `serialize(parse(file)) === file_text` must result in a 0-byte difference.

### Context-Aware Strict Validation
When `lq` mutates document structure with the `insert` command, it enforces semantic rules to prevent corrupting `.lyx` files.

**Checks that always run (no config needed):**
- **Core CST guards**: `document`, `body`, and `header` cannot be mutated directly.
- **Malformed `--raw-file` syntax** is rejected (doesn't parse as valid LyX).
- **Unknown inset types in `--raw-file`** produce a warning to stderr but don't block the insertion. This uses a hardcoded registry of known LyX engine inset types (sourced from LyX's `InsetCode.h`, available globally regardless of textclass) and matches LyX's own permissive read path.

**Checks that require `.layout` files** (enabled when `~/.lq/config.json` has a `layoutsDir`, silently skipped otherwise):
- **Layout name**: Unrecognized layout names are rejected with the list of valid alternatives.
- **Context boundaries**: Document layouts (e.g., `Section`) cannot be inserted inside insets (e.g., `Foot`); only `Plain Layout` is allowed within insets. Inset-only layouts cannot be inserted into the document body. Insets must be inside a layout, not at the body level.
- **Cross-class**: Layouts from other document classes (e.g., `Frame` in an `article` document) are rejected.
- **Inset types and inline properties**: Checked against the document class schema (both global AND textclass-specific) — rejected if not valid for this textclass.

Underpinning the schema:
- **Dynamic Document Class Resolution**: `lq` queries the document's header (`\textclass`) to determine the class (e.g., `article`, `book`) and loads the corresponding `.layout` file.
- **Global Constructs**: Core engine constructs (Insets like `Formula`, `Note`, or inline properties like `change_inserted`) are mapped globally to provide a complete menu of legal operations regardless of textclass.

### LaTeX Independence
While LyX is a frontend for LaTeX, `lq` operates entirely independently of the LaTeX layer:
- **Separation of Concerns**: The tool mutates the LyX source file format directly. It does not parse, understand, or interact with LaTeX syntax.
- **Opaque Payloads**: Any raw LaTeX existing in the document (such as within `\begin_inset Formula`, `\begin_inset ERT`, or `\begin_preamble`) is treated as opaque string data and preserved flawlessly by the lossless parser.
- **LyX as the Translator**: By strictly adhering to the schema defined in the LyX `.layout` files, `lq` ensures that the resulting `.lyx` file is structurally sound. When the user opens the file, the LyX engine handles the final translation to LaTeX.

### Git-Driven Workflow (No Dry-Run)
`lq` intentionally omits a `--dry-run` flag. It is designed under the assumption that the workspace is version-controlled via `git`, and users should rely on `git restore <file>` to undo unwanted changes.

## How This Tool Works

At its core, `lq` operates on a simple lifecycle:
1. **Parse**: Reads a `.lyx` file and converts it into a structured Concrete Syntax Tree (CST).
2. **Query**: Uses a CSS-like selector engine to find specific nodes in the CST.
3. **Mutate**: Applies changes (insert, set, delete) to the matched nodes.
4. **Serialize**: Converts the modified CST back into a perfectly formatted `.lyx` file.

### The LyX-to-CST Mapping
To effectively use the query engine, Users need to understand how LyX syntax maps to the CST nodes:
- **Block Nodes**: Structures like `\begin_layout Section` map to a `layout` tag with a `Section` argument. Users select them using `layout[Section]`.
- **Insets**: Structures like `\begin_inset Formula` map to an `inset` tag with a `Formula` argument. Users select them using `inset[Formula]`.
- **Property Nodes**: Single-line settings like `\textclass article` map to property nodes. 
- **Text Nodes**: The actual text content inside layouts and insets.
- **CST is flat**: Layouts like `Section` and `Standard` are **siblings** under the document body, not parent-child.

### Query Engine (CSS Selectors)
The query engine supports traversing the CST using standard CSS syntax:
- **Tags**: `layout`, `inset`, `property`
- **Attributes**: `layout[Section]`, `inset[Formula]`, `property[family]`
- **Descendants**: `layout[Section] inset[Formula]` (Finds a Formula inside a Section)
- **Pseudo-classes**: `:first`, `:last`, `:nth-child(an+b)` (supports `odd`/`even`)
- **Text content**: `:contains("some text")` (Recursively and case-sensitively searches node children for text)

### Safe Mutation Workflow
Mutations apply to all matched nodes of a selector. Specifically,
   - `insert` duplicates the payload once for each matched node.
   - `set` and `delete` apply to *all* matched nodes — an overly broad selector (e.g., `layout[Standard]`) could wipe out the entire document!
   - The `set` command replaces **all** children of a target node. If you target a `Section` layout that contains text *and* a label inset, `set` will destroy the label inset. To preserve inner nested insets, use a more precise selector or rebuild the structure using `--raw`.
   - If there are more than 1 match, a warning is emitted to stderr. Use `lq read --count <file> <selector>` before mutating to check how many nodes will be affected.

When modifying a document, users should follow this safe workflow:
1. **Check Schema**: Documents vary wildly. A `Beamer` presentation allows `Frame` layouts, but an `article` does not. Run `lq schema <file>` to know what layouts and insets are legally allowed in the specific document.
2. **Test Blast Radius (i.e. the number of nodes a selector matches)**: Run `lq read --count <file> <selector>` to verify how many nodes the selector matches. Then `lq read <file> <selector>` to verify selector targets exactly what's intended.

### Cross-Referencing & Labels
To safely insert cross-references, users need to know the exact names of existing labels in the document.
They can find all defined labels by querying label insets. Labels are stored as text inside
`\begin_inset CommandInset label` blocks, so use `:contains()` to filter:
- `lq read <file> "inset[CommandInset label]"` — returns all labels (e.g., `sec:Introduction`, `fig:Result`)
- `lq read <file> "inset[CommandInset label]:contains('sec:')"` — labels whose name contains "sec:"

Parse the returned JSON to extract the label name from the `children` array. To inject references, use `--raw` (e.g., `\begin_inset CommandInset ref\nLatexCommand ref\nreference "sec:Introduction"\n\end_inset`).

### Bibliography & Citations
To correctly cite external literature, users need to know the available citation keys from the linked `.bib` files. (Only `.bib` files are supported — references to `.bst` style files or embedded bibliographies are ignored.)
Users can query or search the bibliography by `lq bib`, then inject citations using `--raw` (e.g., `\begin_inset CommandInset citation\nLatexCommand citet\nkey "Einstein1905"\nliteral "false"\n\end_inset`).

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

## Development

Requires **Deno 2.8+**.

- **Run tests:** `deno test -A` (28 tests across 6 test files; I/O-heavy tests have per-test timeouts)
- **Test coverage:** `deno task coverage` (generates per-function coverage report)
- **Benchmark:** `deno bench -A --no-check tests/bench.ts`
- **CPU profiling:** `deno task profile <args...>` (outputs .cpuprofile, SVG flamegraph, and Markdown report)
- **Watch execution:** `deno task dev`
- **Build binary:** `deno task build` (or `deno task build:all` for all platforms)
- **Release:** `deno task release:patch` or `deno task release:minor` (bumps version in `deno.json` via `deno bump-version`)
- **Compatibility**: 
  - Developed and verified against **LyX 2.4 and LyX 2.5**.
  - Developed for MacOS/Linux/Windows, tested on Windows.

## License

MIT

Co-Author: GitHub Copilot powered by Gemeni 3.1 Pro
