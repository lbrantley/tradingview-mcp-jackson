#!/usr/bin/env bash
# Wrapper script called by launchd to deliver the scanner --review as a brief.
# Sources nvm so the correct node version is used regardless of the shell
# launchd starts in (which has no user profile loaded).
#
# Args: daily | weekly
#
# History: this used to call src/generate_brief.mjs (LLM-synthesized brief).
# 2026-07-07: user preferred the deterministic scanner --review output over
# the LLM synthesis. Now calls scripts/deliver_review.mjs which pauses the
# running scanner, runs --review, and sends a Pushover ping with the GitHub
# URL to the full review markdown.
set -euo pipefail

CADENCE="${1:-daily}"
REPO_ROOT="/Users/leebrantley/tradingview-mcp-jackson"
LOG_DIR="$REPO_ROOT/logs"
mkdir -p "$LOG_DIR"
LOG_FILE="$LOG_DIR/review_${CADENCE}_$(date +%Y-%m-%d).log"

# Load nvm and pin to the installed Node version.
export NVM_DIR="$HOME/.nvm"
if [ -s "$NVM_DIR/nvm.sh" ]; then
  # shellcheck source=/dev/null
  . "$NVM_DIR/nvm.sh"
fi

cd "$REPO_ROOT"

{
  echo "===== $(date -u '+%Y-%m-%d %H:%M:%S UTC') — review delivery: $CADENCE ====="
  node scripts/deliver_review.mjs "$CADENCE"
  echo "===== exit=$? ====="
} >> "$LOG_FILE" 2>&1
