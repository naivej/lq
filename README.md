<h1 align="center">
  <picture style="display:inline-block; margin-right:12px;">
    <source media="(prefers-color-scheme: dark)" srcset="brand/icon.svg">
    <source media="(prefers-color-scheme: light)" srcset="brand/icon-light.svg">
    <img src="brand/icon-light.svg" alt="lq - a CLI for LyX" width="48" height="48" style="vertical-align:-10px; display:inline-block;">
  </picture>
  lq - a CLI for LyX
</h1>

`lq` is a standalone CLI designed to parse, query, and mutate LyX documents (`.lyx` files).

### Quick start

- Build for your platform with `deno task build`, or download the binary
- `lq init` to create a local configuration in `./.lq/`
- `npx skills add naivej/lq` to install the skill
- Ask your agent to `/use-lq`
- Learn more from `lq help` if you like

### Highlights

- `lq` mutates `.lyx` files in the same way as LyX (verified by LyX source code).
- CLI + skill designed for **autonomous agents**.
  - The skill also covers how to use the LyX binary to create, import, and export LyX documents, allowing the user to work with LaTeX (and other supported formats) using LyX as the translator.
- Collaborate with agents in an **auto-refreshed** LyX GUI through [LyXServer](https://wiki.lyx.org/LyX/LyXServer).
- Agents make **tracked changes**, allowing easy review.

### Limitations
- `lq` focuses on writing assistance, not complex type-setting (e.g., intricate tables). Use the LyX GUI to fine-tune type-setting and preview the final PDF.
- **Windows limitations**: Three named-pipe behaviors of LyXServer on Windows that `lq` works around:
  - **`buffer-switch` is unusable**: the pipe protocol delimits messages with `:`, which conflicts with the drive letter in Windows absolute paths (e.g. `C:\...`). Auto-refresh therefore operates on LyX's active buffer rather than switching to the target file first. **Open only one `.lyx` file while using `lq` to avoid using the wrong buffer.**
  - **Confirmations are unreliable**: LyX's Windows pipe server can lose a command's *response* even though the command executed (a LyX server behavior — no client read strategy fixes it). `lq` therefore treats a command as dispatched once it is written to the pipe, and a lost confirmation only downgrades the outcome. **warnings mean "unconfirmed", not "failed"** — the command was dispatched and almost certainly executed. When warnings repeat, restart LyX to restore a healthy server.
  - **Refresh round-trips are slow (~4 s per mutation)**: recovering a lost confirmation re-sends the command on a fresh connection, so a refresh-enabled mutation averages two pipe round-trips (~2 s each) instead of one. **Turning off live GUI sync with `--refresh none` (the default) for almost instant `lq`**.

## Development

Requires **Deno 2.8+**.

- **Run tests:** `deno test -A`
- **Only affected tests:** `deno test -A --changed` (Deno 2.9+)
- **Test coverage:** `deno task coverage` generates per-function coverage report in `./cov`
- **Benchmark:** `deno bench -A --no-check tests/bench.ts`
- **CPU profiling:** `deno task profile <args...>` (outputs .cpuprofile, SVG flamegraph, and Markdown report)
- **Audit messages:** `deno task audit:messages` writes a report grouped by kind to `./audit/messages.md`; add `-- --format json` for `./audit/messages.json` or `--output <path>` for a custom destination
- **Watch execution:** `deno task dev`
- **Build binary:** `deno task build` (or `deno task build:all` for all platforms)
- **Compatibility**:
  - Developed and verified against **LyX 2.4 and LyX 2.5**.
  - Developed for MacOS/Linux/Windows, tested on Windows.

## License

MIT
