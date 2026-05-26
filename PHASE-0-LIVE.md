# Phase 0 — Live Micro Deployment ($1K real money)

*Last updated 2026-05-25. This is the live execution-proving layer (System 2). It is NOT the
get-rich engine and NOT the spread edge. Primary objective: **SURVIVE.** Secondary: collect real
execution data.*

> **What tomorrow IS:** live execution validation, infra reliability, broker/API integration,
> slippage/latency reality, order handling, operational + emotional discipline, real data.
> **What tomorrow is NOT:** scaling, oversized leverage, account gambling, "the final edge."
> We expect Phase 0 to be roughly break-even-to-small-loss. That cost is tuition for the live layer.

---

## 1. Instruments
**Day one: MES, MNQ, MGC only.** These are the most liquid micros AND the only three the live engine
already routes + has contract specs for. **MCL, MYM, M2K are deferred** — they need contract-spec +
routing verification and a demo test first (don't put unproven order routing on real money). Add them
to Phase 0 only after they trade cleanly on demo.

- **One position at a time.** Max 1 concurrent position, max 1 contract (pyramiding OFF — see §3).

## 2. Allowed times (RTH only)
- Equity micros (MES/MNQ/MYM/M2K): **~9:45 AM – 3:50 PM ET.** Engine skips the first 15 min (open
  auction) and the close, takes midday at half weight. No ETH, no overnight.
- Metals (MGC): **~8:20 AM – 1:30 PM ET** (COMEX prime).
- Avoid low-liquidity hours entirely (already blocked by the session gate).

## 3. Hard live constraints (enforced in engine + config)
| Rule | Setting | Enforcement |
|------|---------|-------------|
| Max 1 position | `live_futures_max_positions = 1` | config ✅ |
| Max trades/day | `live_futures_max_trades_per_day = 3` | config ✅ (engine blocks at cap) |
| Per-trade risk | 1 micro, hard stop ≈ $30–80 (**~3–8% of $1K**) | sizing from `risk_per_trade_pct = 5` so exactly 1 micro fits |
| Max daily loss | **≈ $80 (8%)** → entries stop for the day | config ✅ (engine hard-stops) |
| Max weekly loss | **≈ $160 (16%)** → stand down for the week, reassess | ⚠️ needs a small add (or manual) |
| No overnight | flatten + cancel all at 3:50 PM ET | engine ✅ |
| No averaging down | engine never adds to losers | by design ✅ |
| No pyramiding | **disable the 1.2R add-to-winner** | ⚠️ one code change (gated off for live) |
| No revenge/tilt | consecutive-stop + tilt pause | engine ✅ |
| Kill switch | orchestrator pause halts entries | engine ✅ |

**Per-trade risk note:** 1 micro on $1K is unavoidably ~3–8% — you cannot size to 1% (that's a $10
budget; no micro fits). Phase 0 *accepts* this because the objective is validation, not edge-harvesting,
and total exposure is bounded hard by the daily ($80) and weekly ($160) dollar caps + low trade count.
This is a deliberate, bounded departure from the 1% professional ceiling, not a reversal of it.

## 4. Trade selection
No validated directional edge exists yet. So: **highest-conviction setups only**, RTH liquid hours,
most-liquid instruments, no impulsive entries, no overtrading. The conviction gate + the edge-filter
veto list stay on. Few, clean, deliberate trades — the point is the plumbing, not the P&L.

## 5. Shutdown rules (exact)
1. **Daily loss ≈ $80 reached** → no new entries the rest of the day (open position still managed to its stop/EOD).
2. **Weekly loss ≈ $160 reached** → stand down for the week.
3. **3 trades taken** → done for the day.
4. **Consecutive stops / tilt** → engine pause (cooldown).
5. **Orchestrator pause** (VIX/consecutive-stop) → entries halt.
6. **Broker disconnect** → stop trading (verify heartbeat coverage — telemetry task).
7. **Manual kill** → set the orchestrator pause / stop the Railway live service.
8. **EOD 3:50 PM** → flatten everything, cancel all working orders.

## 6. Telemetry / logging requirements
Per trade: timestamp, environment=LIVE, strategy, market, signal reason, entry, exit, stop, target,
**spread-at-entry, intended vs actual fill, realized slippage, order latency**, volatility regime.
Per skip: reason (risk rule / liquidity / spread-too-wide / exposure cap / shutdown state).
- Already captured: trade YAML → Obsidian journal, decision rationale, DB trade log.
- **To add (this week):** spread-at-entry, intended/actual fill, slippage, latency, rejects →
  new `execution_quality` table. This is the core data-collection deliverable of Phase 0.

## 7. Operational / behavioral discipline
This is an automated engine, so "psychology" = **operator discipline**: every manual override or
intervention gets logged with the reason (did you stop it on a whim? widen a stop? add size?). Track
hesitation/impulse-to-intervene. The engine enforces no-revenge/no-martingale in code; the human rule
is **don't touch it** unless a real bug or risk event demands it.

## 8. Demo vs live separation
- **Demo ($50K):** continues broad/experimental research, new params, spread combos, directional tests.
- **Live ($1K):** ultra-conservative, operationally focused, tiny size, zero experimental behavior.
  Nothing reaches live without going through demo/paper-forward first.

## 9. Deployment checklist (run before tomorrow's open)
- [ ] Live Tradovate auth token fresh (bootstrap if stale).
- [ ] Config written: `max_positions=1`, `max_trades_per_day=3`, `daily_loss_limit_pct=8`,
      `risk_per_trade_pct=5`, `simulated_equity=0` (real $1K). Verify in DB.
- [ ] Pyramiding gated OFF for live (code change, tested on demo first).
- [ ] Instrument set = MES/MNQ/MGC only.
- [ ] Confirm EOD-flatten + daily-loss hard-stop fire in a demo dry-run.
- [ ] Deploy in the market-closed window only (today is a holiday — safe; otherwise after 4 PM ET).
- [ ] Telemetry capture live (or accept day-1 runs with journal-only logging, add execution table next).

## 10. Things NOT to do
Oversize · average down · hold overnight · pyramid · chase/impulse-enter · trade the open auction,
the close, or illiquid hours · deploy during market hours · add experimental strategies to live ·
treat tomorrow's P&L as success/failure · expect the $1K to scale fast. **Survive, log, learn.**
