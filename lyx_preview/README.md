# LyX Preview

VS Code extension that shows a read-only **Live** preview of saved `.lyx` files by running the `lq preview` CLI and rendering its HTML in a webview.

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

Build a discoverable binary with `deno task build` from the `lq` package root (output under `lq/bin/`), or set `lyx-preview.lqPath` / `LQ_PATH` explicitly.


