#!/bin/zsh
# THE OPTIONS LIVE DESK on this Mac — real money, one contract, inside the $100 cap.
#   options-live-run.sh guard   every 5 min (launchd StartInterval); exits at once outside the regular session
#   options-live-run.sh entry   :05 and :35 during the session — guard, then at most one entry attempt
# OAuth stays in ~/.config/esbueno-robinhood; nothing here prints it. Separate from the read-only
# collector (options-desk-run.sh) and the research sessions (options-market-run.sh).
set -u
MODE="${1:-guard}"
REPO="${OPTIONS_DESK_REPO:-/Users/user/trading-rh-options}"
LOG="$HOME/Library/Logs/options-live.log"
mkdir -p "$(dirname "$LOG")"
stamp() { date -u +%Y-%m-%dT%H:%M:%SZ }
cd "$REPO" 2>/dev/null || { echo "$(stamp) [fail] checkout unavailable" >> "$LOG"; exit 1; }
node --env-file="${OPTIONS_DESK_ENV_FILE:-.env.local}" --import tsx scripts/robinhood/live-desk.ts "$MODE" >> "$LOG" 2>&1
rc=$?
[ $rc -ne 0 ] && echo "$(stamp) [done] $MODE exit=$rc" >> "$LOG"
exit $rc
