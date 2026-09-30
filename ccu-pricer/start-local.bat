@echo off
title Doc's Ship Shop Launcher
cd /d "%~dp0"
where node >nul 2>&1 || (
  echo Node.js is not installed. Download it from https://nodejs.org
  pause
  exit /b 1
)
node launcher.js
pause
