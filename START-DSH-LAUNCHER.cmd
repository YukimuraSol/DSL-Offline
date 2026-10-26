@echo off
setlocal
cd /d "%~dp0"
set "NPM_BIN="
if exist "%ProgramFiles%\nodejs\npm.cmd" set "NPM_BIN=%ProgramFiles%\nodejs\npm.cmd"
if not defined NPM_BIN if exist "%ProgramFiles(x86)%\nodejs\npm.cmd" set "NPM_BIN=%ProgramFiles(x86)%\nodejs\npm.cmd"
if not defined NPM_BIN for /f "delims=" %%F in ('where npm.cmd 2^>nul') do if not defined NPM_BIN set "NPM_BIN=%%F"

if not defined NPM_BIN (
  echo Node.js/npm not found. Install Node.js 20 or newer, then try again.
  pause
  exit /b 1
)

if not exist "node_modules\electron\dist\electron.exe" (
  call "%NPM_BIN%" install
  if errorlevel 1 (
    echo Dependency installation failed.
    pause
    exit /b 1
  )
)

call "%NPM_BIN%" run dev
if errorlevel 1 pause
endlocal
