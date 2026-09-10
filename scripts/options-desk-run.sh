#!/bin/zsh
# DURABLE RUNNER for the Robinhood options desk.
#
# Robinhood has no server credentials — its only official route is an OAuth login held on
# THIS machine — so the options paper book's data path cannot live on Vercel. This script is
# that path: a launchd job runs it each weekday after the close, it drives one Claude session
# through the `options-desk` skill, and that session pushes quotes into the book.
#
# Installed at: ~/Library/LaunchAgents/com.esbueno.options-desk.plist
# Log:          ~/Library/Logs/options-desk.log
#
# SAFETY. This runs unattended, so the tool allowlist below is the real guard rather than the
# skill's prose. It permits exactly the Robinhood READ tools this job needs and the two
# script invocations — nothing else. Every Robinhood write tool is ALSO named in the
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

claude -p "Run one Robinhood data pull for the options paper book using the options-desk skill. Follow it exactly. This is PAPER ONLY: never place, cancel or modify any order. If the Robinhood MCP is not authenticated, report that and stop rather than retrying." \
  --allowedTools \
    "Skill" \
    "Read" \
    "Write" \
    "Bash(node --env-file=.env.local --import tsx scripts/options-rh-agent.ts:*)" \
    "mcp__robinhood-trading__get_accounts" \
    "mcp__robinhood-trading__get_portfolio" \
    "mcp__robinhood-trading__get_option_chains" \
    "mcp__robinhood-trading__get_option_instruments" \
    "mcp__robinhood-trading__get_option_quotes" \
    "mcp__robinhood-trading__get_equity_quotes" \
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
