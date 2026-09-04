# LyX Preview

A VS Code companion extension for [`lq`](https://github.com/naivej/lq) — the standalone CLI for querying, inspecting, and mutating LyX documents.

LyX Preview renders a read-only preview of saved `.lyx` files directly inside a VS Code webview, combining visual feedback, outline navigation, and AI-assisted workflows.

## Features

- **LyX-Familiar Appearance:** Renders layouts, sections, formatting, tables, images, and math with styling faithful to the LyX editor.
- **LyX Outline View:** Dedicated panel in the Explorer sidebar to navigate the Table of Contents, figures, tables, equations, tracked changes, footnotes, and labels/references across both the raw `.lyx` buffer and the preview.
- **Tracked-Change Views:** Toggle between **Tracked** (markup shown), **Original** (pre-change), and **Clean** (post-change/accepted) views from the title bar.
- **Agent Context Sharing:**
  - Selecting text or constructs in the preview generates a temporary `live-selection.json` sidecar next to the previewed `.lyx` file for AI agents using `lq`.
  - Integrates with VS Code Language Model Tools via `#lyxSelection`.
- **Status Bar Inspection:** Displays the active selector, tracked-change author/timestamp metadata, and selection details in the VS Code status bar.
- **Built-in Webview Search:** Full support for standard search (`Ctrl+F` / `Cmd+F`) inside the preview panel.

## Getting Started

1. Install this extension.
2. Set `lq`'s installation path in `lyx-preview.unmanagedLqPath` (used first) or `lyx-preview.lqPath` (used second). LyX Preview downloads or updates the latter path from the latest GitHub Release. Both settings accept `~`.
3. Run `npx skills add naivej/lq` to install the `use-lq` skill for AI agent workflows.