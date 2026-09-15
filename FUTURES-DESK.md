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
2. **Ten charts.** `ES1!`, `NQ1!`, `YM1!` on **1D** with `pine/futures-desk-index-daily-mr.pine`;
   `ES1!`, `NQ1!`, `YM1!`, `GC1!`, `SI1!`, `HG1!` on **60** with
   `pine/futures-desk-donchian-60m-long.pine`; `ES1!` on **60** with
   `pine/futures-desk-feed-heartbeat.pine` (the feed heartbeat). Chart settings → Symbol → **Adjust
   for contract changes: ON** (the validations used back-adjusted series).
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

## Journal completeness and demo realism (E4, `src/lib/futures-desk-journal.ts`)

**The judged series WILL be `pnl_after_slip_usd`, not `pnl_usd`** (E6 wires the leaderboard and the
verdict to it; until then the scoreboard still reads `pnl_usd`). The demo fills at the touch and reports
no slippage, so every row also carries a per-market slippage model: `slip_model_pts` per side
(`SLIP_PTS_PER_SIDE` — ES 0.89 · NQ 11.74 · GC 0.50 **measured** in the edge factory; YM 4 · SI 0.01
· HG 0.0025 · RTY 0.5 **assumed** and labelled so) and `slip_model_usd` = 2 × slip × point value ×
contracts (an MNQ 1-lot round trip = $46.96). `settle` writes `pnl_after_slip_usd = pnl_usd −
slip_model_usd`; `pnl_usd` stays the demo's own number. A rolled chain is charged per leg — each leg
models its own round trip, so one roll costs four sides of slippage. Entry slip is also **measured** per trade:
`signal_price` is the alert's close, `entry_slip_pts` = fill − signal (long; sign flipped for a
short), positive = paid. TradingView's alert arrives on a delayed bar close, so a non-zero figure is
the expected cost, recorded rather than hidden.

**Every ledger row** (entry and roll leg alike) carries: `stop_points`, `atr_at_entry` (Pine v2),
`session` (ET slice at entry — overnight 18–02 · european 02–07 · premarket 07–09:30 · open 09:30–10
· morning 10–11:30 · midday 11:30–14 · power 14–15:30 · close 15:30–17 · break 17–18; a stamp, never a
gate), `grade`, `regime` / `event_mode` (null until E7 / E3 stamp them), `error_class` and the
excursion columns. **`error_class`** (mistake tracking): `partial_fill` (an entry or a roll re-open filled short — the remainder is cancelled before the row is written),
`unprotected` (no stop could be placed — the position was closed), `roll_failed` (old month closed,
new month did not open), `close_refused` (the broker refused a liquidation), `queue_expired` (a
queued alert aged out — on the SIGNAL row), `auth_backoff`, `foreign_position`. Precedence on one
row: `unprotected` overwrites anything (the position is gone); `close_refused` is written only when
the row has no class yet (`COALESCE`), so a partial fill or an unprotected close keeps its class.
`classifyError` reads the class off a stamped row, or from the text of a row written before the
column existed.

**MFE / MAE** (`mfe_pts`, `mae_pts`, `mfe_r`, `mae_r`, `bars_held`, `mfe_source`, `mfe_to`): the desk
has no price feed, so the guardian folds **delayed Yahoo 1-hour bars** (`ES=F`, `NQ=F`, `YM=F`,
`GC=F`, `SI=F`, `HG=F`) into every open row and every row closed in the last 7 days whose fold has
not yet reached its close, **once per ET day after 17:05 ET** (`futures_desk_state.excursionDayKey`,
stamped together with `guardianAt` BEFORE the fold runs). Every distinct (symbol, kind) is fetched
once, in parallel, under one 30-second deadline. `mfe_source = yahoo_1h_delayed`; a row first seen
more than 5 days old is backfilled from daily bars and stays `yahoo_1d`. `mfe_to` is the last bar
folded, so bars are never counted twice. Fail-soft: a Yahoo problem is a guardian note and the day's
`lastError`, never an exception. Roll week caveat: Yahoo's symbol is the continuous front month, so a
position still in the old month carries the calendar spread in its excursion — labelled, not corrected.

**Signals** carry `score`, `score_json` (the Pine v2 context: `atr, rsi, volRatio, dist20h, d1Up,
h4Up`), `grade` (stamped by the entry path), `session`, `regime` / `event_mode` (E7 / E3),
`checklist_json` (E5) and `error_class`.

### Pine v2 (one re-paste)

Both scripts now write six optional context fields into every message and a third action, **`watch`**:
Donchian fires it when the close is within 0.5% of the prior 100-bar high with no position on; daily
MR when RSI(14) < 33 with no position on. A watch row is logged with a **dry-run sizing card** as its
reason (`dry run: 1× MES · stop 40 pts · risk $201.70 of $250 (normal · stage A)`), never queued and
never executed, capped at **three per market per ET day** (the fourth reads `watch cap reached`), and
expired by the guardian after 24 h. A v1 message (no new fields) parses exactly as before, so the
re-paste can happen chart by chart.

**Manual re-paste (E4 and, later, E5's heartbeat chart — the only two re-paste events):**
1. On each of the 9 charts: Pine editor → replace the script body with the file from `pine/` → Save →
   the "Desk webhook secret" input keeps its value; re-check it.
2. Recreate the alert on each chart (an edited script does NOT update a live alert): delete the old
   one, add → condition = the indicator → *Any alert() function call* → webhook URL → message empty →
   expiration open-ended.
3. Verify: the next row on `/futures` → alert inbox shows a `watch` or an entry whose `score_json`
   carries `atr` (the desk page's inbox; or `SELECT score_json FROM futures_desk_signals ORDER BY id
   DESC LIMIT 1`).

## Kill switches, platform safety, feed heartbeat, pre-trade checklist (E5, `src/lib/futures-desk-safety.ts`)

Kept from before: guardian stale 20 min refuses entries, auth backoff, entry/guardian locks, the
foreign-position report, unknown-status rows, the balance-read abort. Added:

- **Three execution errors in one ET day disable the desk** (`disabledReason = "3 execution errors
  today"`, one Slack; a person re-enables from `/futures`). Counted: inbox rows that ended in `error`
  (watch rows never count) plus ledger rows classed `roll_failed` / `close_refused` / `unprotected`
  (an unprotected entry is its signal's error, counted once). Enabling records today's count as
  `state.execErrorBaseline`; the trip is `count ≥ baseline + 3`, so a re-enable is a fresh allowance
  of three, not an instant re-trip.
- **Anomalies pause ENTRIES until a person clears them** (`futures_desk_anomaly` = `{kind, detail,
  at}`; refusal `anomaly open: foreign position #123 — entries paused until cleared`). The guardian
  writes one on: a contract the desk did not open (`foreign_position`), a broker position that
  disagrees with its ledger row in qty or side (`ledger_mismatch on MESZ6: broker long 2, ledger
  long 1`), or **equity moving more than 30% between two runs with no fills** (`equity_jump`). A
  manual trade in the Tradovate app therefore pauses the desk — intended. Closes, rolls and
  re-protection are never gated. While an entry is in flight (its fill exists before its ledger row)
  the foreign/mismatch read is skipped for that run. A stop-out between two runs is settled AFTER the
  check, so it counts as no fill — at $250 of risk on $50k it cannot move equity 30%, by design.
  `/futures` shows the open anomaly (kind, detail, when) in a red panel with a **type CLEAR** control;
  the API is `POST /api/futures/desk/enable` `{ "action": "clear-anomaly", "confirm": "CLEAR" }`.
  `deskStatus()` returns `anomaly`, `feedSeenAt`, `feedStale`, and the last ten `watch` rows separately
  from the 40-row inbox.
- **Feed heartbeat.** The tenth chart, `pine/futures-desk-feed-heartbeat.pine` on **ES1! 60m**, posts
  `{"action":"heartbeat"}` every confirmed bar. The webhook (secret required, rate-limited like any
  alert) stores `futures_desk_feed_seen_at` and writes **no signal row**. `feedStale` = more than
  **180 CME-open minutes** since the last heartbeat (the 17–18 break and the weekend count for
  nothing; never seen = stale). Health carries `feedSeenAt` / `feedStale`; the guardian Slacks once
  per 6 h while stale; the brief reads NO TRADE. **Entries are NOT refused for a stale feed** — an
  alert that arrives is itself proof of the feed — it is a `checklist_json.warnings` entry. This also
  catches TradingView's alert expiry (Essential: ~2 months unless open-ended).
- **The enforced pre-trade checklist** runs after every existing refusal and right before the order,
  and is stored whole as `checklist_json` on the signal row; the **first failure is the refusal**.
  Exact strings: `account is not the demo (host must be demo.tradovateapi.com)` (asserted from the
  desk client's pinned mode, `DESK_MODE`, through the same mode→host rule `tradovate.ts` uses) ·
  `ES is not a root of index_daily_mr` · `contract month code V not in ACTIVE_MONTH_CODES for ES`
  (metals: `ACTIVE_MONTH_CODES`; index roots: the quarterlies H/M/U/Z) ·
  `MESU6 is inside its roll window (expires in 1 day)` · `micro symbol MES does not match
  MICRO_FOR_ROOT` · `qty 2 exceeds the stage A cap of 1` · `stop missing or on the wrong side of
  price` · `risk $301.70 exceeds the $250 budget` · `already holding ES` · `event calendar not
  checked in the last 20 minutes` (until E3 writes `futures_desk_event_policy` the key is missing and
  this is a **warning**; a present-but-stale key is a failure) · feed stale = warning only.

**Manual (E5):** add the tenth chart — ES1! 60m, paste `pine/futures-desk-feed-heartbeat.pine`, set
the secret input, one alert → *Any alert() function call* → the desk webhook, message empty,
open-ended. Verify: `/api/health` → `desk.feedSeenAt` moves within the hour and `feedStale` is false.

## Proof

`scripts/futures-desk-round-trip.ts` — 1× MES on the demo: OSO placed, fill confirmed, bracket stop
working, cancel, liquidate, flat, exit fill, no working orders. Run during Globex hours from the repo
with the Railway env: `PROBE_PRICE=<MES last> node --env-file=<railway kv> --import tsx scripts/futures-desk-round-trip.ts`.

## Tables and keys

`futures_desk_signals` (inbox), `futures_desk_trades` (ledger) — raw SQL, never prisma-managed; the
E4 columns are added with `ADD COLUMN IF NOT EXISTS` on first use (`ensureDeskTables`, `futures-desk-store.ts`).
`futures_desk_state` (JSON), `futures_desk_enabled`, `futures_desk_risk_pct` (Normal %),
`futures_desk_risk_pct_strong`, `futures_desk_risk_pct_aplus`, `futures_desk_sizing_basis`,
`futures_desk_stage`, `futures_desk_stage_d_armed`, `futures_desk_score_promoted`, `futures_desk_risk_state` (JSON),
`futures_desk_entry_lock`, `futures_desk_guard_lock`, `futures_desk_anomaly` (JSON; empty = clear),
`futures_desk_feed_seen_at` (ISO). Slack lane `futures_demo` (`webhook_futures_demo`).
