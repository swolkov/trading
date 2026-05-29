# MBT NR4 Range Expansion (daily)

**Strategy id:** `mbt-nr4-daily`
**Code:** `src/lib/strategies/mbt-nr4-daily.ts`
**Tier:** 2 — plausible-unvalidated (positive 4-yr backtest, needs forward shadow execution)
**Discovered:** 2026-05-28
**Symbols:** MBT (Micro Bitcoin futures, CME GLBX.MDP3, 0.1 BTC contract)
**Timeframe:** Daily bars

---

## Edge

4-year Databento backtest (2022-05-26 → 2026-05-25), `scripts/edge-scan-crypto-deep.ts`:

| Metric | Value |
|---|---|
| Trades | 136 |
| Profit factor | **2.03** |
| Net per contract | **+$4,177** |
| Win rate | 54% |
| Avg expectancy | +0.21R |
| Years positive | 4 of 5 |

### Year-by-year

| Year | Trades | PF | Net | Notes |
|---|---|---|---|---|
| 2022 | 23 | 1.26 | +$108 | Bear market, edge held |
| 2023 | 34 | 0.90 | −$65 | Flat — only mildly negative year |
| 2024 | 36 | **2.60** | **+$2,106** | Bull, strongest year |
| 2025 | 32 | 1.68 | +$1,003 | Mixed chop, edge held |
| 2026 | 11 | 5.55 | +$1,026 | YTD partial, small sample |

## Theory (pre-registered before backtest)

Volatility compression → directional expansion. A narrow-range day (range < 0.5× ATR-20) is
the market coiling; the next day's break of that day's H/L is the resolution. Mechanism is
positional liquidity drying up at extremes, then directional traders pressing the break.

Lineage: Linda Raschke's NR4/NR7 work on equity index futures. The pre-registration
discipline (hypothesis named before running the scan) is what gives this edge credibility
above the noise floor — we ran 7 such hypotheses, only this one cleared the bar.

## Why we trust the result

1. **Pre-registered** — the hypothesis was named before the backtest ran (vs. mining patterns post-hoc).
2. **Year-on-year consistency** — positive in 4 of 5 years across distinct regimes (2022 bear, 2024 bull, 2025 chop, 2026 expansion).
3. **Failed where theory predicts** — NR4 on MET (ETH) PF 0.18, on BFF (BTC weekly) PF 0.69. If this were curve-fit noise it would have worked everywhere it was tested.
4. **Survives walk-forward** — split at 2026-01-01, in-sample and out-of-sample both positive.

## Signal logic

```
Aggregate intraday bars → daily session bars (ET-aligned).
At end of day D:
  ATR_20 = 20-day average true range
  rangeD = HighD − LowD
  if rangeD < 0.5 × ATR_20 → mark day D as NR4 candle.

On day D+1:
  if price breaks above HighD → enter LONG at HighD
  if price breaks below LowD → enter SHORT at LowD

Stop: 1 × rangeD from entry
Target: 3 × rangeD from entry
Hold: until stop, target, or end of D+1 session
```

## Risk + sizing

- Per-contract stop dollar risk ≈ `rangeD × multiplier (0.10)`. Typical NR4 range on
  BTC ≈ $500–1500 → $50–150 per contract stop risk.
- Targets 3× the stop ⇒ asymmetric reward, win rate 54% is sufficient for PF > 2.
- Max-hold: end of next session (D+1 close).

## Capital requirements (why this is NOT on the $1K live account)

MBT day margin ≈ $1,500–2,500 per contract. The $1K live account cannot meet margin without
risking overrun. Deployment paths:

1. **Demo first** — forward shadow execution on the $50K demo for 30+ trades. Confirm backtest fills hold up under realistic broker latency/slippage.
2. **Topstep/Apex eval** — $50K eval account (~$150 entry). Fastest path to real capital deployment if forward test passes.
3. **Organic account growth** — when live account hits $5–10K from existing edges (spread book, MES/MNQ), MBT becomes safely tradeable.

## Caveats / open questions

- **Backtest does NOT model the AI grader.** The futures-agent's AI confirmation overlay may filter some NR4 signals; backtest is a superset. Forward execution will reveal the real fired-trade rate.
- **Stop placement at exactly prior-day H/L is a known liquidity zone.** Live fills may slip 1–2 ticks worse than backtest assumes.
- **Concentration risk.** This is a single-asset, single-direction-at-a-time edge. Don't size as if it were an uncorrelated diversifier.
- **Regime sensitivity untested.** 4 years covers some regime variation but not, e.g., a full multi-year bear market. The 2022 bear year (PF 1.26) is encouraging but small.

## Forward validation criteria (gate to Tier 1)

To promote to Tier 1 (real-capital ready) the strategy must show:

- ≥ 30 forward demo trades
- PF ≥ 1.50 forward (degradation from backtest's 2.03 is expected; 1.50 is the bar)
- No single losing month > 3R loss
- Live fills within 0.10R of backtest fills

Until met, this strategy stays Tier 2 and runs demo-only.
