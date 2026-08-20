# LyX Preview

VS Code extension that shows a read-only **Live** preview of saved `.lyx` files by running the `lq preview` CLI and rendering its HTML in a webview.

## Use

1. Open a `.lyx` file.
2. Run **LyX Preview: Open LyX Preview** (command palette), or use the editor title icon when a `.lyx` buffer is active.
3. The preview refreshes from the **saved** file (unsaved editor buffer changes are not shown until you save).

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


