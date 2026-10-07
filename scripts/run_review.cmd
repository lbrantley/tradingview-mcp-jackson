@echo off
REM Review runner for the Windows VM. Task Scheduler points at this one file and
REM passes the cadence, so the schedule never changes when the commands do.
REM
REM   run_review.cmd morning    06:00 CST — the adjustment pass
REM   run_review.cmd evening    18:00 CST — the primary pass
REM   run_review.cmd weekly     Sunday
REM
REM WHY TWO DAILY PASSES. Measured 2026-10-06 over ~2 years of H1 bars: the
REM 07:00-10:00 Chicago window carries 1.39-1.58x an average hour and
REM 14:00-18:00 carries 0.65-0.91x. Session preference persists at 0.91-0.96
REM across a split of the history, the most stable signal in this system,
REM because London and New York do not move.
REM
REM The EVENING pass is the more powerful of the two, which is the opposite of
REM how it looks: an order placed at 6pm rests through Tokyo, London AND the
REM next morning's NY overlap, about sixteen hours covering the best window of
REM the following day. The 6am pass only has the NY overlap before the
REM afternoon goes dead, so it is the adjustment pass -- the morning-skewed
REM pairs (USDCAD 1.67x AM against 0.81x PM) and whatever filled overnight.

cd /d "%~dp0.."
if not exist logs mkdir logs

set KIND=%1
if "%KIND%"=="" set KIND=morning

for /f "tokens=1-3 delims=/- " %%a in ("%date%") do set TODAY=%%c-%%a-%%b

echo ===== %date% %time% ===== %KIND% >> "logs\review_%KIND%_%TODAY%.log"

REM PULL FIRST, same reason as run_scan.cmd: this machine once ran whatever code
REM was last copied here by hand, and two features reached the repo but never
REM the phone. Shipping is not deploying. A failed pull is logged and the review
REM still runs on the old code, because a stale review beats no review.
git pull --rebase --autostash >> "logs\review_%KIND%_%TODAY%.log" 2>&1
if errorlevel 1 (
  echo !! GIT PULL FAILED - reviewing on possibly stale code >> "logs\review_%KIND%_%TODAY%.log"
) else (
  for /f %%h in ('git rev-parse --short HEAD') do echo running @ %%h >> "logs\review_%KIND%_%TODAY%.log"
)

node scripts\deliver_review.mjs %KIND% >> "logs\review_%KIND%_%TODAY%.log" 2>&1
