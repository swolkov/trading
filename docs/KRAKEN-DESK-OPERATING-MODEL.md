# Kraken margin desk — operating model (Sep 15 2026)

This is the desk's constitution: how an idea becomes a paper sleeve, how a paper sleeve earns
live money, what takes it back off, and where every line of the two operating prompts Spencer
pasted on Sep 15 lives in code — or why it deliberately does not. Everything here is either
pinned by a test, read from a named file, or marked REJECTED with the number that rejected it.

Two rules above all others, both already true in code:

1. **Nothing changes an armed sleeve's rule from inside the loop.** Sleeves are pre-registered
   experiments; the synthesis reports, the operator (or a deliberate PR) changes the code.
2. **Every twin is judged against its comparator on identical signals**, at ≥30 resolved,
   t ≥ 2, 7+ distinct days — never on hit rate, never on a pooled row.

---

## 1. The five-stage ladder

| Stage | Name | What it is | The code that gates the edge INTO it | Back-edge |
|---|---|---|---|---|
| 0 | RESEARCH | A replay on historical bars (`scripts/lib/replay-engine.ts`, `scripts/replay-walkforward.ts`), or a slice of the paper record (`candidateSlice`). Produces numbers, never trades. | — | — |
| 1 | PAPER | A `source` with an `exitParams` branch and an `autoShadowPlans` branch (`margin-shadow.ts`, `margin-auto-plans.ts`); its hypothesis and kill rule written in §4 of this doc **before** its first row opens. Scored by `evaluateShadowSignals` on real Kraken 1-min candles with real fees. | The PR that adds it. A twin also joins `TWIN_SOURCES` (excluded from every pooled statistic). | RETIRE: added to `RETIRED_AUTO_SOURCES` (open rows still resolve); the row stays on the scoreboard as evidence. |
| 2 | PAPER-GRADUATE | `promotionVerdict` (`margin-leaderboard.ts`) is green on all eight gates: forward resolved ≥30 · live-priced net >0 · t ≥2 · ≥7 distinct days · maxDD (live series) ≤ breaker % · PF ≥1.2 · rolling-30 not DECAYING · **has a live container**. Without the last it reads `PAPER-ONLY`. | `promotionVerdict`; `weeklyAction` says PROMOTE-READY; the go-live panel shows N/8. | Any gate going red (the verdict is recomputed every synthesis and every Monday). |
| 3 | LIVE-CAPABLE | A `LIVE_CONTAINERS` entry (`margin-live-risk.ts`) pinned to the paper `exitParams` by `tests/margin-containers.test.ts`, and a guardian that mirrors the exit (`managedStopTarget` = paper `managedStop` level for level; the pyramid add via `pyramidAddDue`/`pyramidAddNotional`). A paper exit the guardian does not run (tightening trail, launch stop, partial, conditional entry) **cannot** have a container — the containers test proves those sources return `null` from `liveContainerFor`. | A deliberate PR, after stage 2, after a Fable review of the guardian mirror. | Removing the container (the sleeve stays on paper). |
| 4 | ARMED | `kraken_margin_auto=true`, `validate_only=false`, `kraken_margin_live_sources=<one source>`; stage-3 half size (`kraken_margin_stage3`, base 1.5% → paper's base only on graduation — **held**, see §6). Every entry runs the executor's gate chain (§2) and the one multiplier chain `liveRiskPctChain` = min(8%, ladder × dd × event × decay). | The typed ARM on the Live Desk, or `switch-source` (never ARM) to change sleeves. | **REDUCE** — `maybeDecayReduce` (rolling-30 Welch t ≤ −2 → `kraken_margin_decay_multiplier=0.5`, restored only on `stable`). **DEMOTE** — `maybeDemote` (forward record ≤$0 at 30 · live diverges from paper after 5 closed · DECAYING and last-30 net ≤ 0) → `kraken_margin_auto=false` first, then the reason under `kraken_margin_demoted`; re-arming needs the demotion acknowledged. **HALT** — the 15% drawdown breaker (`margin-watch`). |

The comparator for every 4h twin is `swing-wide` on identical signals; the live sleeve today is
`swing-pyr` (switched Sep 12). The 5m/15m family's comparator is `selective`.

## 2. The armed entry, gate by gate (read-only map of `executeAlert`)

In order, each a refusal that is logged (`look[]`, `margin_trade_cards` from A3 onward): arm switch
→ source armed → US-retail universe → `kraken_margin_symbols` allow-list → drawdown breaker →
concurrent-entry lock → submissions/day → cooldown → operator max leverage ≥2 → guardian fresh
(<15 min) → trade sync fresh → financing complete → equity readable → event policy (B2: paused →
refuse) → daily loss cap → drawdown tier (A1) → losers today (A1 revenge pause) → anomaly key (A5)
→ slots (`MAX_LIVE_POSITIONS`) → positions read not degraded → pyramid pending marker → same-pair
exposure/netting → live container exists → stop survives the leverage (`leverageThatFitsStop`) →
BTC-shock veto and data-quality (scan route, before the call) → **sizing** (`liveNotional` × the
multiplier chain) → margin-level floor 150% → liquidation buffer (A1) → cluster cap (A2) → Kraken
minimum → guardian still fresh → route time left → AddOrder → ledger → card → Slack → Decisions/.

## 3. Both prompts, section by section → code

Status words: **EXISTS** (before Sep 15), **BUILT NOW** (the Sep 15 plan: PR #171 = A1/B1/B2,
#174 = C1/C2/C3, #177 = A3/A4/A2/A5, #180 = B3/B4/B5/B6, **this PR** = C4/C5/C6/C7),
**PAPER-ONLY** (measured, never live until it graduates), **REJECTED** (tested on this account;
the number is the reason; do not re-litigate).

### Prompt 1 — the operating spec

| Section | Status | Where |
|---|---|---|
| Research → paper → live gate | EXISTS + BUILT NOW | `strategyVerdict` (30/net/t/7d) + `promotionVerdict` (8 gates, C2) |
| Risk as % of equity at the stop; leverage derived | EXISTS | `liveNotional`, `leverageThatFitsStop` (0.36/stop → 9× at 4%) |
| Liquidation buffer ≥1.5–2× the stop | EXISTS, made explicit | `LIQ_BUFFER_MULT=1/0.6` (1.67× isolated, ≥3× account-level with the 150% floor), `liqBufferOk` refusal, the card's `liqMultipleVsStop` (A1/A3) |
| Portfolio / cluster / correlated exposure | BUILT NOW | `exposureSummary`, `clusterEntryAllowed` (A2): all-stops risk + new risk ≤ breaker headroom |
| Tiered drawdown (reduce before halt) | BUILT NOW | `DD_TIERS` −5% ×0.5, −10% ×0.25, −15% halt (A1); loss sequence at 8% A+: 8.0 → 3.68 → 1.77 → 1.73 → halt |
| Multi-strategy leaderboard (Sharpe/Sortino/PF/maxDD/R) | BUILT NOW | `sleeveMetrics` (C1), `leaderboard()` (C2), paper page + weekly memo + statistics file |
| Regime engine (nine labels) | BUILT NOW, **not a gate** | `regimeLabel(features)` (B6), stamped `regime_label`; the only regime filter ever tested (`selective-btc`) is at t=−6.06 |
| Walk-forward / OOS / sensitivity / Monte Carlo | BUILT NOW (research) | `scripts/replay-walkforward.ts` → `Performance/margin-research.md` (C6, §5) |
| EV after costs | EXISTS + BUILT NOW | fees inside every `shadow_pnl`; `expectancy`/`grossExpectancy`/`feeShare` (C1) |
| Trade journal with MFE/MAE | BUILT NOW | `shadow_trough`/`shadow_mae_r`, `margin_round_trips` (A4) |
| Post-trade review | BUILT NOW | `margin-review.ts` (C4): seven mechanical answers per closed live round trip → `Decisions/YYYY-MM-DD.md`, once per txid (`margin_review_done`) |
| Strategy decay | BUILT NOW | `rollingVerdict` (C1) → `maybeDecayReduce` (C3): REDUCE at 0.5× before DEMOTE |
| Kill switch on anomalies | EXISTS + BUILT NOW | guardian freshness, trade-sync freshness, fail-closed reads, margin floor, cushion pages (existed); `bookMatchesCard`, bot-shaped orphan never swept, `kraken_margin_anomaly` (A5) |
| Opportunity ranking | BUILT NOW, **paper ranker** | `opportunityScore` 0–100 (B5), `promotionVerdict` in `margin-opportunity-slices.ts` — a live gate only after the ≥80 bucket beats the rest at t ≥ 2 |
| Reporting format | BUILT NOW | `renderDeskBrief` — the eight sections in order, `deriveAction` (B6); `Brain/crypto-desk-brief.md` daily after 13:00 UTC |
| Data quality | BUILT NOW | `barFeatures.dataOk` (gap/dup/stale) — the scan refuses the live hand-off, paper still opens (B1) |
| Paper realism (spread/latency/partials) | EXISTS + noted | 0.1% entry chase (`MODEL_CHASE_BP`); candle-based stops with gap-aware fills; `PAPER_STOP_SLIP_BP` (this PR, default 0, §6) |
| Execution engine (maker vs market) | EXISTS, OFF | `kraken_margin_maker_entries=false` on purpose; replay: maker saves a constant +$7/trade but never models the breakouts that run away unfilled |

### Prompt 2 — the aggressive live override layer

| Section | Status | Where / why |
|---|---|---|
| 6h–72h horizon | EXISTS | swing containers: 4h signals, 96h–168h holds; `horizonH` on the card |
| Leverage ceilings BTC ≤20× / alts ≤10× as maximums | EXISTS | `US_MARGIN_MAX_LEVERAGE` (Kraken's own list), operator cap `kraken_margin_max_leverage`. **20× as a target is REJECTED**: leverage is derived from the stop (9× at 4%); 20× needs a ≤1.8% stop and tighter stops lost (t=−2.01) |
| Risk 0.5–2% by setup grade | REJECTED as numbers, ADOPTED as structure | Evidence: the 10-seed sweep puts the **ceiling at 8%** with a **cliff at 12%** (12% → −1.1%/mo, 5/10 seeds; 16% → −8%/mo). Structure: Normal 2 / Strong 4 / A+ 8 = base 4 × conviction 0.5/1/2 (`SETUP_GRADE_PCT`, A1) |
| Liquidation distance ≥1.5–2× stop | EXISTS | see above |
| Large-win philosophy: partials at 2R, trail the rest | PAPER-ONLY | `swing-partial` twin (§4, 5a). Fixed take-profits lost on this account: **four TP variants, t ≤ −2.15**. The prompt's TP1/TP2/TP3 fields read "no fixed target — 2R trail, add at +1R" on the card (`rrNote`) |
| 1D+4H direction / 4H+1H confirm / 15m+5m entry | BUILT NOW as a stamp, PAPER-ONLY as a gate | `mtfState` stamped on every row (B1); `swing-mtf` twin (§4, 5c) tests the gate — pre-registered as expected to fail |
| News + macro + derivatives + BTC leadership engine | BUILT NOW as veto + research feed | event calendar veto (B2), BTC-shock veto for alt entries (B3), funding/OI stamps (B4), BTC regime stamp. **News as an entry signal is REJECTED** (news-reaction trading died out of sample on this account) |
| 0–100 opportunity score, 80+ live threshold | BUILT NOW as ranker | `OPP_LIVE_LINE=80` documented as "the prompt's line — a ranker until promoted" (B5). The desk's own conviction score ranked **backwards** on the record; no weighted score gates money until measured |
| Conditional entries (breakout + retest) | PAPER-ONLY | `swing-retest` twin (§4, 5b): `margin_pending_entries`, resolved by 1-min bars at the top of each scan tick |
| Exact trade-card output | BUILT NOW | `buildTradeCard` / `renderTradeCard` (A3), persisted `margin_trade_cards`, announced after AddOrder |
| 3/5/8% drawdown tiers | ADOPTED, scaled | −5% halve, −10% quarter, −15% halt (A1) — the prompt's tiers scaled to the existing 15% breaker |
| Correlated-exposure accounting | BUILT NOW | A2 (`exposureSummary`: long/short/gross/net, all-stops risk) |
| ATR-based stops | PAPER-ONLY | `swing-atr` twin (§4, 5d): clamp(2×ATR14/close, 2%, 8%) |
| Shorts | PAPER-ONLY | `swing-short` twin (§4, 5e). Every short on the record (37, 11% won, −$5,140) was taken inside a 20–40% rally; `selective-short` (5m/15m, BTC down-regime) already exists |
| Market list BTC ETH SOL XRP DOGE BNB AVAX LINK SUI ADA | EXISTS minus one | all in the 26-coin US universe **except BNB — not US-margin-tradeable on Kraken** |
| Isolated vs cross margin | Documented | Kraken US margin is **account-level** (one margin level for the whole account, Kraken calls at 80% / liquidates at 40%). The card shows both the isolated estimate (`0.6/leverage`) and the account-level distance (`liqDistAccountPct`) |
| Liquidation maps | ABSENT (no free feed) | B4's OI-drop proxy (OI −5%/24h with a price move) is the stand-in, stated on the brief |
| Never widen a stop | EXISTS | the guardian only ratchets (`managedStopTarget`); A5 verifies the resting stop against the ledgered level every run |
| 1 slot vs 3 | EXISTS | 1 slot **beat** 3 in the slots-vs-size replay (slots and size are the same dial); `MAX_LIVE_POSITIONS=3` is a ceiling, the arm sets 1 |
| Leader / rotation switching | REJECTED | leader/switching replay −$1,420 |
| Liquidity-sweep fade (ICT/SMC) | REJECTED | `sweep-fade` retired Sep 3 (t=−2.7 / −6.0) |

## 4. Pre-registration ledger — dated 2026-09-15, committed before any twin opens a trade

Every entry below is judged at **30 resolved, paired against its comparator on identical
signals, t ≥ 2, 7+ distinct days**. What fires by itself: only the generic **KILL CANDIDATE**
line in the weekly memo (`weeklyAction`: resolved ≥ 30 and live-priced net ≤ $0). The twin-specific
kill reads below — paired t, fill rate, maxDD comparison — are **computed by the synthesis agent
from the scoreboard, the leaderboard and the statistics file and acted on by hand**; nothing in
code evaluates them, and the retire is a PR. All five are `TWIN_SOURCES` /
`OWN_SIGNAL_PAPER_SOURCES` members — never pooled, never armable (no live container;
`tests/margin-containers.test.ts` proves it).

### 5a `swing-partial` — bank 30% at +2R, trail the rest 2R

- **Container:** swing-wide's (4% stop, 2R trail, 168h hold, leveraged) + `partialAtR: 2`,
  `partialFrac: 0.3` on `ExitProfile`. The first **completed** 1-min bar whose favourable extreme
  reaches entry + 2R sells 30% of the notional at that level (at the bar's open when it gapped
  through — a resting limit fills at the better price). The remaining 70% keeps trailing 2R on
  the **first unit's** entry and R. The partial leg pays its pro-rata share of the entry fee, a
  taker exit, and rollover to its own time (`margin-shadow-legs.ts`, pure, reused by the replay).
  Columns `shadow_partial_px / _t / _notional`.
- **Hypothesis:** banking a third at +2R buys a narrower outcome distribution (lower maxDD, less
  give-back on the modal 2–3R run) for a bounded cost in expectancy.
- **Comparator:** `swing-wide` on the same signals.
- **Kill:** paired t ≤ −2, **or** expectancy ≥ $40/trade worse with **no** maxDD improvement.
- **Why it might fail:** the four fixed-TP variants lost; the large-win philosophy on this record
  is carried by the right tail (best 3.3R vs 0.93R average win) and a partial clips it by 30%.

### 5b `swing-retest` — conditional entry on the breakout's retest

- **Container:** swing-wide's, on a **deferred** plan: the 4h breakout is queued in
  `margin_pending_entries` with `level` = the pierced 20-bar high. The resolver (top of each
  `margin-scan` tick, ≤10 rows, its own 20 s wall clock) walks completed 1-min bars in three
  steps: **arm** — a bar must first CLOSE above level × 1.005 (price has left the level; stored
  as `armed`); **fill** — once armed, the first bar whose low touches ≤ level × 1.005 **and**
  closes above level fills the row at that close (chased 0.1%); **fail** — any bar closing below
  level × 0.995, armed or not; 24h unfilled expires it, as does a hole in the resolver's walk
  (first new bar > 2 min after the last one walked → `coverage gap`, never judged blind). A fill
  is claimed (`status='filling'`) before the row is opened, so overlapping ticks cannot open it
  twice. *Correction note: the rule as first written (touch + close, no arming) would have filled
  on the first bar after the pierce — a chase, not a retest. Corrected in review on 2026-09-15
  before the resolver ever ran in production; no row could have filled under the old text.*
- **Hypothesis:** entering on the retest rather than the pierce buys a better average entry (the
  0.1% chase plus the breakout bar's extension) at the cost of missing the breaks that never look
  back.
- **Comparator:** `swing-wide` on the same queued signals, **read on the filled subset** (paired on
  filled) **and** on the whole queue (what the misses cost).
- **Kill:** fill rate < 25% after 40 queued, **or** paired-on-filled t ≤ −2.

### 5c `swing-mtf` — multi-timeframe gate (pre-registered as EXPECTED TO FAIL)

- **Container:** swing-wide's; the plan is emitted only when the coin's **1d close > SMA20(1d)
  AND 4h close > SMA20(4h)** (`coinMtfTrend` in `margin-regime.ts`, read from the scan's
  `barFeatures`; the SMA includes the forming bar exactly as `mtfState` does).
- **Hypothesis (the null):** the gate does not add expectancy on this record. The only regime
  filter ever tested, `selective-btc`, is at t=−6.06; a 4h breakout above its 20-bar high is
  above its 20-bar mean by construction, so the gate mostly reads the daily.
- **Comparator:** `swing-wide` on the same signals — the paired read is on the signals the gate
  **takes**; the value of the gate is `swing-wide`'s result on the signals it **skips**.
- **Kill:** paired t ≤ −2 at 30 (it is retired either way once the 30-trade read is in unless it
  is significantly positive).

### 5d `swing-atr` — volatility-scaled stop

- **Container:** swing-wide's hold and trail; the initial stop = **clamp(2 × ATR14(4h) ÷ close,
  2%, 8%)** at signal time (`ScanSignal.atrFrac`, `atrStopFrac`), written to `shadow_stop_frac`
  and read back by `exitParams(source, lev, entry, stopFrac)` (optional 4th arg, default 0.04 —
  every legacy call and the containers test are untouched). Risk-sized notional shrinks with a
  wider stop and grows with a tighter one; 1R = the ATR stop.
- **Hypothesis:** a stop sized to the coin's current range is hit by noise less often than a
  fixed 4% on the volatile alts and wastes less room on the calm majors.
- **Comparator:** `swing-wide` (fixed 4%) on the same signals.
- **Kill:** paired t ≤ −2, **or** maxDD 25% worse than `swing-wide`'s over the same trades.
- **Why it might fail:** tighter stops lost (t=−2.01, slippage); the clamp floor of 2% is exactly
  the region that lost.

### 5e `swing-short` — 4h breakdowns in a BTC down-regime

- **Container:** swing-lev's (4% stop, 1R trail, 96h hold) **mirrored for paper only** — no live
  container. Plan: high-conviction **4h breakdown**, `regime.btcUp === false` (last complete daily
  close below its 20-day SMA); an unreadable regime opens nothing. Its own signals, so its own
  scoreboard row and its own exclusion from pooled totals (`OWN_SIGNAL_PAPER_SOURCES`).
- **Hypothesis:** the record's shorts lost because they were taken inside a rally; the same
  container in a confirmed down-regime is a different population.
- **Comparator:** none paired (own signals); judged on its own record.
- **Kill:** net ≤ $0 at 30 resolved; **early stop at 20** if hit ≤ 15% and net ≤ −$1,000.

### Research questions (C6) — pre-registered before the first run

Data: Binance 1h bars 2024-01 → latest (`data/crypto/*.csv`, refreshed by
`scripts/crypto-bars-refresh.ts`; BTC ETH SOL XRP DOGE AVAX LINK + ADA LTC SUI when the endpoint
answers), aggregated to UTC 4h and 1d on the same boundaries `isFourHourClose` uses. Entries =
the desk's own detector and conviction scorer (`evaluate` + `scoreConviction`, high tier, with the
1d context), one open trade per coin decided by the control profile — identical entries for every
variant, exactly as `scripts/backtest-variants.ts` did. Fees and rollover as paper models them.
Verdict words appear only at |t| ≥ 2; every table carries n, t and a 95% CI.

- **WF1 — anchored 3-fold walk-forward of the live rule** (`swing-pyr`: 4% stop, 2R trail, 168h,
  risk-sized add at +1R). Folds: IS 2024-01→2024-12 / OOS 2025-01→06 · IS 2024-01→2025-06 /
  OOS 2025-07→12 · IS 2024-01→2025-12 / OOS 2026-01→06. The rule has no fitted parameters, so
  WF1 asks only: is the OOS expectancy positive in each fold, and is the pooled OOS t ≥ 2?
- **WF2 — walk-forward efficiency.** In each fold, the S1 cell with the best IS expectancy is
  applied OOS and compared with the live rule OOS on the same entries. Efficiency = OOS/IS
  expectancy of the picked cell. The question is whether picking beats not picking; a negative
  or sub-0.5 efficiency is the expected result and is the reason the desk does not pick cells.
- **S1 — sensitivity, read for FLATNESS, never to choose a cell.** Grid: stop {3, 4, 5}% × trail
  {1.5, 2, 2.5}R × hold {120, 168, 240}h × add {none, 0.75, 1, 1.25}R on identical entries
  (108 cells). A cliff = a neighbour differing by more than 2 SE of the paired difference. The
  live cell (4 / 2 / 168 / 1) must not sit on a cliff. If the full grid is too slow the stop ×
  trail plane is read first and the report says so.
- **MC1 — block bootstrap of the live rule's R-multiples** (block length 5, seeded). 10,000 paths
  of 100 trades on $5,000 at 3 / 5 / 8% risk per trade → P(hit the 15% breaker), median and 95th
  percentile maxDD, longest losing streak, P(−50%), P(+50%). Read beside the 8% ceiling sweep;
  it is a variance map, not a size recommendation.

## 5. Paper realism, and what the paper model still does not know

- **Entry:** every paper entry pays a 0.1% adverse chase (`MODEL_CHASE_BP = 10`) — a market
  order chasing a 5-min-late break. Measured live: `divergenceSummary.avgEntrySlipBp` flags
  >2× the model.
- **Stops:** candle-based on Kraken 1-min last-trade candles, gap-aware (a bar opening beyond the
  stop fills at the open). Live stops trigger on Kraken's **index** price — a paper stop-out live
  survived, or the reverse, is a measurement difference, not an edge.
- **Stop-fill slippage:** the replay assumed 0.7% (`EXPECTED_SLIP_PCT`); A4 measures the real
  number per stop exit (`stop_fill_slip_bp` in `margin_round_trips`). **`PAPER_STOP_SLIP_BP`**
  (margin-shadow, this PR) is the haircut the paper series will apply to stop exits — **0 until
  ≥10 measured stop fills exist**, then set to the measured average by a deliberate PR. Inert
  today by construction.
- **Fees:** 0.25% taker in and out (real fills paid 0.215–0.223%/side), rollover per 4h on
  notional (BTC 0.015% measured, ETH 0.02%, alts 0.03% — on the high side on purpose).
- **Partial fills / latency:** not modelled — irrelevant at this size on these books (spreads
  re-checked Sep 5, all <0.10%).
- **Not modelled and known:** the occupancy cost of longer holds in paired replays (occupancy is
  decided by the control profile so variants stay paired — generous to longer-holding variants);
  `rollover4h` keys on `pairBase` and reads the alt default for any spelling it does not map
  (a separate follow-up PR, not this one).

## 6. Things deliberately frozen or absent, and why

- **Stage-3 auto-graduation is HELD** (`maybeGraduateStage3` writes `status: "held"`). Graduation
  could only raise the base toward paper's, and the base is already 4% > the 3% it would graduate
  to, so it is moot; it stays held until financing and current-campaign profitability are
  reconciled.
- **Take-profit fields** on the card read "no fixed target — 2R trail, add at +1R". Four TP
  variants lost; 5a tests the partial in paper.
- **Fear & Greed** (`api.alternative.me/fng`) and the **ETH/BTC ratio** are research stamps only:
  F&G rides in B4's derivatives snapshot (`fearGreed` on `kraken_margin_derivatives_latest`), ETH/BTC
  is computed by B6's regime section from the public ticker and printed on the brief.
- **BNB** is not in the universe: not US-margin-tradeable on Kraken.
- **No new Vercel cron.** Everything in this PR runs inside `margin-scan` (pending-entry resolver)
  or `margin-synthesis` (review, 4h bars snapshot).

## 7. Cron runbook

| Cron | Schedule (UTC) | Does |
|---|---|---|
| `margin-watch` (guardian) | */5 | Protect every bot book (stops, ratchet, time stop, pyramid trigger), risk state, event policy, anomaly checks, journal phase A. Stamps `margin_watch_protect_ok`. |
| `margin-scan` | 2-57/5 | Derivatives snapshot → **pending-entry resolver (5b)** → 130-call universe scan → resolve open paper rows → `maybeDemote` → fresh signals → paper plans (+ the five twins) → live hand-off for the armed sleeve → tsmom → brief after 13:00. |
| `margin-synthesis` | 00:20 daily | Statistics file, journal phase B, **post-trade reviews (C4: oldest 5 per run, done-set persisted after each; the first run seeds every already-closed trip as done)**, observations, lessons, stage 3, `maybeDemote`, crypto regime file, run stamp + Slack, then LAST the **4h bars snapshot (`margin_bars_4h`, C6: since = newest stored bar, one insert per coin, 30 s budget)**. |
| `margin-weekly` | Mon 13:00 | Weekly memo: leaderboard, `weeklyAction` per sleeve (PROMOTE-READY / REDUCE / KILL CANDIDATE / KEEP). |
| `kraken` | */30 | Spot/ledger sync for the parked book. |

Operator checks after a deploy of this PR: (1) three already-resolved rows' `shadow_pnl` are
unchanged the next day (the C5 invariant — no legacy row's arithmetic moved); (2) the scan tick's
`look[]` shows the new sources on the next high-conviction 4h breakout; (3) `margin_pending_entries`
gains a row on that breakout and resolves within 24h; (4) the first closed live round trip after
the deploy has a `### Post-trade review` block in that day's `Decisions/` file.

## 8. Research results (the C6 run, 2026-09-15 — full tables in `Performance/margin-research.md`)

Recorded after the pre-registration above was committed (commit order: C7 → C4 → C5 → C6 → this
section). Numbers, n, t, CI only; verdict words only where |t| ≥ 2. Wall time 4 s.

**Engine reproduction first.** The Sep 12 bar cache (`bars.json` in a scratchpad) no longer
exists, so the +$125 / t=2.63 line cannot be re-run on the same bytes. Two checks were run
instead: (1) the original `scripts/backtest-variants.ts` (origin/main) and the extracted engine
were both run on a FRESH Kraken cache (26 coins, 720 × 4h/1d, 2026-05-18 → 2026-09-15) — **their
output is byte-identical** (`diff` empty), so the extraction changed nothing; (2) on that fresh
window Q2f reads **+$113/trade vs swing-wide, t=2.45, 95% CI +$23 … +$204, n=89, adds 39/89,
worst −$499 vs −$426** (Sep 12: +$125, t=2.63, n=88, adds 40/88, worst −$499 vs −$403). Same
sign, same size, three days of window shift; the difference is the data, not the code.

**The proxy check.** On the overlapping window, the Binance 1h→4h proxy for the same 10 coins
yields 23 entries vs Kraken's 28, and control / wide / pyr of +$169 / +$200 / +$240 (Kraken:
+$149 / +$250 / +$352). The proxy tracks the sign and rough size; it is not the same tape.

**WF1 — the live rule (swing-pyr) over 2024-01 → 2026-09, 10 coins, 196 non-overlapping entries.**
Whole sample: **+$31/trade, t=0.56, CI −$78 … +$140** — not distinguishable from zero. By year:
2024 +$5 (n=104, t=0.06) · 2025 +$31 (n=50, t=0.31) · 2026 +$98 (n=42, t=0.74). OOS folds:
F1 −$11 (n=24, t=−0.10) · F2 +$70 (n=26, t=0.42) · F3 −$74 (n=19, t=−0.34) · **pooled OOS +$2
(n=69, t=0.02, CI −$181 … +$186)**. Post-folds 2026-07 → Sep 15: +$240 (n=23, t=1.48). Jackknife
by coin: t from 0.09 (without BTC) to 1.00 (without AVAX); AVAX alone is −$211 (n=22, t=−3.39).
**Read:** the edge the 120-day Kraken window shows (+$335, t=2.72) is a 2026 phenomenon on this
proxy; over 2.7 years the rule is flat out of sample. That is the honest state of the live rule
and it is why nothing in this PR changes it — the forward paper record decides.

**Paired on the same 196 entries:** rule − swing-lev −$17 (t=−0.41) · rule − swing-wide −$13
(t=−0.64) · rule − swing-partial −$16 (t=−0.58). None distinguishable; the Sep 12 pyramid
advantage does not appear on the long sample.

**WF2 — walk-forward efficiency.** The IS-best cell was 5/2.5/120/0.75 in every fold (IS
+$88 … +$90, t ≈ 0.8–1.1). OOS: +$99 / +$89 / −$102; efficiency 1.13 / 0.99 / −1.14; paired vs
the live rule OOS +$110 (t=1.12) / +$19 (t=0.17) / −$28 (t=−0.40) — **picking is not
distinguishable from not picking in any fold**, and the third fold reverses.

**S1 — flatness.** 108 cells, **0 cliffs on 297 neighbour edges**; the live cell's eight
neighbours differ by −$7 … +$32 per trade, |t| ≤ 0.86; no cell reaches t ≥ 2 (best 5/2.5/120/0.75
at +$85, t=1.26; worst 5/1.5/168/1 at −$2). The surface is flat — which is the same statement as
WF1: there is little here to be sensitive to.

**MC1 — 10,000 × 100-trade block-bootstrap paths of the rule's R-multiples** (mean 0.098R, sd
2.43R, 107/196 ≤ −0.9R, 20/196 > 3R): P(hit the 15% breaker inside 100 trades) **100% at 3, 5
and 8%**; median maxDD 16 / 17 / 19%; 95th 18 / 20 / 21%; longest losing streak (median) 5 / 3 /
2 before the halt; median final −10 / −16 / −17% (paths stop at the breaker, so P(−50%) = 0 and
P(+50%) = 9–11%). **Read:** on this distribution the breaker is not an edge case, it is the
expected event; the 8% ceiling sweep (which used the paper record's 65%-hit distribution) and
this bootstrap (a 26%-hit replay distribution) disagree because the distributions do, and the
forward paper record is the one that will settle which is closer to the truth.

**What this changes:** nothing in code. It sets the bar the five twins and the live rule must
clear on the forward record, and it is the number the next arming discussion starts from.
