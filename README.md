<h1 align="center">
  <picture style="display:inline-block; margin-right:12px;">
    <source media="(prefers-color-scheme: dark)" srcset="brand/icon.svg">
    <source media="(prefers-color-scheme: light)" srcset="brand/icon-light.svg">
    <img src="brand/icon-light.svg" alt="lq - a CLI for LyX" width="48" height="48" style="vertical-align:-10px; display:inline-block;">
  </picture>
  lq - a CLI for LyX
</h1>

`lq` is a standalone CLI designed to parse, query, and mutate LyX documents (`.lyx` files).

## Quick start

- Build for your platform with `deno task build`, or download the binary
- Run `lq init` to create a local configuration in `.lq/`
- Run `npx skills add naivej/lq` to install the skill
- (Optional) Install the [LyX Preview extension for VS Code](lyx_preview/README.md)
- Ask your agent to `/use-lq`
- Explore `lq help` to learn more

## Highlights

- `lq` mutates `.lyx` files in the same way as LyX (verified against the LyX source code).
- CLI and skill designed for AI agents.
  - The skill also covers how to use headless LyX to create, import, and export LyX documents, allowing users to work with LaTeX (and other supported formats) using LyX as a translator.
- Collaborate with agents:
  - in an auto-refreshed LyX GUI through [LyXServer](https://wiki.lyx.org/LyX/LyXServer).
  - in VS Code through the [LyX Preview extension](lyx_preview/README.md).
- Agents make tracked changes, allowing easy review.

## Compatibility

- Developed and verified against **LyX 2.4 and LyX 2.5**.
- Developed for macOS, Linux, and Windows; tested on Windows.

### Windows patch

LyX's Windows LyXServer has a response-delivery race that can lose a command's *response* even though the command executed. This is an upstream LyX bug that affects `lq` auto-refresh.  
While the upstream fix is pending, a patched LyX build is provided in [`lyx_patch/`](lyx_patch/) with one-click swap scripts for reliable response confirmations and fast refresh.  
Without the patch, `lq` works around the race: a command counts as dispatched once written to the pipe, so warnings mean "unconfirmed", not "failed" — the command was almost certainly executed.

## License

MIT
