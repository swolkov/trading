import { prisma } from "@/lib/db";
import { RECORD_SQL } from "@/lib/margin-shadow";

// ── COST OF CAPACITY ────────────────────────────────────────────────────────────────────────
// The live book has a hard number of slots (free margin ÷ one position's margin — two at the
// 2× rung). Every high-conviction setup the executor REFUSED for lack of a slot, the cooldown,
// or the daily cap still ran on paper to a finish. This module answers, with the record and
// not with a guess, "what did the setups we could not take go on to do?" and "with N slots,
// what would the same stream of setups have earned?" — the number behind the max-positions
// decision at the next leverage rung. Read-only. Paper dollars are at paper's base risk;
// `liveFactor` scales them to the live base (stage 3 = half).

export type RefusalKind = "taken" | "slots" | "cooldown" | "daily cap" | "other";

export interface CapacitySetup {
  id: number; time: string; symbol: string; timeframe: string | null;
  kind: RefusalKind; note: string | null;
  status: "open" | "resolved"; pnl: number | null; unrealized: number | null; resolvedAt: string | null;
}

export interface ReplayConfig { slots: number; perDay: number; cooldownMin: number }
export interface ReplayResult {
  slots: number; taken: number; resolved: number; open: number;
  net: number;        // resolved paper P&L of the trades this configuration would have taken
  floating: number;   // unrealized paper P&L of the ones still open
}

export function classifyRefusal(liveTxid: string | null, note: string | null): RefusalKind {
  if (liveTxid) return "taken";
  if (!note) return "other";
  if (/positions\+resting orders already/.test(note)) return "slots";
  if (/cooldown/.test(note)) return "cooldown";
  if (/trades already today/.test(note)) return "daily cap";
  return "other";
}

// Replays the executor's admission rules over a time-ordered stream of setups: a setup is
// taken when a slot is free (positions that have not resolved by then occupy one), the
// cooldown since the last taken entry has elapsed, and the UTC day's cap is not reached.
// Setups are the paper rows, so a taken setup occupies its slot until its paper resolution.
// `slots: 0` = no admission rules at all (every setup in the stream).
export function replaySlots(setups: CapacitySetup[], cfg: ReplayConfig): ReplayResult {
  const ordered = [...setups].sort((a, b) => new Date(a.time).getTime() - new Date(b.time).getTime());
  const occupied: number[] = [];               // resolution times (ms) of taken, still-open trades
  const perDay: Record<string, number> = {};
  let lastEntry = -Infinity;
  const out: ReplayResult = { slots: cfg.slots, taken: 0, resolved: 0, open: 0, net: 0, floating: 0 };
  for (const s of ordered) {
    const t = new Date(s.time).getTime();
    if (!Number.isFinite(t)) continue;
    while (occupied.length && occupied[0] <= t) occupied.shift();
    if (cfg.slots > 0 && occupied.length >= cfg.slots) continue;
    if (t - lastEntry < cfg.cooldownMin * 60_000) continue;
    const day = new Date(t).toISOString().slice(0, 10);
    if ((perDay[day] ?? 0) >= cfg.perDay) continue;
    const end = s.status === "resolved" && s.resolvedAt ? new Date(s.resolvedAt).getTime() : Number.POSITIVE_INFINITY;
    occupied.push(end); occupied.sort((a, b) => a - b);
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
  refused: { total: number; slots: number; cooldown: number; dailyCap: number; other: number };
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
    cfgNum("kraken_margin_max_positions", 1), cfgNum("kraken_margin_max_trades_per_day", 3), cfgNum("kraken_margin_cooldown_min", 30),
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
  const replay = [1, 2, 3, 4].map((n) => replaySlots(setups, { slots: n, perDay, cooldownMin }));
  replay.push(replaySlots(setups, { slots: 0, perDay: Number.POSITIVE_INFINITY, cooldownMin: 0 }));
  return {
    source, since, liveFactor, rules,
    setups: setups.length, taken: setups.filter((s) => s.kind === "taken").length,
    refused: { total: refusedRows.length, slots: count("slots"), cooldown: count("cooldown"), dailyCap: count("daily cap"), other: count("other") },
    refusedOutcome: {
      resolved: rr.length, wins: rr.filter((s) => (s.pnl ?? 0) > 0).length, net: rr.reduce((a, s) => a + (s.pnl ?? 0), 0),
      open: ro.length, floating: ro.reduce((a, s) => a + (s.unrealized ?? 0), 0),
    },
    replay,
    ledger: [...setups].reverse(),
  };
}
