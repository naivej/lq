# lq - A CLI Tool for Editing LyX documents

`lq` is a standalone CLI tool designed to parse, query, and mutate LyX documents  (`.lyx` files) using a lossless Virtual DOM. It allows users to target document elements using CSS-like selectors without breaking the file formatting expected by LyX.

Quick start
- Download the (fat) binary, then `lq`
- Or install deno, clone this repo, then `deno run -A main.ts` or `deno task build`

### Highlight
- `lq` mutates `.lyx` files in the same way as LyX (verified by LyX source code).
- CLI + skills designed for **AI agents**.
- **Cross-reference and citation** support.
- **Tracked change** support.
- **Auto reload** `lq` mutations in opened `.lyx` files using [LyXServer](https://wiki.lyx.org/LyX/LyXServer).

### Limitation
- `lq` is designed to edit existing LyX documents, not to create one from scratch. It enables AI-assisted writing, not type-setting. That said, all LyX syntax is supported, so typesetting with `lq` is possible in principle.

### Known issue & todo
- Continue to optimise the lq-use skill in battle. 
- **Deferred: `--strict` mode** would format `lq`-generated content to match LyX's serialization conventions (500-char column limit, punctuation newlines, font/change delta optimization). Those are purely cosmetic and LyX reads files fine without them. However, currently `lq` can cause formatting-only diffs the next time LyX saves.
- **Inset type validation is warning-only:** This matches LyX's permissive read path. Unknown inset types in `--raw` content produce a warning but don't block the operation.

## Design Philosophy & Architecture

### Lossless Virtual DOM
`lq` is built on a "Lossless DOM" architecture. It parses `.lyx` files into a Concrete Syntax Tree (CST) rather than an Abstract Syntax Tree (AST). This ensures that perfectly valid but idiosyncratic LyX formatting (such as trailing whitespaces in specific tags or exact newline placement) is preserved exactly. The core rule of the project is that `serialize(parse(file)) === file_text` must result in a 0-byte difference.

### Context-Aware Strict Validation
`lq` validates mutations in two layers to prevent corrupting `.lyx` files:

**Mandatory layer (always active):** Core safety checks that run on every `insert` command:
- Unrecognized layout names are rejected with the list of valid alternatives.
- Document layouts (e.g., `Section`) cannot be inserted inside insets (e.g., `Foot`); only `Plain Layout` is allowed within insets.
- Inset-only layouts cannot be inserted directly into the document body.
- Insets cannot be inserted at the body level — they must be inside a layout.
- Core CST structures (`document`, `body`, `header`) cannot be mutated.

**Optional layer (`--validate-layouts-dir <path>`):** Extended schema checks that require `.layout` files:
- Cross-class layout validation (e.g., rejecting `Frame` in an `article` document).
- Inset type validation against the full registry.
- Inline property validation (e.g., `change_inserted`).
- If the path is invalid and was explicitly provided, produces a hard error; if auto-detected from `~/.lq/config.json`, warns on stderr.

Underpinning both layers:
- **Dynamic Document Class Resolution**: `lq` queries the parsed document's header (`\textclass`) to determine the document class (e.g., `article`, `book`) and loads the corresponding `.layout` file.
- **Global Constructs**: Core engine constructs (Insets like `Formula`, `Note`, or inline properties like `change_inserted`) are mapped globally in the CLI to provide a complete menu of legal operations regardless of document class.

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
To correctly cite external literature, users need to know the available citation keys from the linked `.bib` files. (Only `.bib` files are supported — references to `.bst` style files or embedded bibliographies are ignored.)
You can query or search the bibliography by `lq bib`, then inject citations using `--raw` (e.g., `\begin_inset CommandInset citation\nLatexCommand citet\nkey "Einstein1905"\nliteral "false"\n\end_inset`).

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
- `lq read <file> <selector>`
  - Outputs matching nodes and text content as JSON.

### Mutate
- `lq set <file> <selector> <new text>`
  - Overwrites the targeted nodes with new text content. No structure change (layouts, insets, properties).
- `lq delete <file> <selector>`
  - Safely deletes the targeted nodes from the `.lyx` file.
- `lq insert <file> <selector> <position> [options]`
  - Insert new blocks or properties `before`, `after`, `prepend`, or `append` to a selector.
  - Helpers (You must provide exactly one generation strategy):
    - `--layout <name> --text <content>`: The safest option. Automatically generates a valid LyX block with the specified text.
    - `--raw <string>`: The power-user option. Provide exact, raw LyX syntax (e.g., `\begin_layout Itemize\nFoo\n\end_layout`). `lq` will parse it into CST nodes. Useful for injecting complex structures like nested formulas. If the raw string is invalid LyX syntax, it will be safely rejected. Unknown inset types in `--raw` content produce a warning to stderr but do not block the insertion — this matches LyX's own permissive read path.
    - `--raw-file <path>`: Same as `--raw`, but reads the raw LyX string from a file. Use this to avoid shell escaping issues with complex LyX markup.
  - `--validate-layouts-dir <path>`: Extended schema checks — inset type validation against the full registry, cross-class layout validation, property validation. Requires `.layout` files. If the path is invalid and was explicitly provided, produces a hard error; if auto-detected, warns on stderr.

## Development

- **Run tests:** `deno test -A` (Tests require read access to the fixtures and layout files)
- **Benchmark:** `deno bench -A --no-check tests/bench.ts`
- **Watch execution:** `deno task dev`
- **Build binary:** `deno task build` (or `deno task build:all` for all platforms)
- **Compatibility**: 
  - Developed and verified against **LyX 2.4 and LyX 2.5**.
  - Developed for MacOS/Linux/Windows, tested on Windows.

## License

MIT

Co-Author: GitHub Copilot powered by Gemeni 3.1 Pro
