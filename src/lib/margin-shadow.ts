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
// Calibrated to Spencer's REAL fills: 115 trades, $3,031 fees on $1.76M notional =
// 0.172%/side (~0.34% round trip) measured from kraken_my_trades. Exits here are always
// market (taker, higher); entries are post-only (maker, lower). Set slightly conservative
// (0.40% round trip) so the paper record never flatters a strategy on understated cost —
// the one bias that could wrongly green-light going live. Re-check if his fee tier changes.
const MAKER = 0.0015;   // ~0.15% entry (post-only limit / maker)
const TAKER = 0.0025;   // ~0.25% exit (stop/target = market / taker)
const MAX_HOLD_H = 48;
// Per-4h rollover on notional, by coin. Kraken's US-margin rates FLUCTUATE with market
// conditions (locked at execution, shown on the order form) — no static number is exact, so
// these are best estimates. BTC 0.015% is MEASURED from Spencer's real ledger (verified). ETH
// is a major (borrow ≈ BTC), estimated 0.02%. Other alts default 0.03% — within Kraken's
// published 0.01–0.05%/4h range and deliberately on the HIGH side, so paper overstates cost
// slightly (safe: never flatters a strategy). Only the LIVE view (real fills) is exact. As
// Spencer trades a coin on margin, recalibrate its rate here from the real kraken_my_ledger.
const ROLLOVER_4H: Record<string, number> = { BTC: 0.00015, ETH: 0.0002, SOL: 0.0003 };
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
    "conviction text",                // low/med/high — set on auto-opened trades (confluence)
    "conviction_score double precision",
    "source text",                    // which strategy generated it: 'scanner' | 'manual'
    "shadow_unrealized double precision",  // live mark-to-market P&L while open ("if closed now")
    "shadow_fees double precision",        // fee+rollover $ deducted on resolve (for gross-vs-net)
  ]) {
    await prisma.$executeRawUnsafe(`ALTER TABLE tradingview_alerts ADD COLUMN IF NOT EXISTS ${col}`);
  }
  // Backfill source on any pre-existing rows (auto-opened breakouts vs manual alerts).
  // Idempotent: only touches rows where source is still null.
  await prisma.$executeRawUnsafe(
    `UPDATE tradingview_alerts SET source = CASE WHEN note LIKE 'auto:%' THEN 'scanner' ELSE 'manual' END WHERE source IS NULL`,
  );
}

export interface ShadowResolution {
  id: number; symbol: string; side: string; entry: number; exit: number;
  pnl: number; pnlPct: number; reason: string; leverage: number; conviction: string | null;
}

interface OpenRow {
  id: number; time: Date; symbol: string; side: string; leverage: number | null;
  mark_price: number; shadow_peak: number | null; shadow_stop: number | null;
  conviction: string | null; source: string | null;
}

// Per-strategy exit profile. Fast breakouts cut quickly (tight, leverage-scaled stop, 2-day
// cap). Swings hold longer with a WIDER fixed stop so a multi-day move can breathe. Spot swings
// carry NO rollover — holding the coin outright borrows nothing; leveraged trades pay rollover
// on notional. This is what lets the scoreboard show where leverage stops being worth it.
function exitParams(source: string | null, lev: number, entry: number): { maxHoldH: number; oneR: number; carry: boolean } {
  if (source === "swing-spot") return { maxHoldH: 24 * 14, oneR: entry * 0.06, carry: false };
  if (source === "swing-lev") return { maxHoldH: 24 * 4, oneR: entry * 0.04, carry: true };
  // Fast-breakout A/B: same entries, different stop width — the scoreboard decides which earns
  // more. 'fast-tight' cuts a failed break fast (~2%, resolves in minutes-hours); 'scanner' is
  // the wide 6% control. Winner keeps trading, loser gets retired once the record is clear.
  if (source === "fast-tight") return { maxHoldH: MAX_HOLD_H, oneR: entry * 0.02, carry: lev > 1 };
  // Liquidity-sweep fade — mean-reversion: stop just beyond the swept wick (2.5%), quick
  // resolution (a real reversal moves fast; if it doesn't revert, the "sweep" was a true break).
  if (source === "sweep-fade") return { maxHoldH: 24, oneR: entry * 0.025, carry: lev > 1 };
  // Selective (high-conviction only): a better setup earns a bit more room (3% stop) + the
  // managed exit banks the green (breakeven at +1R, then trails). Fewer of these = tiny fee drag.
  if (source === "selective") return { maxHoldH: MAX_HOLD_H, oneR: entry * 0.03, carry: lev > 1 };
  return { maxHoldH: MAX_HOLD_H, oneR: entry * (0.3 / lev), carry: lev > 1 };
}

// RISK-BASED SIZING — mirrors the LIVE executor (margin-executor.ts:273-280): size the position
// so the INITIAL stop loses at most maxRiskPct of a reference account = a hard MAX LOSS per
// trade. A tighter stop → a BIGGER position for the SAME dollar risk (the real lever). Capped by
// leverage (can't hold more than lev × equity). This makes paper P&L read like real risk-managed
// trading — realistic size, fixed downside — instead of an arbitrary fixed stake.
export function positionNotional(source: string | null, lev: number, entry: number, refEquity: number, maxRiskPct: number): number {
  const { oneR } = exitParams(source, lev, entry);
  const stopDistPct = entry > 0 ? oneR / entry : 0;
  const levCap = refEquity * Math.max(1, lev);
  if (!(stopDistPct > 0) || !(maxRiskPct > 0)) return Math.min(refEquity, levCap);
  return Math.min((maxRiskPct * refEquity) / stopDistPct, levCap);
}

// CONVICTION-SCALED RISK — "bet bigger on the ones you know" (Spencer's instinct), done safely:
// high-conviction trades risk MORE (bigger position), low-conviction risk LESS — but every trade
// still has a HARD-capped max loss (never the 30%-of-account gamble). high=2×, low=0.5×, else 1×,
// applied to the base max_risk_pct and clamped to a 6% ceiling. This is the pro version of
// "size up on your best calls," and the fee-drag/scoreboard shows whether it pays.
const RISK_CEILING = 0.06;
function convictionRisk(conviction: string | null, baseRiskPct: number): number {
  const mult = conviction === "high" ? 2 : conviction === "low" ? 0.5 : 1;
  return Math.min(RISK_CEILING, baseRiskPct * mult);
}

// Reference account + max-risk for paper sizing (config-driven; defaults ≈ Spencer's account so
// the paper dollars are realistic). kraken_shadow_ref_equity and kraken_margin_max_risk_pct.
async function sizingParams(): Promise<{ refEquity: number; maxRiskPct: number }> {
  const eq = await prisma.agentConfig.findUnique({ where: { key: "kraken_shadow_ref_equity" } })
    .then((r) => (r?.value ? parseFloat(r.value) : NaN)).catch(() => NaN);
  const risk = await prisma.agentConfig.findUnique({ where: { key: "kraken_margin_max_risk_pct" } })
    .then((r) => (r?.value ? parseFloat(r.value) : NaN)).catch(() => NaN);
  return {
    refEquity: Number.isFinite(eq) && eq > 0 ? eq : 5000,
    maxRiskPct: (Number.isFinite(risk) && risk > 0 ? risk : 3) / 100,
  };
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
export async function evaluateShadowSignals(): Promise<ShadowResolution[]> {
  await ensureShadowColumns();
  const { refEquity, maxRiskPct } = await sizingParams();
  const rows = await prisma.$queryRawUnsafe<OpenRow[]>(
    `SELECT id, time, symbol, side, leverage, mark_price, shadow_peak, shadow_stop, conviction, source
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
    const lev = Math.max(1, Math.min(20, r.leverage || 2));
    const dir = r.side === "buy" ? 1 : -1;
    const { maxHoldH, oneR, carry } = exitParams(r.source, lev, entry);   // per-strategy exit profile
    const notional = positionNotional(r.source, lev, entry, refEquity, convictionRisk(r.conviction, maxRiskPct));   // risk-based, bigger on high-conviction
    const timeStopLabel = `${Math.round(maxHoldH)}h time stop`;
    const ageH = (Date.now() - r.time.getTime()) / 3600_000;

    const now = price[r.symbol];
    // No fresh price this run: normally skip — but still honor the time stop so a
    // persistently-unpriceable signal can't sit "open" forever. Resolve flat (at entry),
    // which after fees is a small loss.
    if (!(now > 0)) {
      if (ageH >= maxHoldH) {
        const rollPeriods = Math.ceil(ageH / 4);
        const feeFrac = MAKER + TAKER + (carry ? rollPeriods * rollover4h(r.symbol) : 0);
        const netPct = -feeFrac;
        const pnl = netPct * notional;
        await prisma.$executeRawUnsafe(
          `UPDATE tradingview_alerts SET shadow_status='resolved', shadow_exit=$1, shadow_pnl=$2, shadow_reason=$3, shadow_resolved_at=now(), shadow_fees=$5 WHERE id=$4`,
          entry, pnl, `${timeStopLabel} (no price)`, r.id, feeFrac * notional,
        );
        resolved.push({ id: r.id, symbol: r.symbol, side: r.side, entry, exit: entry, pnl, pnlPct: netPct, reason: `${timeStopLabel} (no price)`, leverage: lev, conviction: r.conviction });
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
    } else if (ageH >= maxHoldH) {
      exit = now;
      reason = timeStopLabel;
    }

    if (exit == null) {
      // Still open — persist peak/stop for trailing, PLUS the live mark-to-market P&L: what
      // this trade would net if closed right now (gross at current price − entry maker − exit
      // taker − rollover accrued so far). Refreshed every 5 min so the log shows a live float.
      const uGross = (dir * (now - entry)) / entry;
      const uRoll = Math.ceil(ageH / 4);
      const uNet = uGross - MAKER - TAKER - (carry ? uRoll * rollover4h(r.symbol) : 0);
      const unrealized = uNet * notional;
      await prisma.$executeRawUnsafe(
        `UPDATE tradingview_alerts SET shadow_peak=$1, shadow_stop=$2, shadow_unrealized=$3 WHERE id=$4`,
        peak, stopPx, unrealized, r.id,
      );
      continue;
    }

    const grossPct = (dir * (exit - entry)) / entry;
    const rollPeriods = Math.ceil(ageH / 4);
    // Net of maker entry + taker exit + per-coin rollover on notional (leverage-scaled).
    // Spot swings (carry=false) pay NO rollover — nothing is borrowed.
    const feeFrac = MAKER + TAKER + (carry ? rollPeriods * rollover4h(r.symbol) : 0);
    const netPct = grossPct - feeFrac;
    const pnl = netPct * notional;
    const feeDollars = feeFrac * notional;   // the fee drag on this trade (for gross-vs-net)

    await prisma.$executeRawUnsafe(
      `UPDATE tradingview_alerts SET shadow_status='resolved', shadow_exit=$1, shadow_pnl=$2, shadow_reason=$3, shadow_resolved_at=now(), shadow_peak=$4, shadow_stop=$5, shadow_unrealized=NULL, shadow_fees=$7 WHERE id=$6`,
      exit, pnl, reason, peak, stopPx, r.id, feeDollars,
    );
    resolved.push({ id: r.id, symbol: r.symbol, side: r.side, entry, exit, pnl, pnlPct: netPct, reason, leverage: lev, conviction: r.conviction });
  }
  return resolved;
}

// Per-conviction-tier tally — the direct test of "do high-conviction breaks win more?".
export interface ConvictionTier {
  tier: string; resolved: number; wins: number; hitRate: number | null; totalPnl: number;
}

// Tally of resolved shadow signals — the "would these signals have made money?" answer.
export interface ShadowScore {
  resolved: number; wins: number; hitRate: number | null; totalPnl: number;
  avgWin: number; avgLoss: number; open: number; openUnrealized: number; byConviction: ConvictionTier[];
}
export async function shadowScore(): Promise<ShadowScore> {
  await ensureShadowColumns();
  const [agg] = await prisma.$queryRawUnsafe<{ resolved: bigint; wins: bigint; total: number | null; open: bigint; openfloat: number | null }[]>(
    `SELECT
       count(*) FILTER (WHERE shadow_status='resolved')::bigint AS resolved,
       count(*) FILTER (WHERE shadow_status='resolved' AND shadow_pnl > 0)::bigint AS wins,
       COALESCE(sum(shadow_pnl) FILTER (WHERE shadow_status='resolved'),0)::float AS total,
       count(*) FILTER (WHERE side IN ('buy','sell') AND COALESCE(shadow_status,'open')='open')::bigint AS open,
       COALESCE(sum(shadow_unrealized) FILTER (WHERE side IN ('buy','sell') AND COALESCE(shadow_status,'open')='open'),0)::float AS openfloat
     FROM tradingview_alerts`,
  );
  const [wl] = await prisma.$queryRawUnsafe<{ avgwin: number | null; avgloss: number | null }[]>(
    `SELECT
       avg(shadow_pnl) FILTER (WHERE shadow_status='resolved' AND shadow_pnl > 0) AS avgwin,
       avg(shadow_pnl) FILTER (WHERE shadow_status='resolved' AND shadow_pnl <= 0) AS avgloss
     FROM tradingview_alerts`,
  );
  const tiers = await prisma.$queryRawUnsafe<{ tier: string; resolved: bigint; wins: bigint; total: number | null }[]>(
    `SELECT COALESCE(conviction,'untagged') AS tier,
       count(*)::bigint AS resolved,
       count(*) FILTER (WHERE shadow_pnl > 0)::bigint AS wins,
       COALESCE(sum(shadow_pnl),0)::float AS total
     FROM tradingview_alerts WHERE shadow_status='resolved'
     GROUP BY COALESCE(conviction,'untagged')`,
  );
  const order: Record<string, number> = { high: 0, med: 1, low: 2, untagged: 3 };
  const byConviction: ConvictionTier[] = tiers
    .map((t) => ({
      tier: t.tier,
      resolved: Number(t.resolved),
      wins: Number(t.wins),
      hitRate: Number(t.resolved) > 0 ? Number(t.wins) / Number(t.resolved) : null,
      totalPnl: t.total || 0,
    }))
    .sort((a, b) => (order[a.tier] ?? 9) - (order[b.tier] ?? 9));

  const resolved = Number(agg.resolved);
  return {
    resolved,
    wins: Number(agg.wins),
    hitRate: resolved > 0 ? Number(agg.wins) / resolved : null,
    totalPnl: agg.total || 0,
    avgWin: wl.avgwin || 0,
    avgLoss: wl.avgloss || 0,
    open: Number(agg.open),
    openUnrealized: agg.openfloat || 0,
    byConviction,
  };
}

// PER-STRATEGY paper scoreboard — the "what's working" answer. Every paper trade is tagged
// with the strategy that generated it (scanner breakouts vs your manual TradingView alerts);
// this groups the resolved outcomes by strategy so each one's real edge is visible side by
// side. Expectancy (avg $ per trade after modeled fees) is the number that matters — a high
// hit rate with tiny wins and big losses still loses.
export interface StrategyStat {
  key: string; label: string; resolved: number; wins: number; hitRate: number | null;
  avgWin: number; avgLoss: number; expectancy: number | null; totalPnl: number; open: number;
  grossPnl: number; fees: number;   // gross (before fees) and the fee drag — net = gross − fees
  peakedGreen: number;    // resolved trades that were in profit at their PEAK — the give-back
                          // numerator: peakedGreen vs wins is "green that appeared vs green banked"
  tStat: number | null;   // t = mean × √n / std — is the net expectancy distinguishable from luck?
  verdict: string;        // rule-based: gathering / not paying / promising (could be luck) / REAL EDGE
}

// Rule-based verdict — the honest "does this work" call. Guards against reading luck as edge:
// needs a real sample (30+) AND positive net AND statistical significance (t≥2, ~95% it's not
// zero) before it says "REAL EDGE". Below t=2 a positive result could easily be luck — say so.
function strategyVerdict(resolved: number, net: number, tStat: number | null): string {
  if (resolved < 30) return `gathering (${resolved}/30)`;
  if (net <= 0) return "not paying";
  if (tStat != null && tStat >= 2) return "REAL EDGE — significant";
  return "promising (could be luck)";
}
const STRATEGY_LABELS: Record<string, string> = {
  scanner: "Fast — wide 6% stop (5x)",
  "fast-tight": "Fast — tight 2% stop — RETIRED Sep 1 (proven loser)",
  "swing-lev": "Leveraged swing (5x, ≤4d)",
  "swing-spot": "Spot swing (1x, ≤2w)",
  "sweep-fade": "Liquidity-sweep fade (5x)",
  selective: "Selective — high-conviction only (5x)",
  manual: "Manual alerts (yours)",
};
export async function strategyBreakdown(): Promise<StrategyStat[]> {
  await ensureShadowColumns();
  const rows = await prisma.$queryRawUnsafe<{
    source: string; resolved: bigint; wins: bigint; total: number | null;
    avgwin: number | null; avgloss: number | null; open: bigint; fees: number | null;
    meanpnl: number | null; stdpnl: number | null; peaked: bigint;
  }[]>(
    `SELECT COALESCE(source,'manual') AS source,
       count(*) FILTER (WHERE shadow_status='resolved')::bigint AS resolved,
       count(*) FILTER (WHERE shadow_status='resolved' AND shadow_pnl > 0)::bigint AS wins,
       count(*) FILTER (WHERE shadow_status='resolved' AND shadow_peak IS NOT NULL AND mark_price > 0
         AND ((side='buy' AND shadow_peak > mark_price) OR (side='sell' AND shadow_peak < mark_price)))::bigint AS peaked,
       COALESCE(sum(shadow_pnl) FILTER (WHERE shadow_status='resolved'),0)::float AS total,
       avg(shadow_pnl) FILTER (WHERE shadow_status='resolved' AND shadow_pnl > 0) AS avgwin,
       avg(shadow_pnl) FILTER (WHERE shadow_status='resolved' AND shadow_pnl <= 0) AS avgloss,
       count(*) FILTER (WHERE side IN ('buy','sell') AND COALESCE(shadow_status,'open')='open')::bigint AS open,
       COALESCE(sum(shadow_fees) FILTER (WHERE shadow_status='resolved'),0)::float AS fees,
       avg(shadow_pnl) FILTER (WHERE shadow_status='resolved') AS meanpnl,
       stddev_samp(shadow_pnl) FILTER (WHERE shadow_status='resolved') AS stdpnl
     FROM tradingview_alerts
     GROUP BY COALESCE(source,'manual')`,
  );
  return rows
    .map((r) => {
      const resolved = Number(r.resolved);
      const net = r.total || 0;
      // t-stat of net per-trade P&L: mean × √n / std. |t|≥2 ≈ 95% confident it's not zero.
      const tStat = resolved > 1 && r.meanpnl != null && r.stdpnl != null && r.stdpnl > 0
        ? (r.meanpnl * Math.sqrt(resolved)) / r.stdpnl
        : null;
      return {
        key: r.source,
        label: STRATEGY_LABELS[r.source] ?? r.source,
        resolved,
        wins: Number(r.wins),
        hitRate: resolved > 0 ? Number(r.wins) / resolved : null,
        avgWin: r.avgwin || 0,
        avgLoss: r.avgloss || 0,
        expectancy: resolved > 0 ? net / resolved : null,
        totalPnl: net,
        open: Number(r.open),
        peakedGreen: Number(r.peaked),
        fees: r.fees || 0,
        grossPnl: net + (r.fees || 0),   // net + fees = gross (before-fee P&L)
        tStat,
        verdict: strategyVerdict(resolved, net, tStat),
      };
    })
    .sort((a, b) => b.resolved - a.resolved);
}

// EDGES — the paper record sliced by FACTOR (not strategy), to find WHERE profit comes from:
// direction (long vs short) and coin. This is the microscope on the edge — but thin slices
// find FAKE edges (data mining), so the UI gates every bucket on sample size and calls
// nothing an edge until it has a real count. Expectancy (avg $/trade after fees) is the number.
export interface EdgeStat {
  key: string; label: string; resolved: number; wins: number; hitRate: number | null;
  expectancy: number | null; totalPnl: number; open: number;
}
// groupExpr is a FIXED column name ("side" / "symbol") chosen by edgeBreakdowns — never user
// input, so the interpolation is injection-safe (same pattern as ensureShadowColumns).
async function edgeBy(groupExpr: string, labelFn: (k: string) => string): Promise<EdgeStat[]> {
  const rows = await prisma.$queryRawUnsafe<{ k: string; resolved: bigint; wins: bigint; total: number | null; open: bigint }[]>(
    `SELECT ${groupExpr} AS k,
       count(*) FILTER (WHERE shadow_status='resolved')::bigint AS resolved,
       count(*) FILTER (WHERE shadow_status='resolved' AND shadow_pnl > 0)::bigint AS wins,
       COALESCE(sum(shadow_pnl) FILTER (WHERE shadow_status='resolved'),0)::float AS total,
       count(*) FILTER (WHERE side IN ('buy','sell') AND COALESCE(shadow_status,'open')='open')::bigint AS open
     FROM tradingview_alerts
     WHERE side IN ('buy','sell')
     GROUP BY ${groupExpr}`,
  );
  return rows
    .map((r) => {
      const resolved = Number(r.resolved);
      return {
        key: r.k, label: labelFn(r.k), resolved, wins: Number(r.wins),
        hitRate: resolved > 0 ? Number(r.wins) / resolved : null,
        expectancy: resolved > 0 ? (r.total || 0) / resolved : null,
        totalPnl: r.total || 0, open: Number(r.open),
      };
    })
    .sort((a, b) => b.resolved - a.resolved);
}
export interface EdgeBreakdowns { byDirection: EdgeStat[]; byCoin: EdgeStat[] }
export async function edgeBreakdowns(): Promise<EdgeBreakdowns> {
  await ensureShadowColumns();
  const byDirection = await edgeBy("side", (k) => (k === "buy" ? "Long" : "Short"));
  const byCoin = await edgeBy("symbol", (k) => k.replace("/USD", ""));
  return { byDirection, byCoin };
}

// The full trade log — every tracked paper trade, newest first, for the admin trade log.
export interface PaperTradeRow {
  id: number; time: string; source: string; symbol: string; side: string;
  leverage: number | null; conviction: string | null; entry: number | null;
  exit: number | null; pnl: number | null; unrealized: number | null; notional: number | null; status: string; reason: string | null;
}
export async function recentPaperTrades(limit = 100): Promise<PaperTradeRow[]> {
  await ensureShadowColumns();
  // Size the log the SAME risk-based way the P&L is computed (max-loss ÷ stop distance, capped
  // by leverage), so the Size column matches what actually drives each trade's dollar P&L.
  const { refEquity, maxRiskPct } = await sizingParams();
  const rows = await prisma.$queryRawUnsafe<{
    id: number; time: Date; source: string | null; symbol: string; side: string;
    leverage: number | null; conviction: string | null; mark_price: number | null;
    shadow_exit: number | null; shadow_pnl: number | null; shadow_unrealized: number | null;
    shadow_status: string | null; shadow_reason: string | null;
  }[]>(
    `SELECT id, time, source, symbol, side, leverage, conviction, mark_price,
            shadow_exit, shadow_pnl, shadow_unrealized, shadow_status, shadow_reason
     FROM tradingview_alerts
     WHERE side IN ('buy','sell')
     ORDER BY time DESC LIMIT $1`,
    Math.max(1, Math.min(500, limit)),
  );
  return rows.map((r) => ({
    id: r.id,
    time: r.time.toISOString(),
    source: r.source ?? "manual",
    symbol: r.symbol,
    side: r.side,
    leverage: r.leverage,
    conviction: r.conviction,
    entry: r.mark_price,
    exit: r.shadow_exit,
    unrealized: r.shadow_status === "resolved" ? null : r.shadow_unrealized,
    pnl: r.shadow_pnl,
    notional: r.mark_price ? positionNotional(r.source, Math.max(1, Math.min(20, r.leverage ?? 2)), r.mark_price, refEquity, convictionRisk(r.conviction, maxRiskPct)) : null,
    status: r.shadow_status ?? "open",
    reason: r.shadow_reason,
  }));
}
