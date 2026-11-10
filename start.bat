@echo off
rem Double-click to start everything in one window (API, web, local avatar, local TTS).
rem Stop: press Ctrl+C once in that window and wait for the "stopped" message.
cd /d "%~dp0"
where node >nul 2>nul || (echo Node.js was not found. Install Node.js 22 or newer, then run this again. & pause & exit /b 1)
start "Lecture Video Studio" powershell -NoExit -NoProfile -ExecutionPolicy Bypass -Command "node scripts/dev-all.mjs"
