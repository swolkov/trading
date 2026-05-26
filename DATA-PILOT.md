# Data Decision — CME / Databento order-book pilot

*Last updated 2026-05-25. A serious, non-blind decision on whether to buy tick/L2 order-book data.
Verdict up front, reasoning below.*

> **Verdict: SMALL PILOT — sequenced and re-prioritized. Not a giant build, not "buy because more
> data sounds better," not nothing.**
> - **Buy NOW (cheap):** execution-realism slice — **Trades + MBP-1** for the **spread legs** (the real
>   edge) [+ MES/MNQ for Phase 0 fills]. Directly de-risks the one validated edge. Likely free-tier–$50.
> - **Buy LATER (small pilot, after the spread engine is paper-forward):** **MBP-10** for **ES/NQ** to
>   test the two most-executable order-flow hypotheses (H1, H4). Bounded R&D. ~$100–400.
> - **Do NOT buy:** MBO (HFT granularity, huge/expensive), the live/real-time feed (CME licensing fees,
>   unneeded for research), or a multi-instrument full-depth historical build.

**Does the pilot help the mission more than focusing on the spread engine right now? — No.** The spread
engine is the priority. BUT the *execution-realism slice* is cheap and serves the spread engine
**directly** (roadmap item 2: "realistic execution modeling," "slippage tracking"), so do that small
piece now. The order-flow *edge* pilot is genuine R&D — worth it, but **after** the spread engine is
paper-forward, not instead of it.

**The instrument nuance that matters:** the validated edge is **spreads** (CL/RB, ZC/ZS, 6E/6B), not
ES/NQ. So execution-realism data for *our edge* means the **spread legs**, not equity index. ES/NQ are
the right instruments for the *speculative order-flow* track only. Don't conflate the two.

---

## A. Would order-book data materially improve our ability to find/validate edge?
- **Validate the existing edge:** YES, modestly and reliably — replace *assumed* slippage with *measured*
  slippage and build a realistic fill simulator for the spread book. This is the most certain value.
- **Find new edge:** MAYBE — it unlocks a class of hypotheses OHLCV can't touch, but "able to test" ≠
  "will find." Expect most to be rejected (our track record) or HFT-dominated. The honest payoff is
  execution realism first, new alpha second and uncertain.

## B. Which hypotheses would it unlock?
Execution/slippage realism + real fill simulation (highest, most certain value), plus the five Tier-3
hypotheses: H1 opening-auction imbalance persistence · H2 post-liquidation exhaustion · H3 liquidity-
vacuum continuation · H4 failed-auction continuation · H5 post-news overreaction/reversion.

## C. Realistic for us WITHOUT colocation/HFT?
- **Yes:** execution/slippage realism; H1 (minutes); H4 (10–60 min); H5 *reversion* leg (min–hrs).
- **Maybe:** H2 (entry precision matters).

## D. Likely HFT-dominated — not worth it?
- H3 liquidity-vacuum (seconds; book evaporates) → useful only as a *risk/avoidance* signal, not entry.
- The *fast* leg of H5 (first seconds of news). Anything sub-second / queue-position / tick-footprint.
- **This is why we do NOT need MBO.**

## E. Exact dataset first?
1. **Now:** **Trades + MBP-1 (top-of-book)** — cheapest, answers execution realism.
2. **Pilot:** **MBP-10** (10 levels) — enough for imbalance, depth, auction structure.
3. **Skip:** **MBO** — order-level granularity is HFT territory and 10–100× the size/cost.

## F. Which instruments first?
- **For the edge (now):** the **spread legs** — start CL/RB (crack) and ZC/ZS (grains).
- **For the order-flow pilot (later):** **ES and NQ** (full-size — that's where the order flow lives),
  plus **MES/MNQ** for micro execution realism.

## G. How much history is enough for the first hypothesis?
- **Execution realism:** a few hundred representative fills across calm + volatile periods → ~3–6 months.
- **Order-flow pilot:** enough *events*. Daily auctions over 3–6 months ≈ 60–125 sessions (a first
  read, not a deflated-Sharpe verdict). Event-conditioned (post-news) needs more → 6 months ≈ 20–40 events.
- Pilot window: **3–6 months**, weighted to high-vol + macro days. Full validation needs more, later.

## H. Storage / compute?
- Trades + MBP-1, 2 instruments, a few months: a few GB → laptop / Postgres / parquet.
- MBP-10, ES+NQ, 3–6 months: tens of GB → single workstation with DuckDB/Polars/parquet.
- MBO would be hundreds of GB–TB (another reason to skip it). **No cluster, no big infra build at pilot scale.**

## I. Estimated cost?
- Databento historical is usage/volume-based and **previews cost before you buy** (new-user credit has
  been ~$125). Rough: Trades+MBP-1 slice ≈ free-tier–$50; MBP-10 ES+NQ 3–6 mo ≈ $100–400; MBO ≈ $1,000s
  (skip). Live feed adds **CME real-time licensing/professional fees** — avoid for research.
- **Verify exact numbers on Databento's cost estimator.** The point: the pilot is **cheap** (low
  hundreds at most). Cost is not the barrier — focus and sequencing are.

## J. First 30-day plan if we buy
- **Wk1:** pull Trades+MBP-1 for the spread legs; build a fill/slippage simulator; compare *modeled vs
  actual* slippage on the spread book's historical signals → PASS/WARN/FAIL on our cost assumptions.
- **Wk2:** (order-flow track) pull MBP-10 ES/NQ for the window; build the book-feature pipeline
  (imbalance, depth, auction imbalance).
- **Wk3:** test H1 (opening-auction imbalance) + H4 (failed-auction continuation) — most executable.
  Honest reject/greenlight, net of cost.
- **Wk4:** write-up + decision: did execution realism confirm or break the spread cost assumptions? Did
  H1/H4 show anything survivable? → expand, park, or kill. Same falsification discipline as everything else.

## K. Minimum purchase that answers the most valuable question?
The most valuable question is **"are our slippage/execution assumptions real?"** — it validates or breaks
the one edge we have. Minimum to answer it: **Trades + MBP-1 for the spread legs, a few months across
calm + volatile periods.** Cheapest tier, smallest data, possibly free-tier-covered. **Start here.**

---

## Decision framework summary
| Option | Verdict |
|--------|---------|
| Buy now | ✅ **only** the cheap execution-realism slice (Trades+MBP-1, spread legs) |
| Small pilot | ✅ MBP-10 ES/NQ for H1/H4 — **after** the spread engine is paper-forward |
| Buy later | the rest of the order-flow program, gated on pilot results |
| Do not buy | MBO, live/real-time feed, giant full-depth historical build |

The path to millions is: prove the edge forward → deploy on funded/prop capital → scale carefully →
track record → larger capital. Order-book data supports *step 1's execution realism* now, and a
*bounded research bet* later. It is not a shortcut and not the priority.
