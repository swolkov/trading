# Options live desk — Robinhood, real money, one contract (Sep 13 2026)

Spencer: "go live Monday and keep learning… you do it all, that's why it's agentic." This is that desk.
It places real options orders on the Robinhood account, one contract at a time, inside the approved
**$100 maximum loss per trade including fees**, debit structures only. It runs on the Mac (the OAuth
credential lives there; Vercel never holds it) and reports to the admin like the other two desks.

## The pieces

| Piece | File | Job |
|---|---|---|
| Trade client | `scripts/robinhood/client.ts` → `RobinhoodTradeClient` | The ONE connection that may call `review_option_order`, `place_option_order`, `cancel_option_order`. The collector and research sessions keep the read-only class. Account pinned. |
| Broker adapter | `src/lib/options-live-broker.ts` | Snapshot (account, positions, orders, fresh quotes), review/placement decoders, ref_id binding, lost-response recovery (see below). |
| Core | `src/lib/options-live-executor.ts` + `options-live-policy.ts` (Codex, Sep 12) | review → durable reservation → place → reconcile, under the account lock; every limit enforced before any call. Unchanged except a `createdAtMs` stamp on intents. |
| Store | `src/lib/options-live-store.ts` on `DATABASE_URL_UNPOOLED` | Intents + owned positions, session advisory lock, autocommitted. |
| Guardian rules | `src/lib/options-live-guardian.ts` | Pure: exit rules, drawdown halt, executable prices. |
| Runner | `scripts/robinhood/live-desk.ts` `guard | entry | probe` | Every 5 min in the session: reconcile intents, ingest fills into ownership, manage exits, cancel stale entries, drawdown halt, stamp `options_live_guardian_ok_at`. On `entry` ticks (:05/:35): at most one entry a day from the research screen, re-priced on quotes fetched that second. |
| Schedulers | `scripts/com.esbueno.options-live-guard.plist` (StartInterval 300), `scripts/com.esbueno.options-live-entry.plist` (:05/:35, 09–15 h weekdays), `scripts/options-live-run.sh` | Install once: copy both plists to `~/Library/LaunchAgents/` and `launchctl bootstrap gui/$UID <plist>`. They fast-forward `/Users/user/trading-rh-options` from `main` before each run. |
| Admin | `/options` → Live desk panel (typed **ARM** / Disarm, state, probe, intents, log); `/api/options/live-desk`; System Health rows; Orders → Robinhood segment | The switch the runner reads on every tick. |

## Rules in force (`OPTIONS_LIVE_RULES`)

Debit structures only (long call, long put, call/put debit spread) so max loss = premium paid + fees ·
one contract · one open position · one entry per day · no entries in the last 30 minutes · premium
stop at 50% of entry · no fixed target: once worth 1.5× entry a trail keeps half the best gain (a spread at full width exits) · out 7 days before expiry · unfilled entry cancelled after
15 min · account value $300 under its high-water mark → desk disarms itself (positions stay managed).
Entry signal = the research screen's 20-session breakout/breakdown with 50/200-day alignment, on the
day's broker bars; the structure is chosen by the screen and re-priced on live quotes.

## How the first live order happens (Monday Sep 14)

1. Spencer types **ARM** on the Live Account page (sets `options_live_armed=true`, fee reserve $2 if unset).
2. 09:35 ET entry tick: adapter unverified → the desk runs a **review only** on the top candidate (or,
   with no signal, on the cheapest quality-passing debit spread). It must decode fees and buying
   power from the real response. Success sets `options_live_integration_verified=true` and pages Slack.
3. 10:05 ET tick onward: if a candidate fits the cap on live quotes, the core reviews and places
   **one contract**. Fills page Slack; the guardian takes over.
4. If nothing fits, nothing trades. That is the rule working, not the desk broken.

## The lost-response problem, solved the broker's way

Robinhood accepts `ref_id` on placement but never returns it. The adapter binds our ref_id to the
broker order: on the placement response (same call), then by the saved broker order id. Only for a
LOST placement response does it match an order Robinhood labels `placed_agent="agentic"`, created
inside the intent's window, with exactly our legs/quantity/price. Nothing else on the account places
agentic orders and the store allows one unsettled intent at a time, so one such order is ours; two
are ambiguous and the intent stays `unknown` — the desk refuses new entries until a human resolves it.

## Operating

- Log: `~/Library/Logs/options-live.log`; the admin shows the last 40 lines and every intent.
- Disarm: the button, or `options_live_armed=false`. Takes effect within 5 minutes; never touches an open position.
- An `unknown` intent: check the Robinhood app for the order, then either mark the intent settled (no order) or set its `order.id` (order exists) in `options_live_intents`. The desk will not trade past it by itself — by design.

## Railway worker (Sep 14 2026) — the desk leaves the laptop

Service **options-desk** in Railway project `futures-engine` (service id 866dd190-3f2f-437b-abf1-daf99ef58d41),
built from `Dockerfile.options-desk`, running `scripts/robinhood/desk-worker.ts`: every minute it asks
`src/lib/options-desk-schedule.ts` what is due (guard every 5 min 09:30–16:05 ET, entry :05/:35
09:35–15:35, account snapshot 17:32) and runs it in-process. Variables: `OPTIONS_DESK_WORKER`
(`on`/`off`), `ROBINHOOD_AUTH_DIR=/data/robinhood` (volume `options-desk-credential` at `/data`),
`DATABASE_URL`, `DATABASE_URL_UNPOOLED` (the account lock needs a direct connection),
`RAILWAY_DOCKERFILE_PATH=Dockerfile.options-desk`. Deploy with `railway up --service options-desk`
from a checkout of main (the `railway volume` CLI subcommand panics; use the Railway MCP/dashboard).

**Cutover from the Mac — do it OUTSIDE the session, in this order, once.** Robinhood rotates the
refresh token on every use, so exactly one consumer may hold the credential.
1. Unload the Mac jobs: `for l in options-live-guard options-live-entry options-desk; do launchctl bootout gui/$(id -u)/com.esbueno.$l; done`.
2. Copy `~/.config/esbueno-robinhood/oauth.json` to the volume as `/data/robinhood/oauth.json` (Railway dashboard → service → volume → files, or a one-off `railway ssh`). Mode 0600. Delete any stale `session.lock` there.
3. `railway variables --service options-desk --set OPTIONS_DESK_WORKER=on` (the worker reads it per tick after a redeploy; redeploy to be safe).
4. Watch the deploy logs: the next scheduled tick should log `guard tick … ET` and the admin's Live desk panel should show the guardian reporting. If a tick logs "Robinhood direct connection is not authorized", the credential copy failed — stop the worker and re-copy before re-enabling the Mac jobs.
The research sessions (`options-market-run.sh`, `claude -p`) stay on the Mac: they use Claude's own Robinhood login.

## Why the desk sat out a day (Sep 14 2026)

The desk already buys single long calls, long puts (on breakdowns) and debit verticals — never
credit spreads. What it lacked was names it could afford: at a $100 max loss, nothing on a $300+
stock fits, and the six-name base list was all index ETFs and mega-caps. The research base now
carries an **affordable core** (`OPTIONS_WATCHLIST` in `src/lib/options-desk-model.ts`): $11–$30
names with deep option markets, where an at-the-money contract 21–60 days out costs $50–$100.
The 20-session breakout rule and every quality gate are unchanged; the research prompt reads the
list from code so the prompt, the admin page and the screen cannot drift apart. The entry log now
says which gate blocked: no breakout among the researched names, or a breakout nothing could
afford.

## When the desk does what (Sep 14 2026)

**Expiry.** Research pulls two standard expirations per name — the nearest at least 21 days out and
the nearest at least 35, both at most 60 (the DTE engine below); the desk is out 7 days before expiry.
A breakout takes days to weeks to pay. At-the-money decay per day as a share of premium: ~1.1% at
45 days, ~1.4% at 35, ~1.8% at 28, ~2.4% at 21, ~3.5% at 14, ~7% at 7, 36% or worse at 1. Seven-day
and one-day options are not a setting this desk offers: at $100 a contract on a cheap name is
$0.10–$0.30 wide on a nickel spread, so friction alone is 15–30% a side, and the decay means a flat
week is the stop.

**Single leg or spread.** Decided by the market, not by mood: ATM implied vol ÷ 20-day realized vol.
At or under 1.15× the option is fairly priced against how the stock actually moves → a long call (or
long put on a breakdown) with its upside uncapped. Above that the option is rich → a debit vertical,
which sells the richness back. Sep 14 examples: SOFI 0.90× and AAPL 1.10× → single; SPY 1.44× → spread.

**Which contract.** Within the preferred family, the most P&L per dollar at risk if the stock moves
exactly the move the options market is pricing (ATM straddle ÷ spot), in the signal's direction,
**after the theta the expected hold costs** (DTE engine below). A structure worth nothing at that
move is rejected outright — that is a lottery ticket.

**Exit.** Stop at half the premium. No fixed target: once a position has been worth 1.5× entry, a
trail keeps half of the best gain seen. A spread worth its full width exits. Out 7 days before expiry.

## Earnings and ex-dividend (Sep 15 2026)

A 21–60 day single-name contract very often spans an earnings date, and the breakout rule says
nothing about earnings — that is an **EARNINGS TRADE** the desk never asked for. So the research
session now also reads the broker's earnings calendar (next 31 days, then the 29 after) and each
name's fundamentals (dividend schedule, batches of 10); the ingest turns them into
`events[symbol] = {earningsAt, earningsTiming, exDivAt, dividendAmount, at}` on the research
snapshot (`src/lib/options-research-ingest.ts`), carried forward by the merge with its original
clock. The rules live in `src/lib/options-events.ts` and are pure:

- **`spansEarnings`** — refused when earnings fall on or before expiry; refused as **unknown** when
  there is no row, the row is older than 36 hours, or the expiry lies past `calendarThrough` — the
  last day the calendar was **proven** to cover (a page counts only when it is non-empty, not
  paginated, and its `start_date`/`days` are known; pages are unioned contiguously from the capture
  day). SPY/QQQ/IWM have no earnings and are exempt.
  The screen drops refused structures and the empty-tick note names the date
  (`signal on SOFI bullish but earnings 2026-10-28 falls before expiry 2026-11-20 (1 refused by the earnings rule)`).
- **`exDivRisk`** — a call debit spread whose short call the market's expected move can put in the
  money before an ex-dividend date inside the hold is refused (early assignment). Fundamentals never
  read → every spread is refused (index ETFs included); single legs are unaffected.
- **Live re-check** — `pickCandidate` re-runs `spansEarnings` on the desk's own clock and, for the
  chosen name only, asks the broker once: `get_earnings_results {symbol}`, decoded by named fields.
  **Any failure refuses — fail closed by design** (empty results, `not_found`, no upcoming
  `report.date`, a foreign row, an unrecognized shape) and the entry log says why:
  `refused: SOFI long_call: live earnings check failed — … (refused, fail closed)`. A decode
  failure also logs the response's key shape.
- **Guardian** — the owned record now carries `exDivAt` and `shortStrike` (stamped at fill);
  `guardianExDivExit` closes a call debit spread whose short call is in the money with the ex-date
  two days out or less, priced at the executable mark (no bid → `ex-dividend exit wanted but no bid —
  will retry next tick`). The underlying quote (`broker.underlyingQuote`, `get_equity_quotes`) is
  fail-soft: no quote, or one older than 15 minutes → rule skipped and logged.

**The broker's shapes (captured live Sep 15 2026), which the ingest and the adapter are pinned to:**

- `get_earnings_results {symbol}` and `get_earnings_calendar {days: 1..31, start_date?, filter?}` both
  return `data.results[]` of `{symbol, year, quarter, eps: {estimate, actual}, report: {date: "YYYY-MM-DD",
  timing: "am"|"pm"|null, verified}}`, ascending. Upcoming = `eps.actual === null`; `verified: false` is
  tentative and still counts for the veto. Results for an unresolvable symbol come back empty with the
  symbol in `not_found` → **unknown, refused** — never "none"; a past-dated row with `eps.actual` still
  null is an **overdue** quarter and also refuses. The calendar has no end date: the research session
  calls it with `days=31` from today and again with `start_date = today+31, days=31` (61 days ≥ the
  60-day max DTE), without the `high_market_cap` filter (the affordable core is small caps). A
  researched name absent from both pages = `earningsAt: null` through `calendarThrough`.
- `get_equity_fundamentals {symbols: [≤10]}` → `data.results[]` of `{symbol, …, dividend_yield,
  dividend_per_share, distribution_frequency, payable_date, ex_dividend_date, record_date}`; a
  non-payer has every dividend field null. `ex_dividend_date` is the MOST RECENT scheduled ex-date —
  past (F: 2026-08-11) or upcoming (SPY: 2026-09-18). `nextExDiv` (pure): all null → no dividend;
  upcoming → `exDivAt` **scheduled**; past + Quarterly/Monthly/Semi-Annual/Annual → last + 91/30/182/365
  days rolled forward past today, **projected**, which the spread rule and the guardian read as a
  **±7-day window**; past + any other frequency, or a date too stale to roll forward past today →
  key absent (unknown → spreads refused).

Until the first research run after this ships stores `events`, every single-name candidate reads
as unknown and is refused; index ETFs still trade. That is the rule working, not the desk broken.

## Broad market first: alignment stamp and one pre-registered veto (Sep 15 2026)

`src/lib/options-market-state.ts` (pure) reads SPY and QQQ from the research bars — close vs the
20- and 50-day averages, the signal day's move, `above`/`below`/`unknown` — and VIX from Yahoo
(`vixLevel`, **null on failure; never `cross-asset.ts`, which fabricates 20**). The screen stamps
`market` on every candidate with `aligned` for its direction; the desk writes the same view into
`options_live_state.market` on every entry tick (shown on the Live desk panel).

Exactly one rule vetoes, registered before any trade was measured against it: a **bullish
single-name** entry is refused when SPY closed **below its 20-day average AND −1.5% or worse** on
the signal day (mirror for bearish: above and +1.5% or better). At the moment of entry a live SPY
quote (`broker.underlyingQuote`) adds an **intraday shock** check: ≥1.5% against the trade refuses.
Index ETFs are exempt from the day rule (an ETF breakout is the market). Missing or stale bars and
a failed quote stamp `unknown` (a quote older than 15 minutes stamps `stale`) and never veto — this
layer is fail-soft; the earnings rule is the fail-closed one. The VIX read is raced against an
8-second timeout so the guard loop can never stall on Yahoo. Off switch: `options_live_market_veto="false"` (default on). Entry log lines:
`refused: SOFI long_call: market veto — SPY below its 20-day (651.2 vs 660.4) and -2.1% on 2026-09-14 — bullish single-name entries refused`
and `… market shock veto — SPY -1.7% intraday against a bullish entry`.

## Do not chase, the DTE engine and the strike-window slice (Sep 15 2026)

**Do not chase.** `chaseRatio(todayMovePct, atmIv)` (`options-market-state.ts`, pure) = |today's
move| ÷ the implied daily move (ATM IV ÷ √252). The screen stamps `chase` on every candidate from
the signal day's close-to-close move and that expiry's ATM IV. At the moment of entry `pickCandidate`
recomputes it from a live quote of the name itself (`broker.underlyingQuote`, last vs prior close,
fresh ≤15 minutes) and **refuses at 2× or more**:
`refused: SOFI long_call: WAIT FOR TRIGGER: SOFI moved +6.1% today = 2.4× its implied daily move — not chasing`.
Direction-blind (a put on a −6% day is chasing too). No quote, a stale one, or no ATM IV → ratio
null, no veto, logged as skipped — fail-soft like the market layer. Constant: `OPTIONS_MARKET_RULES.chaseMaxRatio = 2`.

**DTE engine.** The research prompt asks for **two** standard expirations per name — the nearest
≥21 days out and the nearest ≥35, both ≤60. `OPTIONS_DESK_RULES.minDte` is **21** (was 28);
`exitBeforeDte` stays 7. The theta table the floor is set against (ATM decay per day as a share of
premium): 45 DTE ≈1.1% · 35 ≈1.4% · 28 ≈1.8% · 21 ≈2.4% · 14 ≈3.5% · 7 ≈7% · 0–1 DTE ≥36%. 7–14
DTE and 0–1 DTE are deliberately not offered. Ranking inside the preferred family is now
`(payoffAtMoveUsd − thetaDragUsd) / plannedLoss` with `thetaDragUsd = −netTheta × 100 ×
expectedHoldDays`, net theta = long − short from the broker greeks, `expectedHoldDays = min(10,
dte − 7)` (always 10 inside the window). A leg without a broker theta charges nothing and stamps
`thetaDragUsd: null` — no invented number. A structure whose theta-adjusted payoff is ≤ 0 is
rejected like the lottery ticket it is. This is a **heuristic**, not a pricing model: at-expiry
payoff at the expected move minus a flat 10-day theta charge (theta is not constant over the hold
and the position is rarely held to expiry) — good enough to order two expiries of the same idea,
not a forecast. DTE follows the guardian's one convention (`dteOf`: expiry at the 20:00Z close), so
an expiry 21 calendar days out reads 21.x during the day. So of two expiries the longer wins
whenever the decay it saves outweighs its extra premium (the test pins a 26-DTE call at −$0.08/day
losing to a 55-DTE one at −$0.01/day). Stamps: `dteBucket` (`21-30` | `30-45` | `45-60`), `expectedHoldDays`,
`thetaDragUsd`, `atmIv`; the entry note carries them (`[dte 45-60 · hold 10d · theta $10 · delta prompt · chase 0.4]`).

**Strike window.** Live stays |delta| 0.35–0.75 (PR #166's band has zero trades; changing it would
restart an empty record). Every candidate is stamped `deltaBand`: **prompt** = the long leg's
|delta| in [0.40, 0.70], **outer** = the rest of the window (or no delta). D7 measures the slice
before anything moves.

## Universe expansion and research slices (Sep 15 2026)

`OPTIONS_WATCHLIST` is now **28 base names** = `OPTIONS_WATCHLIST_SLICES.A ∪ B` (order preserved; a
test pins the partition):

- **A (18)** — the six index/mega names (SPY QQQ IWM AAPL AMD NVDA) that give the desk its regime
  read, plus the affordable core (F AAL T PFE CCL NCLH WBD DKNG RIOT SOFI MARA RIVN). It takes the
  post-close refresh, since the core is where the live desk actually trades.
- **B (10)** — TSLA MSFT AMZN META GOOGL AVGO NFLX PLTR COIN MSTR. At their prices only a $2.5–5-wide
  debit spread fits the cap; the screen enforces that by price, nothing special-cases them. Scanner
  **discovery** names (≤6) ride in this slice only.
- For D4's cluster map: RIOT, MARA, COIN and MSTR are one `crypto-proxy` bet, not four.

**The load math.** 28 base + ≤6 discovery = 34 names × 2 expiries × 5 strikes × 2 types =
**680 contracts** per full pass (34 quote batches of 20) against 180 (9 batches) before, and the
broker's instrument reads already flaked past ~100 in one run. So each run reads **≤360 contracts**:
slice A = 18 × 20 = 360; slice B = (10 + 6) × 20 = 320. One run takes roughly **10–15 minutes**
(bars, two chains per name, quote batches until every ID answers, the calendar twice, fundamentals
in tens).

**The schedule** stays one plist (`scripts/com.esbueno.options-market.plist`, four weekday
entries). launchd cannot vary the environment per `StartCalendarInterval`, so
`scripts/options-market-run.sh` picks the slice by ET hour — **10:15 and 17:45 → A; 12:15 and
15:15 → B** (any other hour → A) — unless `RESEARCH_SLICE=A|B` is set for a hand run (anything
else refuses and logs). The script derives `BASE_SYMBOLS` from that slice, runs the scanner
session and adds the discovery clause only in B (a failed scanner session is logged and the run
continues without discovery — the large caps are still read), exports `RESEARCH_SLICE` so the
ingest log line carries `slice`, `runSymbols`, `runContracts` and `unmatchedQuotes`.

**The merge** (`mergeResearchSnapshot`) keeps every watchlist symbol's bars, contracts and event
rows from whichever run last observed them, so a slice-B run never drops slice A's data and the
screen always sees all 28 (a test pins both directions). A run that observed no discovery names
(slice A never asks) carries the last run's discoveries forward instead of dropping them for half
the day; a run that observed some replaces them (six at most, sorted). `errors` are the run's own.

**Unmatched quotes on the panel.** The ingest already writes `N requested contracts lacked usable
matched quotes` into the snapshot's `errors`; `unmatchedQuoteCount(errors)` reads it back and
`/api/options/live-desk` exposes `research {capturedAt, symbols, contracts, unmatchedQuotes,
errors}`, shown on the Live desk panel's research line ("412 contracts on 28 names, last run 2h
ago · 3 unmatched quotes · 2 error lines"). A rising count is the first sign a slice is too big.

After this ships, the first two runs (one A, one B) fill both halves; until then the merged
snapshot carries whatever the old 18-name runs left, and the ten new names simply have no bars yet.
