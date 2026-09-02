# LyX Preview

A VS Code companion extension for [`lq`](https://github.com/naivej/lq) — the standalone CLI for querying, inspecting, and mutating LyX documents.

LyX Preview renders a read-only live preview of saved `.lyx` files directly inside a VS Code webview, combining visual feedback, outline navigation, and AI-assisted workflows.

---

## Features

- **LyX-Familiar Appearance:** Renders layouts, sections, formatting, tables, images, and math with styling faithful to the LyX editor.
- **Instant Live Refresh:** Automatically updates whenever the `.lyx` file is saved or modified on disk (when the editor buffer is clean).
- **LyX Outline View:** Dedicated panel in the Explorer sidebar to navigate the Table of Contents, figures, tables, equations, tracked changes, footnotes, and labels/references across both the raw `.lyx` buffer and the preview.
- **Tracked-Change Views:** Toggle between **Tracked** (markup shown), **Original** (pre-change), and **Clean** (post-change/accepted) views from the title bar.
- **Agent Context Sharing:**
  - Selecting text or constructs in the preview generates a temporary `live-selection.json` sidecar next to the previewed `.lyx` file for AI agents using `lq`.
  - Integrates with VS Code Language Model Tools via `#lyxSelection`.
- **Status Bar Inspection:** Displays active CST selectors, tracked-change author/timestamp metadata, and selection details in the VS Code status bar.
- **Built-in Webview Search:** Full support for standard search (`Ctrl+F` / `Cmd+F`) inside the preview panel.

---

## Getting Started

### 1. Prerequisites

1. Set `lq`'s installation path in `lyx-preview.lqPath`. On load (and whenever that setting changes), LyX Preview downloads or updates the matching binary from the latest GitHub Release. For development, the extension first loads (but does not download or update) the Cargo release binary at `~/Github/lq_dev/lq/target/release/lq.exe` (or `lq` on Unix). Remove or rename that file to test GitHub-managed `lqPath` download.

2. Run `npx skills add naivej/lq` to install the `use-lq` skill for AI agent workflows.

### 2. Open Preview
1. Open any `.lyx` file in VS Code.
2. Click the **LyX Preview** icon (blue **L**) in the editor title bar, or run `LyX Preview: Open LyX Preview` from the Command Palette.

### 3. Tracked Changes View
When reviewing documents with revision marks, click the **Tracked-change view** icon (yellow **L**) in the preview title bar to switch views:
- **Tracked** *(default)*: Displays insertions with a blue underline and deletions with a red strikethrough.
- **Original**: Displays the document text prior to tracked modifications.
- **Clean**: Displays the document with all pending tracked changes accepted.

### 4. Share Selection with an AI Agent
- Select text or constructs inside the preview.
- Share the context with your agent by referencing `@live-selection.json` or mentioning `#lyxSelection` in VS Code chat.

---

## Relationship with LyXHTML

LyX Preview is **inspired by and verified against** LyX's native LyXHTML export, but it does **not** execute headless LyX processes to render HTML:
1. **Fast & Independent:** `lq` parses `.lyx` directly into a Concrete Syntax Tree (CST) and renders semantic HTML in milliseconds without requiring LyX to be installed or running.
2. **Editor-Focused Semantics:** While native LyXHTML targets a PDF-like reading layout, LyX Preview is tailored for reviewing. This introduces intentional differences:

| What you see in Preview | Explanation |
| --- | --- |
| `pageref` shows a section or figure number | No PDF pagination exists in HTML; a tooltip explains the reference. |
| Formula macros (e.g. `\qG`) appear as raw commands | Macro *insets* are omitted (matching native LyX); call sites are not expanded inline. |
| Math formatting is close but not identical to LyX MathML | Rendered via `lq`'s built-in TeX→MathML engine (with preamble `\newcommand` support) rather than LyX's internal converter. |
| Minimal layout chrome / no print page headers | Deliberately uses clean semantic HTML rather than print-emulating page margins. |
| Clickable chips for ERT, Phantom, Index | Preview-only interactive markers (omitted in native LyXHTML/PDF). |
| Collapsed Footnotes, Notes, Boxes, and Greyed-out blocks | Click the label disclosure to expand/collapse and select content inside. |
| `Note` and `Comment` insets are visible | Preview-only: private notes are accessible via click disclosure (omitted in exported PDF/LyXHTML). |
