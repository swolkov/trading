#!/bin/zsh
# Read-only research collector. Separate from account collection and live execution.
set -eu
umask 077
REPO="${OPTIONS_DESK_REPO:-/Users/user/trading-rh-options}"
LOG="$HOME/Library/Logs/options-market.log"
cd "$REPO"
mkdir -p "$(dirname "$LOG")"
CAPTURE=$(mktemp /private/tmp/options-market.XXXXXX)
trap 'rm -f "$CAPTURE"' EXIT
claude -p 'Collect READ-ONLY options research. Never trade, review, cancel, exercise, transfer, or change settings. Get saved scans and run only Esbueno Bullish Trend, Esbueno Bearish Trend, Esbueno Volume Expansion. Get daily regular-session historical bars for SPY, QQQ, IWM, AAPL, AMD, NVDA for the last 420 days, and current equity quotes. For SPY, QQQ, IWM, AAPL, AMD, NVDA, get option chains, select the nearest standard monthly expiration 21-60 days away, and retrieve active standard 100-share call and put instruments at 3 consecutive strikes around the underlying price. Obtain real option quotes for all retrieved contract IDs. Do not invent prices, bars, Greeks or identifiers. If a result is too large the calling process reads the actual saved tool response; do not try to rewrite it. Stop after these reads; give a short completion/failure summary.' \
  --tools '' --permission-mode dontAsk --no-session-persistence --output-format stream-json --verbose \
  --allowedTools mcp__robinhood-trading__get_scans mcp__robinhood-trading__run_scan mcp__robinhood-trading__get_equity_historicals mcp__robinhood-trading__get_equity_quotes mcp__robinhood-trading__get_option_chains mcp__robinhood-trading__get_option_instruments mcp__robinhood-trading__get_option_quotes > "$CAPTURE"
node --env-file="${OPTIONS_DESK_ENV_FILE:-.env.local}" --import tsx scripts/options-research-ingest.ts "$CAPTURE" >> "$LOG" 2>&1
