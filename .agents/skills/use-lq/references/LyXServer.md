# LyXServer and refresh

LyXServer is optional; disk is the primary integration point. For automatic refresh: `lq init --refresh reload` (fast, but discards unsaved in-LyX edits) or `lq init --refresh save-reload` (preserves unsaved edits; requires LyXServer and is slower). Use `save-reload` when LyX has unsaved work that must be preserved; use `none` for ordinary fast, Git-backed edits when LyX can reload externally changed files.

To use `save-reload`, start LyXServer yourself: open the target file in the GUI with `"{lyx}" <file>` (omit `-batch`; see [`LyX_GUI.md`](LyX_GUI.md) "Open GUI and LyXServer"). No human is required — a window appears on the user's screen, which is expected. LyXServer is on by default; a cleared `\serverpipe` preference (enable once in Preferences, then restart) is the only way it stays off.

On Windows, if the LyX version is not patched with a bug fix, LyXServer's response delivery could be unreliable. But a lost confirmation does not mean the command failed. `lq` distinguishes dispatched, confirmed, and errored outcomes as a safety net, so an unconfirmed refresh is treated as a warning when it is safe to proceed.

Genuine can't-connect, in order of likelihood:
1. **Wrong user dir** — `$LYXSOCKET` (override) else `%APPDATA%\LyX2.5\lyxpipe`, only if that dir exists AND `LyX.exe` is in `tasklist`.
2. **Shell-escaping trap** — inline PowerShell/bash mangles `\\.\pipe\` → use lq's own detection / script files.
3. **Server not enabled** (rare) — `\serverpipe` preference empty; enable once in the GUI + restart.

Sanity checks: `lq init --refresh save-reload` is the fastest discovery check (dispatch-only, no response wait); a `REFRESH_PRE_ERROR` or pipe-open timeout means a genuine disconnect (items 1–3), never a response-delivery issue (with the patched LyX from `lyx_patch/`, confirmations are delivered reliably).
