# Edge Hierarchy

*Last updated 2026-05-28. The honest map of what we've tested, what's deployable, what's
speculative, and what isn't worth our time. Updated as evidence changes — an edge moves tiers
only on evidence, never on hope.*

The point of this document: **systematically narrow toward durable, executable, structurally
grounded, realistically-capturable edges** — and refuse to fool ourselves about the rest.

---

## Tier 1 — Validated & Deployable

*Survived institutional falsification (parameter plateau, rolling walk-forward, deflated Sharpe,
cost-stress, tail accounting). Real, but with hard constraints.*

| Edge | Evidence | Constraint |
|------|----------|------------|
| **Relative-value spread book** (crack CL/RB, grain ZC/ZS, FX 6E/6B, metals) | Ann. Sharpe ~1.59 gross → ~1.13 net @0.10R slip; 14/14 rolling 3yr windows positive (2011–2026); 16/16 parameter combos positive (plateau, not spike); deflated Sharpe ~100% vs ~40 trials; +0.59R in 2022 crisis | **Needs ~$100k+ capital.** One full-size spread margins at $1,210–$24,133 risk; at 1% sizing that's $121k–$2.4M min capital. $1K **cannot** trade it. Tail is idiosyncratic per-pair (gap-through-stop: 19.6% of exits worse than −1R) → needs **per-pair structural-break controls, not market-regime stand-down** (regime overlay tested, FAILED to cut the tail). |

**Deployment path:** real capital ($100k+) is the gate. User REJECTED the prop-firm route (2026-05-26),
so the path is: forward track record (`scripts/spread-track.ts`) → raise investor capital → deploy.
NOT the $1K live account. This is the *only* edge cleared for real capital.

**Independent red-team caveats (Claude fresh review, 2026-05-26 — open questions BEFORE funding):**
- **Adverse selection at entry.** z=2 fires exactly when the spread is moving *against* the relationship;
  the measured ~0.03R cost is a *resting-quote* cost, not what we'd actually fill at. Expect 2–4× on the
  entry tick. The forward tracker's SIMULATED fills do NOT capture this.
- **Possibly short-vol, not alpha.** −6.3R worst + 38% gap-through-stop ⇒ the stop is advisory; +0.43R ≈
  many small reversions minus rare regime breaks. 3yr of 1m data under-samples the true left tail; Sharpe
  1.59 with that skew is not a 1.59 risk profile (insurance-selling masquerading as edge).
- **"Economic, not data-mined" is a story, not a full defense.** Real search space (pair × lookback × 3
  z-thresholds × maxHold) is in the hundreds → deflated Sharpe likely overstated; effective independent
  bets ≈ 2–3, not 8 (shared USD/growth/risk factors push correlation → 0.85+ in stress).
- **THE falsifying test:** live SHADOW EXECUTION (60–90 days, real broker fills, marketable limits, realized
  R vs backtest R). If realized < ~0.15R/trade → execution-fragile, do NOT fund. This — not more
  backtesting — is the real next step.

---

## Tier 2 — Plausible but Unvalidated

*Positive in-sample, but not put through the full battery, or known to be flattered by the sample.
Promising, not proven. Do not size real capital yet.*

| Candidate | Status | What's missing |
|-----------|--------|----------------|
| **MBT (Micro Bitcoin) NR4 range expansion** | **Discovered 2026-05-28; slippage-stress-tested 2026-05-29.** 4yr Databento backtest (2022–2026). Two detection variants: 5m-bar-close (PF 2.03, n=136) and daily-only (PF 1.71, n=146). Both positive 4-of-5 years. Daily-bar signal: narrow-range day (range < 0.5× ATR-20) → next-day breakout of prior day H/L. Wide stop (1× prior range), 3× target. **Execution-robust:** PF holds > 1.0 even at 5 ticks slippage + $3 commission. Per-trade exp +$25 net, win 53%. | **Forward shadow execution** (30+ live demo trades) to validate vs backtest fills. **$1K cannot trade MBT** (day margin ~$1.5–2.5k); deployment path is demo → larger account (Topstep eval $50k or organic growth) → live. Most credible directional edge in the system after the spread book — slippage stress confirms execution-robust. |
| **MBT buy-and-hold w/ wide ATR trail** | 4yr backtest, +$5,830 per contract at 10× daily ATR trail, max DD −$5,929. Captures secular BTC trend. | Complementary to NR4 not standalone; sizing must respect 100% drawdown of unrealized in trending pause. Same capital constraint as NR4. |
| **Overnight equity drift** (long ~16:00 ET → exit ~09:30 ET, skip Friday) | Parity Sharpe ~1.84, but **bull-flattered** (3yr sample, mostly up-market). De-rated to ~1.3–1.5 in the combined book. | Test through a real bear leg; decompose how much is just beta/risk-premium harvesting vs a true overnight anomaly; overnight gap-risk accounting. Directional → vulnerable to regime. |
| **Failed-reaction / failed-auction fade** (daily) | NFP/vol-shock studies hint at mild reversion (+0.05 ATR) after outsized moves; small, inconsistent. | Larger sample, precise intraday window (needs 1m + verified event dates), cost-stress. Likely too small to trade alone. |

---

## Tier 3 — Speculative but Testable (data-gated R&D)

*We have NOT tested these — our data wall (daily + 3yr 1m OHLCV, no bid/ask, no DOM, no tick)
makes them untestable today. They are defined hypothesis-first so any future tick/L2 spend is
spent against named, falsifiable claims — not a generic "buy a tick platform" wish.*

**Gate: do not buy tick/L2 data until we commit to testing a specific row below.** Databento
MBP-10/MBO ≈ $1,000s–$10,000s + hundreds-of-GB–TB storage + a real pipeline. Only justified
against a hypothesis where (a) the holding period is minutes (not microseconds), and (b) a
non-colocated participant can plausibly execute.

| # | Hypothesis | Data required | Latency-sensitive? | Can WE (non-colocated) execute? | Holding period | Structural or arbitraged? |
|---|-----------|---------------|--------------------|---------------------------------|----------------|---------------------------|
| H1 | **Opening-auction imbalance persistence** — large auction imbalance predicts first 5–30 min drift | L1/L2 + auction imbalance feed | Low–moderate (minutes) | **Yes** — minutes-scale | 5–30 min | Plausibly structural (forced auction flow); test crowding |
| H2 | **Post-liquidation exhaustion reversal** — after a forced-liquidation flush, mean-reversion | 1m OHLCV (proxy for tick+DOM) | Moderate | **Maybe** — depends on entry precision | minutes | **TESTED 2026-05-29:** ES 49% noise, NQ 47.8% (slight inverse), **MBT 52.6–53.1% ✅ SIGNIFICANT positive** (z 3.0–3.6 across 15/30/60min, n=3340). Small but real on BTC; doesn't appear on equity indexes. |
| H3 | **Liquidity-vacuum continuation** — thin book → moves extend | Full DOM depth over time | Moderate–high | **Marginal** — book evaporates fast | seconds–minutes | NOT TESTABLE on current Databento plan (needs MBP-10). |
| H4 | **Failed-auction continuation** — auction rejects a level, continues away | L2 + value-area/auction data | Low–moderate | **Yes** — minutes-scale | 10–60 min | **TESTED 2026-05-29:** ES — 62 events, 0 met our 0.05% deviation threshold (auctions clear cleanly). Inconclusive on equity indexes; would need looser threshold or different instrument. |
| H5 | **Post-news overreaction → reversion** — initial spike overshoots, partially retraces | Tick + timestamped news | Moderate (first seconds are HFT) | **Yes for the reversion leg** (not the spike) | minutes–hours | **TESTED 2026-05-29:** ES/NQ ~50% noise. **MBT 52.8% at 15min, 52.4% at 30min ✅ SIGNIFICANT** (z 3.4 / 2.9, n=3532). Avg retracement when occurs: 70% of shock move. Small directional edge on BTC, not equity. |

**Priority if we ever fund this:** H1 and H4 first — lowest latency-sensitivity, clearest
structural story, minutes-scale holding (executable without colocation). H3 is mostly a
risk/avoidance signal, not an entry edge.

---

## Tier 4 — Likely Impossible for Our Infrastructure

*The edge may be real but requires capabilities we do not and will not realistically have.*

- **Sub-second order-flow reactions** — microsecond imbalance, queue-position games, fastest-sweep
  detection. Requires colocation + FPGA/kernel-bypass. We are a cloud-hosted Node engine with
  internet-latency order routing. Structurally out of reach.
- **The fast leg of any news reaction** (H5's first seconds) — owned by colocated firms before our
  order acknowledges.
- **True latency arbitrage** between venues — needs cross-venue colocation.

---

## Tier 5 — HFT-Dominated, Not Worth Pursuing

*Even with infrastructure, these are saturated by firms whose entire business is being faster.
Negative expected value for us; do not spend research time here.*

- Tick-level market-making / queue position.
- Microsecond statistical arbitrage.
- Exchange-feed latency races.
- Spoofing/layering detection-and-fade at tick speed (also legally fraught).

---

## Rejected — Tested and Failed Validation

*These were measured and falsified. Recording them prevents re-litigating dead ends. "A simple
mechanical rule on minute bars failed after costs" — NOT "the market is efficient."*

| Rejected | How it failed |
|----------|---------------|
| **Intraday directional micro systems** (VWAP reclaim, liquidation-reversal, high-vol mean-rev) | ES/NQ/GC 1m, net of cost: −0.22R to −0.33R, 0/4 years positive each. Coin-flips after cost. |
| **Trend-continuation, vol-coil breakout, opening-drive** (edge-filter VETO list) | Negative/random in the measured edge map; disabled in the live engine. |
| **Gap continuation/fade** (27 mkts / 15yr) | Small gaps weakly continue (+0.011 ATR), large weakly fade (−0.018) — inconsistent, no clean edge. |
| **NFP directional** | +35% range expansion (expected) but direction is **random** — no directional edge, no pre-drift. |
| **Pre-FOMC drift** (Lucca-Moench 2015) | **Decayed + concentrated.** ES 2016–20 0.160%/event → 2021–26 0.037% (≈baseline); ES edge goes **negative ex-top-5 events**; ~0.6–1.5% annualized. Academically documented ≠ currently tradable. Largely arbitraged post-publication. |
| **Market-regime stand-down overlay** | Detected COVID coincidentally (not early); standing down did NOT cut the worst trade (−6.4R unchanged) and made maxDD worse. Tail is idiosyncratic per-spread, not regime-driven. |
| **$1K micro directional grind** | Forced 5% risk → 51% probability of ruin with no edge; even a "strong edge" is mostly variance. Math says get sized capital, don't grind $1K. |
| **H1 — Opening auction imbalance persistence (CME GLOBEX equity index futures, ES)** | Tested 2026-05-29: 51k statistics records over 90 days; 59 clean opening events (IOP + open price). Drift-match-rate vs imbalance sign: 5min 50.8%, 15min 44.1%, 30min 40.7% — all near random or slightly inverse. Filtering to top-quartile imbalances didn't help (5min 56%, 15min 48%, 30min 44%). **The hypothesis does not hold on CME equity index futures.** May still work on individual stocks via Nasdaq ITCH imbalance feed (separate dataset), but not in our index-futures focus. Saves us from chasing further. Script: `scripts/research-h1-imbalance-analysis.ts`. |
| **Crypto futures intraday setups (existing 5m strategy library on MBT/MET/BFF)** | 2026-05-28 Databento 1yr backtest: MBT PF 0.84, MET PF 0.06, BFF PF 0.27. Combined −$13.7k over 3,692 trades. Then 33k-trade edge scan across crypto-tuned ATRs, crypto-native sessions, RSI sub-bands, dir-isolated, vol-regime → ZERO subsets cleared n≥50 / PF≥1.30 IN / PF≥1.20 OOS. Our equity-index intraday framework does not transfer. |
| **Crypto weekend gap fade (H1, 2026-05-28)** | 4yr scan: MBT n=131 PF 0.56, MET n=153 PF 0.27, BFF n=52 PF 0.37. Lost in 4/5 years on MBT, 5/5 on MET. The "spot-trades-through-weekend → futures-open-mean-reverts" thesis does not pay. |
| **Crypto long-only daily momentum (H2, 2026-05-28)** | MBT PF 0.93 overall: +PF 1.61/1.59 in 2023/2024 bull, then PF 0.26/0.25 in 2025/2026 chop. Curve-fit to bull regime; no robust edge. |
| **Crypto Asian-session fade (H3, 2026-05-28)** | MBT n=489 PF 0.91, MET n=617 PF 0.15, BFF n=194 PF 0.50. Fade-overnight-Asian-move at US open: consistently loses across instruments and years. |
| **BFF Friday gamma scalp (H5, 2026-05-28)** | Long Fri morning n=79 PF 0.44; short Fri afternoon n=55 PF 0.38. Weekly-expiry gamma idea did not show edge. |
| **NR4 on MET / BFF (H6, 2026-05-28)** | Same NR4 logic that works on MBT (PF 2.03) → MET PF 0.18, BFF PF 0.69. Edge is BTC-specific, not crypto-wide. Confirms NR4 is not curve-fit (it works where theory predicts, fails where it doesn't). |
| **MSL (micro SOL) + XRP futures — daily pattern battery (2026-05-29)** | Goal: find 24/7 tradeable edge on $1K live with small-margin crypto micros. Tested NR4, 3-day momentum, 3-day mean reversion on 371 MSL bars (since 2025-03 launch) and 317 XRP bars (since 2025-05 launch). **EVERY pattern loses on BOTH symbols.** MSL: NR4 PF 0.44 (n=96, WR 24%), Momentum PF 0.45 (n=188), MeanRev PF 0.51 (n=82). XRP: NR4 PF 0.67 (n=93), Momentum PF 0.57, MeanRev PF 0.54. No yearly subset positive. Same pattern as MET/BFF: simple daily structure doesn't transfer to non-BTC crypto. **Decision: do NOT add to live whitelist.** Script: `scripts/backtest-msl-xrp.ts`. Note: micro XRP (MXR) symbol is not on Databento — only the full-size XRP futures (50,000 XRP/contract, way too big for $1K). |
| **$1K 24/7 crypto trading path (2026-05-29)** | Conclusion across MBT/MET/BFF/MSL/XRP: only MBT has a validated daily edge (NR4), and its day margin (~$2k) won't fit $1K. Every smaller-margin micro tested (MET, BFF, MSL) has zero edge across multiple pattern families. **The $1K live account has NO 24/7 tradeable edge as of today.** Realistic paths: (1) grow account via RTH equity index trading until MBT NR4 margin fits, (2) prop firm $25-50K eval that lets MBT NR4 run live, (3) wait for new CME micro launches with better characteristics. |

---

## Shipped to live engine (2026-05-29 evening)

| Strategy | Status | Notes |
|---|---|---|
| **MBT NR4 (daily)** | **Live in demo engine** via strategy-runner adapter | Engine fetches MBT daily bars from Databento once/day, runs detect(), routes signals through evaluateAndTrade with setupType=`mbt-nr4-daily`. Demo-only — $1K live can't fit MBT day margin (~$2k). |
| **VWAP reclaim (5m)** | **Live on both engines** as setup #4.5 | Detects 5-of-6 bars on one side of VWAP, then close-back-through. Setup type `vwap_reclaim`. Joins the 5m library; pattern memory will rate it like any other setup. |
| **Overnight equity drift** | **Deferred** | Code exists at `/lib/strategies/overnight-strategy.ts`. Wiring requires adding `isOvernight` flag to Position + gating 4 management code paths (trail stop, breakeven, stale-trade, pyramiding) so the time-based hold-through-globex thesis isn't broken. Needs its own session. |
| **Spread book** | **Deferred** | Validated pairs (CL/RB, ZC/ZS, 6E/6B) need symbols/data we don't subscribe to via Databento sidecar. ES/NQ is not in the validated pair set. |
| **GC-tuned RSI bounce** | **Not needed** | Pattern memory keys on instrument; GC-specific WR will naturally cluster from the generic `extreme_rsi_bounce` setupType. |
| **Volume profile POC reversion** | **Deferred — needs build+backtest** | Databento data is captured (used in UI) but not yet used as entry signal. Unvalidated. |
| **Order flow / cumulative delta** | **Deferred — needs build+backtest** | Databento trades schema captured but not aggregated by direction for entry signals. Unvalidated. |
| **Asia/London session opens** | **Deferred — needs build+backtest** | Engine only handles US RTH OR. Non-US session detection + open-range tracking would be a separate setup. Unvalidated. |

## The bottom line

- **One validated edge:** the spread book — and it needs real capital ($100k+ / prop-firm), not $1K.
- **Three plausible-unvalidated:** overnight equity drift, failed-reaction fade, and **MBT NR4 range expansion** (new, 4-yr backtest, PF 2.03; **now wired into demo engine 2026-05-29**). All need forward shadow execution before real capital.
- **A defined speculative frontier:** five microstructure hypotheses, gated behind a deliberate
  tick/L2 data decision, prioritized by executability (H1/H4 first).
- **A large, honestly-labeled rejected pile** — including the academically-famous pre-FOMC drift
  and the full crypto-intraday strategy battery (7 pre-registered hypotheses on 4 years of
  Databento data — only NR4-on-MBT survived).

The $1K live account has **no validated edge it can trade.** The institutional spread engine and
MBT NR4 both need bigger capital (spread book: $100k+; MBT NR4: $5–10k+ to fit margin safely).
The realistic capital path is a prop-firm eval (Topstep/Apex), not grinding micros.
