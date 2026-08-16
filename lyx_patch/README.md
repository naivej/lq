# LyX Windows fix — patched files + step-by-step build guide

This folder lets you build your **own patched LyX** on Windows that fixes a bug in
LyX's Windows "LyXServer" (the built-in control interface). On Windows, LyX's
pipe server could fail to deliver replies to LyXServer clients (tools like
JabRef, or `lq`): a command ran, but the reply was dropped, so clients thought
LyX was slow or stuck. These two files repair the pipe server that delivers
those replies.

You do **not** need to be a programmer to follow this guide. If you use the
quick install below, it takes about 2 minutes and needs no tools at all.

> **A note on versions:** this fix is written for **LyX 2.5.1**. Use it with the
> 2.5.1 source code exactly as described below. It may also apply to nearby
> 2.5.x releases, but 2.5.1 is the guaranteed target.

---

## Quick install (no building — about 2 minutes)

If you just want the fix and don't want to compile anything, everything you need
is in this folder. **Double-click `swap_to_patched.cmd`**. It will:

- find your installed LyX 2.5 (the usual install locations; edit the `LYXDIR`
  line at the top of the script if yours is elsewhere),
- keep your official `LyX.exe` aside as `LyX.exe.orig`,
- install the patched `LyX2.5.1.exe` as your `LyX.exe`.

That's it — your LyX is now the fixed one, and `lq` (or JabRef, …) uses the
reliable server automatically. To go back to the official LyX later, double-click
`swap_back_original.cmd`.

> The patched binary is built the **same way as the official release** (MSVC and
> the same Qt version), so it uses the Qt DLLs that are already in your LyX
> folder — only `LyX.exe` is replaced, nothing else.
>
> Everything the swap needs lives in the `runtime\` folder — a single patched
> binary `LyX2.5.1.exe` (about 12 MB, **not committed** to the repository, see
> `.gitignore`). If this folder doesn't contain it — e.g. you cloned the repo —
> follow the build-from-source guide below instead.
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
| `runtime\` | Everything the swap needs: the single patched binary `LyX2.5.1.exe` (git-ignored local copy — present when this folder comes from the author's machine). |
| `src/Server.cpp` | Patched source file — replaces `src/Server.cpp` in the LyX source code. |
| `src/Server.h`   | Patched source file — replaces `src/Server.h` in the LyX source code. |

That's the whole fix: **two files**. The original LyX source has a buggy
Windows pipe loop; these two files contain the corrected version. Everything else
in LyX is untouched.

---

## Build from source (only if you didn't use the quick install)

The steps below build LyX the **same way the official LyX for Windows is built**
(Microsoft Visual C++ and Qt for MSVC). This is what makes the swap a single
file: the resulting `LyX.exe` uses the same Qt DLLs the official installer ships.

1. **Download the LyX source code** (the "ingredients").
2. **Install the build tools**: Visual Studio Build Tools, CMake, Qt, and LyX's
   dependency bundle.
3. **Copy the two patched files** over the originals in the source code.
4. **Build** — CMake compiles LyX into a program.
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

## Step 2 — Install the build tools

You need four things. All are free.

**2a. Visual Studio Build Tools (the C++ compiler).**
1. Go to <https://visualstudio.microsoft.com/downloads/> and download
   **Build Tools for Visual Studio 2022** (the standalone "Build Tools" link, not
   the full Visual Studio).
2. Run the installer. On the workload list, tick **"Desktop development with
   C++"** and click Install. (This is ~2–4 GB and takes a while.)

**2b. CMake.**
1. Download the Windows x64 zip from <https://cmake.org/download/> (the current
   one is named something like `cmake-4.x.x-windows-x86_64.zip`).
2. Extract it and note the path to `cmake.exe` inside `bin\`, e.g.
   `C:\cmake\cmake-4.4.2-windows-x86_64\bin\cmake.exe`. (Use the official CMake
   from cmake.org, not a package-manager build — it keeps the build clean.)

**2c. Qt 6.10.2 for MSVC.** LyX 2.5.1's official Windows installer ships
**Qt 6.10.2**, so the patched binary must be built against exactly that version.
1. Install Python from <https://www.python.org> (any recent 3.x; tick "Add
   python.exe to PATH" during install).
2. Open a **Command Prompt** and install the Qt downloader:
   ```
   pip install aqtinstall
   ```
3. Download Qt 6.10.2 (MSVC 2022, 64-bit) into `C:\Qt`:
   ```
   aqt install-qt windows desktop 6.10.2 win64_msvc2022_64 -O C:\Qt
   ```
   This gives you `C:\Qt\6.10.2\msvc2022_64`.

**2d. LyX's Windows dependency bundle.** LyX needs a small bundle of Windows
tools (gettext, Python, Ghostscript, …) at build time.
1. Download **`lyx-windows-deps-msvc2019_64.zip`** from
   <http://ftp.lyx.org/pub/lyx/devel/win_deps/>.
2. Extract it and note the inner folder, e.g.
   `C:\lyx-deps\lyx-windows-deps-msvc2019_64`.

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

Build in a **"x64 Native Tools Command Prompt for VS 2022"** — this is the
prompt that knows where the compiler is (Start menu → search "x64 Native
Tools"). In that prompt:

1. Go to the LyX source folder (adjust if you extracted elsewhere):
   ```
   cd C:\lyx-src\lyx-2.5.1
   ```
2. Configure the build. Adjust the two paths — the LyX deps folder (Step 2d)
   and the Qt folder (Step 2c) — then paste this entire long line and press
   Enter:
   ```
   C:\cmake\cmake-4.4.2-windows-x86_64\bin\cmake.exe -S . -B build-msvc -G "Visual Studio 17 2022" -A x64 -DLYX_USE_QT=QT6 -DCMAKE_BUILD_TYPE=Release -DLYX_3RDPARTY_BUILD=ON -DGNUWIN32_DIR=C:\lyx-deps\lyx-windows-deps-msvc2019_64 -DCMAKE_PREFIX_PATH=C:\Qt\6.10.2\msvc2022_64 -DLYX_CONSOLE=OFF
   ```
   Success looks like lines ending in `-- Build files have been written to:
   .../build-msvc` with **no** red `error` lines. (The first run takes a few
   minutes while CMake checks the compiler.)
3. Build (this is the long one — 10–30 minutes; let it run):
   ```
   C:\cmake\cmake-4.4.2-windows-x86_64\bin\cmake.exe --build build-msvc --config Release --target LyX
   ```
   The last line should be:
   `LyX.vcxproj -> ...\build-msvc\bin\Release\LyX.exe`
   Any `error C...` means something went wrong — see Troubleshooting.

**Your patched LyX is now at** `build-msvc\bin\Release\LyX.exe`.

---

## Step 5 — Turn on the LyXServer (needed for the fix to matter)

The patched pipe server is only active when LyX's server interface is on. Do this
once:

1. In the Command Prompt, copy the default settings file into the source `lib`
   folder:
   ```
   copy build-msvc\lyxrc.dist lib\lyxrc.dist
   ```
   (This file tells LyX to enable the server pipe. If you ever want the default
   back, delete `lib\lyxrc.dist`.)

---

## Step 6 — Run your patched LyX

In the Command Prompt, start it with a small "where to find LyX's data" hint:

```
set LYX_DIR_25X=C:\lyx-src\lyx-2.5.1\lib
build-msvc\bin\Release\LyX.exe
```

The LyX window opens. That's it — you're now running the **fixed** LyX. Use it
normally: open documents, edit, save.

> If you close the Command Prompt you can also just double-click
> `build-msvc\bin\Release\LyX.exe`, but then the `LYX_DIR_25X` hint is not set,
> so LyX may ask where its data files are — point it at
> `C:\lyx-src\lyx-2.5.1\lib`.

---

## Step 7 — How to know the fix worked

- **Everyday use:** open a document, type, save, close — everything works as
  usual. The fix is invisible in normal use; it shows up for *programs that talk
  to LyX* (JabRef, `lq`, …): their commands are now answered reliably instead of
  replies being lost.
- **Optional quick check (for the curious):** open a document in LyX first, then
  start LyX with the server log on (in the Command Prompt):
  ```
  set LYX_DIR_25X=C:\lyx-src\lyx-2.5.1\lib
  build-msvc\bin\Release\LyX.exe -dbg LYXSERVER
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
  path of the document open in LyX.

---

## Installing the patched LyX over your official one

Instead of always launching the built `build-msvc\bin\Release\LyX.exe`, you can
make the patched LyX your **default `LyX.exe`**, so `lq` (and JabRef, etc.)
automatically use the fixed server — no `LYXSOCKET` override needed. The quick
install script (`swap_to_patched.cmd`) does this for you; here is what it does:

1. **Keep the official exe aside**: the script renames your official
   `bin\LyX.exe` to `bin\LyX.exe.orig`, so it can be restored at any time.
2. **Copy** the patched `LyX2.5.1.exe` over `bin\LyX.exe`.

That's the whole swap — just the exe. Because the patched binary is built the
same way as the official one (MSVC, and the same Qt 6.10.2), it runs against the
Qt DLLs the official installer already put in `bin\` — no other files change.

**To undo the swap:** close LyX, then run `swap_back_original.cmd`, which deletes
the patched `LyX.exe` and renames `LyX.exe.orig` back to `LyX.exe`.

> **If LyX fails to start with "The procedure entry point ... could not be
> located in the dynamic link library":** the patched `LyX.exe` was built against
> a different Qt version than the one in your install's `bin\`. The official LyX
> 2.5.1 ships Qt **6.10.2**; rebuild with exactly that version (Step 2c). The
> swap scripts never touch the Qt DLLs, so an entry-point error means the exe
> itself was built against the wrong Qt — rebuild, don't re-swap.

Verified on 2026-08-16 with this setup: the installed patched `LyX.exe` starts,
`lq init --refresh save-reload` finds it automatically (image name `LyX.exe`), and
`set --find` mutations round-trip with zero refresh warnings.

---

## Troubleshooting

| Symptom | Cause / fix |
|---------|-------------|
| `cmake: command not found` | CMake isn't on your PATH. Use the full path from Step 2b (`C:\cmake\...\bin\cmake.exe`) or add its `bin\` to your PATH. |
| `cl.exe` / compiler errors at configure time | You're not in the **"x64 Native Tools Command Prompt for VS 2022"**. Re-open that specific prompt (Start menu → search "x64 Native Tools") and repeat Step 4 there. |
| Configure fails with `Could NOT find GNUWIN32` | The LyX deps path is wrong. Double-check `-DGNUWIN32_DIR=...` points at the extracted `lyx-windows-deps-msvc2019_64` folder (Step 2d). |
| Configure fails with `Could NOT find Qt6` | The Qt path is wrong. Double-check `-DCMAKE_PREFIX_PATH=...` points at `C:\Qt\6.10.2\msvc2022_64` (Step 2c), and that you installed exactly 6.10.2. |
| Build fails at the *end* with `cannot open output file ... Permission denied` or `LNK1104` | A `LyX.exe` is still running, so Windows locked the file. Close all LyX windows, then run the `cmake --build ... --target LyX` line again. |
| Build takes 30+ minutes | Normal — LyX is a big program and this is a full compile. Only the first build is slow; later builds are fast. |
| The LyX window opens but the PowerShell check returns nothing | The server may be off. Redo Step 5 (`copy build-msvc\lyxrc.dist lib\lyxrc.dist`), restart LyX, and make sure the PowerShell check ran *after* LyX was fully started. |
| LyX starts but shows a DLL / "procedure entry point" error | Qt version mismatch — see the note in "Installing the patched LyX over your official one". |
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
