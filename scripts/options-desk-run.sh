#!/bin/zsh
# Direct read-only account collection. OAuth remains on this Mac.
# This is an account snapshot job, not a position guardian or execution scheduler.
set -u
REPO="${OPTIONS_DESK_REPO:-/Users/user/trading-rh-options}"
LOG="$HOME/Library/Logs/options-desk.log"
mkdir -p "$(dirname "$LOG")"
stamp() { date -u +%Y-%m-%dT%H:%M:%SZ }
cd "$REPO" 2>/dev/null || { echo "$(stamp) [fail] checkout unavailable" >> "$LOG"; exit 1; }
echo "$(stamp) [start] direct Robinhood account snapshot" >> "$LOG"
node --env-file="${OPTIONS_DESK_ENV_FILE:-.env.local}" --import tsx scripts/robinhood/collect.ts >> "$LOG" 2>&1
rc=$?
echo "$(stamp) [done] exit=$rc" >> "$LOG"
exit $rc
