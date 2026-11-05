@echo off
REM Starts the Restaurant POS server. Keep this window open while the restaurant is working.
REM To stop: click in this window, press Ctrl+C, then answer Y.
cd /d "%~dp0"
title Restaurant POS server - keep this window open (Ctrl+C to stop)
call npm start
echo.
echo The POS server has stopped.
pause
