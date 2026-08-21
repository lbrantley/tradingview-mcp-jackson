@echo off
REM Hourly scanner for the Windows VM. Task Scheduler points at this one file,
REM so the schedule never has to change when the commands do.
REM Logs are kept per-day so a bad run can be found after the fact — the old
REM scanner had no logging on Windows and two days of failures left no trace.

cd /d "%~dp0.."
if not exist logs mkdir logs

for /f "tokens=1-3 delims=/- " %%a in ("%date%") do set TODAY=%%c-%%a-%%b

echo ===== %date% %time% ===== >> "logs\scan_%TODAY%.log"
node scripts\scan_live.mjs --notify  >> "logs\scan_%TODAY%.log" 2>&1
node scripts\track_trades.mjs        >> "logs\scan_%TODAY%.log" 2>&1
