#!/usr/bin/env bash
# Wrapper script called by launchd to run the brief generator.
# Sources nvm so the correct node version is used regardless of the shell
# launchd starts in (which has no user profile loaded).
#
# Args: daily | weekly
set -euo pipefail

CADENCE="${1:-daily}"
REPO_ROOT="/Users/leebrantley/tradingview-mcp-jackson"
LOG_DIR="$REPO_ROOT/logs"
mkdir -p "$LOG_DIR"
LOG_FILE="$LOG_DIR/brief_${CADENCE}_$(date +%Y-%m-%d).log"

# Load nvm and pin to the installed Node version.
export NVM_DIR="$HOME/.nvm"
if [ -s "$NVM_DIR/nvm.sh" ]; then
  # shellcheck source=/dev/null
  . "$NVM_DIR/nvm.sh"
fi

cd "$REPO_ROOT"

{
  echo "===== $(date -u '+%Y-%m-%d %H:%M:%S UTC') — brief run: $CADENCE ====="
  node src/generate_brief.mjs "$CADENCE"
  echo "===== exit=$? ====="
} >> "$LOG_FILE" 2>&1
