# MBT NR4 Range Expansion (daily)

**Strategy id:** `mbt-nr4-daily`
**Code:** `src/lib/strategies/mbt-nr4-daily.ts`
**Tier:** 2, plausible research candidate
**Execution authorization:** observation only, demo and live orders blocked
**Symbols:** MBT (Micro Bitcoin futures, 0.1 BTC contract)
**Timeframe:** UTC daily bars

## Corrected evidence

The bias-controlled study in `scripts/backtest-mbt-nr4-corrected.ts` supersedes the older
PF 2.03 result. It fixes first-touch direction, starts exit evaluation after entry, models
gap fills, matches Databento's UTC daily boundary, and applies realistic execution costs.

| Metric | Corrected result |
|---|---:|
| Period | 2022-05-26 to 2026-05-25 |
| Trades | 216 |
| Profit factor | **1.23** |
| Net per contract | **+$1,937** |
| Expectancy | **+$9/trade** |
| Win rate | 41% |
| Student t-stat | **1.13** |
| Bootstrap PF 95% CI | **[0.85, 1.78]** |
| Cost model | 25 points adverse slippage per side + $4 round-trip commission |

### Year by year

| Year | Trades | PF | Net |
|---|---:|---:|---:|
| 2022 | 40 | 1.30 | +$195 |
| 2023 | 52 | 0.96 | -$41 |
| 2024 | 54 | 1.43 | +$1,116 |
| 2025 | 55 | 0.95 | -$180 |
| 2026 YTD | 15 | 2.38 | +$846 |

The confidence interval includes PF below 1.0, t-stat is below 2, and two full years lost
money. This fails the pre-committed demo-arm gate. The result is promising enough to retain
for research, but not strong enough to put on a broker account.

## Research hypothesis

Volatility can cluster. After an unusually narrow daily range, a first break of the prior
day's high or low may start a directional expansion.

Correct test rules:

1. Prior UTC day's range must be below 0.5 times ATR-20.
2. On the next UTC day, the first touched boundary determines direction.
3. Skip a one-minute bar that touches both boundaries because direction is unknowable.
4. Anchor entry, stop, and target to the registered breakout level.
5. Stop is one prior-day range; target is three prior-day ranges.
6. Exit any remainder at the end of that UTC signal day.
7. Allow one attempt total per UTC signal day.

## Production state

- Databento sidecar collects exact-contract MBT and MET quotes across CME's seven-day schedule,
  excluding the exchange's published maintenance windows.
- Both demo and live assignments are **observation** with a one-contract ceiling retained
  for any future trial.
- The web cron contains no crypto broker-order call.
- The strategy dispatcher hard-blocks observation-only strategies from emitting executable
  signals.
- Admin blocks changing this strategy to Active while its execution eligibility is observation.
- MET, BFF, MXR, and MSL remain observation-only because no qualifying edge was found.

## What would unlock a demo trial

The research must first show equivalent evidence with deterministic first-touch logic:

- at least 50 resolved, de-clustered shadow signals;
- positive net expectancy and t-stat at least 2;
- both sample halves positive;
- realistic costs, no single-period dependence, and no look-ahead;
- an execution design with atomic daily reservation, exact-contract pricing, tick rounding,
  chase protection, linked OCO protection, and the required end-of-day exit.

Only after that review may demo change from Observation to Active. Live promotion would still
require real demo fills and the separate live evidence gate.
