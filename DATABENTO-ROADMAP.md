# Databento Maximization Roadmap

We pay **$179/mo ($2,148/yr)** for Databento. At this price point we should be maximizing every schema in our subscription. If a research idea here says "plan upgrade required," double-check the portal first — old assumption was $15/mo and several items were marked gated that may not actually be.

## Shipped (2026-05-29)

| Capability | Where | Notes |
|---|---|---|
| Live MBP-1 stream (sidecar) | `sidecar/databento-md-sidecar.py` → `live_quotes` table | 8 symbols (ES/NQ/GC + MBT/MET/BFF/MXR/MSL). Engines + chart read from DB. |
| Historical OHLCV-1m for backtests | `scripts/dbn-fetch.ts`, `dbn-fetch-crypto.ts` | Powers 4-yr edge scan that found MBT NR4. |
| Live trades stream (T&S) | sidecar via `trades` schema | Captures cumulative volume per symbol. |
| **Volume Profile component** | `/futures` → "Depth · Tape" tab | Last 24h aggregated trades, horizontal histogram, POC marker, buy/sell split. |
| **Time & Sales tape** | `/futures` → "Depth · Tape" tab | Last 100 trades, color-coded by side, size-emphasized top 10%. |
| **Tape pressure indicator** | `/futures` → "Depth · Tape" tab | Cumulative buy vs sell pressure ratio over tape window. |
| `/api/databento/depth` endpoint | Returns live + tape + profile | Symbol-parameterized. Cached client-side for 60s. |

## High-leverage next ideas

### Shipped this session (2026-05-29)

| New capability | Where |
|---|---|
| Cross-asset correlation matrix | `/research/correlations` page + `/api/research/correlations` |
| Slippage sensitivity sweep | `scripts/backtest-crypto-slippage-sweep.ts` (revealed MBT NR4 is execution-robust; PF 1.71 honest baseline) |
| Statistics schema confirmed available | `scripts/research-h1-auction-imbalance.ts` proved CME GLOBEX statistics returns IOP (stat_type 2), settlement, open interest. **H1 microstructure hypothesis is testable on our current plan** — just need analysis logic added. |

### Tier 1 — quick wins (each ~1-2 hours)

1. **Order book ladder (MBP-10)** — currently we only subscribe to MBP-1 (best bid/ask). Subscribing to MBP-10 gives 10 levels of depth. Useful for:
   - Pre-trade depth check (is there real size at our target?)
   - Iceberg detection (refilling top-of-book)
   - Slippage prediction
   - **STATUS (2026-05-29): subscribe error returned. NEEDS PORTAL VERIFICATION — at $179/mo subscription, MBP-10 is likely available, but the API key may not have this schema toggled on.** Server returns "Not authorized for mbp-10 schema". Code is ready (`ENABLE_MBP10` flag in sidecar, `/api/databento/book` endpoint, `OrderBookLadder` component all built). Upgrade Databento plan to Plus or Pro tier, flip the flag in sidecar, redeploy with `railway up ./sidecar --path-as-root --service databento-sidecar`. UI gracefully shows "unavailable" message until then.

2. **Volume profile overlay on chart** — currently volume profile is a separate tab. The pro UX is overlaid on the price chart as semi-transparent horizontal bars to the right. Lightweight-charts can do this.

3. **Session VWAP + bands** — current chart shows VWAP but not the standard-deviation bands (1σ, 2σ). Crucial for mean-reversion strategies.

4. **Prior day high/low/close lines** — chart should always show PDH/PDL/PDC. Free off existing data.

5. **Open interest / volume statistics** — Databento `statistics` schema gives settlement prices, daily volume, open interest changes. Powers a "positioning shift" page (when OI rises with price, longs adding; when OI rises with falling price, shorts adding).

### Tier 2 — research enablers (each ~half-day)

6. **Replay mode** — pick a historical trade from the journal, see the tape + book + price action around the entry/exit at 1m or tick resolution. Helps debug "why did this trade fail?" without rerunning backtests.

7. **Real slippage analysis** — our backtest assumes 1-tick flat slippage. Pull historical MBP-1 at each backtest trade timestamp; compute actual slippage from bid/ask spread + recent volume. Should make backtest PFs more honest.

8. **Cross-asset correlation matrix** — ES vs NQ vs RTY vs GC vs CL vs BTC. Pull 1h bars for all, compute rolling correlations. Helps confirm "uncorrelated diversification" claims for the spread book.

9. **Microstructure hypothesis testing** — the H1-H5 hypotheses in EDGE-HIERARCHY.md are gated on "tick + DOM data we don't have." We DO have it via Databento — we just haven't tested. Specifically:
   - **H1 opening-auction imbalance persistence**: Databento has auction imbalance data on equity index futures.
   - **H4 failed-auction continuation**: same data feed.
   - **H3 liquidity-vacuum continuation**: MBP-10 over time = book depth time series.

### Tier 3 — bigger structural moves (each ~1-2 days)

10. **Replace Alpaca equity data with Databento** — Databento `DBEQ.BASIC` is the consolidated SIP (NYSE + Nasdaq + ARCA + etc.). Better than Alpaca's IEX-only data for stocks. Alpaca stays for execution.

11. **Options data via OPRA** — Databento has options consolidated. Could power:
    - Real options chain on `/options` page
    - Implied volatility surfaces
    - Greeks calculations
    - Forward-test the wheel strategy properly.

12. **Order flow heatmap** — full MBO (market by order) stream. Shows individual order placement, modification, cancellation. Powers institutional flow detection ("dark pool sweep about to happen"). Bandwidth + storage cost.

13. **Time-of-day analysis page** — using all our historical 1m bars, compute average volatility, range, volume by hour. Identify "best windows" for each strategy.

### Tier 4 — moonshots

14. **Equity sector relative strength** — using SIP data, build a real-time sector heatmap.
15. **Cross-venue arbitrage detector** — equity prints differ slightly between exchanges; can we capture that? (Likely arbitraged at HFT speed but worth investigating.)
16. **News-driven backtester** — combine Databento price data with a news API; backtest "fade the spike on bad news."

## Architecture decisions

- **Sidecar adds more schemas the same way**: edit `sidecar/databento-md-sidecar.py`, add to subscribe() call. Restart with `railway up ./sidecar --path-as-root --service databento-sidecar`.
- **Historical fetch always via `/api/databento/depth` style endpoints**: hit Databento HTTP API, cache where reasonable. Costs accrue per byte pulled — keep date ranges narrow.
- **Live + historical never overlap**: live = sidecar → DB → engine. Historical = scripts/API → research/UI. Separate pipelines.

## Cost discipline

Databento bills per-message-per-subscription. Our current spend should be ~$15/mo on the live MBP-1 + trades streams for 8 symbols. Adding MBP-10 doubles message volume per symbol; budget ~$25-30/mo if we add it. Historical pulls are cheap (OHLCV-1m is ~cents per million bars).
