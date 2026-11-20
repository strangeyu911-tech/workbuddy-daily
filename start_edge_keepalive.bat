@echo off
rem One-time setup (double-click this file).
rem Starts a keep-alive Edge OUTSIDE the automation process tree, opens the login
rem page, and waits for ONE scan. After that: DO NOT close that Edge window.
rem Daily automation will reuse it via CDP 9223 and will never close it.
cd /d "%~dp0"
set "NODE_EXE=C:\Users\23159\.workbuddy\binaries\node\versions\22.22.2-6\node.exe"
if not exist "%NODE_EXE%" set "NODE_EXE=node"

echo [1/2] Starting keep-alive Edge on CDP 9223 ...
"%NODE_EXE%" wb_start_edge.js
if errorlevel 1 goto :fail

echo [2/2] Opening login page. Please scan ONCE in the Edge window.
"%NODE_EXE%" wb_login_once.js --timeout=8

echo.
echo Done. Keep that Edge window open (minimizing is fine).
echo Daily automation reuses it; no more scanning needed.
timeout /t 15 >nul
exit /b 0

:fail
echo Failed to start Edge. See the message above.
pause
exit /b 1
