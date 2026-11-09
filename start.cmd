@echo off
title ZipStream
cd /d "%~dp0backend"
if not exist node_modules (
  echo Installing backend dependencies...
  call npm install
)
echo.
echo   ZipStream is starting at  http://localhost:8787
echo   Keep this window open. Press Ctrl+C to stop.
echo.
start "" http://localhost:8787
node server.js
pause
