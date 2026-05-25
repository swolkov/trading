# Systematic Futures Framework — Institutional Design & Honest Assessment

> Written 2026-05-25. Brutally honest, quantitative. Anchored in this repo's actual 15-year
> backtests (`scripts/backtest.ts`, `trend-test.ts`, `pairs-test.ts`, `session-test.ts`,
> `calendar-test.ts`, `combined-test.ts`) — not generic theory.

## 0. Ground truth from our own research (read this first)
What 15 years of CME daily + 3 years of 1-minute data across ~30 markets actually said:
- **Intraday mean-reversion (RSI/ORB on 5m): no edge.** PF ~0.97 over 12k trades. ES/NQ lose every year; only gold barely positive.
- **Trend-following (Donchian, 27 markets): real but modest + lumpy.** PF 1.15, ~5%/yr, Sharpe ~0.3, only 7/16 years positive, −70% theoretical drawdown if over-sized.
- **Relative-value spreads (crack, grains, FX cross): the best edge found.** ~12%/yr, **Sharpe ~0.94, −20% maxDD, HELD out-of-sample 2020-2026.** Economically grounded.
- **Session/overnight drift: real, directional.** Overnight (16:00→03:00 ET) positive every year; gold +53% overnight vs +3% in the US day. Bull-market/long-only dependent.
- **Calendar: modest tilts.** Gold turn-of-month captures 57% of return; equity Monday/September effects.
- **Combining spread+trend:** correlation 0.04 (uncorrelated) but combining a strong edge (Sharpe 0.94) with a weak one (0.26) *dragged* it to 0.53. **Stacking only helps with similar-quality components.**

**The honest baseline: a serious version of this operation targets a Sharpe ~1.0–1.5 multi-strategy book returning ~12–25%/yr — not "thousands a day."** Income = edge × capital. $1K is unviable; ~$25–50K is the floor to trade a futures book properly; ~$2–3M makes "tens of thousands/month."

---

## 1. Which markets offer exploitable inefficiency (and why)
Efficiency ∝ liquidity. The deepest markets give the *least* directional edge but the *most* structure.
| Market | Character | Best for | Edge availability |
|---|---|---|---|
| **ES** | Deepest, most efficient. Huge SPX options complex → dealer gamma drives intraday regime. | Overnight drift, gamma/OPEX effects, execution. | Low directional, high microstructure/gamma |
| **NQ** | Higher vol, more intraday trend persistence (tech momentum). | Trend, vol breakout. | Moderate |
| **RTY** | Less efficient, retail-heavy, trendier, lower liquidity. | Trend, regime. | Higher (but lower capacity) |
| **CL** | Inventory/news-driven (EIA), strong intraday trends, vol expansion. | Breakout, trend, crack spreads. | Good |
| **GC** | Real-yield/macro driven; mean-reverts intraday, strong overnight (London/Asia). | Overnight, reversion, turn-of-month. | Good (our standout) |
| **ZN/ZB** | Macro/Fed-driven, low vol. | Carry, curve spreads, auction/FOMC calendar. | Moderate, structural |
| **Ags (ZC/ZS/ZW)** | Weather/seasonal, hedger-driven. | Crush/spread, seasonality. | Good (our spreads worked) |
| **BTC futures** | Young, inefficient, retail-heavy, high vol, funding/basis. | Funding carry, basis, momentum. | Highest inefficiency, worst execution/tail risk |
**Rule:** the inefficiency you can capture is bounded by liquidity (capacity) and by whether a *forced* participant (hedger, dealer, index/ETF rebalancer) is on the other side.

## 2. Edges that actually survive (ranked by durability + structural reason)
An edge survives only if there's a **structural reason someone keeps trading against it.** Ask "who's the forced loser?"
1. **Carry / roll yield** — hedgers pay it; the largest, most durable CTA factor.
2. **Time-series momentum / trend** (Moskowitz-Ooi-Pedersen 2012) — slow-to-react flows; durable, modest Sharpe, diversify across markets.
3. **Cointegrated spreads / stat-arb** — economic linkage forces reversion (crack, crush, curve). **Our best (Sharpe ~0.9).**
4. **Volatility risk premium** (short vol) — hedgers overpay for protection; durable but fat left tail.
5. **Dealer gamma / options positioning** — dealers must hedge; drives index mean-reversion (long gamma) vs trend (short gamma). Real, needs options data.
6. **Pre-FOMC / macro-event drift** (Lucca-Moench 2015) — documented, cheap to access.
7. **Overnight inventory / session drift** — real, directional, regime-dependent (we confirmed).
8. **Seasonality / turn-of-month** — flow-driven (index rebal, pension), modest.
Everything without a forced-loser story is noise that dies out-of-sample.

## 3. What degrades fastest (and why)
- **Indicator overfitting** — more parameters = better in-sample, dead OOS. (We saw the 2026 "regime ghosts.")
- **Latency-sensitive scalping** — you lose to colocation; retail is the slow money. High win-rate scalps hide tail risk.
- **Crowded retail concepts** (RSI/MACD/ORB as taught) — arbitraged away (our intraday PF 0.97).
- **Single-regime edges** — work in one regime, die in the next.
- **Data leakage / lookahead** — the #1 reason a backtest lies. Use point-in-time data, lag every signal.
- **Slippage blindness** — high-turnover strategies that are great gross and negative net.
- **Survivorship bias** — backtesting only surviving contracts/symbols.

## 4. System archetypes (honest viability for us)
| Archetype | Verdict |
|---|---|
| High win-rate scalping | **Avoid.** Latency-bound; win rate is a dial you can fake; hidden tail risk. |
| Asymmetric trend-following | **Viable**, modest Sharpe; only works diversified across many markets (CTA style). |
| Volatility breakout | Marginal alone (crowded); good *conditioned on* a vol-compression regime. |
| Intraday mean-reversion | **Weak** on liquid index without order-flow/gamma context (our result). |
| **Market-neutral spread** | **Our best.** Economically-grounded cointegration, Sharpe ~0.9, OOS-validated. The institutional sweet spot for us. |
| AI-assisted adaptive | **Justified for meta-decisions** (regime detection, strategy weighting, sizing) — **not** raw next-bar price prediction (overfits). |

## 5. Professional backtesting framework (the part that separates real from lucky)
- **Walk-forward** (rolling re-fit) + a **locked OOS holdout** never touched until the end.
- **Monte Carlo** — resample the trade sequence → distribution of CAGR/maxDD → **risk-of-ruin**.
- **Realistic fills** — model spread cost + slippage as f(order size / ADV); for spreads, model legging slippage; event-driven engine (no vectorized lookahead) for the execution sim.
- **Liquidity/impact** — cap size at a % of bar volume; penalize impact.
- **Regime segmentation** — report per VIX bucket, per trend/chop regime. An edge that only works in one regime isn't an edge.
- **TCA** — net of all commissions + slippage + financing. Gross results are marketing.
- **Multiple-testing correction** — Deflated Sharpe Ratio (Bailey & López de Prado): adjust for how many strategies you tried. Demand an *economic rationale* before believing any result.
- **Sizing** — vol-targeting (scale to constant risk per market) + fractional Kelly (¼–½). 
- **Risk-of-ruin** — size so P(drawdown > X%) is acceptable; this is the binding constraint, not return.

## 6. How institutions think differently than retail
- **Portfolio first, not trades.** They optimize the covariance matrix, not single setups.
- **Sharpe/Sortino, not win rate.** Win rate is irrelevant; risk-adjusted return after costs is everything.
- **Drawdown control is the binding constraint** — investors redeem on drawdown, so maxDD caps leverage.
- **Probabilistic** — every position is an expectation; they're comfortable being wrong 45% of the time.
- **Edge-decay monitoring** — track *live* Sharpe vs backtest; auto-deleverage/kill when it degrades.
- **Capacity awareness** — every edge has an AUM ceiling; they size to it.
- **Infrastructure as moat** — data, execution, risk systems. Retail competes on "ideas"; institutions compete on process.

## 7. Highest-leverage data/signals (ranked by value-per-effort for us)
1. **Options positioning / dealer gamma (GEX)** — high value for ES/NQ regime (long-gamma = mean-revert, short-gamma = trend/squeeze). Needs options data.
2. **Intermarket / spread relationships** — already our best edge; cheap (just price data).
3. **Vol regime (VIX term structure)** — regime filter + VRP edge; cheap.
4. **Economic calendar** (pre-FOMC drift, event vol) — cheap, documented.
5. **COT / positioning extremes** — slow reversion signal; free (CFTC).
6. **Seasonality / funding rates** (BTC funding = real carry) — cheap.
7. **Order flow / DOM / L2 / footprint** — real edge but **latency-sensitive + expensive + institutional-moat**; low value unless we invest in colocation-grade infra. Don't start here.

## 8. Software stack
- **Execution:** Tradovate API (REST + WebSocket). ⚠️ **No bundled market data** — needs CME sub-vendor licensing or external feed.
- **Data:** Databento (GLBX.MDP3) historical + live for futures; separate source for options/GEX; store as **Parquet + DuckDB** (research) / **TimescaleDB or ClickHouse** (live tick).
- **Research:** Python — polars/pandas, numpy, statsmodels, scikit-learn; vectorized backtester for research + **event-driven** engine for execution realism. (PyTorch only if ML is justified per §4.)
- **Live engine:** strategy runner (our Railway service is the seed) + a **separate risk-overlay process** that can veto/flatten.
- **Streaming:** WebSocket ingest → Redis/Kafka → strategy engine.
- **Monitoring:** Prometheus + Grafana; live-vs-backtest Sharpe tracking; per-strategy P&L attribution.
- **Risk controls:** pre-trade checks (size/heat limits), daily-loss + drawdown **kill switches**, fat-finger guards, position reconciliation, fail-open/closed policies.
- **Ops:** Docker; cloud near CME (Aurora, IL) only if latency matters (it doesn't for our edges); structured journaling + Slack/email alerting + full audit trail.

## 9. Realistic expectations (no fluff)
- **Achievable Sharpe:** 0.8–1.5 = good; 1.5–2.5 = excellent (rare); >2.5 = elite/HFT/capacity-limited. Our spread edge is ~0.9.
- **Returns:** a Sharpe-1 book vol-targeted to 15% vol ≈ **~15%/yr with ~−25% maxDD.** Even great systems see −20–40% drawdowns — you *must* survive them.
- **Capital:** ~$25–50K floor to trade a futures book properly (margin + sizing); $250K–1M for a living; **$2–3M for "tens of thousands/month."** $1K cannot trade futures at professional risk (one micro ≈ 6% of $1K).
- **Scalability:** spreads/reversion capacity-limited (~$M–$50M); trend scales to billions.
- **Why most fail:** no real edge (trading noise), over-leverage (ruin before the edge compounds), overfitting, no risk management, psychology (abandoning the system mid-drawdown), under-capitalization.
- **Durable vs lucky:** durable = economic rationale + survives OOS + multiple regimes + positive net of realistic costs + uncorrelated + capacity-aware. Lucky = great in-sample, one regime, no rationale (the ghosts we found and rejected).

## 10. If I built this firm from scratch with modern AI
1. **Research** — hypothesis-driven from a *structural inefficiency* ("who's the forced loser?"), never data-mining. Use AI to generate + critique hypotheses, accelerate code, digest literature.
2. **Discovery** — clean point-in-time data + fast backtester → test economically-motivated edges → require OOS + multi-regime survival + Deflated Sharpe.
3. **Validation** — walk-forward + locked OOS + Monte Carlo risk-of-ruin → **paper-forward-test in real time before any capital.**
4. **Deployment** — small size first; scale only as live confirms backtest; automated execution + independent risk overlay + kill switches.
5. **Monitoring** — live Sharpe vs backtest per strategy; auto-deleverage on edge decay; full attribution.
6. **Scaling** — add capital as the track record compounds; add *uncorrelated* strategies to raise portfolio Sharpe; respect capacity.
7. **Risk** — vol-targeting, fractional Kelly, portfolio heat caps, drawdown kill, correlation monitoring, risk-of-ruin ≈ 0.
8. **Diversification** — many uncorrelated edges × many markets × multiple horizons. The portfolio Sharpe is the product, not any single strategy.

---

## The concrete path for THIS repo (next 5 moves)
1. **Harden the spread edge** — proper event-driven backtest with legging slippage + 2-leg costs + Monte Carlo + Deflated Sharpe. (Our best edge; validate it institutionally.)
2. **Add options/GEX data** → build a dealer-gamma regime signal for ES/NQ (highest-value new signal).
3. **Find 2–3 more spread-quality uncorrelated edges** to stack (raises portfolio Sharpe — the real lever).
4. **Build the risk-overlay + kill-switch process** (separate from the strategy engine) and live-vs-backtest monitoring.
5. **Paper-forward-test the combined book on the $50K demo** → that track record is what raises real capital.
