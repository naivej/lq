# LyX Windows fix — patched files + step-by-step build guide

This folder lets you build your **own patched LyX** on Windows that fixes a bug in LyXServer. On Windows, LyX's pipe server could fail to deliver replies to LyXServer clients (tools like JabRef, or `lq`): a command ran, but the reply was dropped, so clients thought
LyX was slow or stuck. These two files repair the pipe server that delivers those replies.

> **A note on versions:** this fix is written for **LyX 2.5.1**. Use it with the 2.5.1 source code exactly as described below. It may also apply to nearby 2.5.x releases, but 2.5.1 is the guaranteed target.

---

## Quick install (no building — about 2 minutes)

If you just want the fix and don't want to compile anything, everything you need is in this folder. **Double-click `swap_to_patched.cmd`**. It will:

- find your installed LyX 2.5 (the usual install locations; edit the `LYXDIR` line at the top of the script if yours is elsewhere),
- keep your official `LyX.exe` aside as `LyX.exe.orig`,
- install the patched `LyX2.5.1.exe` as your `LyX.exe`.

To go back to the official LyX later, double-click `swap_back_original.cmd`.

---

## What's in this folder

| File | What it is |
|------|-----------|
| `swap_to_patched.cmd` | Double-click to install the patched LyX over your official one (backup + swap, no build). |
| `swap_back_original.cmd` | Double-click to restore your original official LyX from the backup. |
| `runtime/LyX2.5.1.exe` | The patched binary. |
| `src/Server.cpp` | Patched source file — replaces `src/Server.cpp` in the LyX source code. |
| `src/Server.h`   | Patched source file — replaces `src/Server.h` in the LyX source code. |

---

## Build from source (only if you didn't use the quick install)

The steps below build LyX the **same way the official LyX for Windows is built** (Microsoft Visual C++ and Qt for MSVC). This is what makes the swap a single file: the resulting `LyX.exe` uses the same Qt DLLs the official installer ships.

1. **Download the LyX source code** (the "ingredients").
2. **Install the build tools**: Visual Studio Build Tools, CMake, Qt, and LyX's
   dependency bundle.
3. **Copy the two patched files** over the originals in the source code.
4. **Build** — CMake compiles LyX into a program.
5. **Run your patched LyX** and use it.

### Step 1 — Download the LyX source code

1. Open <https://www.lyx.org/Download> in your browser.
2. In the **"Source code"** section, download the file **`lyx-2.5.1.tar.xz`**
   (about 10 MB).

### Step 2 — Install the build tools

**2a. Visual Studio Build Tools (the C++ compiler).**
1. Go to <https://visualstudio.microsoft.com/downloads/> and download **Build Tools for Visual Studio 2022** (the standalone "Build Tools" link, not the full Visual Studio).
2. Run the installer. On the workload list, tick **"Desktop development with C++"** and click Install. (This is ~2–4 GB and takes a while.)

**2b. CMake.**
1. Download the Windows x64 zip from <https://cmake.org/download/> (the current one is named something like `cmake-4.x.x-windows-x86_64.zip`).
2. Extract it and note the path to `cmake.exe` inside `bin\`, e.g. `C:\cmake\cmake-4.4.2-windows-x86_64\bin\cmake.exe`. (Use the official CMake from cmake.org, not a package-manager build — it keeps the build clean.)

**2c. Qt 6.10.2 for MSVC.** LyX 2.5.1's official Windows installer ships **Qt 6.10.2**, so the patched binary must be built against exactly that version.

1. Install Python from <https://www.python.org> (any recent 3.x; tick "Add python.exe to PATH" during install).
2. Open a **Command Prompt** and install the Qt downloader:
   ```
   pip install aqtinstall
   ```
3. Download Qt 6.10.2 (MSVC 2022, 64-bit) into `C:\Qt`:
   ```
   aqt install-qt windows desktop 6.10.2 win64_msvc2022_64 -O C:\Qt
   ```
   This gives you `C:\Qt\6.10.2\msvc2022_64`.

**2d. LyX's Windows dependency bundle.** LyX needs a small bundle of Windows tools (gettext, Python, Ghostscript, …) at build time.

1. Download **`lyx-windows-deps-msvc2019_64.zip`** from <http://ftp.lyx.org/pub/lyx/devel/win_deps/>.
2. Extract it and note the inner folder, e.g. `C:\lyx-deps\lyx-windows-deps-msvc2019_64`.

### Step 3 — Copy the patched files

1. In Windows Explorer, open the LyX source folder you made in Step 1, then open the **`src`** subfolder. You should see (among many files) `Server.cpp` and `Server.h`.
2. Copy the two files from **this** folder's `src` subfolder (`lyx_patch\src\Server.cpp` and `lyx_patch\src\Server.h`) into the LyX source `src` folder with replace.

### Step 4 — Build LyX

Build in a **"x64 Native Tools Command Prompt for VS 2022"**. This is the prompt that knows where the compiler is (Start menu → search "x64 Native Tools"). In that prompt:

1. Go to the LyX source folder (adjust if you extracted elsewhere):
   ```
   cd C:\lyx-src\lyx-2.5.1
   ```
2. Configure the build. Adjust the two paths — the LyX deps folder (Step 2d) and the Qt folder (Step 2c) — then paste this entire long line and press Enter:
   ```
   C:\cmake\cmake-4.4.2-windows-x86_64\bin\cmake.exe -S . -B build-msvc -G "Visual Studio 17 2022" -A x64 -DLYX_USE_QT=QT6 -DCMAKE_BUILD_TYPE=Release -DLYX_3RDPARTY_BUILD=ON -DGNUWIN32_DIR=C:\lyx-deps\lyx-windows-deps-msvc2019_64 -DCMAKE_PREFIX_PATH=C:\Qt\6.10.2\msvc2022_64 -DLYX_CONSOLE=OFF
   ```
   Success looks like lines ending in `-- Build files have been written to:.../build-msvc` with **no** red `error` lines. (The first run takes a few minutes while CMake checks the compiler.)
3. Build (this is the long one — 10–30 minutes; let it run):
   ```
   C:\cmake\cmake-4.4.2-windows-x86_64\bin\cmake.exe --build build-msvc --config Release --target LyX
   ```
   The last line should be: `LyX.vcxproj -> ...\build-msvc\bin\Release\LyX.exe` Any `error C...` means something went wrong — see Troubleshooting.

**Your patched LyX is now at** `build-msvc\bin\Release\LyX.exe`.

---

## How to know the fix worked

- **Everyday use:** after `swap_to_patched.cmd` finishes, start LyX from your usual shortcut. The `LyX.exe` in your normal installation is now the patched binary, so open a document, type, save, and close as usual. The fix is invisible in normal use; it shows up for *programs that talk to LyX* (JabRef, `lq`, …): their commands are now answered reliably instead of replies being lost.
- **Optional quick check (for the curious):** close LyX, then open **PowerShell**. Start the installed executable with the server log on. For the default system-wide installation, run:
   
   ```
  Start-Process -FilePath "C:\Program Files\LyX 2.5\bin\LyX.exe" -ArgumentList '-dbg', 'LYXSERVER'
  ```
   For a per-user installation, use:
   ```
  Start-Process -FilePath "$env:LOCALAPPDATA\Programs\LyX 2.5\bin\LyX.exe" -ArgumentList '-dbg', 'LYXSERVER'
   ```
   `Start-Process` returns immediately, so keep using the same PowerShell window.
   Open a document in LyX, then paste:
  
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

## Troubleshooting

| Symptom | Cause / fix |
|---------|-------------|
| `cmake: command not found` | CMake isn't on your PATH. Use the full path from Step 2b (`C:\cmake\...\bin\cmake.exe`) or add its `bin\` to your PATH. |
| `cl.exe` / compiler errors at configure time | You're not in the **"x64 Native Tools Command Prompt for VS 2022"**. Re-open that specific prompt and repeat Step 4 there. |
| Configure fails with `Could NOT find GNUWIN32` | The LyX deps path is wrong. Double-check `-DGNUWIN32_DIR=...` points at the extracted `lyx-windows-deps-msvc2019_64` folder (Step 2d). |
| Configure fails with `Could NOT find Qt6` | The Qt path is wrong. Double-check `-DCMAKE_PREFIX_PATH=...` points at `C:\Qt\6.10.2\msvc2022_64` (Step 2c), and that you installed exactly 6.10.2. |
| Build fails at the *end* with `cannot open output file ... Permission denied` or `LNK1104` | A `LyX.exe` is still running, so Windows locked the file. Close all LyX windows, then run the `cmake --build ... --target LyX` line again. |
| Build takes 30+ minutes | Normal — LyX is a big program and this is a full compile. Only the first build is slow; later builds are fast. |
| The LyX window opens but the PowerShell check returns nothing | Make sure a document is open and run the check after LyX has fully started. For a source build, run `Copy-Item build-msvc\lyxrc.dist lib\lyxrc.dist` once from the source directory, then restart LyX. |
| LyX starts but shows a DLL / "procedure entry point" error | Qt version mismatch — make sure the patched binary was built against Qt 6.10.2, as described in Step 2c. |
| `Document not loaded` error from a client | That's normal for a command naming a file that isn't open in LyX — it's a correct reply, not the bug. |
| I want the original files back | If you used the quick install, run `swap_back_original.cmd`. If you replaced files in a source tree, re-extract `lyx-2.5.1.tar.xz` and copy the original `Server.cpp` / `Server.h` over them. |

---

## Notes

- **Windows only.** The fix touches only LyX's Windows named-pipe server. The
  Unix/macOS code path is untouched.
- **Scope.** It's two files (`src/Server.h`, `src/Server.cpp`) that repair the
  Windows pipe loop: replies are now delivered as soon as they're ready, stale
  replies are never handed to the wrong client, replies are never discarded by an
  early disconnect, and the pipe instances recycle properly.
- **The fix is not yet in an official LyX release.** A patch was submitted to the
  LyX developers. Until it ships, this local build is how you get the fix today. When a
  future LyX release includes it, you can switch back to the normal installer.
- **License.** LyX is GPL — building from source is fully allowed. These patched
  files are derived from LyX 2.5.1 and are provided under the same license.
