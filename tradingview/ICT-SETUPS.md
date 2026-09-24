# ICT Setups — Liquidity · MSS · iFVG (MES / MNQ / MGC)

A Pine v6 chart indicator for decision support, plus a strategy version for backtesting. Both are
generated from one rules file.

> **Status:** the indicator is a chart-reading tool. The 15-year test of its mechanical rule is
> **negative on MES, MNQ and MGC** (see Results). ENTRY READY means *every programmed chart
> condition has closed and confirmed*. It does **not** mean "take the trade", and nothing places orders.

## Files
| File | What it is |
|---|---|
| `ict-core.pine` | **Single source of truth.** Every rule, drawing, dashboard and alert. Edit only this. |
| `ict-strategy-block.pine` | Strategy-only order block: orders exist only while a side is ENTRY READY. |
| `build-ict.sh` | Builds both outputs: `bash tradingview/build-ict.sh` |
| `ict-setups.pine` | GENERATED indicator. In TradingView as **"ICT Setups — Liquidity · MSS · iFVG"**. |
| `ict-setups-strategy.pine` | GENERATED strategy. In TradingView as **"ICT Setups — Strategy"**. |
| `lab/ict_lab.py` | 15-year Python port of the core (ablation `python3 lab/ict_lab.py ES`, exits `... ES --exits`). |
| `lab/results.md` | All result tables (ablation + exit test). `out_*.json` hold every trade. |
| `ict-selftest-block.pine` → `ict-selftest.pine` | In-TradingView self-test: runs the SAME engine on hand-built candles (FVG indexing, wick vs close, inversion, iFVG failure, swing delay, HTF de-dup). Saved as **"ICT Setups — Self-test"**. |
| `lab/test_ict_lab.py` | The same checks on the lab engine + HTF alignment (completed candles only). `python3 lab/test_ict_lab.py` |

## Timeframes (chart = 5M)
4H + 1H = higher-timeframe context · 15M = location / context · 5M = execution · 1M = optional precision.
Every higher timeframe is fetched with one `request.security(..., [x[1]], lookahead_on)` call per
timeframe (its last COMPLETED candle). Each engine is fed only when that candle's timestamp changes.
There are 6 data requests in total.

## The rule (per side; shorts are the mirror image)
1. **Context** (Balanced): the 1H bias is not against the trade, AND at least one of: 1H agrees, 4H agrees,
   the sweep tapped a 15M/1H/4H zone pointing the trade's way, or the swept level was overnight /
   prior-day / prior-week / 1H–4H swing liquidity.
2. **Liquidity sweep:** price trades through a qualified level and a candle CLOSES back within 3 bars.
3. **Displacement:** body ≥ 1.3 × ATR and ≥ 60 % of the range.
4. **5M MSS:** a close beyond the internal swing that led into the sweep, with displacement, within 12 bars.
5. **iFVG:** an opposite FVG is closed through **at or after the MSS candle**, within 12 bars of the MSS.
   → **PREPARE** (plan drawn: entry = zone edge, stop beyond the sweep + 0.1 ATR, TP1–3 = the next
   opposing levels ≥ 0.5R away: the leg high/low made after the sweep, the current session high/low,
   unswept liquidity, and 15M/1H/4H opposing zones. None are invented. With TP1 exits the "LEG HIGH/LOW"
   is often TP1).
6. **Retest:** a 5M candle trades into the zone and CLOSES holding it. With 1M precision ON, the
   1-minute chain must also confirm.
   → **ENTRY READY**: a limit at the entry price, valid 3 bars, then cancelled.
7. Before entry, everything is **close-based**: a close beyond the sweep extreme, a close through the
   iFVG, or a completed 1H candle flipping bias → **INVALIDATED — CANCEL ORDER**. Price running
   0.5R past the entry unfilled, or the order window passing → **MISSED — DO NOT CHASE**.
   Long and short active together → **WAIT (conflict)**.
8. Setups start, arm, and fill only between 09:30 and 14:00 ET. A pending order is cancelled if the next bar
   falls outside the window. The model is flat at the 15:50 bar's close (15:55).
   Liquidity, zones and structure are drawn around the clock; only *setups* are limited to the window
   (switch "Only start setups / take entries inside" off to scan 24h — tested as variant E, also negative).

## Chart design
- FVG = light fill, thin solid edge. iFVG = stronger fill, **dashed 2-px outline**. 1H/4H zones get a thicker edge and larger label.
- Labels: `5M BULL FVG`, `15M BEAR FVG`, `1H BULL iFVG`, `4H BEAR iFVG` … Only live zones exist; the nearest 2 per timeframe
  within 2.5 × that timeframe's ATR are drawn (rebuilt on the last bar, so no stale or duplicate boxes).
- Candidate zones: grey dotted box, text ends in **NOT READY**.
- Everything draws **in front of** the candles (`behind_chart=false`; Pine v6 otherwise draws overlay scripts behind them).
- Dashboard: compact (tiny text), opaque, **bottom-left by default** (the newest candles stay visible), long sentences
  wrapped. Glossary and history stats are off by default (inputs). **After adding the indicator, use its legend menu
  → Visual order → Bring to front**, otherwise TradingView can draw candles over the table.
- Entry / stop / target labels sit just right of the setup candle. The structural stop is rounded outward to a valid tick.
- The strategy build draws no dashboard or zones (only its results table and the plan lines) so it never doubles the indicator.

## QA done (Sep 24)
- TradingView self-test ("ICT Setups — Self-test"): **all 18 checks passed** on the final build (Pine Logs).
- Bar Replay, MNQ Aug 6 2026, stepped candle by candle: PREPARE LONG at the 09:45 close, RETEST + ENTRY READY at the
  09:50 close — identical to the normal history run (same zone 29494.00–29502.75, entry 29502.75, stop 29236.00).
  Nothing appeared early. Replay logs also show real FVG/iFVG math: e.g. bull FVG c1 high 29510.25 < c3 low 29525.75;
  inversion only on a CLOSE beyond the edge; 15M inversions processed only after the 15M candle completed.
- QA log over the loaded TradingView history: searching Pine Logs for "VIOLATION" → **no matches**.
- CORE vs TV logs on MES agree trade-for-trade after the tick-rounding fix (e.g. stops −22.75 / −18.75 pts on both).
- Math: `bull FVG = high[candle 1] < low[candle 3]`, `bear FVG = low[candle 1] > high[candle 3]`, candle 1 = index 2 and
  candle 3 = index 0 of the timeframe's own CLOSED bars. Inversion only on that timeframe's CLOSE beyond the edge.
  Proven by `lab/test_ict_lab.py` (5/5 pass) and encoded in the TradingView self-test.
- Rule order on real data: 373,101 checks over 15 years (every PREPARE → RETEST → ENTRY READY → FILL of every variant on
  MES/MNQ/MGC): **0 violations**. The same checks run in TradingView with input "QA log" (Pine Logs, `QA VIOLATION` lines).
- Independent code review (Fable): no lookahead/repainting; bugs it found are fixed in both the Pine core and the lab.

## Recommended live settings
Defaults, as shipped: **1M precision OFF** · context **Balanced** · window **09:30–14:00** · entry
**Zone edge** · exit plan **TP1** · **My max $ risk blank** (no contract count shown) · fees MES
1.08 / MNQ 1.03 / MGC 1.03 per side (MNQ/MGC look like the flat estimate; correct them from your statements).

## Results (1 micro, net of fees, 1-tick stop slippage, limit fills need a 1-tick trade-through)
All tables: `lab/results.md` (re-run Sep 24 after the Fable review fixes).
### 15-year lab, full rule, 1M OFF (2011 → mid-2026)
| | Trades | Win % | Exp R (t) | PF | Net |
|---|---|---|---|---|---|
| MES | 150 | 56 | −0.101 (−1.5) | 0.76 | −$1,461 |
| MNQ | 164 | 48 | −0.202 (−3.3) | 0.57 | −$3,267 |
| MGC | 63 | 49 | −0.088 (−1.0) | 0.74 | +$343 |

Ablation A→F (adding one ingredient at a time) is negative at every step on every market.
1M precision ON completes 0–5 trades in 15 years per market, which is too few to evaluate.

### Pre-declared exit test (same entries; only the exit changes)
| Exp R | TP1 | TP2 | Thirds |
|---|---|---|---|
| MES | −0.101 | −0.177 | −0.137 |
| MNQ | −0.202 | −0.192 | −0.186 |
| MGC | −0.088 | −0.039 | −0.028 |

### TradingView Deep Backtest (entire history, 1M OFF, TV commission $1.03/side) — measured BEFORE the Sep 24 fixes
MNQ 82 trades, −$918, PF 0.86 · MES 92 trades, −$1,383, PF 0.68 · MGC 87 trades, +$38, PF 1.02.
1M ON: MES 2 trades · MNQ 1 · MGC 0. (Not re-run after the fixes: TradingView only recalculates while
its window is on screen.)

## Why TradingView and the core can differ
The core is authoritative and conservative:
- A target touched in the same minute as the fill is not credited.
- A stop and a target in the same minute count as the stop.
- Fees are per instrument.

TradingView's broker emulator guesses the intrabar order, so it can look more optimistic.
Every trade is logged to Pine Logs as `CORE ...` / `TV ...` lines so any gap can be traced.

## Known limitations
- On the LIVE bar, TradingView may not yet include the final 1-minute bar when the 5M bar closes, so
  live same-bar stop/target sequencing (and 1M precision) can differ slightly from a reload.
- The strategy's `slippage=1` also applies to the session-flat close; commission is one flat $1.03/side.
- The mechanical rule is not a demonstrated positive-expectancy system.
- TradingView's 1m intrabar history is short (about 3 months on 5m charts), so TV-side precision tests are tiny.
- The lab uses Databento front-month data with panama back-adjustment; TV uses its own continuous contract. Trades match closely, not exactly.
- Liquidity / target selection depends on what is loaded on the chart (the HTF engines warm up from the first loaded bar).
