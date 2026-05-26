# Databento Migration — phased, lean, execution stays on Tradovate

*Last updated 2026-05-25. Goal: ONE canonical market-data source (Databento) across research, replay,
paper-forward, and live inputs — while Tradovate remains the broker/execution + account-state layer.
Staged, validation-first, and explicitly NOT a big-bang rewrite. Spread-engine forward validation stays priority #1.*

> **Architecture target:** Databento = market data · Tradovate = execution + account state · Yahoo =
> last-resort fallback (removed once the live feed is proven). Strategies consume a **canonical bar/quote
> interface**, never a vendor API directly.

## Key codebase facts that shape this (verified)
- **Historical Databento = plain REST from Node** (`hist.databento.com`, already used by `dbn-fetch-daily.ts`).
  So Phases 1–3 are pure TypeScript. **No Python needed for historical/research.**
- **Live Databento = Python/C++/Rust only** (no Node SDK — confirmed at signup). So the live feed needs a
  small **Python sidecar**; everything else stays Node.
- **2-device limit (Standard):** ONE sidecar streams once and republishes to BOTH engines via Postgres →
  stays in budget, no duplicate subscription.
- **Current MD chain (engine):** Tradovate WS → Tradovate REST `getChart` → demo MD → **Yahoo poll**. Databento
  slots in as a new highest-priority source; if it's stale/missing the existing chain runs unchanged (safe).

---

## PHASE 1 — Parallel validation  ← IN PROGRESS
**1a. Databento vs Yahoo (historical 1m) — DONE** (`scripts/md-validate.ts`). Finding (ES/NQ/GC, 7 days):

| metric | result |
|--------|--------|
| coverage | both ~23/24 UTC hrs — Yahoo *does* cover ETH for liquid indices |
| OHLC close | mean \|Δ\| **0.000%**, max \|Δ\| 0.25–0.38% (rare single-minute bad ticks) |
| volume | Databento real vol on **every** bar; Yahoo ~99% (occasional zero/missing) |
| exclusive bars | ~110 only-Yahoo (likely forward-filled no-trade minutes), ~5–41 only-Databento |

**Honest read:** for *liquid index* futures on 1m, Yahoo is closer than expected — Databento isn't fixing a
broken feed there. The migration is justified on **consistency (one canonical source), clean real volume,
real-time streaming (vs poll lag), order-book extensibility, and the *less-liquid spread legs*** (CL/RB,
ZC/ZS, 6E/6B… — where Yahoo gaps are likely worse; tested next). So: **don't rush to *remove* Yahoo; do
migrate to Databento as primary.** Yahoo stays as a harmless last-resort fallback.

**1b. Tradovate vs Databento (live parallel) — TODO** (needs the sidecar): log both engines' quotes
side-by-side during a live session → discrepancy/lag report. Also re-run 1a on the **spread legs**, not just indices.

## PHASE 2 — Canonical market-data layer
A single abstraction; strategies stop touching vendor APIs:
```ts
interface Bar { ts: number; o: number; h: number; l: number; c: number; v: number; symbol: string; }
interface MarketDataAdapter {
  getBars(symbol: string, interval: string, start: Date, end: Date): Promise<Bar[]>;  // historical
  subscribe?(symbols: string[], onBar: (b: Bar) => void): void;                        // live
}
```
Adapters behind it: **DatabentoAdapter** (REST historical + reads the sidecar's `live_quotes` table),
**TradovateAdapter** (existing getChart/WS — kept for fallback/compare), **ReplayAdapter** (parquet/CSV for backtests).
Plus ONE symbol-normalization map and ONE session model (ETH/RTH, DST-aware — reuse `session-time.ts`).

## PHASE 3 — Research standardization
Re-pull canonical datasets from Databento (`ohlcv-1m`/`ohlcv-1d`) → **parquet/DuckDB**, reproducible replay
sessions. Retire scattered CSVs over time. The spread lab + paper-forward read the canonical store.

## PHASE 4 — Live engine data switch (only after validation)
Add a **Python sidecar** (`databento` live, `mbp-1`/`trades`) → upserts latest L1 to a `live_quotes(symbol,
bid, ask, last, ts)` Postgres table. Engine MD layer gains `fetchDatabentoQuotes()` (reads `live_quotes`,
freshness-checked) as the **primary** source; Tradovate/Yahoo remain fallbacks. **Execution routing does NOT
change — Tradovate stays the broker.** Roll to DEMO first, validate a full session, then LIVE in a safe window.

**STATUS (2026-05-26): BUILT + PROVEN, not yet activated.** `scripts/databento-md-sidecar.py` streams
ES/NQ/GC mbp-1 → `live_quotes` (verified live: real-time bid/ask written for all three). Engine
`fetchDatabentoQuotes()` is committed, **gated OFF** (`DATABENTO_MD_ENABLED`), fail-safe (stale/missing →
existing Tradovate→Yahoo chain, unchanged). **Not pushed yet on purpose:** deploying = a live-engine restart,
and the reader is inert until the sidecar is hosted — so activation is staged to avoid disturbing the first
Phase-0 trade.

**Activation runbook (one monitored session, market open, NOT right before a live trade):**
1. Host the sidecar persistently (Railway Python service or macOS launchd) so `live_quotes` stays fresh.
2. Push the engine reader (restarts both engines — pick a window with no live trade in flight).
3. Set `DATABENTO_MD_ENABLED=true` on the **DEMO** service only → confirm demo logs show
   `[MD] Databento primary: N fresh symbols`, prices match `live_quotes`, and fail-safe works (stop sidecar → Yahoo resumes).
4. After a clean demo session, set `DATABENTO_MD_ENABLED=true` on **LIVE**.
5. Then demote Yahoo to last-resort only.

## PHASE 5 — Order-book pipeline (optional R&D)
Once canonical bars are stable: pull `mbp-1`/`mbp-10`/`trades` (1mo L2 included, usage-based beyond) for
execution-realism + microstructure R&D (the Tier-3 hypotheses). Replay tooling for feature engineering.

---

## Sequencing & guardrails
1. **Validate** (Phase 1) — offline, safe. ← here. Extend 1a to spread legs; do 1b after sidecar.
2. **Canonical layer** (Phase 2) — refactor behind an interface; no behavior change.
3. **Research standardization** (Phase 3).
4. **Live bar switch** (Phase 4) — demo first, then live in a safe window. Execution unchanged.
5. **Order-book tooling** (Phase 5).

**Hard rules:** do NOT destabilize live execution; do NOT touch the live MD path before tomorrow's Phase-0
trade (Yahoo is fine for one MES order); keep it lean (no infra sprawl — one sidecar, one DB table, one
interface). **Spread-engine forward validation remains priority #1** — this migration serves it, doesn't displace it.
