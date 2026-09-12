# Futures Desk — Tradovate DEMO, rules on TradingView

**What it is.** The futures edge lab. TradingView evaluates each registered rule on real-time CME
data and fires an alert; the desk sizes it off a fixed **$50,000** basis at **3% a trade** and places
it on the **Tradovate demo** account with the protective stop attached in the same request. Every
rule earns the same verdict as the crypto and options books: 30 resolved · net positive after
modeled fees · t ≥ 2 · 7+ days. Nothing in this desk can reach a live account (every broker call
pins the demo, `src/lib/tradovate-desk.ts`).

**Why this shape.** The 2026 engine priced only from Databento; Databento was cancelled Aug 24 and
the engines went down Aug 31. TradingView supplies the real-time data for ~$20/mo and evaluates the
rule; the desk never needs a price feed of its own — the broker holds the stop and the guardian
settles from the broker's fills.

## Registered edges (`src/lib/futures-desk-rules.ts`)

| key | rule | markets | evidence |
|---|---|---|---|
| `index_daily_mr` | daily RSI(14) < 30 & close > SMA200×0.92 → long; exit RSI ≥ 50 / 1.5×ATR(14) stop / 30 d | ES NQ YM (1D) | 15-yr: ES PF 3.14 · NQ 2.22 · YM 1.79, both halves, every 5-yr block |
| `donchian_60m_long` | close > prior 100-bar high → long; exit close < prior 50-bar low; 4×ATR(20) stop | ES NQ YM GC SI HG (60m) | 10 mkts 2011-26: +0.101R, PF 1.17, t=2.93, 2nd half stronger; beta, not alpha |

Only registered edges trade. Adding one is a code change (registry + Pine script + PR), never an alert.

## One-time setup

1. **TradingView plan.** Essential or higher (webhook alerts need a paid plan). Add the **CME
   real-time data** add-on for non-professionals so the chart sees the prices the broker fills at.
   Alerts on Essential expire after two months unless set open-ended — the inbox on `/futures` shows
   when alerts stop arriving.
2. **Nine charts.** `ES1!`, `NQ1!`, `YM1!` on **1D** with `pine/futures-desk-index-daily-mr.pine`;
   `ES1!`, `NQ1!`, `YM1!`, `GC1!`, `SI1!`, `HG1!` on **60** with
   `pine/futures-desk-donchian-60m-long.pine`. Chart settings → Symbol → **Adjust for contract
   changes: ON** (the validations used back-adjusted series).
3. **The secret.** Paste `TRADINGVIEW_WEBHOOK_SECRET` (Vercel) into each script's "Desk webhook secret"
   input. It travels in the alert body; TradingView cannot set headers.
4. **One alert per chart.** Condition: the indicator → *Any alert() function call*. Notifications →
   Webhook URL: `https://<admin host>/api/webhook/tradingview-futures`. Leave the message empty — the
   script writes it. Expiration: open-ended.
5. **Vercel env.** `TRADOVATE_USERNAME`, `TRADOVATE_PASSWORD`, `TRADOVATE_CID`, `TRADOVATE_SEC`,
   `TRADOVATE_APP_ID`, `TRADOVATE_APP_VERSION` (copy from the Railway `futures-engine` service),
   `TRADINGVIEW_WEBHOOK_SECRET`, `CRON_SECRET`.
6. **Enable.** `/futures` → type ENABLE. Needs the broker answering and the guardian (every 5 min,
   `/api/cron/futures-desk-watch`) run in the last 15 minutes.
7. **The $50k.** Sizing is a % of a fixed basis (`futures_desk_sizing_basis`, default 50000), not of
   the demo's drifting balance. Reset the demo to $50,000 in the Tradovate app whenever the equity
   curve should match.

## What the desk does with an alert

`parseAlert` → shape, registered edge, allowed market, side, stop on the correct side of price, bar
time. Duplicate (same edge+market+action+bar) → logged, not traded. CME closed (Sat, Sun before 18:00
ET, the 17:00–18:00 ET break) → **queued**, sent by the guardian at the reopen, expired after 12 h.
`entryRefusal` → disabled · guardian stale (> 20 min) · already holding the market · 6 positions ·
4 entries today · day down 6% of basis · equity 20% off its high (disables the desk; a person
re-enables). `sizeEntry` → contracts = floor(3% × $50k ÷ (stop points × micro point value + fees)),
refused below one, capped at 20. Entry = `/order/placeoso` market + bracket stop, `clOrdId =
fd-<signal id>` so a timeout is recovered by lookup, never re-sent. The fill is confirmed from
`/fill/deps` before the ledger row exists.

**Guardian** (`deskGuard`, every 5 min): equity, day P&L, drawdown disable; a working stop on every
open position (re-protects if missing); the rule's time stop; **rolls** — index micros two days before
expiry, deliverable metals 20 days before first notice, into the month `deskContract` picks; settles
closes from the broker's own fills (stop → rule exit → external), books P&L with modeled fees
($0.85/side/contract); reports positions it did not open and leaves them alone; drains the queue.

## Proof

`scripts/futures-desk-round-trip.ts` — 1× MES on the demo: OSO placed, fill confirmed, bracket stop
working, cancel, liquidate, flat, exit fill, no working orders. Run during Globex hours from the repo
with the Railway env: `PROBE_PRICE=<MES last> node --env-file=<railway kv> --import tsx scripts/futures-desk-round-trip.ts`.

## Tables and keys

`futures_desk_signals` (inbox), `futures_desk_trades` (ledger) — raw SQL, never prisma-managed.
`futures_desk_state` (JSON), `futures_desk_enabled`, `futures_desk_risk_pct`, `futures_desk_sizing_basis`,
`futures_desk_entry_lock`. Slack lane `futures_demo` (`webhook_futures_demo`).
