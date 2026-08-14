# LyX GUI (open/close for LyXServer)

The LyX GUI hosts LyXServer. The agent opens and closes LyX itself — no human is required; a window appears on the user's screen, which is expected.

### Open GUI and LyXServer

```bash
"{lyx}" doc.lyx                          # open lyx file in GUI: launching the LyX binary starts LyXServer by default
"{lyx}" -r doc.lyx                       # reuse running instance
```

Omit `-batch` (batch runs headless and exits). Wait for LyX to finish starting before dispatching refresh. If LyXServer is unreachable after launch, stop and ask the user — do not invent LFUN workarounds. For refresh modes and can't-connect troubleshooting, see [`LyXServer.md`](LyXServer.md).

### Close LyX (for a fresh session)

Close LyX when the session is done, or to restart a degraded LyXServer — a fresh server is the fix for repeated confirmation loss (see [`LyXServer.md`](LyXServer.md)), and a fresh session also re-reads externally changed files. Force-kill is fine once the buffer is on disk; if LyX may hold unsaved in-GUI edits, run a `--refresh save-reload` mutation first so they are written before closing:

```bash
# Windows — terminate all LyX instances:
taskkill //IM LyX.exe //F

# ...or terminate one instance by PID:
tasklist | grep -i "LyX.exe"     # find the PID
taskkill //PID <pid> //F

# Unix:
pkill lyx                          # or: kill <pid>
```

(The `//` flag form is for Git Bash; in cmd/PowerShell use a single `/`, e.g. `taskkill /IM LyX.exe /F`.) To start a fresh session, open the file again as above.
