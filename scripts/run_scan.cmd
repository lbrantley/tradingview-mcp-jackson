@echo off
REM Hourly scanner for the Windows VM. Task Scheduler points at this one file,
REM so the schedule never has to change when the commands do.
REM Logs are kept per-day so a bad run can be found after the fact — the old
REM scanner had no logging on Windows and two days of failures left no trace.

REM 2026-08-30: switched from scan_live.mjs to scan_v2.mjs. The old scanner ran
REM the level-rejection setup, which was measured to have NO edge once two
REM lookaheads were removed — see project-level-rejection-is-dead. scan_v2 runs
REM the room framework: one level engine, three branches decided by how much
REM clear space sits ahead of the level. track_trades.mjs is dropped for now
REM because it reads the old alert format.

cd /d "%~dp0.."
if not exist logs mkdir logs

for /f "tokens=1-3 delims=/- " %%a in ("%date%") do set TODAY=%%c-%%a-%%b

echo ===== %date% %time% ===== >> "logs\scan_%TODAY%.log"
node scripts\scan_v2.mjs --notify >> "logs\scan_%TODAY%.log" 2>&1
