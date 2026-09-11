@echo off
setlocal
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 goto missing_node

node scripts\local-setup.mjs
if errorlevel 1 goto setup_failed
exit /b 0

:missing_node
echo [Commute Radius] Node.js was not found.
echo Install Node.js 22.13 or newer, then double-click this file again.
echo https://nodejs.org/
pause
exit /b 1

:setup_failed
echo.
echo [Commute Radius] Local setup could not start.
echo Keep this window open and share the error shown above.
pause
exit /b 1
