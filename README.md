<h1 align="center">
  <picture style="display:inline-block; margin-right:12px;">
    <source media="(prefers-color-scheme: dark)" srcset="icon.svg">
    <source media="(prefers-color-scheme: light)" srcset="icon-light.svg">
    <img src="icon-light.svg" alt="lq — a companion for LyX" width="48" height="48" style="vertical-align:-6px; display:inline-block;">
  </picture>
  lq - A CLI Tool for Editing LyX documents
</h1>

`lq` is a standalone CLI tool designed to create, parse, query, and mutate LyX documents  (`.lyx` files) using a lossless Virtual DOM. It allows users to target document elements using CSS-like selectors without breaking the file formatting expected by LyX.

### Quick start

- Download the binary or build for your platform with `deno task build`
- Configure default behaviours with `lq init`. Add `--help` flag to see options.
- Ask your agent to `/use-lq`

### Highlights

- `lq` mutates `.lyx` files in the same way as LyX (verified by LyX source code).
- CLI + skills designed for **autonomous agents**.
- Collaborate with agents in **auto refreshed** LyX GUI through [LyXServer](https://wiki.lyx.org/LyX/LyXServer).
- Agents make **tracked changes**, allowing easy review.

### Limitations

- **Windows auto-refresh**: Before auto-refresh, we use LyX function `buffer-switch` to ensure that mutations are reloaded into the correct target file, rather than the one that users are working on in the GUI. This however does not work on Windows, because LyXServer uses a named pipe protocol that delimits messages with `:`, which conflicts with the drive letter in Windows absolute paths (e.g. `C:\...`). As a result, `buffer-switch` cannot be sent through the pipe, and auto-refresh operates on LyX's active buffer rather than switching to the target file first. **Windows users are advised to open only one `.lyx` file while using `lq`.**
- Some LyX's serialization conventions (500-char column limit, punctuation newlines, font/change delta optimization) are not enforced by `lq`. Those are purely cosmetic and LyX reads files fine without them. As a result, open a `lq` edited file in LyX can cause formatting-only diffs.

## Design Philosophy & Architecture

### Lossless Virtual DOM

`lq` is built on a "Lossless DOM" architecture. It parses `.lyx` files into a Concrete Syntax Tree (CST) rather than an Abstract Syntax Tree (AST). This ensures that perfectly valid but idiosyncratic LyX formatting (such as trailing whitespaces in specific tags or exact newline placement) is preserved exactly. The core rule of the project is that `serialize(parse(file)) === file_text` must result in a 0-byte difference.

### Context-Aware Strict Validation

When `lq` mutates document structure with the `insert` command, it enforces semantic rules to prevent corrupting `.lyx` files at two scales:

- **Global Constructs**: Core engine constructs (Insets like `Formula`, `Note`, or inline properties like `change_inserted`) are mapped globally to provide a complete menu of legal operations regardless of textclass.
- **Dynamic Document Class Resolution**: `lq` queries the document's header (`\textclass`) to determine the class (e.g., `article`, `book`) and loads the corresponding `.layout` file.

**Checks that always run (no config needed):**

- **Core CST guards**: `document`, `body`, and `header` cannot be mutated directly.
- **Malformed `--raw-file` syntax** is rejected (doesn't parse as valid LyX).
- **Unknown inset types in `--raw-file`** produce a warning in the JSON response's `warnings` field but don't block the insertion. This uses a hardcoded registry of known LyX engine inset types (sourced from LyX's `InsetCode.h`; There is no inset at the textclass level) and matches LyX's own permissive read path.

**Checks that require `.layout` files** (enabled when `~/.lq/config.json` has a `layoutsDir`, silently skipped otherwise):

- **Layout name**: Unrecognized layout names are rejected with the list of valid alternatives.
- **Context boundaries**: Document layouts (e.g., `Section`) cannot be inserted inside insets (e.g., `Foot`); only `Plain Layout` is allowed within insets. Insets must be inside a layout, not at the body level.
- **Cross-class**: Layouts from other document classes (e.g., `Frame` in an `article` document) are rejected.
- **Inline properties**: Unknown property keys are rejected with the list of valid alternatives.

### LaTeX Independence

While LyX is a frontend for LaTeX, `lq` operates entirely independently of the LaTeX layer:

- **Separation of Concerns**: The tool mutates the LyX source file format directly. It does not parse, understand, or interact with LaTeX syntax.
- **Opaque Payloads**: Any raw LaTeX existing in the document (such as within `\begin_inset Formula`, `\begin_inset ERT`, or `\begin_preamble`) is treated as opaque string data and preserved flawlessly by the lossless parser.
- **LyX as the Translator**: By strictly adhering to the schema defined in the LyX `.layout` files, `lq` ensures that the resulting `.lyx` file is structurally sound. When the user opens the file, the LyX engine handles the final translation to LaTeX.

## [User Manual](.claude/skills/use-lq/SKILL.md)

## Development

Requires **Deno 2.8+**.

- **Run tests:** `deno test -A`
- **Only affected tests:** `deno test -A --changed` (Deno 2.9+)
- **Test coverage:** `deno task coverage` generates per-function coverage report in `./cov`
- **Benchmark:** `deno bench -A --no-check tests/bench.ts`
- **CPU profiling:** `deno task profile <args...>` (outputs .cpuprofile, SVG flamegraph, and Markdown report)
- **Watch execution:** `deno task dev`
- **Build binary:** `deno task build` (or `deno task build:all` for all platforms)
- **Compatibility**:
  - Developed and verified against **LyX 2.4 and LyX 2.5**.
  - Developed for MacOS/Linux/Windows, tested on Windows.

## License

MIT

Co-Author: GitHub Copilot powered by Gemeni 3.1 Pro (Thank you google for Vertex free trial!) and DeepSeek V4 Pro
