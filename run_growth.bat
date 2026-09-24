@echo off
chcp 65001 >nul
cd /d "%~dp0"
setlocal

rem ---- locate node.exe (no machine-specific path hardcoded) ----
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
  pause
  exit /b 1
)

echo.
echo === WorkBuddy growth tasks (web UI, real clicks) ===
echo node : %NODE_BIN%
echo.
rem 先确保常驻 Edge 在跑，再执行任务脚本
"%NODE_BIN%" wb_start_edge.js
echo.
"%NODE_BIN%" wb_run_tasks.js %*
echo.
echo === finished (exit code %ERRORLEVEL%) ===
pause
