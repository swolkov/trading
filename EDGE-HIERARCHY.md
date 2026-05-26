# Edge Hierarchy

*Last updated 2026-05-25. The honest map of what we've tested, what's deployable, what's
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

**Deployment path:** funded/prop-firm account ($50–150k for a ~$150–300 eval fee, capped downside),
NOT the $1K live account. This is the *only* edge cleared for real capital.

---

## Tier 2 — Plausible but Unvalidated

*Positive in-sample, but not put through the full battery, or known to be flattered by the sample.
Promising, not proven. Do not size real capital yet.*

| Candidate | Status | What's missing |
|-----------|--------|----------------|
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
| H2 | **Post-liquidation exhaustion reversal** — after a forced-liquidation flush, mean-reversion | Tick + DOM (to identify absorption/exhaustion) | Moderate | **Maybe** — depends on entry precision | minutes | Structural (forced sellers exhaust) IF identifiable; risky to fade |
| H3 | **Liquidity-vacuum continuation** — thin book → moves extend | Full DOM depth over time | Moderate–high | **Marginal** — book evaporates fast | seconds–minutes | Partly arbitraged; edge in *sizing/avoidance*, not entry |
| H4 | **Failed-auction continuation** — auction rejects a level, continues away | L2 + value-area/auction data | Low–moderate | **Yes** — minutes-scale | 10–60 min | Plausibly structural (auction theory); testable on 1m+context |
| H5 | **Post-news overreaction → reversion** — initial spike overshoots, partially retraces | Tick + timestamped news | Moderate (first seconds are HFT) | **Yes for the reversion leg** (not the spike) | minutes–hours | Structural behavioral overreaction; the *fast* leg is HFT-owned, the *slow* reversion may not be |

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

---

## The bottom line

- **One validated edge:** the spread book — and it needs real capital ($100k+ / prop-firm), not $1K.
- **Two plausible-unvalidated:** overnight drift, failed-reaction fade — finish the battery before trusting.
- **A defined speculative frontier:** five microstructure hypotheses, gated behind a deliberate
  tick/L2 data decision, prioritized by executability (H1/H4 first).
- **A large, honestly-labeled rejected pile** — including the academically-famous pre-FOMC drift,
  which did not survive skeptical modern validation.

The $1K live account has **no validated edge it can trade.** The institutional spread engine is the
real program; the realistic capital path is a prop-firm eval, not grinding micros.
