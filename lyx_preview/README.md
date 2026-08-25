# LyX Preview

VS Code extension that shows a read-only **Live** preview of saved `.lyx` files by running the `lq preview` CLI and rendering its HTML in a webview.

## How Live relates to LyXHTML

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

**Live↔GUI comparison fixture:** open `lq/tests/fixtures/Synthetic/disclosure_collapsibles.lyx` in LyX and in this preview side by side (inventory in the file header; DL131 §10). Companion: `disclosure_notes.lyx`.

**Navigate (M2.7, closed):** **Explorer → LyX Navigate** — Outline, List of Figures/Tables/Equations/Listings/Algorithms, and **Labels**.

| Group | Contents |
| --- | --- |
| **Outline** | TOC headings (same ids as Live Contents / preview scroll targets) |
| **List of Figures / Tables / Equations / Listings / Algorithms** | Numbered floats and formulas |
| **Labels** | **Leftover** anchors only — mid-body / box / note labels **not** already listed as a heading, float, or equation. Tree shows the label **name** (e.g. `note:custom-hook`), not the enclosing section title |

Click an entry to scroll Live Preview (opens ancestor `<details>` when needed) and pan the visible `.lyx` editor without stealing focus from the tree.

**Fixture:** `lq/tests/fixtures/Synthetic/navigate_labels.lyx` — expect Labels = `note:custom-hook`, `box:aside-point` only (`sec:` / `fig:` / `eq:` stay in Outline / LoF / Equations).

If empty: **Developer: Reload Window**; open a `.lyx` / Live Preview; set `lyx-preview.lqPath` to a current `lq` that emits `navigate`.

Full tolerance list: development log `130_live_native_xhtml_parity.md` §8; disclosure/outline work in `131_live_disclosure_outline_mapping.md` (in the lq_dev repo).

## Tracked-change views

`lq preview` renders **every** tracked insertion and deletion in one change-aware
HTML (`<ins class="change-inserted" id="change-N">` /
`<del class="change-deleted" id="change-N">`). The extension shows that one render
through three views — click the **View** button in the top-right corner of the
Live panel title bar (it opens a quick pick; the button replaces the Open LyX
Preview button while Live is focused):

| View | Shows |
| --- | --- |
| **Original** | The document before the changes (insertions hidden, deletions shown unstruck) |
| **Tracked** (default) | Both directions: insertions underlined, deletions struck, each author in their own color |
| **Clean** | The document after accepting (deletions hidden, insertions plain) |

Switching views never re-runs `lq`; the webview only flips a `data-mode` attribute.

Tracked marks follow LyX semantics:

- **Whole-inset changes** — an inserted inset (footnote, note, box, float, …)
  has its chip label and body underlined; a deleted inset's chip label is
  struck through and, once expanded, the whole box gets a diagonal deleted
  stamp (no separate body line-through).
- **Numbering** — a tracked-deleted footnote, float, or table caption keeps
  its would-be number on the chip but does not consume it, so the next
  surviving construct reuses that number; a deleted equation shows `#`.
  Footnotes/captions nested inside a deleted owner skip too, while equations
  inside a deleted owner still consume (LyX's per-inset behavior).
- **Author colors** — each author gets a fixed color slot in order of first
  appearance (`change-author-0`…`7`); chip labels inherit the author color in
  Tracked view.

Two supporting surfaces share the same change index:

- **Explorer → LyX Navigate → List of Changes** — one row per change region
  (`N Insert — snippet` / `N Delete — snippet`, described by author and local
  time). Clicking a row scrolls Live to that region.
- **Status bar** — while the webview caret/selection sits inside a change region,
  the bar shows `Changed by <author> on <local time>`; it clears when the
  selection leaves the region, when Live loses focus, or when the panel closes.
  A separate compact selector (`layout[Standard]:nth-match(12)`) stays after
  Live loses focus so the agent pointer survives switching to chat.

## Live selection (read pointer)

A **Live selection** is a caret or a highlight in the preview. A **highlight** is a
range with non-empty `selectedText`; a **caret** leaves `selectedText` empty.
Either captures a **read-first** pointer for the lq agent. It does **not** jump
the `.lyx` editor and is **not** a mutation selector. The same record is
published on two buses:

```json
{
  "file": "<absolute path of edit target>",
  "diskHash": "<sha256 of that file's saved bytes>",
  "stale": false,
  "mode": "tracked",
  "selector": "layout[Standard]:nth-match(12)",
  "coords": null,
  "selectedText": "phrase from a highlight, or empty if caret-only",
  "changeId": null,
  "multi": false,
  "capturedAt": "<ISO-8601>",
  "via": {
    "file": "<parent .lyx when file is an included child>",
    "selector": "inset[CommandInset include]:nth-match(1)"
  }
}
```

`via` is omitted for ordinary same-file selections. When present, `file` is the **child** document and `via` names the Include in the previewed parent (DL136).

| Bus | How |
| --- | --- |
| **VS Code Chat** | Language-model tool `#lyxSelection`. The chip is a hint; `invoke()` returns the in-memory record (or `no Live selection`). |
| **File** | Workspace `.lq/live-selection.json` (gitignored), or the extension globalStorage when there is no workspace folder. Other agents `Read` this path. |

**Hint the agent** after you select in Live (the status bar compact selector confirms a pointer). Do not rely on the webview selection becoming editor `@selection`.

| Chat | What to type |
| --- | --- |
| **VS Code Chat** | `#lyxSelection` |
| **Other sidebars** (Claude Code, Cursor, Cline, …) | `@.lq/live-selection.json` — type `@` then the path if the picker skips gitignored files |

`stale: true` means the editor buffer has unsaved edits — inspect only until save. `coords` is `{row, column}` (1-based) for table cells. `multi: true` means a highlight crossed owners; v1 still sends the **anchor** owner’s selector plus the full `selectedText`.

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

1. `~\Github\lq_dev\lq\bin` — development preference: the most recently modified `lq*` file there (e.g. `lq_<version>_win64.exe`, case-insensitive, `.map` excluded)
2. `lyx-preview.lqPath`
3. `lq` on `PATH`
