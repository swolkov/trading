import { prisma } from "@/lib/db";
import { RECORD_SQL } from "@/lib/margin-shadow";
import { usRetailMaxLeverage } from "@/lib/kraken-pairs";
import { DEFAULT_MAX_LEVERAGE, effectiveMaxLeverage, leverageThatFitsStop, liveContainerFor, liveNotional, MIN_ENTRY_MARGIN_LEVEL } from "@/lib/margin-live-risk";

// ── COST OF CAPACITY ────────────────────────────────────────────────────────────────────────
// The live book has a hard number of slots (free margin ÷ one position's margin — two at the
// 2× rung). Every high-conviction setup the executor REFUSED for lack of a slot, the cooldown,
// or the daily cap still ran on paper to a finish. This module answers, with the record and
// not with a guess, "what did the setups we could not take go on to do?" and "with N slots,
// what would the same stream of setups have earned?" — the number behind the max-positions
// decision at the next leverage rung. Read-only. Paper dollars are at paper's base risk;
// `liveFactor` scales them to the live base (stage 3 = half).

export type RefusalKind = "taken" | "slots" | "cooldown" | "daily cap" | "margin" | "leverage" | "other";

export interface CapacitySetup {
  id: number; time: string; symbol: string; timeframe: string | null;
  kind: RefusalKind; note: string | null;
  status: "open" | "resolved"; pnl: number | null; unrealized: number | null; resolvedAt: string | null;
}

/**
 * `margin` makes the replay model what a slot COSTS, not just how many there are.
 *
 * Until 2026-09-09 every slot was interchangeable, which was true while the whole desk ran
 * at 2×. It is not true now: margin is notional ÷ leverage and Kraken's leverage is per
 * COIN, so at the same risk a position costs ~$940 on a 9× major and ~$4,172 on a 2× venue
 * like XLM. The executor's 150% entry floor then refuses the expensive ones outright. A
 * replay that counts slots therefore OVERSTATES what the desk could have taken, and it
 * overstates it most on exactly the low-leverage coins where the refusals actually happen.
 *
 * Omit `margin` and the replay behaves exactly as before (slots only) — the existing
 * capacity card and its tests are unchanged.
 */
export interface ReplayMargin { equity: number; riskFrac: number; stopFrac: number; floorPct: number }
export interface ReplayConfig { slots: number; perDay: number; cooldownMin: number; margin?: ReplayMargin }
export interface ReplayResult {
  slots: number; taken: number; resolved: number; open: number;
  net: number;        // resolved paper P&L of the trades this configuration would have taken
  floating: number;   // unrealized paper P&L of the ones still open
  refusedByMargin: number;   // setups a free slot existed for, but the margin floor still blocked
}

export function classifyRefusal(liveTxid: string | null, note: string | null): RefusalKind {
  if (liveTxid) return "taken";
  if (!note) return "other";
  if (/positions\+resting orders already/.test(note)) return "slots";
  if (/cooldown/.test(note)) return "cooldown";
  if (/trades already today/.test(note)) return "daily cap";
  // Added 2026-09-09 with the margin-level floor and the leverage/stop clamp. Without these
  // two the ledger filed both under "other", which is where reasons go to be ignored — and
  // "margin level" is now the binding refusal on the low-leverage coins, so it is exactly
  // the one an operator needs to see named.
  if (/margin level/.test(note)) return "margin";
  if (/leverage clamp/.test(note)) return "leverage";
  return "other";
}

// Replays the executor's admission rules over a time-ordered stream of setups: a setup is
// taken when a slot is free (positions that have not resolved by then occupy one), the
// cooldown since the last taken entry has elapsed, and the UTC day's cap is not reached.
// Setups are the paper rows, so a taken setup occupies its slot until its paper resolution.
// `slots: 0` = no admission rules at all (every setup in the stream).
/** What one position on this coin costs in margin, at the executor's own applied leverage. */
export function setupMarginUsd(symbol: string, m: ReplayMargin): { margin: number; leverage: number } {
  const venue = usRetailMaxLeverage(symbol, 2);
  const leverage = leverageThatFitsStop(m.stopFrac * 100, Math.min(effectiveMaxLeverage(DEFAULT_MAX_LEVERAGE, m.equity), venue));
  const notional = liveNotional(m.equity, m.riskFrac, m.stopFrac, leverage, 0, m.equity);
  return { margin: leverage > 0 ? notional / leverage : Number.POSITIVE_INFINITY, leverage };
}

export function replaySlots(setups: CapacitySetup[], cfg: ReplayConfig): ReplayResult {
  const ordered = [...setups].sort((a, b) => new Date(a.time).getTime() - new Date(b.time).getTime());
  const occupied: { end: number; margin: number }[] = [];   // taken trades still open
  const perDay: Record<string, number> = {};
  let lastEntry = -Infinity;
  const out: ReplayResult = { slots: cfg.slots, taken: 0, resolved: 0, open: 0, net: 0, floating: 0, refusedByMargin: 0 };
  for (const s of ordered) {
    const t = new Date(s.time).getTime();
    if (!Number.isFinite(t)) continue;
    for (let i = occupied.length - 1; i >= 0; i--) if (occupied[i].end <= t) occupied.splice(i, 1);
    if (cfg.slots > 0 && occupied.length >= cfg.slots) continue;
    if (t - lastEntry < cfg.cooldownMin * 60_000) continue;
    const day = new Date(t).toISOString().slice(0, 10);
    if ((perDay[day] ?? 0) >= cfg.perDay) continue;
    // The margin gate, when modelled: this coin's own leverage decides what the position
    // costs, and the entry is refused if it would leave the book under the floor — which is
    // what the live executor now does, and what a slot count alone cannot see.
    let cost = 0;
    if (cfg.margin) {
      const used = occupied.reduce((a, o) => a + o.margin, 0);
      const { margin } = setupMarginUsd(s.symbol, cfg.margin);
      const after = used + margin;
      const level = after > 0 ? (cfg.margin.equity / after) * 100 : Number.POSITIVE_INFINITY;
      if (!Number.isFinite(margin) || level < cfg.margin.floorPct) { out.refusedByMargin++; continue; }
      cost = margin;
    }
    const end = s.status === "resolved" && s.resolvedAt ? new Date(s.resolvedAt).getTime() : Number.POSITIVE_INFINITY;
    occupied.push({ end, margin: cost });
    lastEntry = t; perDay[day] = (perDay[day] ?? 0) + 1;
    out.taken++;
    if (s.status === "resolved") { out.resolved++; out.net += s.pnl ?? 0; }
    else { out.open++; out.floating += s.unrealized ?? 0; }
  }
  return out;
}

export interface CapacityReport {
  source: string; since: string; liveFactor: number;
  rules: { slots: number; perDay: number; cooldownMin: number };
  setups: number; taken: number;
  refused: { total: number; slots: number; cooldown: number; dailyCap: number; margin: number; leverage: number; other: number };
  // What the refused setups went on to do, paper-sized.
  refusedOutcome: { resolved: number; wins: number; net: number; open: number; floating: number };
  replay: ReplayResult[];                       // slots 1..4 under the current per-day + cooldown, then every setup (slots 0)
  ledger: CapacitySetup[];                      // every setup since arming, newest first
}

const TF_SQL = `COALESCE(substring(note from '(5m|15m|1h|4h|1d)'), '?')`;

async function cfgNum(key: string, dflt: number): Promise<number> {
  const v = await prisma.agentConfig.findUnique({ where: { key } }).then((r) => (r?.value != null ? parseFloat(r.value) : NaN)).catch(() => NaN);
  return Number.isFinite(v) ? v : dflt;
}

// null = not armed yet (no stage-3 clock to measure from).
export async function capacityReport(source: string): Promise<CapacityReport | null> {
  // The stage-3 clock (kraken_margin_stage3, written by the arm switch) is "since arming".
  let stage3: { startedAt?: string; fromBase?: number } | null = null;
  try { const raw = (await prisma.agentConfig.findUnique({ where: { key: "kraken_margin_stage3" } }))?.value; stage3 = raw ? JSON.parse(raw) : null; } catch { stage3 = null; }
  if (!stage3?.startedAt) return null;
  const since = stage3.startedAt;
  const [slots, perDay, cooldownMin, liveBase, paperBase] = await Promise.all([
    // Defaults track the executor's own (3 slots, 6/day) — they were 1 and 3, left over from
    // the single-slot arming, so the capacity card was modelling a desk half the size of the
    // real one whenever the keys were unset.
    cfgNum("kraken_margin_max_positions", 3), cfgNum("kraken_margin_max_trades_per_day", 6), cfgNum("kraken_margin_cooldown_min", 30),
    cfgNum("kraken_margin_live_max_risk_pct", stage3.fromBase ?? 1.5), cfgNum("kraken_margin_max_risk_pct", 3),
  ]);
  const liveFactor = paperBase > 0 ? liveBase / paperBase : 0.5;
  const rows = await prisma.$queryRawUnsafe<{
    id: number; time: Date; symbol: string; tf: string; live_txid: string | null; live_exec_note: string | null;
    shadow_status: string | null; shadow_pnl: number | null; shadow_unrealized: number | null; shadow_resolved_at: Date | null;
  }[]>(
    `SELECT id, time, symbol, ${TF_SQL} AS tf, live_txid, live_exec_note, shadow_status, shadow_pnl, shadow_unrealized, shadow_resolved_at
     FROM tradingview_alerts
     WHERE source=$1 AND side='buy' AND mark_price > 0 AND ${RECORD_SQL} AND time >= $2::timestamptz
     ORDER BY time ASC`,
    source, since,
  );
  const setups: CapacitySetup[] = rows.map((r) => ({
    id: r.id, time: r.time.toISOString(), symbol: r.symbol, timeframe: r.tf === "?" ? null : r.tf,
    kind: classifyRefusal(r.live_txid, r.live_exec_note), note: r.live_exec_note,
    status: r.shadow_status === "resolved" ? "resolved" : "open",
    pnl: r.shadow_status === "resolved" ? r.shadow_pnl : null,
    unrealized: r.shadow_status === "resolved" ? null : r.shadow_unrealized,
    resolvedAt: r.shadow_resolved_at?.toISOString() ?? null,
  }));
  const refusedRows = setups.filter((s) => s.kind !== "taken");
  const count = (k: RefusalKind) => refusedRows.filter((s) => s.kind === k).length;
  const rr = refusedRows.filter((s) => s.status === "resolved");
  const ro = refusedRows.filter((s) => s.status === "open");
  const rules = { slots, perDay, cooldownMin };
  // Model what each slot COSTS, not just how many exist. Equity comes from the guardian's
  // last read; without it the replay falls back to slot-counting, which is what it did before.
  let margin: ReplayMargin | undefined;
  try {
    const ws = (await prisma.agentConfig.findUnique({ where: { key: "margin_watch_state" } }))?.value;
    const eq = ws ? Number((JSON.parse(ws) as { lastEquity?: number }).lastEquity) : NaN;
    const container = liveContainerFor(source);
    if (Number.isFinite(eq) && eq > 0 && container) {
      margin = { equity: eq, riskFrac: (liveBase * 2) / 100, stopFrac: container.stopPct / 100, floorPct: MIN_ENTRY_MARGIN_LEVEL };
    }
  } catch { margin = undefined; }
  const replay = [1, 2, 3, 4].map((n) => replaySlots(setups, { slots: n, perDay, cooldownMin, margin }));
  replay.push(replaySlots(setups, { slots: 0, perDay: Number.POSITIVE_INFINITY, cooldownMin: 0, margin }));
  return {
    source, since, liveFactor, rules,
    setups: setups.length, taken: setups.filter((s) => s.kind === "taken").length,
    refused: { total: refusedRows.length, slots: count("slots"), cooldown: count("cooldown"), dailyCap: count("daily cap"), margin: count("margin"), leverage: count("leverage"), other: count("other") },
    refusedOutcome: {
      resolved: rr.length, wins: rr.filter((s) => (s.pnl ?? 0) > 0).length, net: rr.reduce((a, s) => a + (s.pnl ?? 0), 0),
      open: ro.length, floating: ro.reduce((a, s) => a + (s.unrealized ?? 0), 0),
    },
    replay,
    ledger: [...setups].reverse(),
  };
}
