#!/bin/zsh
# Read-only research collector. Separate from account collection and live execution.
set -eu
umask 077
REPO="${OPTIONS_DESK_REPO:-/Users/user/trading-rh-options}"
LOG="$HOME/Library/Logs/options-market.log"
cd "$REPO"
mkdir -p "$(dirname "$LOG")"
CAPTURE=$(mktemp /private/tmp/options-market.XXXXXX)
ERR=$(mktemp /private/tmp/options-market-err.XXXXXX)
trap 'rm -f "$CAPTURE" "$ERR"' EXIT
# launchd hands this job a login shell whose PATH resolves `claude` to /usr/local/bin — a stale
# 2.1.85 the API began rejecting on Sep 14 2026 (four silent exit-1 runs). The current CLI lives in
# ~/.npm-global/bin. Prefer it, and when a session fails, say so in the log instead of dying mute.
CLAUDE_BIN="${CLAUDE_BIN:-}"
if [ -z "$CLAUDE_BIN" ]; then
  for c in "$HOME/.npm-global/bin/claude" "$HOME/.local/bin/claude" "$(command -v claude || true)"; do
    if [ -n "$c" ] && [ -x "$c" ]; then CLAUDE_BIN="$c"; break; fi
  done
fi
[ -n "$CLAUDE_BIN" ] || { echo "$(date -u +%FT%TZ) no claude CLI found — research not run" >> "$LOG"; exit 1; }
# The API's refusal arrives on stdout (stream-json), so quote the tail of both streams.
# A refused session (usage cap, auth, model) ends with a stream-json `result` line carrying is_error and the
# reason in `result`; earlier versions grepped only for API errors and logged a blank cause for two days.
why() { { cat "$ERR"; grep -o -m1 'API Error: [^"]*\|"error":{[^}]*}' "$CAPTURE"; grep -o '"is_error":true.*"result":"[^"]*"' "$CAPTURE" | tail -1 | grep -o '"result":"[^"]*"'; } 2>/dev/null | tr '\n' ' ' | head -c 400; }
fail() { echo "$(date -u +%FT%TZ) $1 failed ($CLAUDE_BIN $("$CLAUDE_BIN" --version 2>/dev/null | head -1)): $(why)" >> "$LOG"; exit 1; }
# CONTEXT DIET (Sep 19 2026). A headless session in this repo used to inherit every MCP server on the Mac
# (the Vercel plugin's ~250 tools, Slack, Drive, Railway…) — 313k tokens of schemas before the first quote,
# ~$6 a run on the global default model (Fable). The collector only needs the Robinhood server, and it is a
# mechanical read, so it is pinned to sonnet: same data, ~$0.30 a run, and far less usage-cap pressure.
SESSION_FLAGS=(--model sonnet --strict-mcp-config --mcp-config "$REPO/scripts/robinhood/mcp-research.json")
# RESEARCH SLICES (Sep 15 2026). One run cannot read the whole universe — 28 base + ≤6 discovery names
# × 2 expiries × 10 contracts = 680, and instrument reads flaked past ~100 — so each run reads ≤360:
#   A = index/mega + affordable core (18 names)      → the 10:15 and 17:45 ET runs (the core gets the post-close refresh)
#   B = the ten large caps + scanner discovery (≤16) → the 12:15 and 15:15 ET runs
# launchd cannot vary the environment per StartCalendarInterval, so the slice is chosen here by ET hour
# unless RESEARCH_SLICE=A|B is set (a hand run). The merge keeps the other slice's data per symbol.
ET_HOUR=$(TZ=America/New_York date +%H)
case "${RESEARCH_SLICE:-}" in
  A|B) SLICE="$RESEARCH_SLICE" ;;
  "") case "$ET_HOUR" in 12|15) SLICE=B ;; *) SLICE=A ;; esac ;;
  *) echo "$(date -u +%FT%TZ) RESEARCH_SLICE must be A or B (got '$RESEARCH_SLICE') — research not run" >> "$LOG"; exit 1 ;;
esac
export RESEARCH_SLICE="$SLICE"
echo "$(date -u +%FT%TZ) research slice $SLICE (ET hour $ET_HOUR)" >> "$LOG"
# The base list lives in code (OPTIONS_WATCHLIST_SLICES) so the prompt, the admin page and the screen agree.
BASE_SYMBOLS=$(node --import tsx -e 'import("./src/lib/options-desk-model.ts").then(m => console.log(((m.OPTIONS_WATCHLIST_SLICES ?? m.default.OPTIONS_WATCHLIST_SLICES)[process.env.RESEARCH_SLICE] ?? []).join(", ")))' || true)
[ -n "$BASE_SYMBOLS" ] || { echo "$(date -u +%FT%TZ) base symbol list for slice $SLICE unavailable — research not run" >> "$LOG"; exit 1; }
# Scanner discovery rides in slice B only. Decode actual scanner output outside the model: oversized MCP
# responses cannot be read by this deliberately restricted agent, whose local tools are all disabled.
# A failed scanner session is logged and the run continues without discovery — the ten large caps still get read.
DISCOVERY_SYMBOLS=""
DISCOVERY_CLAUSE="Do not add any symbols beyond the base list."
: > "$CAPTURE"
if [ "$SLICE" = B ]; then
  if "$CLAUDE_BIN" -p 'Collect READ-ONLY scanner results. Get saved scans and run only Esbueno Bullish Trend, Esbueno Bearish Trend and Esbueno Volume Expansion. Request small pages if supported. Never change scans or account settings. If a result is oversized, stop trying to read its file: the calling process decodes the saved actual response. No other tools or actions.' \
    "${SESSION_FLAGS[@]}" --tools '' --permission-mode dontAsk --no-session-persistence --output-format stream-json --verbose \
    --allowedTools mcp__robinhood-trading__get_scans mcp__robinhood-trading__run_scan < /dev/null > "$CAPTURE" 2> "$ERR"; then
    DISCOVERY_SYMBOLS=$(node --env-file="${OPTIONS_DESK_ENV_FILE:-.env.local}" --import tsx scripts/options-research-ingest.ts "$CAPTURE" --discovery-symbols || true)
    DISCOVERY_CLAUSE="Also get equity quotes for these actual broker scanner symbols: ${DISCOVERY_SYMBOLS:-none}. From verified quotes choose up to six additional symbols priced 10 to 100 dollars, ordered by price ascending then ticker. Exclude leveraged/inverse funds when identified in broker metadata."
  else
    echo "$(date -u +%FT%TZ) scanner session failed ($CLAUDE_BIN $("$CLAUDE_BIN" --version 2>/dev/null | head -1)): $(why) — continuing slice B without discovery" >> "$LOG"
    : > "$CAPTURE"
  fi
fi
"$CLAUDE_BIN" -p "Collect READ-ONLY options research. Never trade, review, cancel, exercise, transfer, or change settings. Get equity quotes for ${BASE_SYMBOLS}. ${DISCOVERY_CLAUSE} Research only, not recommendations. For the base list plus selected extra symbols, get daily regular-session historical bars for the last 420 days. Then get option chains and select TWO standard 100-share expirations (weekly or monthly) per symbol: the nearest at least 21 days out and the nearest at least 35 days out, both at most 60 days out (if they coincide, take the next standard expiration at most 60 days out as the second). For each selected expiration retrieve active standard 100-share calls and puts at five consecutive strikes around the underlying price. Get actual option quotes in batches of at most 20 IDs until EVERY retrieved contract ID has a quote response. A single batch does not complete a larger collection. Then get the market earnings calendar twice, without any market-cap filter: once with days=31 starting today, and once with start_date set to today plus 31 days and days=31. Then for every base and selected symbol get equity fundamentals in batches of at most 10 symbols until every symbol has a response. Do not invent prices, bars, Greeks, dates or identifiers. If a result is oversized, the calling process reads the saved response; do not try local tools. Stop after these reads and report missing data." \
  "${SESSION_FLAGS[@]}" --tools '' --permission-mode dontAsk --no-session-persistence --output-format stream-json --verbose \
  --allowedTools mcp__robinhood-trading__get_equity_historicals mcp__robinhood-trading__get_equity_quotes mcp__robinhood-trading__get_option_chains mcp__robinhood-trading__get_option_instruments mcp__robinhood-trading__get_option_quotes mcp__robinhood-trading__get_earnings_calendar mcp__robinhood-trading__get_equity_fundamentals < /dev/null >> "$CAPTURE" 2> "$ERR" || fail "research session"
node --env-file="${OPTIONS_DESK_ENV_FILE:-.env.local}" --import tsx scripts/options-research-ingest.ts "$CAPTURE" >> "$LOG" 2>&1
