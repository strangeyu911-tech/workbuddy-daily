@echo off
chcp 65001 >nul
cd /d "%~dp0"
setlocal

rem ---- locate node.exe (no machine-specific path hardcoded) ----
rem priority: WB_NODE env  >  PATH  >  WorkBuddy managed node  >  Program Files
set "NODE_BIN="

if defined WB_NODE (
  if exist "%WB_NODE%" set "NODE_BIN=%WB_NODE%"
)

if not defined NODE_BIN (
  for /f "delims=" %%i in ('where node 2^>nul') do (
    if not defined NODE_BIN set "NODE_BIN=%%i"
  )
)

if not defined NODE_BIN (
  for /f "delims=" %%i in ('dir /b /o-n "%USERPROFILE%\.workbuddy\binaries\node\versions" 2^>nul') do (
    if not defined NODE_BIN (
      if exist "%USERPROFILE%\.workbuddy\binaries\node\versions\%%i\node.exe" (
        set "NODE_BIN=%USERPROFILE%\.workbuddy\binaries\node\versions\%%i\node.exe"
      )
    )
  )
)

if not defined NODE_BIN (
  if exist "%ProgramFiles%\nodejs\node.exe" set "NODE_BIN=%ProgramFiles%\nodejs\node.exe"
)

if not defined NODE_BIN (
  echo [x] node.exe not found.
  echo     Install Node 22+ ^(https://nodejs.org^), or set WB_NODE=C:\path\to\node.exe
  echo     Or copy local.config.example.js to local.config.js and fill in "node".
  pause
  exit /b 1
)

echo.
echo === WorkBuddy daily task (send cat travelling) ===
echo node : %NODE_BIN%
echo.
"%NODE_BIN%" "wb_auto_task.js" %*
echo.
echo === finished (exit code %ERRORLEVEL%) ===
pause
