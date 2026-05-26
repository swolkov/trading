# System Architecture — three systems, one honest cut

*Last updated 2026-05-25. The target architecture, and — more importantly — the brutal separation
of what's necessary NOW vs what's institutional over-engineering for a $1K validation account.*

> **Guiding principle (yours, and correct):** optimize for survivability, execution realism,
> auditability, and controlled scaling — NOT impressive backtests. Build the **minimum viable
> *professional* infrastructure** first.

---

## The three systems (correct to separate — never merge)

| System | Capital | Purpose | Posture |
|--------|---------|---------|---------|
| **1. Research / Demo Lab** | $50K paper (Tradovate) + CSV research | edge discovery, forward testing, stress tests | experimental, broad |
| **2. Live Micro Execution ($1K)** | $1K REAL (Tradovate) | prove execution/infra/discipline; collect live data | ultra-conservative, locked down |
| **3. Spread Engine** | future funded/prop-firm | the one validated structural edge | paper-forward → prop-sim → funded |

**Hard rule:** the Lab can never touch live capital. No auto-promotion to live. Promotion is a
manual, evidence-gated decision (see Strategy Lifecycle).

---

## What is OVER-ENGINEERED right now vs NECESSARY now

*This is the most important section. You asked me to challenge the list — here it is.*

### ✅ Necessary now (the MVP professional layer)
- **Hard risk caps + kill switch on LIVE.** Mostly already built — needs tightening to Phase 0 levels.
- **Environment isolation that already exists:** DEMO vs LIVE use separate config keys (`live_futures_*`
  vs `futures_*`), separate API targets, mode-filtered DB queries. Formalize an `environment` enum; do
  NOT build 5 parallel table sets.
- **Live execution telemetry** — intended vs actual fill, slippage, latency, broker heartbeat. This is
  the *entire point* of Phase 0 (collect real execution data). Small, additive, build it.
- **1-contract enforcement** — disable pyramiding on live (it currently adds a 2nd micro at 1.2R).
- **Per-trade + per-skip logging** — mostly exists (Obsidian journal + DB); add slippage/latency fields.

### 🟡 Necessary soon (before the spread engine touches funded capital — NOT for tomorrow)
- **Paper-forward harness for the spread engine** with explicit PASS / WARNING / FAIL drift tracking
  (Sharpe, expectancy, drawdown, tail, slippage drift vs backtest). This is the real Stage 1.
- **Per-pair structural-break monitoring** for the spread engine (rolling cointegration, z-persistence,
  per-pair risk caps, stand-down) — the tail is idiosyncratic per pair (proven).
- **Central risk engine** unification — only worth it once ≥2 live systems run concurrently.

### 🔴 Over-engineered for now (design only; build when scale justifies it)
- **Separate DB tables per environment** — an `environment` enum column does the job at this scale.
- **4 full dashboards** (risk/execution/strategy/pair) — you have a UI. One status+telemetry panel
  suffices for a 1-contract account. Build the pair dashboard when the spread engine deploys.
- **Slack + SMS + 10-event alerting** — wire 3 critical alerts (kill-switch fired, broker disconnect,
  daily-loss breach). SMS infra and degradation/divergence alerts are for the funded phase.
- **Prop-firm sim (Apex + Topstep + generic)** — pointless until the spread engine is paper-forward
  validated. Design the rule layer now; build it at the PROP_SIM stage.
- **9-stage strategy lifecycle state machine** — for ~3 strategies, the `EDGE-HIERARCHY.md` doc + a
  status field + manual gates IS the lifecycle. A formal engine is premature.
- **Regime / volatility-exposure caps** — we *proved* the regime stand-down fails to cut the tail.
  Don't build exposure caps keyed on regime; they don't help. Use per-pair caps instead.
- **VPS migration** — Railway is fine. No VPS needed.
- **Trade-replay dashboard, correlation-instability scoring, tail-expansion alerts** — funded-phase.

**One-line verdict:** ~70% of the wishlist is the right architecture for a $100k+ multi-strategy
operation, and the wrong thing to build for a $1K account proving its plumbing this week.

---

## Target architecture (the North Star — staged, not all at once)

### Environment separation
Five logical environments, one Postgres DB, isolated by an `environment` enum + separate API keys —
NOT five table sets:

| Env | Routing | Capital | Lives in |
|-----|---------|---------|----------|
| `RESEARCH` | none (CSV/backtest) | none | `scripts/` |
| `DEMO` | Tradovate demo | $50K paper | live engine (IS_DEMO) |
| `LIVE` | Tradovate live | $1K real | live engine (LIVE_API) |
| `PAPER_FORWARD` | simulated fills on live data | none | new harness (soon) |
| `PROP_SIM` | simulated + prop rules | none | new (funded phase) |

Each carries its own config keys, risk settings, kill switch, and log scope. DEMO↔LIVE isolation
already exists today.

### Central risk engine (target)
A single overlay that ALWAYS overrides strategy signals. Already partially real (`risk-overlay.ts`,
the live engine's caps). Target adds: weekly/monthly DD, per-market & per-strategy exposure, max
slippage/latency tolerance, broker-disconnect shutdown, duplicate-order prevention. **Build
incrementally** — the live caps + Phase 0 telemetry first.

### Execution engine (target)
Order queueing, ack, retry, reconnect, stale-order detection, fill verification (✅ built),
partial-fill handling, cancel/replace, latency + slippage tracking, broker heartbeat. **MVP slice:**
fill verification (done) + latency/slippage capture + heartbeat. The rest is funded-phase.

### Strategy lifecycle (target, lightweight now)
`IDEA → RESEARCH → BACKTEST → OOS → STRESS → PAPER_FORWARD → DEMO_FORWARD → LIVE_MICRO → PROP_SIM →
FUNDED`. No skips, no auto-promotion, evidence-gated. **Now:** a status field per strategy + the
hierarchy doc. **Later:** a real state machine when strategy count justifies it.

### Deployment topology
- **Railway:** keep 2 services (demo engine, live engine). Add a 3rd (paper-forward) at that stage.
  No VPS.
- **DB:** Neon Postgres, single instance, `environment` enum on trades/config + a new
  `execution_quality` table (intended/actual fill, slippage, latency, rejects).
- **Monitoring/logging:** existing Next.js UI + Obsidian journal + the new execution table. One
  status panel now; full dashboards at the funded phase.

---

## Exact next implementation order

1. **TONIGHT (market holiday — safe deploy window):** Phase 0 live config + disable live pyramiding
   (one small, demo-tested code change). Enables tomorrow. → see `PHASE-0-LIVE.md`.
2. **This week:** LIVE execution telemetry (intended/actual fill, slippage, latency, broker
   heartbeat) + `execution_quality` table. The data-collection core of Phase 0.
3. **Run Phase 0 live ~1–2 weeks:** validate plumbing, slippage assumptions, discipline. Collect data.
4. **In parallel, in the Lab:** build the spread-engine **paper-forward harness** with PASS/WARN/FAIL
   drift tracking. This is the real Stage 1.
5. **Then:** per-pair structural-break monitoring + central risk-engine unification — once paper-forward
   proves the spread engine tracks the backtest.
6. **Later (approaching funded):** prop-firm sim, full dashboards, SMS/Slack alerting suite.

Do not jump ahead. Each step de-risks the next.
