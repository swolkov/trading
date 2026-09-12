# Robinhood options research and execution readiness

Spencer requested scanners, news, strategy selection, contract sizing, admin visibility and live options, preserving the approved $100 maximum planned loss including fees. Options paper remains retired. No broker order was submitted.

## Delivered research

Three real saved Robinhood scanners were created and run: Esbueno Bullish Trend, Esbueno Bearish Trend and Esbueno Volume Expansion. Filters are the actual broker-supported filters, displayed in admin. Broker scans could not express every moving-average comparison requested, so the local daily-bar model separately calculates the 20-session breakout/breakdown and 50/200-day alignment. No claim that these rules have proven positive expectancy is made.

`/options` includes live readiness, risk and contract rules, strategy playbook, native scans, daily trend watch, affordable contract candidates and market news/events. Real broker data is decoded from tool-result events; assistant summaries are ignored. The separate read-only research collector fetches six symbols' daily bars and standard options for all six symbols and runs saved scans. The new launchd schedule runs weekdays at10:15,12:15,15:15,17:45 local time. It does not simulate trades, manage positions or execute orders. The account snapshot collector remains separate.

The research screen supports long calls/puts and four vertical shapes, uses executable-side bid/ask arithmetic with conservative cent rounding, one contract per leg,21–60 days to expiry, liquidity requirements and the approved dollar ceiling. Its $1 per-contract round-trip fee allowance is a screening estimate, NOT a verified broker fee reserve. Prices preserve their source timestamps, and anything older than15seconds is labelled refresh-required. The daily model allows four calendar days and waits until16:00ET even on early-close days; neither rule establishes live session completeness. Missing news/calendars are reported explicitly. The production Finnhub credential is reused; no news subscription was purchased.

Legacy options activation endpoints now refuse to claim live activation or restore paper trading. Kraken and futures execution logic is unchanged.

## Execution foundations, still inactive

The core now saves canonical order parameters and the original intent before submission, so a restart does not leave only a hash. PostgresOptionsLiveStore uses a dedicated session advisory lock and autocommitted reservations, preserving identity, order ID and fill evidence. It must use a direct or session-pooling PostgreSQL connection, NEVER a transaction-pooling endpoint. The store is implemented but not wired into a running executor and has not passed a dedicated database integration test.

The new official OAuth client uses PKCE/state, a loopback callback and private local credential files outside the repo/database. It connects to the documented Robinhood MCP endpoint. Its tool allowlist is strictly read-only. Broker order actions remain blocked. Registration succeeded; authorization requires the owner to select Allow on Robinhood's real permissions screen. That screen includes Agentic trading permissions and read access to other Robinhood accounts. The code will not use other accounts for trading.

Connection setup: `node --import tsx scripts/robinhood/connect.ts`. Inspect tool schemas after authorization with `node --import tsx scripts/robinhood/inspect.ts`. Credentials are in `~/.config/esbueno-robinhood/oauth.json`, mode0600. Never print or commit them. A crashed session's lock can be removed only by `scripts/robinhood/recover-lock.ts`, which verifies the old process is gone.

## Still required before orders

Complete owner OAuth authorization and verify native MCP sessions against actual responses. Implement and verify review/place/cancel decoders, account-wide fills and ownership reconciliation, equity exposure from assignment, partial fills, stale orders, exits, dividend and expiration handling, session calendars and operational daily loss limits. Connect and verify the actual position guardian, establish broker fee reserves inside the $100 cap, and perform broker acceptance checks during a valid market session. Do not mark options live merely because research or OAuth works. `options_live_armed` remains false.

## Validation

30 offline tests passed, including stale data, completed candles, malformed feeds, fee-inclusive rounding, OAuth state safety, read-only tool boundary, immutable durable recovery identity and existing execution/retirement cases. TypeScript, targeted lint, shell syntax, whitespace and production webpack build passed. Two independent reviewers approved this read-only release after fixes. Tests that overwrite production account snapshots were explicitly excluded.
