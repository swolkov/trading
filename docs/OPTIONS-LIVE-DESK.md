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

## Rules in force (`OPTIONS_LIVE_RULES` + `options-risk-ladder.ts`)

Debit structures only (long call, long put, call/put debit spread) so max loss = premium paid + fees ·
sized by the ladder below (one contract, two only on a Strong-or-better structure that fits twice) ·
one slot (a second after ten closed live trades with the divergence check green) · one entry per day ·
no entries in the last 30 minutes · premium stop at 50% of entry · no fixed target: once worth 1.5×
entry a trail keeps half the best gain (a spread at full width exits) · out 7 days before expiry ·
unfilled entry cancelled after 15 min · account value the larger of $300 and 20% under its high-water
mark → desk disarms itself (positions stay managed).

## The size ladder, drawdown tiers, clusters and the reserve (Sep 15 2026, `src/lib/options-risk-ladder.ts`)

**ARM sets `options_live_max_loss_usd` to the CEILING** — $150, or $225 once `options_score_promoted="true"`.
Per trade the runner grades the candidate and sizes under it, then hands the core that cap as the
policy it enforces on review and re-review (`maxLossUsd`, `maxOpenPositions`, `maxQuantity`; the core
refuses anything past its hard limit of 2 and 2):

| Grade | Rule | Max loss (the larger of) |
|---|---|---|
| Normal | any candidate the screen passed | $100 / 6.7% of equity |
| Strong | 20-session breakout or breakdown **and** SPY aligned with the direction **and** every leg's spread ≤5% on the live quote **and** payoff at the market's expected move ≥1.5× the planned loss | $150 / 10% |
| A+ | Strong **and** score ≥80 **and** the score promoted (D7) — locked until then | $225 / 15% |

× the **drawdown tier** from `options_account_snapshot.totalValue` against `options_live_equity_high`:
tier 0 (<5% under) ×1 · tier 1 (5%) ×1 · tier 2 (10%) ×0.5 · tier 3 (15%) ×0.25 · tier 4 (the larger
of $300 and 20%) halt — `drawdownHalt` delegates to `ddTier`; the tier is written to `options_live_dd_tier`.
**Two contracts** only when the grade is Strong or better and one contract's max loss plus its fee
reserve fits twice inside the cap; the $2 fee reserve is per contract and the core scales it.
**Cluster**: `clusterOf` = the paper universe's correlation group plus RIOT/MARA/COIN/MSTR →
`crypto-proxy`, F/RIVN/AAL/CCL/NCLH/T/PFE/WBD/DKNG → `consumer`, NFLX → `megacap`, SOFI → `fintech`.
The same direction in the same cluster, or an index ETF beside any semis/megacap name in the same
direction, is one bet — a second is refused (`cluster: SPY call + NVDA call would be one tech bet — refused`).
**Reserve**: open max loss + the new trade's ≤25% of equity (`reserve: $325 already at risk + $150
would exceed 25% of $1,500`); no account value on file refuses. **Slots** (`slotsFor`): one, a second
once `options-live-ledger.ts` counts ten closed round trips with the divergence verdict green — no
`unknown` intent, every stamped broker review fee inside the reserve, every fill within 5% of its
limit (from the order's fail-soft `averagePrice`; the limit stands in when the broker gave none).
The executor stamps the broker's review figures (`review {estimatedFeeUsd, maxLossUsd,
buyingPowerRequiredUsd}`) on the intent RECORD, not the intent, so recovery identity is untouched.
Names outside both cluster maps (discovery names) are `speculative`, so two of them in the same
direction are one bet.

**Sizing facts, stated plainly (Sep 15 2026 review):**
- The dollar rung is a FLOOR, not a percentage: at $900 equity Normal is still $100 (11% of the
  account), Strong $150 (17%). The percentages only bite once equity is past $1,500.
- Rungs above the armed ceiling are dead: with the $150 ceiling, Strong and Normal are the whole
  ladder; A+ ($225) only exists after promotion **and** a re-ARM (the ceiling is written at ARM time —
  changing `OPTIONS_LADDER` or the ceiling does nothing to a desk armed under the old one).
- The halt WIDENS with the high-water mark: `max($300, 20% × high)` — $300 at a $1,500 high, $400 at
  $2,000. It never tightens below $300, so a shrinking account is not ratcheted into a halt.
- Equity for the tier and the reserve is the **17:32 ET account snapshot** (`options_account_snapshot`),
  not a live read; intraday P&L moves neither. No snapshot on file → every entry is refused by the reserve.
- ARM refuses when the score is promoted but $225 would exceed 15% of that snapshot.
- **The 2-lot review path is unverified against a real broker response.** Every review to date was
  one contract; a quantity-2 review (fees, buying power, max loss decoded ×2) has never been seen.
  Run `probe` on a Strong day before relying on a 2-lot entry.
- A partially filled 2-lot ENTRY is cancelled at once (not after the 15-min sweep); the filled
  contracts become an owned 1-lot on the next tick and are stop-managed like any other.
- With two slots a wanted CLOSE cancels a live entry order first (the policy refuses any order beside
  an outstanding one); the close goes the same tick if the cancel confirms, else the next.
- A leg-quantity mismatch at the broker never releases the record: release only when NONE of the
  record's legs (option + side) is at the broker; a mismatch is kept, logged and paged once.
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
trail keeps half of the best gain seen. A spread worth 90% or more of its width exits whole. Out 7
days before expiry. **Thesis invalidation (Sep 15 2026):** the entry stashes the signal's 20-session
range edges on the reservation record (`candidate`, beside the canonical intent); at fill the edge the
signal CLEARED, back inside the range by the pre-registered 0.5% buffer, becomes `invalidationPx` on the
owned record — `rangeHigh × 0.995` for a bullish breakout, `rangeLow × 1.005` for a bearish breakdown
(`invalidationLevel`; SOFI at 12.10 over a 10.20–12.00 range → 11.94) — with `signalDirection`. A failed
breakout, not noise at the line. The guardian reads the underlying's live quote each tick
(`underlyingQuote`, fail-soft) and exits at the executable mark once the stock has TRADED beyond that
level on **two consecutive ticks** (`invalidationTicks`, persisted on the record so a restart cannot
forget) — trades, not closes, because the premium stop already fires intraday; a quote inside the level,
stale (>15 min) or missing resets the count. Premium stop, width, trail and time exits take precedence.
**Partials:** only a 2-lot (Strong-or-better structure that fit twice) banks one contract at 2× entry
(a close intent with `quantity: 1`) and trails the rest; the policy's close check is now *owned ≥
intent quantity*, the fill ingest rewrites the owned record with the remainder, and the guardian never
releases a position while a close intent is unsettled (a 1-lot remainder must not be misread as gone).

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

## Trade cards and the long-vs-spread comparison (Sep 15 2026, `src/lib/options-trade-card.ts`)

Every structure the desk considers becomes a **trade card** — the prompt's TOP-5 / LIVE TRADE OUTPUT
in one record: symbol, direction, structure, expiry/DTE, strikes, **natural** (`openNetAsk`, what the
desk pays) vs **mark** (net mid) vs **expected fill** (the limit sent), contracts, debit, max loss
(incl. the fee reserve) and max gain (uncapped on a long call), breakeven, % of equity at risk, R:R
(max gain ÷ max loss) and payoff at the market's expected move ÷ risk, net delta/theta, ATM IV and
IV/RV, the expected move and its level, **target** (the short strike, or the expected-move level for
a single), **invalidation** (`invalidationLevel` on the signal's 20-session range — the same number
the guardian watches), expected hold, grade, cap, and **confidence = the 0–100 score labelled "paper
ranker"**. `renderOptionsTradeCard` is the text on the Slack entry page and in the log.

`structureComparison` puts the researched families side by side (cost, max loss/gain, return on
risk, breakeven, net greeks, IV vs realized, payoff at the expected move, theta drag) and applies the
prompt's rule — a single leg only when it costs **≤1.15× the best spread and pays at least as much
per dollar at the expected move**. This EXPLAINS the live desk's choice; it does not make it. The
desk keeps choosing by the IV/RV family rule (PR #166); when the two would differ the card says so
under `disagreement` and the existing rule wins. Stamp and measure.

**Ledger:** raw-SQL table `options_trade_cards` (id, at, source `research|entry|refusal`, symbol,
kind, expiry, score, grade, action, payload; indexed by time and by symbol). Writers: the research
ingest (top five per run, no Slack) and the live desk (every entry attempt and every refused candidate
with its gate), written **after** the core has answered **and after the thesis is stashed on the
reservation record** (the guardian's invalidation rule depends on that stash, so nothing card-shaped
runs before it); the builder is throw-safe (`safeEntryTickCards`: a throw logs and yields no cards)
and the write is `.catch`ed — never on the order's path. On entry ticks the runner also writes a
`logDecision("options-desk", …)` line into the vault's `Decisions/YYYY-MM-DD.md` (fail-soft; ENTRY
always, SKIP at most once per symbol per ET day per process). A refusal card names its gate
(`REFUSED — market veto — SPY below its 20-day …`).

**Credit spreads: not measured yet.** The screen still builds `put_credit` / `call_credit` for the
research page, but the card's max loss / max gain / breakeven, the ledger's settlement and the brief
are all **debit math** (a credit's max loss is width − credit and it profits expiring worthless — the
sign inverts). Every reader passes through `liveEnterableKinds` (= `OPTIONS_LIVE_RULES.entryKinds`,
debit only), exactly as the entry tick does, so no credit structure reaches a card, the score ledger
or the brief until a credit-math PR exists.

## The 0–100 score is a paper ranker (Sep 15 2026, `src/lib/options-score.ts`, `options-score-ledger.ts`)

`optionsOpportunityScore` → `{score, components, missing}`: direction 20 · catalyst 15 (0 with
earnings inside the expiry; an event within 3 days of expiry −5; unknown → 7 and named in `missing`)
· pricing 15 (IV/RV 5, **IV-rank 4 — only once the archive holds ≥30 days, else listed in `missing`**,
spread % 3, theta/day as % of premium 3) · liquidity 10 · R:R 15 (payoff at the expected move ÷
planned loss) · momentum 10 (relative volume; halved at a chase ≥2×) · market 5 (SPY alignment) · EV
10 (payoff × p − loss × (1 − p) with **p = the long leg's |delta|, a stated proxy**). The prompt's
80+ line is `OPTIONS_SCORE_RULES.liveLine` — documented, never enforced.

**Scoring universe = breakouts AND Trend-watch names.** `screenResearchContracts(…, {includeWatch:
true})` builds structures for trend-aligned names without a range break and stamps them `refusedBy:
"no breakout"`; they are appended after every breakout structure and exist only in the research
ledger. **The live desk never sets `includeWatch`; its output is byte-identical** (a test asserts
it). This is what makes thirty resolved rows per bucket reachable in weeks rather than quarters.

**Measurement:** each research run archives its scored rows on the observation
(`OptionsObservation.candidates`, schema-tolerant: older records parse without it, a malformed row
drops, never the record). `resolveCandidates` settles each row at **min(expiry − 7 days, +10 sessions
after the signal day)** on later broker daily bars as intrinsic value − debit − fee reserve, per
contract — a **settlement proxy: no fills, no slippage, no stop, no trail**. It ranks the score; it
does not estimate the desk's P&L. **One row per structure per settlement window:** the first run
that scored a structure (symbol/kind/expiry/strikes) owns it until that row settles — a Trend-watch
name re-screened daily would otherwise be counted many times over as one autocorrelated bet; a
re-scoring after the settlement day starts a new row. Debit structures only (credit spreads are not
measured yet). `bucketStats` ≥80 / 70–79 / <70 with n, mean, sd, t; `promotionVerdict` is green only with
**≥30 resolved in every bucket, the ≥80 mean above the <70 mean, and Welch t ≥ 2** between them
(registered 2026-09-15, before the first row was scored; three buckets are compared, so a lone t ≥ 2
is weaker than it looks — the verdict also needs the means ordered).

**Promotion:** the admin's typed **PROMOTE** (`promote-score` on `/api/options/live-desk`) sets
`options_score_promoted="true"` **only on a green verdict** (409 otherwise). What promotion does
today: the A+ rung ($225 / 15%) unlocks on the **next ARM** (`gradeFor` reads the switch). What it
does NOT yet do: the runner passes no score to `gradeFor` (`options-score` is not imported by the
decision path — asserted by a test), so A+ stays unreachable until a later, reviewed PR feeds the
score in. That is the intended order: measured first, then promoted, then wired. `GET
/api/options/score` and the "Does the 0–100 score rank?" panel on `/options` show buckets, verdict,
the latest run's top scores, recently settled rows and the last twenty trade cards.

## The desk brief and conditional orders (Sep 15 2026, `src/lib/options-brief.ts`)

`renderOptionsBrief` writes six sections in order — **ACCOUNT** (equity, buying power, at risk,
screen cap, drawdown tier, armed) / **MARKET** (SPY, QQQ vs their 20/50-day, vol regime from VIX,
catalysts today among researched names, veto on/off) / **TOP 5** (cards by score) / **BEST TRADE**
(what the tick would take: the first of the screen's top three that passes every stamped gate, its
card, and each gate ✓/✗) / **ACTION** / **CONDITIONAL ORDERS**. `ACTION` is **ENTER NOW** only when
the best structure passes every gate on stamped data **through the same functions the entry tick
calls** — `spansEarnings`, `marketVeto`, `chaseCheck` on the signal-day bar (close vs the prior
close), `clusterRisk`, `gradeFor`/`maxLossFor` × `ddTier`, `reserveRefusal`, the DTE window,
armed+verified, and an **open slot** (any held position fails it: "WAIT, the tick's slot count
decides") — never a re-implementation. What only the tick can check is **named on every ENTER NOW**:
entries today vs the daily limit, the last-30-minutes rule, the intraday SPY shock, the broker's
live earnings date, the exact slot count. Every row passes `liveEnterableKinds` first (debit only).
**WAIT FOR TRIGGER** when a Trend-watch name is within 2% of its range edge or a breakout was refused
for chasing; otherwise **NO TRADE**. Each Trend-watch name gets the rule the tick executes: `enter
long call 12 2026-10-16 only if WTCH closes above 12 with SPY/QQQ constructive and no earnings before
2026-10-16; max loss incl. fee $100.50` (the Normal cap at this equity × the drawdown tier).

Written by the research ingest after every run and re-rendered by the 17:32 account collect with the
fresh snapshot: `options_desk_brief` (JSON + text), vault `Brain/options-desk-brief.md`, and the
`options` Slack lane — **one line** (action, best symbol, reason; the full brief is on the page and in
the vault), **only when the action or the best symbol changed, at most twice per ET day**
(`options_desk_brief_last` carries the day and count and is written **before** the send, so a failed
write can never re-send). The at-risk figure reads `options_live_verified_fee_reserve_usd`, the
runner's own formula.
`GET /api/options/brief` + the Desk brief panel on `/options`. Read-only on the desk: the brief can
place, size or gate nothing.

## The prompt, mapped to code (Sep 15 2026)

**EXISTS (before this week):** the 20-session breakout/breakdown signal with 50/200-day alignment
(`researchSignals`) · quality gates (OI ≥500, volume ≥100, spread ≤10%, standard contracts, two-sided
market) · expected-move ranking (ATM straddle ÷ spot, payoff at that move, lottery tickets rejected)
· the IV/RV single-vs-spread family rule (≤1.15× → single) · stop at half the premium, 1.5× trail
keeping half the best gain, 90%-of-width exit, out 7 days before expiry · the $100 cap and one entry
a day · fresh broker quotes at the moment of the order (chain analysis is live, never stale) · debit
structures only (the never-do list is the policy core).

**BUILT NOW (D1–D9):** earnings + ex-dividend veto with a fail-closed live confirm (D1) · SPY/QQQ
alignment stamp and the one pre-registered market veto + intraday shock (D2) · do-not-chase, the DTE
engine (21–60, two expiries, theta-charged ranking), the 0.40–0.70 delta-band stamp (D3) · the size
ladder Normal $100 / Strong $150 / A+ $225 (locked), drawdown tiers 5/10/15/20%, cluster and 25%
reserve, slots (D4) · trade cards with the long-vs-spread comparison, the ledger and Decisions/ (D5)
· thesis-invalidation exit on two ticks and 2-lot partials (D6) · the 0–100 score as a paper ranker
with its settlement ledger and typed promotion (D7) · the desk brief with conditional orders (D8) ·
the 28-name universe in two research slices (D9).

**PAPER-ONLY (measured, not acted on):** the 0–100 score (stamped on every card; promotion needs the
ledger verdict; a live input only after a later PR) · the 0.40–0.70 delta slice (`deltaBand` stamped
on every candidate; live stays 0.35–0.75) · credit spreads (the screen still builds `put_credit` /
`call_credit` for the research ledger; `OPTIONS_LIVE_RULES.entryKinds` is debit-only and there is no
short-leg guardian) · Trend-watch structures (`refusedBy: "no breakout"`, ledger only).

**REJECTED WITH EVIDENCE:** 0–1 DTE (decay 36%+/day, friction 15–30% a side at $100) · 7–14 DTE as
the default (3.5–7%/day decay; a flat week is the stop — the table in "When the desk does what") ·
the score as a live gate before it ranks (this account's conviction score ranked backwards; the
verdict needs t ≥ 2 with thirty per bucket) · A+ before proof (locked to the promoted switch) · a
second slot before ten closed live trades with the divergence check green · credit spreads live
before a short-leg guardian and a record · intraday market structure (research has daily bars only —
a later research item, not built).

**Promotion ladder (what earns what):**

| Rung | Gate | Unlocks |
|---|---|---|
| Score → live input | ≥30 resolved per bucket, ≥80 mean > <70 mean, Welch t ≥ 2 (`promotionVerdict`), typed PROMOTE | `options_score_promoted`; A+ on the next ARM; a later PR feeds the score to `gradeFor` |
| A+ rung ($225 / 15%) | promoted **and** score ≥80 on the candidate **and** Strong's own rules | the ceiling written at ARM |
| Second slot | 10 closed live round trips with the divergence verdict green (`slotsFor`) | `maxOpenPositions: 2` on the tick |
| Second contract | Strong-or-better grade whose structure fits twice under the cap | `quantity: 2` (the 2-lot review path is still unverified against a real broker response) |
| Delta band 0.40–0.70 | D7's ledger split by `deltaBand` at ≥30 per slice | a later PR; nothing moves before |
| Credit spreads | a short-leg guardian + a measured record on the ledger | a later PR |

**Deploy classes and the re-ARM note.** **R** = the Railway worker (`options-desk`, `scripts/robinhood/desk-worker.ts` → `live-desk.ts`, `collect.ts`): the live desk, the guardian, the 17:32 collect and its brief re-render. **M** = the Mac research job (`scripts/options-market-run.sh` → `options-research-ingest.ts`): the research prompt, the ingest, the score ledger, research cards, the brief. **V** = the Vercel admin: `/options`, `/api/options/*`. D5 = R + V + M, D7 = M + V (+ R for the live cards), D8 = M + R + V, D10 = V. **Sections 1–4 changed no research prompt line in `options-market-run.sh` beyond D1/D3/D9's** — the D5/D7/D8 ingest changes are code-side, so no by-hand pipeline re-run is needed for them (the next scheduled run picks them up; the first run after deploy writes the first scored observation and the first brief). **Re-ARM:** the ceiling is written at ARM time — after D4 deployed, one re-ARM (typed ARM) sets `options_live_max_loss_usd` to the ladder's ceiling ($150; $225 only after promotion **and** another re-ARM). Nothing in D5/D7/D8 needs a re-ARM.
