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

**Signals** carry `score` and `score_json` (the desk's own 0–100 score, E7, over the Pine v2 context:
`atr, rsi, volRatio, dist20h, d1Up, h4Up`), `grade` (stamped by the entry path), `session`, `regime`
(E7) / `event_mode` (E3), `checklist_json` (E5) and `error_class`.

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
  `MESU6 expires in 1 day — inside the roll window; entry refused` (E3's `rollWindowRefusal`, the one
  string) · `micro symbol MES does not match MICRO_FOR_ROOT` · `qty 2 exceeds the stage A cap of 1` ·
  `stop missing or on the wrong side of price` · `risk $301.70 exceeds the $250 budget` · `already
  holding ES` · `event calendar not checked in the last 20 minutes` (missing, unreadable or stale —
  a failure since E3) · feed stale = warning only.

**Manual (E5):** add the tenth chart — ES1! 60m, paste `pine/futures-desk-feed-heartbeat.pine`, set
the secret input, one alert → *Any alert() function call* → the desk webhook, message empty,
open-ended. Verify: `/api/health` → `desk.feedSeenAt` moves within the hour and `feedStale` is false.

## Event calendar, no-trade windows, CME holidays, roll window (E3, `src/lib/futures-desk-calendar.ts`)

**The guardian writes `futures_desk_event_policy` every run** — `{mode, reason, until, at, source:
"static", event}` from the shared `event-calendar.ts` policy (`eventPolicyNow`) on the **static
`MACRO_EVENTS` table only**: Finnhub's economic calendar is a premium endpoint on this account, so
nothing is fetched and `source` is always `static`. A feed being down can therefore never refuse an
entry; what does refuse is the guardian not having written the row lately. Modes: **paused** — a
tier-1 print (FOMC decision, CPI, NFP) within ±30 min; **reduced** — tier 1 within −12h..+2h, or a
tier-2 print (PPI, PCE, FOMC minutes) within ±30 min; **normal** otherwise. FOMC Sep 16 2026 14:00 ET:
reduced from 02:00 ET, paused 13:30–14:30, reduced until 16:00.

**The entry path** (`contextNow` → `entryRefusal`, then the checklist) reads the row back and takes
the STRICTER of the row's mode and the policy recomputed at the entry instant (paused > reduced >
normal) — the row is the freshness proof, the live recomputation closes the gap between guardian runs
(a row written at 13:29 ET reading `reduced` cannot let a 13:33 entry through the pause):
- missing, unreadable or older than **20 minutes** → `event calendar not checked in the last 20
  minutes` (the E5 checklist item is now a **failure** for a missing key too — the warning is gone);
- paused → `event window: FOMC rate decision 14:00 ET — paused until 14:30`;
- reduced → the budget is halved **on top of** the drawdown tier (`budgetMult = tier × 0.5`; tier 2
  in a reduced window sizes at ×0.25). A stale `reduced` row does not halve anything — it refuses.
- `event_mode` is stamped on the signal row (before the verdict, so a refused row says what it met)
  and on the trade row.

**CME holidays close ENTRIES only** (`CME_HOLIDAYS_2026`: Thanksgiving Nov 26 early 13:00 ET, Nov 27
early 13:15, Dec 24 early 13:15, Dec 25 closed, Jan 1 2027 closed, MLK Jan 18 2027 early 13:00,
Presidents' Day Feb 15 2027 early 13:00 — refresh when the 2027 schedule publishes). `cmeOpenForEntry`
= `cmeOpen` and no holiday closure; refusals `CME holiday: Christmas Day — closed; entry refused` and
`CME early close 13:00 ET (Thanksgiving) — entry refused for the rest of the day` (the evening reopen
on an early-close day is holiday-thin, so it stays closed to entries through the ET day). A
**closed-all-day** holiday closes everything: the alert queue, the queue drain, time stops and rolls
use `cmeOpenForDesk` (= `cmeOpen` and not a closed day); an early-close evening stays open for exits
and rolls on the plain `cmeOpen`. A queued entry that drains onto an early-close afternoon is refused,
not placed; queued alerts keep the 12h expiry. The watch card's dry run is sized at tier × event too.

**Sessions** (`sessionOf`, E4) are a journal slice, never a gate. Health exposes `eventMode`,
`eventPolicyAt`, `eventPolicyFresh` and `cmeOpenForEntry`.

## Leaderboard, daily and weekly review, promotion gate (E6, `src/lib/futures-desk-review.ts`)

No money path. `futures-desk-metrics.ts` computes the series metrics (PF, max drawdown as % of
basis, per-trade Sharpe/Sortino, avg R, expectancy $ and R, hit rate, MFE/MAE, streaks) — it
**mirrors the shared `margin-metrics.ts` `sleeveMetrics`** that lands with the crypto PR in what it
measures, on this desk's own row shape (judged P&L, `risk_usd`, close instant, MFE/MAE in R); an
adapter onto the shared module may follow once both are on main. `journalToMetricRows` folds roll chains into one row each
(`mergeRollChains`, which moved here from the status module): the **judged P&L is
`pnl_after_slip_usd` summed across the legs** where every leg has it, else the demo's own
(`pnlSource` says which; a chain with any leg lacking the after-slip figure is judged on the demo's
`pnl_usd` for the WHOLE chain — never a mixed sum), fees and modeled slip summed, MFE/MAE the chain's maxima, the origin leg's
session / regime / side; risk = `risk_usd`. `futuresLeaderboard` = per edge, per edge × root, and
per edge by session / regime / day-of-week / direction. `profitDistribution` = best trade / day /
week / market as a share of GROSS profit.

**Promotion gate** (`futuresPromotionVerdict`, one verdict per edge, on `/futures` and
`/api/futures/desk` as `promotion`): `donchian_60m_long` ≥ 100 resolved over ≥ 56 days;
`index_daily_mr` ≥ 30 resolved over ≥ 84 days (the daily-bar exception, stated on the gate: at ~3–5
signals a year per root even 30 is unlikely inside the window, so its live case rests on backtest
concordance too); net after slip > 0; PF ≥ 1.4 (strong ≥ 1.6); max drawdown ≤ 8% of basis (strong
≤ 6%); t ≥ 2; best trade ≤ 25% and best day ≤ 30% of gross profit; ≥ 3 regime labels seen (**until
E7 stamps regimes this reads "not yet measurable" and counts as failed — no edge can read
LIVE-CANDIDATE before E7**); execution-error rate ≤ 2% (inbox `error` rows + ledger classes over
executed + errored entries); no open anomaly. Verdict: all gates pass → **LIVE-CANDIDATE** (`strong`
when PF ≥ 1.6 and DD ≤ 6%); the sample gates (resolved, span) fail → **GATHERING**; otherwise
**FAILING**, with `failedGates[]`. A verdict is a document, never a switch — a live account is a
separate typed decision.

**Daily review** — the first guardian run after 17:05 ET per ET weekday (`state.reviewDayKey`, stamped
with `guardianAt` before the work, run after the MFE/MAE fold): gross (demo), net after slip, trades,
wins/losses, win rate, avg winner/loser, PF, expectancy, largest win/loss, fees, modeled slip, max
intraday drawdown (**n/a** — the guardian keeps one equity per run, not a series), rule violations
(error classes on the day's rows and inbox), refusals by reason, best/worst setup, watch rows →
appended to `Performance/futures-desk-daily.md` (**capped at 120 entries**, the oldest rolled into
`Performance/futures-desk-daily-archive.md`) + one condensed Slack line on `futures_demo`.
**Weekly review** — the first guardian run on a Monday per ISO week (`state.weeklyReviewKey`): the
leaderboard tables by strategy / instrument / session / day / regime / direction, the profit
distribution, the promotion verdicts and stage readiness → `Performance/futures-desk-weekly.md`
(overwritten) + Slack. **No new Vercel cron**; both are fail-soft guardian notes. `/futures` shows
"Edges — promotion gate" (gate rows with ok / value / target, the edge × market leaderboard) and the
stage-readiness line; the API returns `leaderboard`, `promotion`, `stageReadiness` (`reviewError`
when the read failed).

## Regime engine and the 0–100 opportunity score (E7, `src/lib/futures-desk-score.ts`)

**Stamp and measure, not a gate.** The guardian labels every root once per ET day (its first run of
the day, `state.regimeDayKey`) from **Yahoo daily bars** (`ES=F` … `RTY=F`, 420 calendar days):
trend = close vs SMA50 vs SMA200 (`uptrend` when close > SMA50 > SMA200, `downtrend` when the
reverse, else `range`) × vol = the ATR14 percentile over the last 250 daily ATRs (`lowvol` < 1/3,
`highvol` ≥ 2/3, else `midvol`) → nine labels, `unknown` under 200 bars — never a throw. Written to
`futures_desk_regime` `{at, byRoot: {ES: {label, close, sma50, sma200, atr, atrPct, at}, …}}`; a root
whose bars failed keeps its previous entry (one bad fetch never blanks the stamp); one 30-second
deadline, fail-soft, guardian notes. Each root carries its own `at`; a label older than **2 days** (its
bars kept failing) reads **stale** — amber chip on `/futures`, `(stale — N d old)` in the brief — never
as fresh just because the snapshot's run time moved. Stamped as `regime` on every signal row at receipt and on every
trade row (null when unknown, so the promotion gate's "≥ 3 regimes seen" counts only real labels).
Two clocks (TradingView's delayed bar for the alert fields, Yahoo for the regime) — drift is stamped,
not acted on.

**The score** (`futuresOpportunityScore`, every entry and watch, refused ones included, at receipt):
structure 20 (`dist20h` proximity to the 20-bar high 10 + `d1Up`/`h4Up` 5 + 5) · trend 10 (the
regime's trend half, mirrored for a short) · volume 10 (`volRatio` 0.5× → 0, 1.5× → 10) · liquidity
10 static (ES/NQ 10 · YM/GC 8 · SI/HG/RTY 6) · catalyst 10 (event mode normal/reduced/paused →
10/5/0) · R:R 15 (**k = 2** × ATR ÷ stop distance, 0.5 → 0, 3 → 15 — the k is a stated assumption,
measured against MFE by the weekly review) · regime fit 10 and historical expectancy 15 from the
desk's own leaderboard cells (edge × regime, edge × root; avg R −0.2 → 0, +0.4 → cap; a cell under
10 resolved trades scores neutral). Missing Pine fields score their neutral part and are listed in
`missing` — never NaN; every part is capped; the total is an integer ≤ 100. Written as `score` and in
`score_json` (`{…Pine context, opportunity: {score, components, missing}}`) — the queue replay reads
back only the Pine fields. **A chart-sent `score` is never read**: `parseAlert` drops it, `recordSignal`
inserts the column NULL, and only `stampSignal` (from `scoreSignal`) writes it — so a holder of the
webhook secret cannot grade, bucket or promote its own alerts; a scoring failure leaves the alert
unscored (Normal grade).

**Promotion.** The weekly review adds **score buckets** (≥ 80 / 70–79 / < 70 by n, mean R, PF, Welch
t between the top and bottom buckets) and `scorePromotionVerdict`: green only when every bucket has
≥ 30 resolved, the ≥ 80 bucket beats the < 70 bucket by mean R, and t ≥ 2. `POST
/api/futures/desk/enable` `{ "action": "promote-score", "confirm": "PROMOTE" }` sets
`futures_desk_score_promoted` = `true` **only on a green verdict** (else 400 with the reasons); the
`/futures` "Score promotion" panel carries the typed-PROMOTE control, disabled with the reasons until
the verdict is green. Once
promoted: `gradeFor` unlocks Strong (≥ 80, 0.75%) and A+ (≥ 90, 1.0%), and
**`futures_desk_min_score`** (default 0, clamped 0–100, unreadable → 0) becomes the refusal
`score 64 is below the desk minimum 70` (a missing score refuses too: `score missing — the desk
minimum is 70`). Until promoted the key is inert and every alert is Normal — the conservative side.
Demotion = the key set to anything but `true` (a config write; only reduces risk).

## Desk brief, dashboard fields, watch alerts (E8, `src/lib/futures-desk-brief.ts`)

**Watch alerts** (Pine v2 `watch`, E4/E5): stored as status `watch` with the dry-run size card as
the reason, scored and regime-stamped like an entry, never executed and never queued, capped at three
per root per ET day (the capped rows are excluded from the brief), expired after 24 h, and never
counted as an execution error.

**The brief** (`renderFuturesBrief`, pure — the LIVE TRADE OUTPUT) has four sections in this order:
`## MARKET REGIME` (per-root label · SMA50/200 · ATR percentile, the event window/mode, the next roll
per root) · `## TOP OPPORTUNITIES` (the last 24 h of watch rows by score, top 5, with the size card)
· `## RECOMMENDED TRADE` (the open position or today's latest entry — account DEMO, symbol, month,
micro, qty, order type, stop, $ risk, R:R expected = 2×ATR ÷ stop and MFE so far, session, regime,
event mode, grade, score, stage — or the top watch, marked NOT placed) · `## ACTION` from `actionFor`:
halted (disabled, guardian halt, tier 4) / paused (event window, daily loss spent) / anomaly / feed
stale → **NO TRADE**; an open position at drawdown tier ≥ 2 → **REDUCE**; a watch live → **WAIT**;
else **NO TRADE**. Empty inputs render `—`, never throw. The ACTION is what a person reading the desk
would do — the executor keeps its own gates. Written by the guardian right after the daily review
(same day key, fail-soft) to the vault `Brain/futures-desk-brief.md` (the same DB-backed vault the
reviews use), one Slack line on `futures_demo`, and `futures_desk_brief_latest` `{at, action,
markdown}`; `GET /api/futures/brief` returns the stored one, `?live=1` renders it now from the keys
and tables (no broker call). `/futures` shows it in the "Desk brief" panel.

**Next roll per root** is calendar-derived (`nextRollByRoot`, `futures-desk-calendar.ts`): index
roots the quarterlies' third Friday 09:30 ET; metals the last business day before the contract month
(first notice); the front month is the nearest with more than `guardDays` to go (`deskContract`'s
rule) and the roll is `expiry − (guardDays − 1)` days (`rollDue`). A root the desk HOLDS shows the
held month's roll instead (`ES held Z6 rolls ~Dec 16`) — inside the guard window the calendar would
already name the next month while the guardian still rolls what is held. Labelled `source:
"calendar"` — the broker's own maturity dates decide the real roll.

**Dashboard** (`/futures` → "Desk numbers", from `deskStatus().dashboard`, no broker call beyond the
existing snapshot): equity, HWM, drawdown % and tier with the budget multiplier, daily realized
(cash − day-start cash), open P&L (netLiq − cash), week / month P&L on the judged series, positions,
open risk, daily loss remaining, trades (total, today), violations today, feed last seen, next roll
per root, stage, event mode/window, score promoted / minimum, and the regime chips. Buying power is
**not shown** — Tradovate's cash-balance snapshot does not expose it. `/command`'s futures block gains
the drawdown tier · open risk · daily loss left row, the event mode · feed row and the open anomaly
(from `/api/health`, additive).

## Proof

`scripts/futures-desk-round-trip.ts` — 1× MES on the demo: OSO placed, fill confirmed, bracket stop
working, cancel, liquidate, flat, exit fill, no working orders. Run during Globex hours from the repo
with the Railway env: `PROBE_PRICE=<MES last> node --env-file=<railway kv> --import tsx scripts/futures-desk-round-trip.ts`.

## Tables and keys

`futures_desk_signals` (inbox), `futures_desk_trades` (ledger) — raw SQL, never prisma-managed; the
E4 columns are added with `ADD COLUMN IF NOT EXISTS` on first use (`ensureDeskTables`, `futures-desk-store.ts`).
`futures_desk_state` (JSON), `futures_desk_enabled`, `futures_desk_risk_pct` (Normal %),
`futures_desk_risk_pct_strong`, `futures_desk_risk_pct_aplus`, `futures_desk_sizing_basis`,
`futures_desk_stage`, `futures_desk_stage_d_armed`, `futures_desk_score_promoted`, `futures_desk_min_score` (E7),
`futures_desk_risk_state` (JSON), `futures_desk_event_policy` (JSON), `futures_desk_regime` (JSON, E7),
`futures_desk_brief_latest` (JSON, E8), `futures_desk_entry_lock`, `futures_desk_guard_lock`,
`futures_desk_anomaly` (JSON; empty = clear), `futures_desk_feed_seen_at` (ISO). Slack lane `futures_demo`
(`webhook_futures_demo`). Vault documents: `Performance/futures-desk-daily.md` (+ `-archive`),
`Performance/futures-desk-weekly.md`, `Brain/futures-desk-brief.md`.
