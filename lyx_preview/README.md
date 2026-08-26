# LyX Preview

This extension is a VS Code companion of `lq`, a CLI for agent to parse, query, and mutate LyX documents.
This extension render LyX in VS Code webview that
- Look fimilarly as LyX GUI.
- Refreshes when save or when the file changes on disk while the editor buffer is not dirty. 
- Enable VS Code webview find widget
- Use LyX navigate panel under Explorer to jump to section, figures, tables, equations, tracked changes, and more, in both the raw file and preview.
- Generate .json from preview selection that an agent can read using `lq` to understand the context.
- Tracked change author and timestemp, as well as the selector for hilighted text are shown in the status bar.

## Getting Started
1. Download [lq](https://github.com/naivej/lq) and install `use-lq` skill for your agent. The extension find `lq` binary from 
  1. `~\Github\lq_dev\lq\bin\lq*` for development convenience
  2. Setting `lyx-preview.lqPath`
  3. `PATH`
2. Install this extension
3. Open a `.lyx` file and click the blue L icon from the title bar to open preview
4. If the document has tracked changes, use the yellow L icon from the title bar to select original / tracked/ clean view
5. Drag select in preview, then share the context with agent by `@live-selection.json` (written next to the previewed `.lyx`) or hint VS Code language model tool `#lyxselection`.


## Relation with LyXHTML

Live aims for the same **reader-facing** shape as LyX’s native **LyXHTML** export (`File → Export → LyXHTML`, or `lyx -e xhtml`): semantic structure (headings/sections, lists, floats, footnotes), escaped prose, and MathML-ish math — not a typeset PDF and not File → Export → HTML (the LaTeX→htlatex/TeX4ht path).

| | **LyXHTML (LyX)** | **Live (lq + this extension)** |
| --- | --- | --- |
| **Engine** | LyX C++ (`output_xhtml.cpp`) walks LyX’s in-memory document | **lq** parses the `.lyx` file into a **CST** (concrete syntax tree), then projects that tree to HTML |
| **Needs LyX to render?** | Yes (export) | **No** — only the saved file + `lq` |
| **Similarity** | Ground-truth reader markup for acceptance tests | Same *kind* of result: structural/semantic HTML a reader can scan |
| **Differences** | Uses LyX layout HTML keys, native inset `xhtml()`, full MathML pipeline, page-oriented details (`magicparlabel-*`, real page refs when exported) | CST-driven; layout HTML keys from install/user-dir/LocalLayout when available; lq TeX→MathML subset (+ document preamble `\newcommand`); Info icons from LyX `images/` when present; shortcuts from system+user bind; page chrome omitted; ERT/Phantom/Index and private notes appear as Live-only chips/disclosures; `pageref` shows target number/name, not a PDF page |
| **Role here** | Development **oracle** for parity checks | **Shipped** preview — never runs LyXHTML export in the extension |

So: Live is **inspired by and checked against** LyXHTML, but it is **not** “embed LyXHTML in the webview.” It re-reads source through lq’s CST so preview stays fast, offline, and aligned with later source-aware features (outline, mapping, Review) that a one-shot export cannot own.

### Deliberate differences (not bugs)

| If you see… | Why |
| --- | --- |
| `pageref` text is a section/figure number, not a printed page | Live has no PDF pagination; tooltip notes this |
| FormulaMacro uses like `\qG` still look like raw commands | Macro *insets* are omitted (like native); call sites are not expanded yet |
| Math looks close but not identical to LyX’s MathML | lq owns a TeX→MathML subset; not LyX’s converter |
| No fancy layout CSS / page header chrome | Semantic HTML only; page chrome omitted on purpose |
| ERT / Phantom / Index as click chips | Live-only plain-text markers (native LyXHTML still omits them) |
| Footnotes / Notes / Boxes / Greyedout start collapsed | **Click** the label to expand/collapse (not hover) so you can select text inside |
| `Note` / `Comment` appear in Live | Live-only: private notes are shown behind a click disclosure (not in LyXHTML/PDF) |
| Info icon is ▣ instead of a toolbar PNG | LyX image tree missing or icon name unresolved; themed SVGZ/PNG used when found |
