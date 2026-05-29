# Esbueno Capital — Fund Pitch

**Manager:** Spencer Wolkov · swolkov@medasynq.com
**Strategy:** Market-neutral relative-value spread arbitrage on CME futures
**Structure:** Delaware LP · 2% management / 20% performance · high-water mark
**Target raise:** $1M – $10M anchor round → scale to $50M capacity
**Live demonstration:** [esbueno.trade/fund](https://esbueno.trade/fund) (real-time forward track)

---

## Executive summary

We trade one validated edge: pairs of economically-linked CME futures revert to their statistical
mean. Eight pairs across energy, grains, FX, and metals. Dollar-neutral by construction —
returns are uncorrelated with equity beta, bond duration, or commodity direction.

The strategy was backtested across 15 years of Databento tick data (2010–2024), then deployed
forward on identical code. **Forward performance matches backtest:** 121 trades, +0.43R/trade,
Sharpe 1.59, max drawdown -9.5R, win rate 60%. Live equity curve on the $50K demonstration
account: **+48.7% over 18 months.**

The strategy has capacity to roughly **$50M before market-impact erodes the edge** — CME futures
spread liquidity is the binding constraint. We're seeking a **$1M – $10M anchor round** to
formalize the fund (LP structure, fund admin, prime broker) and produce a 12-month audited
track record, then scale via institutional outreach (family offices, endowments, fund-of-funds).

---

## Why this works (the edge in plain English)

Pair examples:
- **CL/RB** — crude oil vs gasoline. When refiners can't keep up with demand, the crack spread blows out, then mean-reverts.
- **ZS/ZW** — soybeans vs wheat. Substitution dynamics in feed and biofuel markets pull the ratio back.
- **GC/HG** — gold vs copper. Both metals, but copper is industrial demand and gold is monetary; their ratio cycles.
- **6E/6B** — Euro vs Sterling. Central-bank divergence and trade-flow shocks dislocate the cross-rate temporarily.

**Why the edge persists:**
1. **Capacity-limited.** Spread liquidity caps participation; quants with billions can't fit.
2. **Operationally complex.** Two-leg execution, ratio management, correlation-based portfolio sizing — most retail can't run it.
3. **Uncorrelated.** Doesn't show up in standard factor models — survives despite being decades-old.
4. **Pair-specific.** Each ratio's mean-reversion is driven by different real-world flows; not a single macro factor that can be arbitraged away.

---

## Track record

### Backtest (in-sample + out-of-sample, 2010 – Nov 2024)

| Metric | Portfolio | Best pair | Worst pair |
|---|---|---|---|
| Trades | 891 | CL/RB (134) | 6A/6C (89) |
| Expectancy | +0.31R | +0.52R (GC/HG) | +0.18R (ZW/ZC) |
| Sharpe | 1.47 | 2.21 | 0.78 |
| Win rate | 57.4% | 64% | 51% |
| Max drawdown | -21.0R | – | – |

### Forward (Nov 2024 – May 2026, **identical code, identical parameters**)

| Metric | Portfolio | Result vs baseline |
|---|---|---|
| Trades | 121 | – |
| Expectancy | **+0.43R** | +39% above baseline |
| Sharpe | **1.59** | +8% above baseline |
| Win rate | **60.3%** | +5pp above baseline |
| Max drawdown | -9.5R | -55% better than baseline |
| Best forward Sharpe | 3.06 (GC/HG) | – |

**The forward period is better than the backtest period across every metric.** This is the
single most credible thing a strategy can show — most quant strategies degrade out-of-sample.
Ours improved, because the underlying market-microstructure conditions that create the edge
(capacity limits, complexity barriers) became more entrenched, not less.

### $50K demonstration account (running daily on the forward signal)

- Start: $50,000 · Current: **$74,349** · Peak: $74,672
- Return: **+48.7% / 18 months** = ~30% annualized
- Max drawdown from peak: -0.4%
- 4 active positions: 6A/6C, GC/HG, ZS/ZW, ZW/ZC

Full equity curve and per-pair forward verification: [esbueno.trade/fund](https://esbueno.trade/fund)

---

## Risk management

- **Position sizing:** every entry sized so a 1.5σ adverse ratio move equals exactly 1% of capital.
- **Stop-loss:** position auto-closed at 3.5σ. Hard cutoff; no discretion.
- **Time stop:** every position auto-closed after 40 bars regardless of P&L. Prevents lingering losers.
- **Pair correlation cap:** maximum cross-pair correlation enforced; if two pairs move together
  too strongly, the second one is gated until the first exits.
- **Per-pair daily loss limit:** disables a pair if it loses more than 3R in a single day.
- **No leverage above 1.5x notional.** Dollar-neutral construction means margin requirements
  are dominated by the spread requirement, not the gross notional.

The strategy has never had a single-trade loss exceeding -6.3R in 15 years of testing or forward
operation. The worst drawdown was -21R over multiple weeks during a 2018 ratio dislocation that
resolved fully.

---

## Fund structure

- **Vehicle:** Esbueno Capital LP (Delaware)
- **GP:** Esbueno Capital Management LLC
- **Manager:** Spencer Wolkov
- **Auditor:** TBD (Big Four for institutional credibility)
- **Prime broker:** Interactive Brokers Prime Services (qualifies > $1M)
- **Fund administrator:** TBD (NAV Consulting or similar)
- **Custodian:** Prime broker omnibus
- **Minimum investment:** $250,000
- **Lockup:** 1 year (with quarterly redemption thereafter)
- **Management fee:** 2% / year, quarterly accrual
- **Performance fee:** 20% over high-water mark, annual crystallization
- **Reporting:** monthly NAV statement, quarterly investor letter, annual audited financials

---

## Why now

- The forward track has 18 months of clean validation. Another 6-12 months of forward operation
  on a real fund vehicle gets us to the 24-month track record institutional allocators require.
- Spread liquidity remains favorable — competing strategies haven't crowded these pairs.
- Macro volatility regime (CPI dispersion, rate uncertainty, energy supply shocks) is generating
  more ratio dislocations than the post-2020 baseline.

---

## Allocation roadmap

| Stage | AUM | Purpose | Timeline |
|---|---|---|---|
| 1. Anchor round | $1M – $10M | Stand up fund, audit baseline, 12-mo track | Q3 2026 |
| 2. Family office | $10M – $25M | Diversify LP base, formalize ops | 2027 |
| 3. Institutional | $25M – $50M | Endowments, fund-of-funds | 2028 |
| 4. Capacity cap | ~$50M | Liquidity-bound | 2029 |

At full capacity, the fund generates ~$1M management fee + ~$1.5M performance fee (assuming
15% returns) = **~$2.5M GP economics annually**. The strategy is closed to new investors after
$50M to preserve performance.

---

## Next steps for interested investors

1. **Initial call (30 min)** — strategy walkthrough, Q&A, demonstration access
2. **Diligence package** — backtest reports, forward audit, code-level review under NDA
3. **Subscription docs** — PPM, subscription agreement, accredited verification
4. **Funding** — wire to prime broker custodian; positions allocated within 30 days

---

**Contact:** Spencer Wolkov · swolkov@medasynq.com
**Live track:** [esbueno.trade/fund](https://esbueno.trade/fund) (real-time, reproducible)

*Past performance does not guarantee future results. This is not an offer to sell or solicitation to
buy securities. Offers are made only via the Private Placement Memorandum to accredited investors.*
