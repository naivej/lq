# LyX Preview

VS Code extension that shows a read-only **Live** preview of saved `.lyx` files by running the `lq preview` CLI and rendering its HTML in a webview.

## How Live relates to LyXHTML

Live aims for the same **reader-facing** shape as LyX’s native **LyXHTML** export (`File → Export → LyXHTML`, or `lyx -e xhtml`): semantic structure (headings/sections, lists, floats, footnotes), escaped prose, and MathML-ish math — not a typeset PDF and not File → Export → HTML (the LaTeX→htlatex/TeX4ht path).

| | **LyXHTML (LyX)** | **Live (lq + this extension)** |
| --- | --- | --- |
| **Engine** | LyX C++ (`output_xhtml.cpp`) walks LyX’s in-memory document | **lq** parses the `.lyx` file into a **CST** (concrete syntax tree), then projects that tree to HTML |
| **Needs LyX to render?** | Yes (export) | **No** — only the saved file + `lq` |
| **Similarity** | Ground-truth reader markup for acceptance tests | Same *kind* of result: structural/semantic HTML a reader can scan |
| **Differences** | Uses LyX layout HTML keys, native inset `xhtml()`, full MathML pipeline, page-oriented details (`magicparlabel-*`, real page refs when exported) | CST-driven; layout HTML keys from install/user-dir/LocalLayout when available; lq TeX→MathML subset; deliberate omits (ERT, private notes, page chrome); `pageref` shows target number/name, not a PDF page |
| **Role here** | Development **oracle** for parity checks | **Shipped** preview — never runs LyXHTML export in the extension |

So: Live is **inspired by and checked against** LyXHTML, but it is **not** “embed LyXHTML in the webview.” It re-reads source through lq’s CST so preview stays fast, offline, and aligned with later source-aware features (outline, mapping, Review) that a one-shot export cannot own.

## Use

1. Open a `.lyx` file.
2. Run **LyX Preview: Open LyX Preview** (command palette), or use the editor title icon when a `.lyx` buffer is active.
3. The preview refreshes from the **saved** file on open, save, and when the file changes on disk while the editor buffer is **not** dirty. Unsaved buffer edits mark the preview stale until you save (or reload from disk). Use Ctrl+F in the preview panel for find.
4. After updating the extension, run **Developer: Reload Window** (or reinstall the VSIX) so the new refresh watcher is loaded. Point `lyx-preview.lqPath` at a freshly built `lq` binary when preview CLI behavior changes.

## Find in preview

Ctrl+F / Cmd+F focuses VS Code’s **built-in webview find widget** (`enableFindWidget`). There is no separate extension API to configure find options; use the widget’s own toggles when your VS Code build shows them:

- **Match Case** (Aa)
- **Match Whole Word** (ab)
- **Use Regular Expression** (.*)

If a toggle is missing, that is a VS Code/webview limitation for that version — Live does not reimplement find in-page (scripts stay off).

## Settings

| Setting | Default | Meaning |
| --- | --- | --- |
| `lyx-preview.lqPath` | `""` | Path to the compiled `lq` binary |
| `lyx-preview.timeoutMs` | `30000` | Kill hung `lq preview` after this many ms |

**How the extension finds `lq`** (first match wins):

1. `lyx-preview.lqPath`
2. Env var `LQ_PATH`
3. A binary named like `lq*` under workspace `lq/bin` or `bin`
4. Else `lq` on `PATH`


