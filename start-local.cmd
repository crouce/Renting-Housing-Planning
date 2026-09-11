@echo off
setlocal
chcp 65001 >nul
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo [通勤圈] 未检测到 Node.js。
  echo 请先安装 Node.js 22.13 或更高版本，然后重新双击此文件。
  echo https://nodejs.org/
  pause
  exit /b 1
)

node scripts\local-setup.mjs
if errorlevel 1 (
  echo.
  echo 初始化助手未能正常启动，请保留上方错误信息。
  pause
)
