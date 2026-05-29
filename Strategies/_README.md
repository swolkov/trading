# Strategies — registry & status map

This directory is the human-readable companion to `src/lib/strategies/registry.ts`. Each strategy
file describes one **signal-generator** scoped to `(asset class × timeframe × signal-family)`.

Code lives in `src/lib/strategies/<id>.ts`. Validation status comes from `EDGE-HIERARCHY.md`.

---

## Live registry

| Strategy id | Asset | Timeframe | Symbols | Tier | Doc |
|---|---|---|---|---|---|
| `mbt-nr4-daily` | Crypto futures (BTC) | 1d | MBT | 2 | [mbt-nr4-range-expansion.md](mbt-nr4-range-expansion.md) |

## Observation-only (symbols available, no registered strategy)

These symbols stream via the Databento sidecar and are visible in the UI; the engine evaluates
the registry on each cycle, finds no signal, and logs an observation. No trades placed.

| Symbol | Reason | Next step |
|---|---|---|
| MET | 4-yr backtest: PF 0.06–0.27 across all setups tested. No edge found. | Stay observation-only. |
| BFF | 4-yr backtest: PF 0.27–0.69. Friday gamma hypothesis (H5) also failed. | Stay observation-only. |
| MXR | Launched 2025, not yet backtested. | Pull data + run hypothesis scan. |
| MSL | Launched 2025, not yet backtested. | Pull data + run hypothesis scan. |

## Legacy 5m intraday library (not yet migrated into registry)

The original `detectSetup()` in `futures-agent.ts` handles ES/NQ/MES/MNQ/GC/MGC via a single
combined function that tries multiple setup types. These will be migrated into the registry
incrementally so each (asset × signal-family) becomes its own tier-tracked strategy file.

Until migrated, the legacy library runs for symbols NOT in `STRATEGY_REGISTRY_ONLY_SYMBOLS`.

---

## Adding a new strategy

1. Write the signal logic in `src/lib/strategies/<id>.ts` implementing the `Strategy` interface.
2. Register it in `src/lib/strategies/registry.ts`.
3. Add the symbol(s) to `STRATEGY_REGISTRY_ONLY_SYMBOLS` if it should bypass the legacy library.
4. Write a doc here following the existing format.
5. Update `EDGE-HIERARCHY.md` with the strategy's tier + evidence.
6. Forward shadow-execute on demo for 30+ trades before any live capital.
