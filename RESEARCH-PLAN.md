# Edge-Discovery Research Plan — High-Frequency, Positive-Expectancy Futures Edge

> Mission: discover (or falsify the existence of) a strategy archetype with **≥+0.3R expectancy,
> ~1–3 quality opportunities/day, robust across regimes, realistic after costs, automatable on
> Tradovate.** Run like a prop quant lab: hypothesis-driven, fail-fast, compute concentrated on
> survivors, brutally honest about the base rate (most hypotheses die).

## Honest prior (a real lab states this up front)
**+0.3R at 1–3 trades/day, robust over 15 years, is a HIGH bar — roughly Sharpe 2–3 intraday.**
Few desks have it without latency/order-flow infrastructure. The *likely* outcome of a 30-day
sprint is a **modest edge (+0.1–0.2R) on 1–2 archetypes**, or none for pure high-frequency intraday
(efficient-market reality). That's still valuable (improves the book) but may not hit the 5x/30-day
dream. The search is correct *because* we falsify cheaply and bank whatever survives.

## Data & constraints (what we can/can't actually test)
- **Have:** 15yr daily (27 markets), 3yr 1-minute (ES/NQ/GC), Databento (more on demand), the
  engine, Monte-Carlo infra (`scripts/smallaccount-mc.ts`).
- **Don't have (flag honestly):** true tick/L2/order-flow (1-minute is our finest) → *liquidity-sweep
  and fine lead-lag edges are only testable in coarse form*; options/GEX data needs sourcing;
  Tradovate has no market data (Databento for live).
- Implication: prioritize edges testable at 1-minute / daily resolution; tag order-flow ideas as
  "needs data" rather than fake-testing them.

## 1. Hypotheses, ranked (edge-prior × frequency × testability × non-crowding)
**Tier 1 — test first (structural reason + frequent + testable now):**
1. **Volatility compression → expansion** (volatility *clustering* is the most robust empirical fact in markets — ARCH/GARCH). Conditional breakout after low-vol coil. Frequent, regime-anchored.
2. **Opening-drive / opening-range continuation**, *conditioned* on overnight range + gap + prior-day close location. The cash open concentrates forced flow + information. Daily.
3. **Scheduled-event reaction** (pre-FOMC drift [Lucca-Moench], post-CPI/NFP/EIA drift + vol-crush). Structural (hedging/rebalancing flow). Lower frequency, high conviction.

**Tier 2 — test if Tier 1 thin:**
4. **Overnight inventory imbalance** (refine the overnight drift we already found — condition on prior-day strength, gap, vol regime).
5. **Cross-market lead/lag** (ES→laggard index futures; oil→energy; bonds→ES) — real but decays; coarse at 1-min.
6. **Regime-dependent breakout** (breakouts work in trend regime, fail in chop — the *conditioning*, not the breakout, is the edge).

**Tier 3 — needs data we lack (tag, don't fake-test):**
7. **Liquidity-sweep reversals** (stop-runs at clustered levels) — needs L2/order-flow.
8. **Dealer gamma / GEX** (long-gamma = mean-revert, short-gamma = trend) — needs options data. *Highest-value if sourced.*

**Why this order:** lead with structural + frequent + cheap-to-test + least-crowded-by-HFT. Vol-clustering and opening structure are the sweet spot; lead-lag/sweeps are higher-decay and need finer data.

## 2. Markets most likely to hold intraday inefficiency
Inefficiency ∝ retail participation + structural flows − institutional saturation.
- **CL/MCL (crude):** inventory/news-driven, strong intraday trends + vol-expansion, less efficient than ES. **Top intraday candidate.**
- **NQ/MNQ:** high range, momentum persistence, retail-heavy.
- **RTY:** less efficient, trendy. **MBT (crypto):** most inefficient, worst microstructure/tail.
- **ES:** most efficient intraday (hard for directional edge) — but the home of the gamma effect.

## 3. Features that matter most
Realized vol (multi-lookback) + vol-of-vol (regime); opening range; overnight range/gap; prior-day close location; volume profile (POC/value area); time-of-day/session; event proximity + surprise (actual vs consensus); cross-market lagged returns (lead-lag); VIX term structure. Order-flow (cum-delta, imbalance, absorption) *if sourced* — closest proxy for "who's forced."

## 4. Features that are probably noise
Standalone classic indicators (RSI/MACD/stochastic/Bollinger — price-derived, crowded); candlestick/round-number patterns; any high-parameter construct fit to one sample; ML-mined high-order interactions without economic rationale; sub-second features (we can't act — latency).

## 5. AI/ML without curve-fitting
- **Use ML for low-DOF, well-posed tasks:** regime classification (few classes), trade filtering/ranking (binary conviction), volatility prediction (continuous). Push +0.1R → +0.3R by *selectivity*, not by predicting price.
- **Discipline:** economic rationale FIRST; parsimonious features + heavy regularization; **purged + embargoed cross-validation** (López de Prado — kill leakage from overlapping samples); gradient-boosted trees over deep nets on limited data; **Deflated Sharpe** (correct for # of trials); must generalize across markets + regimes.
- **Never:** RL for live sizing, deep nets on small data, touching the test set, per-instrument param fitting. Also use AI for hypothesis generation, code acceleration, literature digestion.

## 6. Walk-forward validation
Rolling walk-forward (train 2–3yr → validate 6mo → step) across 15yr; **purged + embargoed**;
**combinatorial purged CV (CPCV)** for an *outcome distribution* not a single number; a **final locked
OOS** (last 1–2yr) untouched until the end. Report per-fold + per-regime — consistency = real.

## 7. Detecting FALSE edges fast (the fail-fast battery)
Economic-rationale gate (no "forced loser" → deprioritize) · IS-vs-OOS gap (large = overfit) ·
**parameter-neighborhood** (real edge = smooth plateau under ±20% param change, not a spike) ·
sub-period/regime stability · **Deflated Sharpe** · **randomization test** (random entries do as well? → no edge) ·
**2× cost stress** (dies? → slippage mirage) · trade-count ≥100. These kill ~90% of ideas cheaply.

## 8. Durability
Structural rationale (the #1 indicator) · survives multiple regimes + multiple markets (generalizes) ·
survives OOS + walk-forward + cost-stress + param-neighborhood · capacity-aware · live-vs-backtest
decay monitor post-deploy. Trend/carry persist decades (structural); microstructure lead-lag decays fast (crowded).

## 9. Metrics that matter more than Sharpe
**Expectancy/trade (R)** · **profit factor + win/loss tail shape** (carried by few outliers = fragile) ·
**Sortino, MaxDD, Calmar/MAR** (drawdown survival is everything for a small account) ·
**risk-of-ruin / P(target) via Monte Carlo** (THE small-account metric) · **stability across folds** ·
**Deflated Sharpe** · **skew/tail ratio** (positive skew compounds + survives). Sharpe alone hides tail + capacity.

## 10. What the best small-account compounding systems share (honestly)
Positive **skew/asymmetry** (small losses, occasional big wins — let winners run); **high RR (≥2:1)** with
moderate win rate (RR drives target-probability — proven in our MC); **selectivity** (few high-conviction
trades, not constant); a **structural edge** (event/flow), not indicators; **relentless risk + ruin control**
(survivors didn't blow up); **regime adaptivity**; **automation** (removes tilt). Caveat: most "small→big"
stories are survivorship — the blown accounts don't post.

---

## The 30-day research sprint (day-by-day)

### Week 1 — Foundation + fail-fast screening (kill 80% cheaply, no fitting yet)
- **Day 1:** Data-integrity audit (point-in-time, no survivorship/lookahead). Build the research harness: fast vectorized **event-study** engine + backtester with costs baked in. **Regime tagging** (realized-vol buckets, trend/chop, VIX term).
- **Day 2:** Write the hypothesis backlog — each with explicit *economic rationale*, *falsifiable prediction*, *expected frequency*. Rank by (edge-prior × frequency × testability).
- **Day 3–4:** **Event studies** on every Tier-1/2 hypothesis — measure the *conditional mean response* (e.g., return after vol-compression, after opening drive, around events, after coarse sweeps) with confidence intervals, **by regime and by year**. No parameters. This is the fail-fast filter.
- **Day 5:** Triage. Keep the 2–4 with a real, year-consistent conditional signal; kill the rest with documentation.

### Week 2 — Deep-dive survivors + feature engineering
- **Day 6–7:** Turn survivors into actual entry/exit/stop rules; measure **per-trade R, frequency, win/RR**, by regime + year. **2× cost-stress** + **parameter-neighborhood** robustness.
- **Day 8–9:** Feature engineering — vol regime, gap, overnight, cross-market lead-lag, event proximity, (order-flow if sourced). Test which features *sharpen* R without overfitting (parsimony).
- **Day 10:** Re-rank by validated R × frequency × robustness. Pick top 1–2.

### Week 3 — ML filtering + rigorous validation
- **Day 11–12:** Add a regularized **ML conviction-filter** (GBM, few features) — purged+embargoed CV. Keep only if it raises R *out-of-sample*.
- **Day 13–14:** **Walk-forward** (rolling, purged) across 15yr + locked OOS; **CPCV** for the outcome distribution; per-fold/per-regime consistency.
- **Day 15:** Full robustness battery (randomization, cost-sensitivity, param-neighborhood, sub-period, Deflated Sharpe). Kill on any failure.

### Week 4 — Probability + forward-test + decision
- **Day 16–17:** **Monte Carlo** → P(5x/30d), P(ruin), drawdown distribution, across risk levels. The honest probability.
- **Day 18–21:** **Paper-forward** on the live feed (engine on demo) — fires as expected? fills match backtest? live-vs-backtest telemetry.
- **Day 22–25:** Build the execution module (bold-play sizing: ~8% vol-adjusted, ratchet, ruin-floor) + risk overlay + kill switches.
- **Day 26–29:** Continued paper-forward + telemetry; confirm the edge holds in real time.
- **Day 30:** **GO/NO-GO.** Deploy small live *only if*: +R OOS validated, Monte-Carlo P(target) acceptable, paper-forward confirms. Else: document, iterate, or honestly conclude no high-frequency edge — and bank any modest edge found for the broader book.

## Prioritization logic (throughout)
Fail-fast (cheap event studies before expensive fitting) → economic-rationale gate → concentrate compute on survivors → demand OOS + multi-regime + cost-robustness → Monte Carlo before a dollar of risk. **Most hypotheses die in Week 1; that's the point.**
