@echo off
setlocal
REM ============================================================
REM  Swap your official LyX for the PATCHED one - no build needed
REM  Run this from the lyx_patch folder (double-click is fine).
REM  If LyX is installed somewhere unusual, set LYXDIR below.
REM ============================================================
cd /d "%~dp0"

REM --- Where is LyX 2.5 installed? Edit this if not detected ---
set "LYXDIR="
if exist "%LOCALAPPDATA%\Programs\LyX 2.5\bin\LyX.exe" set "LYXDIR=%LOCALAPPDATA%\Programs\LyX 2.5"
if not defined LYXDIR if exist "C:\Program Files\LyX 2.5\bin\LyX.exe" set "LYXDIR=C:\Program Files\LyX 2.5"
if not defined LYXDIR if exist "C:\Program Files (x86)\LyX 2.5\bin\LyX.exe" set "LYXDIR=C:\Program Files (x86)\LyX 2.5"
if not defined LYXDIR (
    echo.
    echo LyX 2.5 was not found in the usual places.
    echo Open this file in Notepad and set LYXDIR to your LyX install folder,
    echo e.g.  set "LYXDIR=C:\Program Files\LyX 2.5"
    echo.
    pause
    exit /b 1
)
set "BIN=%LYXDIR%\bin"

echo.
echo This will replace your official LyX with the patched one.
echo Install folder: %LYXDIR%
echo.

REM --- Close LyX if it is running ---
taskkill /IM LyX.exe /F >nul 2>&1
REM Give Windows a moment to release the locked files.
ping -n 3 127.0.0.1 >nul

REM --- Back up the original bin (once) ---
if not exist "%LYXDIR%\bin_original_backup" (
    echo Backing up the original bin folder to bin_original_backup ...
    xcopy "%BIN%" "%LYXDIR%\bin_original_backup\" /E /I /Q /Y >nul
) else (
    echo Backup bin_original_backup already exists - keeping it.
)

REM --- Install the patched binary ---
echo Installing patched LyX.exe ...
copy /Y "runtime\LyX2.5.1.exe" "%BIN%\LyX.exe" >nul

REM --- Install the MinGW Qt DLLs and plugins (required) ---
echo Installing MinGW Qt DLLs and plugins ...
copy /Y "runtime\*.dll" "%BIN%\" >nul
xcopy "runtime\platforms"    "%BIN%\platforms\"    /E /I /Q /Y >nul
xcopy "runtime\imageformats" "%BIN%\imageformats\" /E /I /Q /Y >nul
xcopy "runtime\iconengines"  "%BIN%\iconengines\"  /E /I /Q /Y >nul

echo.
echo Done! Your LyX is now the PATCHED one (fixes the LyXServer
echo response-loss bug). To go back, run swap_back_original.cmd.
echo.
pause
