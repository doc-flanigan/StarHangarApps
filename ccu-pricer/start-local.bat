@echo off
title Doc's Ship Shop - CCU Pricer

echo Starting Chrome with remote debugging...
start "" "C:\Program Files\Google\Chrome\Application\chrome.exe" ^
  --remote-debugging-port=9222 ^
  --user-data-dir="%TEMP%\chrome-ccu-pricer"

echo Pulling latest code...
git pull origin claude/ccu-pricing-agent-5AeKv

echo Installing dependencies...
call npm install

echo.
echo =========================================
echo  Open http://localhost:3000 in a browser
echo  (not the Chrome window with debug port)
echo =========================================
echo.

npm run dev
