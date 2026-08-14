# Headless LyX

### Resolve the LyX binary

Prefer `lyx`/`tex2lyx` on `PATH` when present (typically not on Windows); otherwise invoke the full path: 

```bash
lq init    # prints layoutsDir = {installRoot}/Resources/layouts
# lyx      = {installRoot}/bin/LyX.exe (Windows) or {installRoot}/bin/lyx (Unix)
# tex2lyx  = {installRoot}/bin/tex2lyx.exe (or tex2lyx)
```

### Create a document

**Finding official templates:**

Templates live at `{installRoot}/Resources/templates/`, derived from `lq init`:

```bash
lq init    # prints layoutsDir = {installRoot}/Resources/layouts
# templates dir = {installRoot}/Resources/templates/
```

List available templates:

```bash
# On Windows (bash):
ls "$(dirname "$(lq init | grep layoutsDir | sed 's/.*: //')")/../templates/"**/*.lyx

# Or directly (Windows/Linux/macOS):
ls "{installRoot}/Resources/templates/"**/*.lyx
```

Templates are organized into subdirectories: `Articles/`, `Books/`, `Letters/`, `Presentations/`, `Posters/`, `Scripts/`, `Theses/`, plus locale folders (`ar/`, `ca/`, `de/`, `es/`, `fr/`, `ja/`). Template filenames use underscores and URI-encoding (e.g. `American_Astronomical_Society_%28AASTeX_v._6.3.1%29.lyx`).

**Write the minimal document directly (reliable):**

Writing the minimal document by hand is the reliable way to create a new `.lyx` from scratch — it needs no GUI and no batch commands, and it is the same document `buffer-new` produces:

```bash
cat > doc.lyx <<'EOF'
#LyX 2.5 created this file. For more info see https://www.lyx.org/
\lyxformat 643
\begin_document
\begin_header
\textclass article
\end_header

\begin_body

\begin_layout Standard

\end_layout

\end_body
\end_document
EOF
```

It contains a single empty `Standard` paragraph in the `article` class. To start from an official template instead, copy one into place and edit it with `lq` (templates are ordinary `.lyx` files):

```bash
cp "{installRoot}/Resources/templates/Articles/APA.lyx" doc.lyx
```

After creating the file, all further edits go through `lq`.

**Via `buffer-new` (headless — NOT reliable):**

```bash
# Minimal new document:
"{lyx}" -batch -x "buffer-new /abs/path/doc.lyx" -x buffer-write

# From an official template (absolute path required):
"{lyx}" -batch -x "buffer-new-template /abs/path/doc.lyx \"{installRoot}/Resources/templates/Articles/APA.lyx\"" -x buffer-write
```

Both LFUNs queue via `-x` and execute sequentially; `buffer-new-template` needs an absolute template path (no GUI file dialog). **In headless batch mode (`-batch`) they are unreliable (verified on LyX 2.5.1 Windows)**: LyX refuses to start headless without a file argument (`init()` aborts with "Missing filename for this operation."), and even with a dummy file loaded the batch `buffer-write` is dispatched to the command-line buffer, never the new buffer — so no file is written. Prefer the direct minimal document above, or `cp` an official template.

### Export

```bash
"{lyx}" -batch -e pdf2 doc.lyx           # export to PDF (format short name)
"{lyx}" -batch -E latex out.tex doc.lyx  # export to specific file (preferred for output control)
```

Common format short names for `-e`/`-E`:

| Short name | Output |
|------------|--------|
| `pdf2` | PDF (pdflatex) — most common |
| `pdf4` | PDF (XeTeX) — Unicode |
| `pdf5` | PDF (LuaTeX) |
| `latex` | LaTeX (plain) |
| `pdflatex` | LaTeX (pdflatex) |
| `xetex` | LaTeX (XeTeX) |
| `dvi` | DVI |
| `html` | HTML |
| `xhtml` | LyXHTML |
| `text` | Plain text |
| `textparagraph` | Plain text, join lines |
| `ps` | PostScript |
| `odt` | OpenDocument (tex4ht) |
| `rtf` | Rich Text Format |
| `word2` | MS Word Office Open XML |
| `docbook5` | DocBook 5 |
| `lyx` | LyX (native) |

Prefer `-E` over `-e` when you need control over the output path. `-batch` is slow (~10-30s+); not for tight edit loops. PDF requires TeX configured in LyX.

### Import

```bash
"{tex2lyx}" paper.tex paper.lyx          # LaTeX → .lyx (preferred, always available)
"{lyx}" -batch -i latex paper.tex        # same via LyX batch
```

Import formats for `-i` (any format with a converter chain to `.lyx`):

| Format | Source | Availability |
|--------|--------|--------------|
| `latex` | LaTeX | Always (tex2lyx bundled) |
| `literate` | Noweb | Requires `tex2lyx -n` |
| `sweave` | Sweave | Requires R + tex2lyx |
| `knitr` | Knitr | Requires R + tex2lyx |
| `text` | Plain text | Built-in converter |
| `html` | HTML | Requires Pandoc or similar |
| `word` / `word2` | MS Word (.doc/.docx) | Requires external converter |
| `rtf` | Rich Text Format | Requires external converter |
| `odt` | OpenDocument | Requires external converter |

`tex2lyx` is the dedicated TeX→LyX converter and is faster and more reliable than `lyx -batch -i`. For non-LaTeX formats, availability depends on what converters are installed on the system — test with a small file first.

### Acceptance check and verification

`deno test` verifies lq's parser, query engine, serializer, and mutation logic; only LyX confirms that a file is acceptable. The acceptance check is a headless export, run with a timeout:

```text
"<LyX>/bin/lyx.exe" -e latex document.lyx
```

Exit 0 with an output file means LyX parsed the document; a non-zero exit or a lingering process usually means LyX opened a modal parse-error dialog. `lyx.exe` is normally not on `PATH` — find the installation root through `lq init`.

For high-risk changes, verify on a copy: apply the mutation to a temporary copy of the fixture or document, export under a bounded process timeout, inspect the generated output, and record the result in the relevant development log. Never use a repository fixture as a scratch file for manual mutation tests; restore or delete temporary files after verification.

Generate ground-truth syntax with `"<LyX>/bin/tex2lyx.exe" -f input.tex output.lyx`; prefer LyX-generated examples over hand-written syntax for unfamiliar structures.

### Open GUI (for LyXServer refresh)

```bash
"{lyx}" doc.lyx                          # open in GUI, start LyXServer
"{lyx}" -r doc.lyx                       # reuse running instance
```

Omit `-batch`. The GUI is for LyXServer connection + human review. If LyXServer is unreachable after launch, stop and ask the user — do not invent LFUN workarounds. For refresh modes and can't-connect troubleshooting, see [`LyXServer.md`](LyXServer.md).

### Requirements & notes

- **LyX must be installed and configured once** before batch use. Open the GUI at least once to complete initial setup.
- **TeX is not bundled** with LyX. PDF export needs a TeX distribution configured in LyX Preferences.
- **Batch is slow** (~10-30s+). Use for create/import/export only.
- **Quote paths with spaces** on all platforms.
- **Binary name**: `LyX.exe` on Windows, `lyx` on Unix.
- **`-batch` vs GUI**: `-batch` runs headless and exits; omit `-batch` to open the GUI and start LyXServer.
