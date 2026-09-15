# Futures Desk — Tradovate DEMO, rules on TradingView

**What it is.** The futures edge lab. TradingView evaluates each registered rule on real-time CME
data and fires an alert; the desk sizes it off a fixed **$50,000** basis on a **0.5 / 0.75 / 1% ladder**
(one micro at Stage A) and places it on the **Tradovate demo** account with the protective stop attached in the same request. Every
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
4 entries today · day down 1.5% of basis · equity 10% off its high (halts the desk; a person
re-enables). `sizeEntry` → contracts = min(floor(budget ÷ (stop points × point value + fees)), stage
cap, 20), refused below one — never stretched. Entry = `/order/placeoso` market + bracket stop, `clOrdId =
fd-<signal id>` so a timeout is recovered by lookup, never re-sent. The fill is confirmed from
`/fill/deps` before the ledger row exists.

**Guardian** (`deskGuard`, every 5 min): equity, day P&L, drawdown disable; a working stop on every
open position (re-protects if missing); the rule's time stop; **rolls** — index micros two days before
expiry, deliverable metals 20 days before first notice, into the month `deskContract` picks; settles
closes from the broker's own fills (stop → rule exit → external), books P&L with modeled fees
($0.85/side/contract); reports positions it did not open and leaves them alone; drains the queue.

**Rolls are calendar-driven.** The desk has no market data, so the volume/open-interest migration
between months is unreadable here; the rule is `rollDue` (index micros: expiry − 2 days; metals:
first notice − 20 days) plus `ACTIVE_MONTH_CODES` (`contract-months.ts`) for the liquid target month.
The guardian logs `roll plan: MESU6 #12 → MESZ6 on ~Sep 16` inside the last 5 days and sends one
Slack the day before. Each ledger row carries `contract_month` (`U6`, `Z6`) so a roll chain reads as
one trade across two months.

## Sizing ladder, stages and readiness

**Budget per trade** is a grade × the $50k basis: **Normal 0.5% = $250**, **Strong 0.75% = $375**,
**A+ 1.0% = $500** (`futures_desk_risk_pct`, `_strong`, `_aplus`; each clamped 0.25–1.0). Every alert
is graded **Normal** until `futures_desk_score_promoted` = `true` (the 0–100 score has to rank at
t ≥ 2 on this desk's own record first); then score ≥ 80 → Strong, ≥ 90 → A+. When one contract risks
more than the budget the trade is refused with the exact reason, e.g.
`one MES risks $301.70 against a $250 budget (normal · stage A) — refused, never stretched` — at
$250 most MES/MNQ daily-MR signals refuse; that is by design and the refusals are counted.

**Stages** (`futures_desk_stage`, default A): **A** one micro max · **B** two · **C** five · **D** one
MINI (`MINI_FOR_ROOT`; needs `futures_desk_stage_d_armed` = `true` as well, and is unreachable in
practice: one ES mini at a $500 budget needs a ≤ 10-pt stop). `maxContracts` 20 is the absolute
ceiling; the stage cap binds first. Every ledger row is stamped with its `stage`.

**Earning the next stage** (`stageReadiness`, on the CURRENT stage's own resolved rows, roll chains
merged): ≥ 30 resolved · net > 0 · profit factor ≥ 1.2 · max drawdown ≤ 3% of basis ($1,500). All
failing reasons are returned. Ceremony: `POST /api/futures/desk/stage` `{ confirm: "STAGE", to: "B" }`
— one step at a time, A→B or B→C only; D is never reachable from the route.

## Portfolio risk (`src/lib/futures-desk-risk.ts`)

Checked on every entry, after the container above, in this order — each with its exact reason:

- **Open-risk cap 2% of basis ($1,000)**: Σ `risk_usd` of the open ledger + the new budget must stay
  UNDER the cap → `open risk $750 + $250 would use up the 2% cap ($1,000)`. Plainly: at Stage A the
  book maxes out at **three** $250 positions; the fourth is refused.
- **Cluster cap** = the A+ budget ($500) per cluster × side; ES/NQ/YM/RTY are one `index` cluster,
  GC/SI/HG `metals`. ES $250 + NQ $250 long is allowed; a YM third is
  `index longs already risk $500 — adding $250 exceeds the $500 cluster cap`.
- **Daily loss $750 counting open risk**: remaining = $750 + (balance − day-start balance) − open
  risk; an entry needs its whole budget to fit →
  `daily loss limit reached: −$620 realized and $250 open risk against $750`. The realized term is
  `totalCashValue − dayStartBalance` (Tradovate's cash snapshot). **Verify after deploy** on the demo
  whether cash moves intraday on a close; if it only settles at end of day, switch the guardian to
  `bal.realizedPnl` (already returned by `deskBalance`) — until then the equity-based "day is down"
  pause (net liq) is the intraday backstop. `futures_desk_sizing_basis` is clamped to 1,000–50,000.
- **Drawdown tiers** from the equity high: −3% budget ×0.75 · −5% ×0.5 · −7% ×0.25 (micros only +
  investigate; one Slack a day) · −10% `equity is 10% off its high — desk halted pending review`
  (the guardian sets `disabledReason`; a person re-enables). The multiplier shrinks the budget, so
  at tier 1 ($187.50) most MES/MNQ signals refuse at Normal — by design; refusals are counted.

The guardian stamps `balance` / `dayStartBalance` on `futures_desk_state` and writes the snapshot
`futures_desk_risk_state` {dd, tier, mult, openRisk, clusterRisk by cluster × side,
dailyLossRemaining, at} for the page and `/api/health`. Until the first guardian run after deploy
has stamped the balances, entries refuse with `risk state not computed yet — waiting for the
guardian` — closes, rolls and re-protection are never gated by any of this.

**Migration note (Sep 15).** No `futures_desk_*` override keys exist in prod, so the new
`DEFAULT_LIMITS` (0.5% / $750 daily pause / 10% halt / stage A) apply on deploy. Positions opened at
the old $1,500 budget keep their stops and `risk_usd` — nothing is resized. Deploy after 4 PM ET.

## Proof

`scripts/futures-desk-round-trip.ts` — 1× MES on the demo: OSO placed, fill confirmed, bracket stop
working, cancel, liquidate, flat, exit fill, no working orders. Run during Globex hours from the repo
with the Railway env: `PROBE_PRICE=<MES last> node --env-file=<railway kv> --import tsx scripts/futures-desk-round-trip.ts`.

## Tables and keys

`futures_desk_signals` (inbox), `futures_desk_trades` (ledger) — raw SQL, never prisma-managed.
`futures_desk_state` (JSON), `futures_desk_enabled`, `futures_desk_risk_pct` (Normal %),
`futures_desk_risk_pct_strong`, `futures_desk_risk_pct_aplus`, `futures_desk_sizing_basis`,
`futures_desk_stage`, `futures_desk_stage_d_armed`, `futures_desk_score_promoted`, `futures_desk_risk_state` (JSON),
`futures_desk_entry_lock`. Slack lane `futures_demo` (`webhook_futures_demo`).
