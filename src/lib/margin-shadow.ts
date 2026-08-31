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
    "shadow_peak double precision",   // best favorable price reached (for the trailing stop)
    "shadow_stop double precision",   // current trailing stop level (ratchets, never loosens)
  ]) {
    await prisma.$executeRawUnsafe(`ALTER TABLE tradingview_alerts ADD COLUMN IF NOT EXISTS ${col}`);
  }
}

export interface ShadowResolution {
  id: number; symbol: string; side: string; entry: number; exit: number;
  pnl: number; pnlPct: number; reason: string; leverage: number;
}

interface OpenRow {
  id: number; time: Date; symbol: string; side: string; leverage: number | null;
  mark_price: number; shadow_peak: number | null; shadow_stop: number | null;
}

// Follow every open tracked entry with a MANAGED exit — the "stay in the trade, profit
// more, get out when it turns" discipline Spencer's give-back problem needs:
//   • Initial stop 1R below entry (0.3/leverage).
//   • Once up +1R, the stop jumps to BREAKEVEN (the trade can no longer lose).
//   • Beyond +1R, the stop TRAILS 1R behind the best price reached — locking in more as
//     the move extends, and cutting the trade when it pulls back 1R from the peak.
//   • 48h time stop as a backstop.
// Peak/stop are persisted per signal, so trailing works across 5-min evaluations.
// Conservative by design: 5-min granularity misses intra-run spikes, so it UNDER-counts
// trailing capture (a real Kraken trailing stop would do at least this well).
export async function evaluateShadowSignals(perTradeUsd: number): Promise<ShadowResolution[]> {
  await ensureShadowColumns();
  const rows = await prisma.$queryRawUnsafe<OpenRow[]>(
    `SELECT id, time, symbol, side, leverage, mark_price, shadow_peak, shadow_stop
     FROM tradingview_alerts
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
    const entry = r.mark_price;
    const lev = Math.max(2, Math.min(20, r.leverage || 2));
    const dir = r.side === "buy" ? 1 : -1;
    const oneR = entry * (0.3 / lev);          // 1R in price terms
    const ageH = (Date.now() - r.time.getTime()) / 3600_000;

    const now = price[r.symbol];
    // No fresh price this run: normally skip — but still honor the 48h time stop so a
    // persistently-unpriceable signal can't sit "open" forever. Resolve flat (at entry),
    // which after fees is a small loss.
    if (!(now > 0)) {
      if (ageH >= MAX_HOLD_H) {
        const rollPeriods = Math.ceil(ageH / 4);
        const netPct = -MAKER - TAKER - rollPeriods * rollover4h(r.symbol);
        const pnl = netPct * perTradeUsd * lev;
        await prisma.$executeRawUnsafe(
          `UPDATE tradingview_alerts SET shadow_status='resolved', shadow_exit=$1, shadow_pnl=$2, shadow_reason=$3, shadow_resolved_at=now() WHERE id=$4`,
          entry, pnl, "48h time stop (no price)", r.id,
        );
        resolved.push({ id: r.id, symbol: r.symbol, side: r.side, entry, exit: entry, pnl, pnlPct: netPct, reason: "48h time stop (no price)", leverage: lev });
      }
      continue;
    }

    // Peak favorable price + trailing stop, carried across runs.
    let peak = r.shadow_peak ?? entry;
    peak = dir > 0 ? Math.max(peak, now) : Math.min(peak, now);
    let stopPx = r.shadow_stop ?? entry - dir * oneR;
    const peakR = (dir * (peak - entry)) / oneR;    // best profit reached, in R
    if (peakR >= 1) {
      // Breakeven once +1R, then trail 1R behind the peak — ratchet only (never loosen).
      const trail = peak - dir * oneR;
      const candidate = dir > 0 ? Math.max(entry, trail) : Math.min(entry, trail);
      stopPx = dir > 0 ? Math.max(stopPx, candidate) : Math.min(stopPx, candidate);
    }

    // Exit checks.
    const hitStop = dir > 0 ? now <= stopPx : now >= stopPx;
    let exit: number | null = null;
    let reason = "";
    if (hitStop) {
      exit = stopPx;
      // Mechanism only — the P&L number carries whether it was actually a profit; at
      // exact breakeven the round-trip fees still make it a small loss, so don't claim
      // "profit" in the label.
      reason = peakR >= 1 ? "trailing stop" : "initial stop";
    } else if (ageH >= MAX_HOLD_H) {
      exit = now;
      reason = "48h time stop";
    }

    if (exit == null) {
      // Still open — persist the updated peak/stop so trailing continues next run.
      await prisma.$executeRawUnsafe(
        `UPDATE tradingview_alerts SET shadow_peak=$1, shadow_stop=$2 WHERE id=$3`,
        peak, stopPx, r.id,
      );
      continue;
    }

    const grossPct = (dir * (exit - entry)) / entry;
    const rollPeriods = Math.ceil(ageH / 4);
    // Net of maker entry + taker exit + per-coin rollover on notional (leverage-scaled).
    const netPct = grossPct - MAKER - TAKER - rollPeriods * rollover4h(r.symbol);
    const notional = perTradeUsd * lev;
    const pnl = netPct * notional;

    await prisma.$executeRawUnsafe(
      `UPDATE tradingview_alerts SET shadow_status='resolved', shadow_exit=$1, shadow_pnl=$2, shadow_reason=$3, shadow_resolved_at=now(), shadow_peak=$4, shadow_stop=$5 WHERE id=$6`,
      exit, pnl, reason, peak, stopPx, r.id,
    );
    resolved.push({ id: r.id, symbol: r.symbol, side: r.side, entry, exit, pnl, pnlPct: netPct, reason, leverage: lev });
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
