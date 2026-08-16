# LyX Windows fix — patched files + step-by-step build guide

This folder lets you build your **own patched LyX** on Windows that fixes a bug in
LyX's Windows "LyXServer" (the built-in control interface). Before the fix, LyX
sometimes **lost about half of the replies** it sends to LyXServer clients (tools
like JabRef, or `lq`). Every command still ran — the reply was just dropped, so
clients thought LyX was slow or stuck. These two files repair the pipe server that
delivers those replies.

You do **not** need to be a programmer to follow this guide. Everything is
copy-paste. The whole process takes about 30–60 minutes (most of it waiting for
the compiler).

> **A note on versions:** this fix is written for **LyX 2.5.1**. Use it with the
> 2.5.1 source code exactly as described below. It may also apply to nearby
> 2.5.x releases, but 2.5.1 is the guaranteed target.

---

## Quick install (no building — about 2 minutes)

If you just want the fix and don't want to compile anything, everything you need
is in this folder. **Double-click `swap_to_patched.cmd`**. It will:

- find your installed LyX 2.5 (the usual install locations; edit the `LYXDIR`
  line at the top of the script if yours is elsewhere),
- back up your `bin\` folder to `bin_original_backup\`,
- install the patched `LyX2.5.1.exe` as your `LyX.exe`,
- install the matching MinGW Qt DLLs and plugins into `bin\` (the essential
  step that makes the patched binary run).

That's it — your LyX is now the fixed one, and `lq` (or JabRef, …) uses the
reliable server automatically. To go back to the official LyX later, double-click
`swap_back_original.cmd`.

> Everything the swap needs lives in the `runtime\` folder — the patched binary
> `LyX2.5.1.exe` plus its MinGW Qt DLLs and plugins (about 50 MB of build
> artifacts that are **not committed** to the repository, see `.gitignore`). If
> this folder doesn't contain them — e.g. you cloned the repo — follow the
> build-from-source guide below instead.
>
> You can run the two scripts from **anywhere**: double-click them in File
> Explorer, or run them from any folder. They locate their own files and your LyX
> install automatically (`cd /d "%~dp0"` + install detection), so there is no
> "right folder" to run them from.

---

## What's in this folder

| File | What it is |
|------|-----------|
| `swap_to_patched.cmd` | Double-click to install the patched LyX over your official one (backup + swap, no build). |
| `swap_back_original.cmd` | Double-click to restore your original official LyX from the backup. |
| `runtime\` | Everything the swap needs: the patched binary `LyX2.5.1.exe` plus its MinGW Qt DLLs and plugins (git-ignored local copies — present when this folder comes from the author's machine). |
| `src/Server.cpp` | Patched source file — replaces `src/Server.cpp` in the LyX source code. |
| `src/Server.h`   | Patched source file — replaces `src/Server.h` in the LyX source code. |

That's the whole fix: **two files**. The original LyX source has a buggy
Windows pipe loop; these two files contain the corrected version. Everything else
in LyX is untouched.

---

## Build from source (only if you didn't use the quick install)

1. **Download the LyX source code** (the "ingredients").
2. **Install a free compiler kit** called MSYS2 (the "oven").
3. **Copy the two patched files** over the originals in the source code.
4. **Build** — MSYS2 compiles LyX into a program.
5. **Run your patched LyX** and use it.

Steps 1 and 2 are one-time setup. Steps 3–5 take ~5 minutes of your time plus a
build that runs on its own.

---

## Step 1 — Download the LyX source code

1. Open <https://www.lyx.org/Download> in your browser.
2. In the **"Source code"** section, download the file **`lyx-2.5.1.tar.xz`**
   (about 10 MB).
3. Download and install **7-Zip** from <https://www.7-zip.org> (free) — you need
   it to unpack `.tar.xz` files. (If you already have 7-Zip or another tool that
   opens `.tar.xz`, skip this.)
4. Right-click `lyx-2.5.1.tar.xz` → **7-Zip → Extract here**, twice if needed
   (first you get a `.tar`, then the folder). You should end up with a folder
   named **`lyx-2.5.1`**.
5. Move that folder somewhere easy to type, for example:
   `C:\lyx-src\lyx-2.5.1` (so the file `C:\lyx-src\lyx-2.5.1\src\Server.cpp`
   exists). This guide assumes that path — if you use another, adjust the commands
   in Step 4.

---

## Step 2 — Install the build tools (MSYS2)

MSYS2 is a free bundle of compilers and tools. LyX is built with it (no Visual
Studio needed).

1. Go to <https://www.msys2.org> and download the installer (it's the big
   "msys2-x86_64-…-exe" link).
2. Run the installer. Accept the defaults; it installs to **`C:\msys64`**.
3. When it finishes it opens a window titled **"MSYS2 MSYS"**. Close it.
4. From the **Start menu**, open the app named **"MSYS2 MINGW64"** (this exact
   one — not "MSYS2 MSYS" and not "MSYS2 CLANG64"). A black terminal window opens.
5. Paste this command and press Enter (it updates the tool list; answer `Y` if it
   asks):
   ```bash
   pacman -Syu --noconfirm
   ```
   If it says the window must close, close it, reopen **MSYS2 MINGW64**, and run
   the same command once more.
6. Now install the tools LyX needs. Paste and press Enter:
   ```bash
   pacman -S --noconfirm --needed mingw-w64-x86_64-gcc mingw-w64-x86_64-cmake mingw-w64-x86_64-ninja mingw-w64-x86_64-qt6-base mingw-w64-x86_64-qt6-svg mingw-w64-x86_64-gettext mingw-w64-x86_64-pkgconf
   ```
   This downloads ~1 GB and takes a few minutes. When it's done, check that the
   tools are there:
   ```bash
   which g++ cmake ninja
   ```
   You should see three file paths. If instead you get errors like
   `which: no g++ in (...)`, re-open **MSYS2 MINGW64** (not MSYS) and repeat.

**Leave this MINGW64 window open** — you'll use it in Step 4.

---

## Step 3 — Copy the patched files

1. In Windows Explorer, open the LyX source folder you made in Step 1, then open
   the **`src`** subfolder. You should see (among many files) `Server.cpp` and
   `Server.h`.
2. **Optional but smart:** make a backup folder somewhere (e.g. `C:\lyx-backup`)
   and copy the *original* `Server.cpp` and `Server.h` into it, so you can undo
   later.
3. Copy the two files from **this** folder's `src` subfolder
   (`lyx_patch\src\Server.cpp` and `lyx_patch\src\Server.h`) into the LyX source
   `src` folder, and choose **"Replace the files in the destination"** when
   Windows asks.

That's the entire "patch". Everything else is just compiling.

---

## Step 4 — Build LyX

In the **MSYS2 MINGW64** window (Step 2):

1. Go to the LyX source folder (adjust if you extracted elsewhere):
   ```bash
   cd /c/lyx-src/lyx-2.5.1
   ```
2. Configure the build. Paste this entire long line and press Enter:
   ```bash
   cmake -S . -B build -G Ninja -DLYX_USE_QT=QT6 -DCMAKE_BUILD_TYPE=Release -DLYX_3RDPARTY_BUILD=OFF -DLYX_EXTERNAL_ICONV=ON -DLYX_EXTERNAL_Z=ON -DGNUWIN32_DIR=C:/msys64/mingw64 -DICONV_INCLUDE_DIR=C:/msys64/mingw64/include -DICONV_LIBRARY=C:/msys64/mingw64/lib/libiconv.dll.a -DICONV_DLL=C:/msys64/mingw64/bin/libiconv-2.dll
   ```
   Success looks like lines ending in `-- Build files have been written to:
   .../build` with **no** red `error` lines. If you see an error, scroll to the
   Troubleshooting section.
3. Build (this is the long one — 10–30 minutes; let it run):
   ```bash
   cmake --build build --target LyX2.5
   ```
   The last line should be:
   `[100%] ... Linking CXX executable bin\LyX2.5.exe`
   (or `[NN%]` numbers counting up to 100). Any red `error:` means something went
   wrong — see Troubleshooting.

**Your patched LyX is now at** `build\bin\LyX2.5.exe`.

---

## Step 5 — Turn on the LyXServer (needed for the fix to matter)

The patched pipe server is only active when LyX's server interface is on. Do this
once:

1. In the MINGW64 window, copy the default settings file into the source `lib`
   folder:
   ```bash
   cp build/lyxrc.dist lib/lyxrc.dist
   ```
   (This file tells LyX to enable the server pipe. If you ever want the default
   back, delete `lib/lyxrc.dist`.)

---

## Step 6 — Run your patched LyX

Start it with a small "where to find LyX's data" hint. In the MINGW64 window:

```bash
cd /c/lyx-src/lyx-2.5.1
LYX_DIR_25X=C:/lyx-src/lyx-2.5.1/lib ./build/bin/LyX2.5.exe
```

The LyX window opens. That's it — you're now running the **fixed** LyX. Use it
normally: open documents, edit, save.

> If you close the MINGW64 window you can also just double-click
> `build\bin\LyX2.5.exe`, but then the `LYX_DIR_25X` hint is not set, so LyX may
> ask where its data files are — point it at `C:\lyx-src\lyx-2.5.1\lib`.
> Starting it from the MINGW64 window (as above) avoids that.

---

## Step 7 — How to know the fix worked

- **Everyday use:** open a document, type, save, close — everything works as
  usual. The fix is invisible in normal use; it shows up for *programs that talk
  to LyX* (JabRef, `lq`, …): their commands are now answered reliably instead of
  ~half the replies being lost.
- **Optional quick check (for the curious):** open a document in LyX first, then
  start LyX with the server log on (in the MINGW64 window):
  ```bash
  LYX_DIR_25X=C:/lyx-src/lyx-2.5.1/lib ./build/bin/LyX2.5.exe -dbg LYXSERVER
  ```
  Open **PowerShell** (Start menu → type "PowerShell") and paste:
  ```powershell
  $base = "$env:APPDATA\LyX2.5\lyxpipe"
  $in = New-Object System.IO.Pipes.NamedPipeClientStream(".", "${base}.in", [System.IO.Pipes.PipeDirection]::Out)
  $in.Connect(5000)
  $w = New-Object System.IO.StreamWriter($in)
  $w.Write("LYXCMD:check1:server-get-filename`n"); $w.Flush(); $in.Dispose()
  Start-Sleep -Milliseconds 400
  $out = New-Object System.IO.Pipes.NamedPipeClientStream(".", "${base}.out", [System.IO.Pipes.PipeDirection]::In)
  $out.Connect(5000)
  $r = New-Object System.IO.StreamReader($out)
  $r.ReadToEnd()
  ```
  You should see a reply like `INFO:check1:server-get-filename:C:/...` with the
  path of the document open in LyX. Before the fix, this reply was frequently
  lost (the command returned nothing).

---

## Installing the patched LyX over your official one

Instead of always launching the built `build\bin\LyX2.5.exe`, you can make the
patched LyX your **default `LyX.exe`**, so `lq` (and JabRef, etc.) automatically
use the fixed server — no `LYXSOCKET` override needed. Here is how to do it on
your machine:

1. **Back up** your official install's `bin\` folder (copy
   `C:\Program Files\LyX 2.5\bin` to `bin_original_backup`, or wherever you keep
   your install). The backup holds your original `LyX.exe` and the original MSVC
   Qt DLLs, so you can undo the swap at any time — no other copy is needed.
2. **Copy** your patched `runtime\LyX2.5.1.exe` over `bin\LyX.exe` (replace the
   official one — the original is safe in `bin_original_backup`).
3. **Pair the MinGW build's dependencies** — this part is essential: your patched
   binary is built with **MSYS2/MinGW**, but the official installer ships **MSVC**
   Qt DLLs with the *same names* (`Qt6Core.dll`, …). A MinGW exe loading MSVC Qt
   DLLs crashes (different C++ ABI), so copy the MinGW `Qt6*.dll` files, the MinGW
   runtime DLLs (`libgcc_s_seh-1.dll`, `libstdc++-6.dll`,
   `libwinpthread-1.dll`, `libiconv-2.dll`, `zlib1.dll`) and the MinGW Qt plugins
   (`platforms\`, `imageformats\`, `iconengines\`) over the MSVC ones in `bin\`.

**To undo the swap:** close LyX, then copy everything from `bin_original_backup\`
back into `bin\` (overwrite), which restores your official `LyX.exe` and the
original MSVC Qt DLLs.

Verified on 2026-08-16 with this setup: the installed patched `LyX.exe` starts,
`lq init --refresh save-reload` finds it automatically (image name `LyX.exe`), and
`set --find` mutations round-trip with zero refresh warnings.

---

## Troubleshooting

| Symptom | Cause / fix |
|---------|-------------|
| `cmake: command not found` or `g++: command not found` | You're in the wrong MSYS2 window. Re-open **MSYS2 MINGW64** from the Start menu (not "MSYS2 MSYS", not Git Bash, not plain PowerShell) and repeat the command there. |
| Configure ends in a red `error: ... iconv ...` | The iconv settings are wrong. Re-run the exact configure line from Step 4 (it points at the MSYS2 iconv). If you changed the install location of MSYS2 (not `C:\msys64`), replace `C:/msys64` in that line with your actual path. |
| Build fails at the *end* with `cannot open output file ... Permission denied` | A `LyX2.5.exe` is still running, so Windows locked the file. Close all LyX windows (or in MINGW64 run `taskkill //IM LyX2.5.exe //F`), then run `cmake --build build --target LyX2.5` again. |
| Build takes 30+ minutes | Normal — LyX is a big program and this is a full compile. Only the first build is slow; later builds are fast. |
| The LyX window opens but the PowerShell check returns nothing | The server may be off. Redo Step 5 (`cp build/lyxrc.dist lib/lyxrc.dist`), restart LyX, and make sure the PowerShell check ran *after* LyX was fully started. |
| `Document not loaded` error from a client | That's normal for a command naming a file that isn't open in LyX — it's a correct reply, not the bug. |
| I want the original files back | Restore `Server.cpp` / `Server.h` from your Step 3 backup, or re-extract the `.tar.xz` and copy the originals over. |

---

## Notes

- **Windows only.** The fix touches only LyX's Windows named-pipe server. The
  Unix/macOS code path is untouched.
- **Scope.** It's two files (`src/Server.h`, `src/Server.cpp`) that repair the
  Windows pipe loop: replies are now delivered as soon as they're ready, stale
  replies are never handed to the wrong client, replies are never discarded by an
  early disconnect, and the pipe instances recycle properly. Full technical
  analysis lives in `dev_logs/lyx/001_server_pipe_delivery_race.md` in the
  `lq_dev` repository.
- **The fix is not yet in an official LyX release.** A patch was submitted to the
  LyX developers (Trac ticket + `lyx-devel` mailing list, per LyX's contribution
  rules). Until it ships, this local build is how you get the fix today. When a
  future LyX release includes it, you can switch back to the normal installer.
- **License.** LyX is GPL — building from source is fully allowed. These patched
  files are derived from LyX 2.5.1 and are provided under the same license.
