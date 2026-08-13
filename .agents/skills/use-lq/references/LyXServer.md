# LyXServer and refresh

LyXServer is optional; disk is the primary integration point. For automatic refresh: `lq init --refresh reload` (fast, but discards unsaved in-LyX edits) or `lq init --refresh save-reload` (preserves unsaved edits; requires LyXServer and is slower). Use `save-reload` when LyX has unsaved work that must be preserved; use `none` for ordinary fast, Git-backed edits when LyX can reload externally changed files.

On Windows, LyXServer's response delivery is unreliable: a lost confirmation does not mean the command failed — lq distinguishes dispatched, confirmed, and errored outcomes and treats an unconfirmed refresh as a warning when it is safe to proceed. Do not diagnose repeated confirmation loss by adding more blocking reads — LyX executes a command even when its response is lost, and stale responses linger in the server's shared reply buffer (`outbuf_`) until the next flush cycle, so no client-side read strategy is reliable. Restart LyX to restore a healthy server.

Genuine can't-connect, in order of likelihood:
1. **Wrong user dir** — `$LYXSOCKET` (override) else `%APPDATA%\LyX2.5\lyxpipe`, only if that dir exists AND `LyX.exe` is in `tasklist`.
2. **Pipe instances exhausted / server degraded** — `MAX_CLIENTS=10` per pipe plus the reply backlog; restart LyX.
3. **Shell-escaping trap** — inline PowerShell/bash mangles `\\.\pipe\` → use lq's own detection / script files.
4. **Server not enabled** (rare) — `\serverpipe` preference empty; enable once in the GUI + restart.

Sanity checks: `lq init --refresh save-reload` is the fastest discovery check (dispatch-only, no response wait); a `REFRESH_PRE_ERROR` or pipe-open timeout means a genuine disconnect (items 1–3), never the race. On Windows only the active buffer is saved/reloaded (buffer-switch is skipped), so keep only the intended `.lyx` file open.
