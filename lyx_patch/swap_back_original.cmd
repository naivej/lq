@echo off
setlocal
REM ============================================================
REM  Restore your ORIGINAL official LyX (undo the patched swap)
REM  Run this from the lyx_patch folder (double-click is fine).
REM ============================================================
cd /d "%~dp0"

REM --- Where is LyX 2.5 installed? Edit this if not detected ---
set "LYXDIR="
if exist "%LOCALAPPDATA%\Programs\LyX 2.5\bin\LyX.exe" set "LYXDIR=%LOCALAPPDATA%\Programs\LyX 2.5"
if not defined LYXDIR if exist "C:\Program Files\LyX 2.5\bin\LyX.exe" set "LYXDIR=C:\Program Files\LyX 2.5"
if not defined LYXDIR if exist "C:\Program Files (x86)\LyX 2.5\bin\LyX.exe" set "LYXDIR=C:\Program Files (x86)\LyX 2.5"
if not defined LYXDIR (
    echo.
    echo LyX 2.5 was not found. Set LYXDIR at the top of this file.
    echo.
    pause
    exit /b 1
)
set "BIN=%LYXDIR%\bin"

if not exist "%LYXDIR%\bin_original_backup" (
    echo.
    echo No backup found at %LYXDIR%\bin_original_backup.
    echo Nothing to restore.
    echo.
    pause
    exit /b 1
)

echo Restoring your original LyX from bin_original_backup ...
taskkill /IM LyX.exe /F >nul 2>&1
REM Give Windows a moment to release the locked files.
ping -n 3 127.0.0.1 >nul
xcopy "%LYXDIR%\bin_original_backup" "%BIN%\" /E /I /Q /Y >nul

echo.
echo Done! Your original official LyX is restored.
echo.
pause
