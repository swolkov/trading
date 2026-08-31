// Shadow evaluator — follows every TRACKED TradingView signal to a win or loss so
// Spencer sees "that ETH long would have made +$X / stopped out −$Y" without a cent at
// risk. This is what makes tracked mode meaningful: a real, scored paper record built
// from his own alerts, at honest sizing and fees.
//
// Each tracked entry is treated exactly as the executor would place it: sized at
// per-trade × leverage, a stop at 0.3/leverage, a 2R target, and a 48h time stop. The
// evaluator marks each open signal against the live market and resolves it the moment a
// level is hit. Awareness only — it places nothing.
import { prisma } from "@/lib/db";
import { krakenPublic } from "@/lib/kraken";
import { publicPairFor, pairBase } from "@/lib/kraken-pairs";

// FEE MODEL — an honest ESTIMATE, not exact truth (that's the real scoreboard, which
// reads actual fills+fees from Kraken's ledger). Modeled: maker entry + taker exit on
// notional, plus the 4-HOURLY margin rollover which is charged on NOTIONAL — so higher
// leverage pays proportionally more (2x on $100 = $200 notional; 10x = $1,000), which is
// exactly how Kraken bills it. Rollover is per-coin (BTC cheaper than alts). These rates
// are Spencer's current US-margin tier; they drift if his fee tier or Kraken's rates change.
const MAKER = 0.001;    // ~0.10% entry (post-only limit)
const TAKER = 0.0018;   // ~0.18% exit (stop/target = market)
const MAX_HOLD_H = 48;
// Per-4h rollover on notional, by coin (from measured Kraken funding: BTC lowest).
const ROLLOVER_4H: Record<string, number> = { BTC: 0.00015, ETH: 0.0003, SOL: 0.0003 };
const ROLLOVER_DEFAULT = 0.0003;
function rollover4h(symbol: string): number {
  return ROLLOVER_4H[pairBase(symbol)] ?? ROLLOVER_DEFAULT;
}

// Add resolution columns to the existing alerts table (idempotent).
export async function ensureShadowColumns(): Promise<void> {
  await prisma.$executeRawUnsafe(`CREATE TABLE IF NOT EXISTS tradingview_alerts (
    id serial PRIMARY KEY, time timestamptz DEFAULT now(), symbol text, side text,
    leverage double precision, note text, mark_price double precision,
    executed boolean DEFAULT false, validated boolean DEFAULT false, exec_note text)`);
  for (const col of [
    "shadow_status text",        // null/open → resolved
    "shadow_exit double precision",
    "shadow_pnl double precision",
    "shadow_reason text",
    "shadow_resolved_at timestamptz",
  ]) {
    await prisma.$executeRawUnsafe(`ALTER TABLE tradingview_alerts ADD COLUMN IF NOT EXISTS ${col}`);
  }
}

export interface ShadowResolution {
  id: number; symbol: string; side: string; entry: number; exit: number;
  pnl: number; pnlPct: number; reason: string; leverage: number;
}

interface OpenRow {
  id: number; time: Date; symbol: string; side: string; leverage: number | null; mark_price: number;
}

// Resolve every open tracked entry that has hit its stop, target, or time limit.
export async function evaluateShadowSignals(perTradeUsd: number): Promise<ShadowResolution[]> {
  await ensureShadowColumns();
  const rows = await prisma.$queryRawUnsafe<OpenRow[]>(
    `SELECT id, time, symbol, side, leverage, mark_price FROM tradingview_alerts
     WHERE side IN ('buy','sell') AND mark_price > 0 AND COALESCE(shadow_status,'open') = 'open'
     ORDER BY time ASC LIMIT 200`,
  );
  if (!rows.length) return [];

  // One price lookup per distinct symbol.
  const symbols = [...new Set(rows.map((r) => r.symbol))];
  const price: Record<string, number> = {};
  for (const sym of symbols) {
    try {
      const res = await krakenPublic("Ticker", { pair: publicPairFor(sym.replace("XBT", "BTC")) });
      const c = (Object.values(res)[0] as { c?: string[] })?.c?.[0];
      if (c) price[sym] = parseFloat(c);
    } catch { /* skip this symbol this run */ }
    await new Promise((r) => setTimeout(r, 120));
  }

  const resolved: ShadowResolution[] = [];
  for (const r of rows) {
    const now = price[r.symbol];
    if (!(now > 0)) continue;
    const lev = Math.max(2, Math.min(20, r.leverage || 2));
    const dir = r.side === "buy" ? 1 : -1;
    const stopFrac = 0.3 / lev;        // matches the executor's default stop
    const targetFrac = 2 * stopFrac;   // 2R
    const stopPx = r.mark_price * (1 - dir * stopFrac);
    const targetPx = r.mark_price * (1 + dir * targetFrac);
    const ageH = (Date.now() - r.time.getTime()) / 3600_000;

    let exit: number | null = null;
    let reason = "";
    // Direction-aware level checks against the current price.
    if (dir > 0 ? now <= stopPx : now >= stopPx) { exit = stopPx; reason = "stop hit"; }
    else if (dir > 0 ? now >= targetPx : now <= targetPx) { exit = targetPx; reason = "target hit (2R)"; }
    else if (ageH >= MAX_HOLD_H) { exit = now; reason = "48h time stop"; }
    if (exit == null) continue;

    const grossPct = dir * (exit - r.mark_price) / r.mark_price;
    const rollPeriods = Math.ceil(ageH / 4);
    // Net of maker entry + taker exit + per-coin rollover on notional (all leverage-scaled
    // because they apply to notional = perTrade × leverage).
    const netPct = grossPct - MAKER - TAKER - rollPeriods * rollover4h(r.symbol);
    const notional = perTradeUsd * lev;
    const pnl = netPct * notional;

    await prisma.$executeRawUnsafe(
      `UPDATE tradingview_alerts SET shadow_status='resolved', shadow_exit=$1, shadow_pnl=$2, shadow_reason=$3, shadow_resolved_at=now() WHERE id=$4`,
      exit, pnl, reason, r.id,
    );
    resolved.push({ id: r.id, symbol: r.symbol, side: r.side, entry: r.mark_price, exit, pnl, pnlPct: netPct, reason, leverage: lev });
  }
  return resolved;
}

// Tally of resolved shadow signals — the "would these signals have made money?" answer.
export interface ShadowScore {
  resolved: number; wins: number; hitRate: number | null; totalPnl: number;
  avgWin: number; avgLoss: number; open: number;
}
export async function shadowScore(): Promise<ShadowScore> {
  await ensureShadowColumns();
  const [agg] = await prisma.$queryRawUnsafe<{ resolved: bigint; wins: bigint; total: number | null; open: bigint }[]>(
    `SELECT
       count(*) FILTER (WHERE shadow_status='resolved')::bigint AS resolved,
       count(*) FILTER (WHERE shadow_status='resolved' AND shadow_pnl > 0)::bigint AS wins,
       COALESCE(sum(shadow_pnl) FILTER (WHERE shadow_status='resolved'),0)::float AS total,
       count(*) FILTER (WHERE side IN ('buy','sell') AND COALESCE(shadow_status,'open')='open')::bigint AS open
     FROM tradingview_alerts`,
  );
  const [wl] = await prisma.$queryRawUnsafe<{ avgwin: number | null; avgloss: number | null }[]>(
    `SELECT
       avg(shadow_pnl) FILTER (WHERE shadow_status='resolved' AND shadow_pnl > 0) AS avgwin,
       avg(shadow_pnl) FILTER (WHERE shadow_status='resolved' AND shadow_pnl <= 0) AS avgloss
     FROM tradingview_alerts`,
  );
  const resolved = Number(agg.resolved);
  return {
    resolved,
    wins: Number(agg.wins),
    hitRate: resolved > 0 ? Number(agg.wins) / resolved : null,
    totalPnl: agg.total || 0,
    avgWin: wl.avgwin || 0,
    avgLoss: wl.avgloss || 0,
    open: Number(agg.open),
  };
}
