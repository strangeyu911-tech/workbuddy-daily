@echo off
chcp 65001 >nul
cd /d "%~dp0"
echo.
echo === WorkBuddy daily task (send cat travelling) ===
echo.
"C:\Users\23159\.workbuddy\binaries\node\versions\22.22.2-2\node.exe" "wb_auto_task.js"
echo.
echo === finished (exit code %ERRORLEVEL%) ===
pause
