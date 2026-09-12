#!/bin/zsh
# DURABLE RUNNER for the Robinhood options desk.
#
# Robinhood has no server credentials — its only official route is an OAuth login held on
# THIS machine — so the real account snapshot collection cannot live on Vercel. This script is
# that path: a launchd job runs it each weekday after the close, it drives one Claude session
# to refresh the real account snapshot. It performs no paper simulation.
#
# Installed at: ~/Library/LaunchAgents/com.esbueno.options-desk.plist
# Log:          ~/Library/Logs/options-desk.log
#
# SAFETY. This runs unattended, so the tool allowlist below is the real guard rather than the
# skill's prose. It permits exactly the Robinhood READ tools this job needs and the snapshot
# ingest invocation — nothing else. Every Robinhood write tool is ALSO named in the
# disallow list, so an order cannot be placed even if the allowlist is later widened by
# mistake. Both lists must be edited to break that, which is the point.
set -u

# Defaults to the DEDICATED desk checkout, not the main working tree — that tree belongs to
# interactive sessions and usually carries uncommitted money-path work. OPTIONS_DESK_REPO
# overrides it for testing.
REPO="${OPTIONS_DESK_REPO:-/Users/user/trading-rh-options}"
LOG="$HOME/Library/Logs/options-desk.log"
mkdir -p "$(dirname "$LOG")"
stamp() { date -u +%Y-%m-%dT%H:%M:%SZ }

cd "$REPO" 2>/dev/null || { echo "$(stamp) [fail] repo not found at $REPO" >> "$LOG"; exit 1; }

# The Robinhood port must actually be present. Until the PR merges, this exits quietly
# rather than driving a session against code that cannot do the job.
if [ ! -f scripts/options-rh-agent.ts ]; then
  echo "$(stamp) [skip] scripts/options-rh-agent.ts missing in $REPO — Robinhood port not merged yet" >> "$LOG"
  exit 0
fi

echo "$(stamp) [start] options desk pull" >> "$LOG"

claude -p "Refresh only the real Robinhood Agentic account 685528705 snapshot. Read scripts/options-rh-agent.ts to see the ingest Payload fields, then use get_accounts, get_portfolio, get_option_positions and get_option_orders. Include complete positions and orders with pagination, setting positionsComplete and ordersComplete to true only after all pages succeed; do not turn failed reads into empty arrays. Write one snapshot payload file and call node --env-file=.env.local --import tsx scripts/options-rh-agent.ts ingest <file>. Options paper trading is retired: do not use the options-desk skill, fetch paper worklists, run scans or simulate trades. Never review, place, cancel, exercise or modify an order. If Robinhood is not authenticated, report it and stop." \
  --allowedTools \
    "Read" \
    "Write" \
    "Bash(node --env-file=.env.local --import tsx scripts/options-rh-agent.ts ingest:*)" \
    "mcp__robinhood-trading__get_accounts" \
    "mcp__robinhood-trading__get_portfolio" \
    "mcp__robinhood-trading__get_option_positions" \
    "mcp__robinhood-trading__get_option_orders" \
  --disallowedTools \
    "mcp__robinhood-trading__place_option_order" \
    "mcp__robinhood-trading__place_equity_order" \
    "mcp__robinhood-trading__place_crypto_order" \
    "mcp__robinhood-trading__cancel_option_order" \
    "mcp__robinhood-trading__cancel_equity_order" \
    "mcp__robinhood-trading__cancel_crypto_order" \
    "mcp__robinhood-trading__exercise_option" \
    "mcp__robinhood-trading__review_option_order" \
    "mcp__robinhood-trading__review_equity_order" \
    "mcp__robinhood-trading__preview_crypto_order" \
  >> "$LOG" 2>&1
rc=$?

echo "$(stamp) [done] exit=$rc" >> "$LOG"
exit $rc
