# Phase 0 — Live Micro Deployment (~$4.8K real money)

*Plan written 2026-05-25 against a $1K account. Capital section corrected 2026-08-16 — the account
was funded and this document went stale, which is worse than useless: it was read as current and the
"$1K" figure propagated into analysis. This is the live execution-proving layer (System 2). It is NOT
the get-rich engine and NOT the spread edge. Primary objective: **SURVIVE.** Secondary: collect real
execution data.*

> ## Capital history — read this before quoting any account figure
>
> | When | Equity | Source |
> |---|---|---|
> | 2026-05-25 | ~$1,025 | this plan, as originally written |
> | 2026-05-27 | **$821** | `futures-realtime.ts` — *"At sub-threshold equity (e.g. $821 today)"* |
> | **2026-07-11** | **+$4,000 ACH deposit** | `capital-flows.ts` — the deposit that dated this doc |
> | 2026-07-10 | rebaselined to **~$4,821** | `starting_capital_live`, `strategy_inception` |
> | 2026-07-28 | ~$5,250 | `futures-realtime.ts` evening-gold sizing note |
> | 2026-08-16 | **$4,500** | operator |
>
> **The live account is not a $1K account and has not been since July 11.** Quote P&L only as
> `netLiq − starting_capital_live − netDeposits` (`src/lib/live-pnl.ts`) — never balance minus a
> remembered number, and never a sum of trade rows.
>
> ### What the funding silently changed, with no decision attached
> Three parts of the risk envelope are derived from equity, so the deposit re-armed them by itself:
> 1. **Position size scaled ~4.7x.** Risk is a percentage (`live_futures_risk_per_trade_pct`), so at
>    5% the budget went from ~$51/trade to ~$241/trade — same setups, no new evidence.
> 2. **Evening gold auto-enabled.** `LIVE_EVENING_GOLD_MIN_EQUITY = 3000`; crossing it opened a
>    session that had never traded live, and on 2026-07-28 its size multiplier was raised 0.5 → 1.0
>    because at 0.5 the engine computed qty 0 and skipped every evening setup. **§10 below says no
>    overnight.** That conflict is unresolved and belongs to the operator, not to the code.
> 3. **Overnight margin utilisation is capped at 90% of equity** — one MGC ties up $2,242.90, half
>    the account. A gap against that is a margin event, not a stop-out.

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

> **⚠️ That justification expired with the funding.** The 3–8% figure was forced by a $1K account:
> one micro was the smallest position that existed, so the risk *was* the minimum. On ~$4,821 at 5%
> the budget is ~$241 and 1% (~$48) now fits a micro comfortably — the constraint that made
> oversizing unavoidable is gone, but the 5% setting stayed. **5% is now a choice, not a floor.**
>
> ### Plan vs. what live actually runs — verified against the code 2026-08-16
>
> | Rule as written above | What the engine does now |
> |---|---|
> | Max 1 position | `maxConcurrentPositions: 2` |
> | Max 1 contract, no pyramiding | `maxContractsPerTrade: 3`, total 4; pyramid add exists |
> | Max 3 trades/day | `maxTradesPerDay: 6` |
> | Conviction gate stays ON (§4) | AI grader **off** on live (`live_futures_ai_grader=false`) |
> | No overnight (§10) | evening gold enabled above $3K equity |
>
> Each gap may be individually defensible; none of them is *documented* as a decision. Either bring
> the config back to this plan or amend this plan — but the gap itself must not persist silently,
> because this table is what "not following the strategy" actually looks like when written down.
>
> **The conviction gate is the load-bearing one.** §4 says *"No validated directional edge exists yet.
> So: highest-conviction setups only… the conviction gate + the edge-filter veto list stay on."* With
> the grader off, `finalScore` collapses to `technicalScore`, which the engine's own comment notes is
> *"still far above the 55 live floor"* — so the confidence threshold no longer rejects anything. Live
> selectivity today is exactly one thing: **did a registered edge fire.** That is defensible only for
> as long as the edge registry is kept honest, which makes `defaultLive` in `realtime-edges.ts` the
> single most safety-critical line in the system.

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
