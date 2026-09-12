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
# Decode actual scanner output outside the model: oversized MCP responses cannot be
# read by this deliberately restricted agent, whose local tools are all disabled.
claude -p 'Collect READ-ONLY scanner results. Get saved scans and run only Esbueno Bullish Trend, Esbueno Bearish Trend and Esbueno Volume Expansion. Request small pages if supported. Never change scans or account settings. If a result is oversized, stop trying to read its file: the calling process decodes the saved actual response. No other tools or actions.' \
  --tools '' --permission-mode dontAsk --no-session-persistence --output-format stream-json --verbose \
  --allowedTools mcp__robinhood-trading__get_scans mcp__robinhood-trading__run_scan > "$CAPTURE"
DISCOVERY_SYMBOLS=$(node --env-file="${OPTIONS_DESK_ENV_FILE:-.env.local}" --import tsx scripts/options-research-ingest.ts "$CAPTURE" --discovery-symbols)
claude -p "Collect READ-ONLY options research. Never trade, review, cancel, exercise, transfer, or change settings. Get equity quotes for SPY, QQQ, IWM, AAPL, AMD, NVDA and these actual broker scanner symbols: ${DISCOVERY_SYMBOLS:-none}. From verified quotes choose up to six additional symbols priced 10 to 100 dollars, ordered by price ascending then ticker. Exclude leveraged/inverse funds when identified in broker metadata. Research only, not recommendations. For the base six plus selected extra symbols, get daily regular-session historical bars for the last 420 days. Then get option chains, select the nearest standard monthly expiration 21-60 days away, and retrieve active standard 100-share calls and puts at five consecutive strikes around the underlying price. Get actual option quotes in batches of at most 20 IDs until EVERY retrieved contract ID has a quote response. A single batch does not complete a larger collection. Do not invent prices, bars, Greeks or identifiers. If a result is oversized, the calling process reads the saved response; do not try local tools. Stop after these reads and report missing data." \
  --tools '' --permission-mode dontAsk --no-session-persistence --output-format stream-json --verbose \
  --allowedTools mcp__robinhood-trading__get_equity_historicals mcp__robinhood-trading__get_equity_quotes mcp__robinhood-trading__get_option_chains mcp__robinhood-trading__get_option_instruments mcp__robinhood-trading__get_option_quotes >> "$CAPTURE"
node --env-file="${OPTIONS_DESK_ENV_FILE:-.env.local}" --import tsx scripts/options-research-ingest.ts "$CAPTURE" >> "$LOG" 2>&1
