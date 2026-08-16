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
  - The skill also covers how to use the headless LyX to create, import, and export LyX documents, allowing the user to work with LaTeX (and other supported formats) using LyX as the translator.
- Collaborate with agents in an **auto-refreshed** LyX GUI through [LyXServer](https://wiki.lyx.org/LyX/LyXServer).
- Agents make **tracked changes**, allowing easy review.

### Windows patch

LyX's Windows LyXServer has a response-delivery race that can lose a command's *response* even though the command executed. This is a LyX server bug that affect `lq` auto-refresh.  
As the fix is pending upstream LyX, a patched LyX is provided in [`lyx_patch/`](lyx_patch/) with one-click swap scripts for reliably delivered confirmations and fast refresh.  
Without the fix, `lq` works around the race: a command counts as dispatched once written to the pipe, so warnings mean "unconfirmed", not "failed" — the command was almost certainly executed. Or keep `--refresh none` for almost instant `lq`.

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
