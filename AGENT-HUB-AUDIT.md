# Agent Hub Audit — realign every agent to the current truth

*Last updated 2026-05-25. Classify every agent; kill stale assumptions; do NOT add agents unless necessary.
"Agent" here spans four artifacts that must stay consistent: vault `Agent-Config/*.md` (the brain),
Railway engine services (demo/live), cron routes (`src/app/api/cron/*`), and the Agent Hub UI.*

> **Guiding truth:** spread book = only validated edge candidate (not $1K-deployable, needs paper-forward) ·
> live $1K = Phase 0 execution validation (not proven alpha) · demo = research lab (P&L ≠ proof) ·
> directional retail systems = rejected · Databento = data (migrating) · Tradovate = execution · risk engine overrides all.

## Classification key
**A** keep active · **B** keep but rename/update scope · **C** disable/archive · **D** convert to research-only (must not drive live) · **E** needs new config (stale assumptions)

## Existing vault agents (14)
| Agent | Class | Action |
|-------|-------|--------|
| `execution-quality-agent` | **A** | Keep + **strengthen**. Critical now. Add latency, order rejects, broker ACKs, intended-vs-actual fill, duplicate-order detection (config currently only covers slippage/fills). = target #5. |
| `watchdog-agent` | **A** | Keep. Ensure it covers Railway health, engine heartbeat, duplicate-process, API disconnect, stale data, stuck orders, shutdown enforcement. = target #9. |
| `orchestrator-agent` | **A/B** | Keep — it's the event-bus control layer. Clarify scope as the **risk/control nervous system** feeding the Risk Engine. |
| `portfolio-risk-agent` | **B** | Rename/merge → **Risk Engine Agent** (target #4): global risk state, max loss, kill switches, stale-data/broker-health blocks, exposure caps, live/demo isolation. Must override every strategy. |
| `research-agent` | **A/D** | Keep as research-only. Update to the edge hierarchy — stop treating rejected systems as candidates. |
| `synthesis-agent` | **A** | Keep. Update to reflect validated/rejected map; feeds lessons. |
| `futures-agent` | **B/E** | **Stale.** Still says "Live: trade MES *and* MNQ", "ultra-aggressive demo", `futures-scalping`. Split into **Futures Engine — Demo** (research lab) and **Futures Engine — Live** (Phase 0: MES only, 1 contract, 1 trade/day). = targets #1, #2. |
| `regime-transition-agent` | **C/D** | We **proved** regime stand-down fails to cut the tail. Convert to research-only or disable — must not drive live. |
| `news-catalyst-agent` | **C/D** | NFP direction tested = random. Generic news trading is unvalidated. Research-only or disable. |
| `liquidity-agent` | **D** | Order-flow/liquidity = **data-gated** (no tick/L2 yet). Park as research-only until the order-book pilot; must not drive live. |
| `options-agent` | **C** | **Archive.** Options are disabled. |
| `crypto-agent` | **B** | Keep (separate Alpaca paper stream) but label **paper / unvalidated**. Out of futures scope. |
| `stocks-agent` | **B** | Keep (Alpaca paper swing) but label **paper / unvalidated**. |
| `jarvis` | **A/B** | Keep as the Obsidian brain interface; clarify it's the vault persona, not a trading authority. |

## New agents genuinely needed (only 3 — not a sprawl)
| Agent | Class | Why |
|-------|-------|-----|
| **Spread Engine Agent** | **E (create)** | The **primary strategic agent**: validated spread research, paper-forward validation, pair-health tracking, execution realism, prop/funded prep. = target #3. |
| **Market Data Agent** | **E (create)** | Databento/Tradovate/Yahoo status, bar+quote freshness, timestamp alignment, data-quality validation. Needed for the migration. = target #6. |
| **Paper-Forward Validation Agent** | **E (create)** | Scheduled wrapper around `scripts/paper-forward.ts` — forward-only, no tweaking, PASS/WARN/FAIL, drift vs baseline. = target #7. |

**Post-Market Review Agent** (target #8): likely **maps to the existing `cron/review` route** — update it rather than create new.

## Automation gate (every agent/strategy must pass ALL before trading)
data feed healthy · broker connection healthy · strategy approved for THIS environment · risk engine approves ·
account config allows · symbol whitelist allows · max-trade-count not breached · no stale signal · no duplicate
order · no conflicting open position · kill switch not active. **Live never inherits demo settings; demo never routes to live.**

## Config audit (DB AgentConfig + vault)
- **LIVE:** MES only · 1 contract · 1 trade/day · Phase 0 · strict caps. *(already set 2026-05-25)*
- **DEMO:** research lab · broader symbols · clearly marked **unvalidated**.
- **SPREAD:** paper-forward only · no $1K live deployment.
- Purge: stale symbols, stale strategy names (`futures-scalping` as "validated"), "aggressive" language, duplicate live/demo keys, agents pointing to rejected systems.

## Execution order (matches your priority list)
1. ✅ Chart + honest provider/env labels (done — `futures-chart.tsx`).
2. Apply this audit: archive `options-agent`; convert `regime-transition`/`news-catalyst`/`liquidity` to research-only; relabel `crypto`/`stocks` as paper.
3. Rename/update: `futures-agent` → Demo + Live(Phase 0); `portfolio-risk` → Risk Engine.
4. Strengthen Execution Quality + Watchdog + Market Data agents.
5. Create Spread Engine Agent + Paper-Forward Validation Agent.
6. Update Agent Hub UI labels to match (DEMO/LIVE-Phase0, Databento=data, Tradovate=exec, spread=validated-research, directional=rejected).
7. Keep live Phase-0 safe; keep demo as the lab; continue Databento migration.

**Do not let automation amplify stale assumptions.** Each step is reversible and staged; none changes execution routing.
