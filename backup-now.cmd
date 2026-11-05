@echo off
REM Makes a checked backup of the POS database right now (safe while the server is running).
cd /d "%~dp0"
call npm run db:backup
pause
