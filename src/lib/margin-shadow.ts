// Shadow evaluator — follows every TRACKED TradingView signal to a win or loss so
// Spencer sees "that ETH long would have made +$X / stopped out −$Y" without a cent at
// risk. This is what makes tracked mode meaningful: a real, scored paper record built
// from his own alerts, at honest sizing and fees.
//
// Each tracked entry is treated exactly as the executor would place it: risk-based
// sizing, a per-strategy initial stop, a breakeven-then-trailing stop once +1R, and a
// per-strategy time stop. The evaluator walks each open signal across 1-min candles and
// resolves it the moment a level is hit. Awareness only — it places nothing.
import { prisma } from "@/lib/db";
import { pairBase } from "@/lib/kraken-pairs";
import { getKrakenOHLC } from "@/lib/kraken-margin";
import {
  LIVE_RISK_DEFAULT_PCT,
  liveRiskFraction,
  parseLiveRiskBasePct,
} from "@/lib/margin-live-risk";

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
    "shadow_seen_t double precision",      // epoch secs of the last 1-min bar already evaluated —
                                           // bars are never scored twice, so a ratcheted stop
                                           // can't be retro-applied to wicks it didn't exist for
    "sim_version text",                    // measurement-model cohort (see SIM_VERSION)
  ]) {
    await prisma.$executeRawUnsafe(`ALTER TABLE tradingview_alerts ADD COLUMN IF NOT EXISTS ${col}`);
  }
  // Backfill source on any pre-existing rows (auto-opened breakouts vs manual alerts).
  // Idempotent: only touches rows where source is still null.
  await prisma.$executeRawUnsafe(
    `UPDATE tradingview_alerts SET source = CASE WHEN note LIKE 'auto:%' THEN 'scanner' ELSE 'manual' END WHERE source IS NULL`,
  );
  // MEASUREMENT COHORTS: v1 rows were scored with snapshot stops, instant-fill entries,
  // and snapshot peaks; v2 uses candle-based stops, gap-aware fills, and a 0.1% entry
  // chase. Pooling the two would make every verdict uninterpretable — a t-stat over a
  // mixture of two simulators gates nothing — so the scoreboard, edges, and milestones
  // read ONLY the current cohort. Old rows stay in the DB for the log.
  //
  // No time predicate: every v2-code insert supplies sim_version in the INSERT itself,
  // so an unstamped row can only have been written by pre-cohort code, whenever the
  // deploy actually lands. (A timestamp cutoff here once mislabeled 9 hours of rows.)
  await prisma.$executeRawUnsafe(
    `UPDATE tradingview_alerts SET sim_version='v1' WHERE sim_version IS NULL`,
  );
  // Pre-cohort OPEN rows resume candle evaluation from NOW rather than replaying an
  // hour of bars against stops that were only ever snapshot-checked — without this seed,
  // the first post-deploy run would mass-resolve the old book in one arbitrary sweep.
  await prisma.$executeRawUnsafe(
    `UPDATE tradingview_alerts SET shadow_seen_t = extract(epoch from now())
     WHERE shadow_seen_t IS NULL AND sim_version='v1' AND side IN ('buy','sell') AND COALESCE(shadow_status,'open')='open'`,
  );
}

// Bump when the measurement model changes materially (fills, fees, entries, stops).
// Inserts stamp it; every aggregate filters to it. See the cohort note in ensureShadowColumns.
export const SIM_VERSION = "v2";
// FAIL CLOSED: only explicitly stamped rows count as current. An insert path that
// forgets the stamp quarantines its rows (they read as pre-cohort via the backfill)
// instead of silently polluting the statistics that gate real money.
export const SIM_COHORT_SQL = `sim_version='${SIM_VERSION}'`;

export interface ShadowResolution {
  id: number; symbol: string; side: string; entry: number; exit: number;
  pnl: number; pnlPct: number; reason: string; leverage: number; conviction: string | null;
}

interface OpenRow {
  id: number; time: Date; symbol: string; side: string; leverage: number | null;
  mark_price: number; shadow_peak: number | null; shadow_stop: number | null;
  shadow_seen_t: number | null; conviction: string | null; source: string | null;
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
  // SELECTIVE-SWING — the direct test of the Sep 3 conviction finding. Across 71 v2 trades
  // conviction was monotonically predictive on a size-neutral basis (high +1.58% avg gross
  // move and +9.4% avg PEAK, med −1.39%, low −2.05%), yet `selective` still lost money. The
  // hypothesis: the SIGNAL is good and the CONTAINER is wrong — a 3% stop and a 48h clock
  // cage a setup whose average peak is 9%. So: same high-conviction entries, swing room and
  // time (5% stop, 4 days). Its own `source`, so it starts at zero and contaminates no
  // existing sample; if it beats `selective` head-to-head, the finding is real.
  if (source === "selective-swing") return { maxHoldH: 24 * 4, oneR: entry * 0.05, carry: lev > 1 };
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
function convictionRisk(conviction: string | null, baseRiskPct: number): number {
  // baseRiskPct is a fraction (0.03). liveRiskFraction takes percent — same helper the executor uses.
  return liveRiskFraction(baseRiskPct * 100, conviction);
}

// ⭐ WHAT THESE TRADES WOULD BE WORTH AS THE LIVE EXECUTOR WOULD SIZE THEM.
// Both sizers now risk 3% base and both scale it by conviction (2x high, 0.5x low, 6%
// ceiling), so the live column currently equals the paper one — and that agreement IS the
// result: it is the check that the executor reproduces the record. It was not always so.
// While live bet a flat 3%, the same 48 surviving trades were worth +$1,779 on paper and
// −$137 live, because flat sizing halved the winners (high conviction averages +$73/trade)
// and doubled the losers (low averages −$74). Keep this column even while it agrees: it is
// what surfaces the next divergence between the record and the executor.
// Fees scale with notional and are already inside shadow_pnl, so the rescale is exact.
async function liveRiskParams(): Promise<number> {
  const v = await prisma.agentConfig.findUnique({ where: { key: "kraken_margin_live_max_risk_pct" } })
    .then((r: { value?: string | null } | null) => (r?.value ? parseFloat(r.value) : NaN)).catch(() => NaN);
  return parseLiveRiskBasePct(Number.isFinite(v) ? v : LIVE_RISK_DEFAULT_PCT);
}

// Reference account + max-risk for paper sizing (config-driven; defaults ≈ Spencer's account so
// the paper dollars are realistic). kraken_shadow_ref_equity and kraken_margin_max_risk_pct.
// ⚠️ PAPER ONLY. The live executor reads kraken_margin_live_max_risk_pct (default 3%,
// conviction-scaled, 6% ceiling) via the same margin-live-risk.ts helpers so paper and
// live cannot silently disagree. The separate key still exists so the two can be tuned
// independently if you ever want a different live budget.
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
// CANDLE-BASED (not snapshot): each run reads the last ~10 minutes of 1-min OHLC per
// symbol and checks the carried-in stop against the window's LOW/HIGH — so a wick that
// hits the stop between runs actually stops the paper trade, exactly as a resting live
// stop order would. Snapshot checking (the old way) silently skipped those stop-outs,
// which flattered every strategy — the one bias that could wrongly green-light go-live.
// Fills are gap-aware: if the window OPENED beyond the stop, the fill is the (worse)
// open, not the stop price. Peaks also come from candle extremes, so trailing capture
// is measured fairly rather than under-counted.
export async function evaluateShadowSignals(): Promise<ShadowResolution[]> {
  await ensureShadowColumns();
  const { refEquity, maxRiskPct } = await sizingParams();
  const rows = await prisma.$queryRawUnsafe<OpenRow[]>(
    `SELECT id, time, symbol, side, leverage, mark_price, shadow_peak, shadow_stop, shadow_seen_t, conviction, source
     FROM tradingview_alerts
     WHERE side IN ('buy','sell') AND mark_price > 0 AND COALESCE(shadow_status,'open') = 'open'
     ORDER BY time ASC LIMIT 500`,
  );
  if (!rows.length) return [];

  // One OHLC lookup per distinct symbol: the last hour of 1-min candles. An hour (not
  // one cron interval) so a skipped or timed-out run leaves no unwatched hole; per-trade
  // shadow_seen_t guarantees no bar is ever scored twice regardless of window size.
  const symbols = [...new Set(rows.map((r) => r.symbol))];
  const price: Record<string, number> = {};
  const barsBySym: Record<string, { t: number; o: number; h: number; l: number; c: number }[]> = {};
  const cutoff = Date.now() / 1000 - 60 * 60;
  for (const sym of symbols) {
    try {
      // krakenPair() inside handles both scanner symbols ("BTC/USD" → XBTUSD) and manual
      // alert formats ("XBTUSD" passes through unchanged).
      const raw = (await getKrakenOHLC(sym, 1, cutoff - 60)).filter((b) => b.t >= cutoff);
      // Kraken can return the in-progress bar twice when `since` falls inside the current
      // minute; dedupe by timestamp keeping the LAST (most complete) copy.
      const bars = raw.filter((b, i) => i === raw.length - 1 || raw[i + 1].t !== b.t);
      if (bars.length) {
        price[sym] = bars[bars.length - 1].c;
        barsBySym[sym] = bars;
      }
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
        const affected = await prisma.$executeRawUnsafe(
          `UPDATE tradingview_alerts SET shadow_status='resolved', shadow_exit=$1, shadow_pnl=$2, shadow_reason=$3, shadow_resolved_at=now(), shadow_fees=$5 WHERE id=$4 AND COALESCE(shadow_status,'open')='open'`,
          entry, pnl, `${timeStopLabel} (no price)`, r.id, feeFrac * notional,
        );
        if (affected === 0) continue;
        resolved.push({ id: r.id, symbol: r.symbol, side: r.side, entry, exit: entry, pnl, pnlPct: netPct, reason: `${timeStopLabel} (no price)`, leverage: lev, conviction: r.conviction });
      }
      continue;
    }

    // Per-trade window: only 1-min bars this trade has actually LIVED through and that
    // have not been scored before. b.t >= tOpen drops the bar containing the entry (its
    // extremes include pre-entry price — a breakout's entry bar low is by construction
    // the pre-spike price); the first full bar arrives within a minute, and `now` covers
    // the trade until then. b.t >= seenT means no bar is ever scored twice, so a stop
    // ratcheted later can never be retro-applied to a wick it didn't exist for.
    const tOpen = r.time.getTime() / 1000;
    const seenT = r.shadow_seen_t ?? 0;
    const tb = (barsBySym[r.symbol] ?? []).filter((b) => b.t >= tOpen && b.t >= seenT);
    // The newest fetched bar is Kraken's IN-PROGRESS bar: its extremes can still grow,
    // so it is walked for a stop TOUCH only — it must not ratchet the trail (a stop
    // derived from its high would be retro-tested against its own low next run) and its
    // peak is not persisted. It stays unmarked as seen; the next run re-walks it
    // complete, and only then does it ratchet.
    const doneBars = tb.slice(0, -1);
    const liveBar = tb.length ? tb[tb.length - 1] : null;
    const nextSeenT = liveBar ? liveBar.t : seenT;

    // SEQUENTIAL WALK, oldest bar first — the stop is tested AS IT STOOD at each bar's
    // open, then that bar's extreme ratchets the trail for the NEXT bar. This is how a
    // live resting stop behaves: a peak-then-retrace inside the window triggers the
    // ratcheted trail; a wick through the initial stop ends the trade before later bars
    // can credit a peak. Within a single bar high/low order is unknowable, so stop-first
    // is the conservative reading. Gap-aware fill: a bar OPENING beyond the stop fills
    // at its (worse) open.
    let peak = r.shadow_peak ?? entry;
    let stopPx = r.shadow_stop ?? entry - dir * oneR;
    let exit: number | null = null;
    let reason = "";
    const ratchet = () => {
      const peakR = (dir * (peak - entry)) / oneR;   // best profit reached, in R
      if (peakR >= 1) {
        // Breakeven once +1R, then trail 1R behind the peak — ratchet only (never loosen).
        const trail = peak - dir * oneR;
        const candidate = dir > 0 ? Math.max(entry, trail) : Math.min(entry, trail);
        stopPx = dir > 0 ? Math.max(stopPx, candidate) : Math.min(stopPx, candidate);
      }
    };
    for (const b of doneBars) {
      if (dir > 0 ? b.l <= stopPx : b.h >= stopPx) {
        exit = dir > 0 ? Math.min(stopPx, b.o) : Math.max(stopPx, b.o);
        // Mechanism only — the P&L number carries whether it was actually a profit; at
        // exact breakeven the round-trip fees still make it a small loss, so don't claim
        // "profit" in the label.
        reason = (dir * (peak - entry)) / oneR >= 1 ? "trailing stop" : "initial stop";
        break;
      }
      peak = dir > 0 ? Math.max(peak, b.h) : Math.min(peak, b.l);
      ratchet();
    }
    if (exit == null && liveBar) {
      // In-progress bar: stop touch only, against the stop as it stood after the last
      // COMPLETE bar. No ratchet, no peak credit — see the note above doneBars.
      if (dir > 0 ? liveBar.l <= stopPx : liveBar.h >= stopPx) {
        exit = dir > 0 ? Math.min(stopPx, liveBar.o) : Math.max(stopPx, liveBar.o);
        reason = (dir * (peak - entry)) / oneR >= 1 ? "trailing stop" : "initial stop";
      }
    }
    if (exit == null && tb.length === 0) {
      // Seconds-old trade with no bar yet: the latest close is all we know.
      peak = dir > 0 ? Math.max(peak, now) : Math.min(peak, now);
      ratchet();
      if (dir > 0 ? now <= stopPx : now >= stopPx) {
        exit = dir > 0 ? Math.min(stopPx, now) : Math.max(stopPx, now);
        reason = (dir * (peak - entry)) / oneR >= 1 ? "trailing stop" : "initial stop";
      }
    }
    if (exit == null && ageH >= maxHoldH) {
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
      // Still-open guard: an overlapping cron run working from an older SELECT must not
      // overwrite peak/stop on a row the other run has since resolved — shadow_peak
      // feeds the give-back metric and must freeze at resolution.
      await prisma.$executeRawUnsafe(
        `UPDATE tradingview_alerts SET shadow_peak=$1, shadow_stop=$2, shadow_unrealized=$3, shadow_seen_t=$5 WHERE id=$4 AND COALESCE(shadow_status,'open')='open'`,
        peak, stopPx, unrealized, r.id, nextSeenT,
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

    // The walk stops crediting peak/stop at the fatal bar, so the persisted peak is the
    // PRE-stop-out peak — the give-back metric can't credit green that appeared after
    // death. The still-open guard makes overlapping cron runs harmless: whichever run
    // resolves the row first wins, the loser affects 0 rows and reports nothing.
    const affected = await prisma.$executeRawUnsafe(
      `UPDATE tradingview_alerts SET shadow_status='resolved', shadow_exit=$1, shadow_pnl=$2, shadow_reason=$3, shadow_resolved_at=now(), shadow_peak=$4, shadow_stop=$5, shadow_unrealized=NULL, shadow_fees=$7 WHERE id=$6 AND COALESCE(shadow_status,'open')='open'`,
      exit, pnl, reason, peak, stopPx, r.id, feeDollars,
    );
    if (affected === 0) continue;
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
  legacyOpen: number;   // open trades from a PRIOR measurement cohort, still winding down —
                        // shown so the live book never looks empty while they exist, but
                        // excluded from every statistic above
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
     FROM tradingview_alerts WHERE ${SIM_COHORT_SQL}`,
  );
  const [wl] = await prisma.$queryRawUnsafe<{ avgwin: number | null; avgloss: number | null }[]>(
    `SELECT
       avg(shadow_pnl) FILTER (WHERE shadow_status='resolved' AND shadow_pnl > 0) AS avgwin,
       avg(shadow_pnl) FILTER (WHERE shadow_status='resolved' AND shadow_pnl <= 0) AS avgloss
     FROM tradingview_alerts WHERE ${SIM_COHORT_SQL}`,
  );
  const tiers = await prisma.$queryRawUnsafe<{ tier: string; resolved: bigint; wins: bigint; total: number | null }[]>(
    `SELECT COALESCE(conviction,'untagged') AS tier,
       count(*)::bigint AS resolved,
       count(*) FILTER (WHERE shadow_pnl > 0)::bigint AS wins,
       COALESCE(sum(shadow_pnl),0)::float AS total
     FROM tradingview_alerts WHERE shadow_status='resolved' AND ${SIM_COHORT_SQL}
     GROUP BY COALESCE(conviction,'untagged')`,
  );
  const [legacy] = await prisma.$queryRawUnsafe<{ n: bigint }[]>(
    // COALESCE, not NOT(...): a NULL sim_version row would vanish from BOTH cohorts
    // under NULL-unsafe negation. Unreachable today (the backfill runs first), but a
    // future insert path that forgets the stamp should show up here, not disappear.
    `SELECT count(*)::bigint AS n FROM tradingview_alerts
     WHERE side IN ('buy','sell') AND COALESCE(shadow_status,'open')='open' AND COALESCE(sim_version,'v1') <> '${SIM_VERSION}'`,
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
    legacyOpen: Number(legacy.n),
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
  liveNet: number;        // the SAME trades priced at the LIVE risk budget instead of the
                          // paper research budget — i.e. what this strategy would actually
                          // have earned. See the note above liveRiskParams().
  paperTStat: number | null;  // t on the paper-sized series, for reference only. `tStat`
                              // and `verdict` are computed on the LIVE-sized series.
  tStat: number | null;   // t = mean × √n / std — is the net expectancy distinguishable from luck?
  verdict: string;        // rule-based: gathering / not paying / promising (could be luck) / REAL EDGE
}

// Rule-based verdict — the honest "does this work" call. Guards against reading luck as edge:
// needs a real sample (30+) AND positive net AND statistical significance (t≥2, ~95% it's not
// zero) before it says "REAL EDGE". Below t=2 a positive result could easily be luck — say so.
// The t-stat assumes independent trades, but crypto coins move together — 30 wins resolved in
// one correlated day are closer to ONE bet than thirty. So REAL EDGE additionally requires the
// resolutions to span 7+ distinct days; until then a significant result stays "promising".
function strategyVerdict(resolved: number, net: number, tStat: number | null, days: number): string {
  if (resolved < 30) return `gathering (${resolved}/30)`;
  if (net <= 0) return "not paying";
  if (tStat != null && tStat >= 2) {
    if (days < 7) return `promising — significant, needs ${7 - days} more day${7 - days === 1 ? "" : "s"} of data`;
    return "REAL EDGE — significant";
  }
  return "promising (could be luck)";
}
const STRATEGY_LABELS: Record<string, string> = {
  scanner: "Fast — wide 6% stop (5x)",
  "fast-tight": "Fast — tight 2% stop — RETIRED Sep 1 (proven loser)",
  "swing-lev": "Leveraged swing (5x, ≤4d)",
  "swing-spot": "Spot swing (1x, ≤2w)",
  "sweep-fade": "Liquidity-sweep fade — RETIRED Sep 3 (proven loser)",
  selective: "Selective — high-conviction, 3% stop / 48h (5x)",
  "selective-swing": "Selective SWING — high-conviction, 5% stop / 4d (5x)",
  manual: "Manual alerts (yours)",
};
export async function strategyBreakdown(): Promise<StrategyStat[]> {
  await ensureShadowColumns();
  const liveRiskPct = await liveRiskParams();
  const { maxRiskPct: paperRiskFrac } = await sizingParams();
  const paperRiskPct = paperRiskFrac * 100;
  const rows = await prisma.$queryRawUnsafe<{
    source: string; resolved: bigint; wins: bigint; total: number | null;
    avgwin: number | null; avgloss: number | null; open: bigint; fees: number | null;
    meanpnl: number | null; stdpnl: number | null; peaked: bigint; days: bigint;
    livenet: number | null; livemean: number | null; livestd: number | null;
  }[]>(
    `SELECT COALESCE(source,'manual') AS source,
       count(*) FILTER (WHERE shadow_status='resolved')::bigint AS resolved,
       count(*) FILTER (WHERE shadow_status='resolved' AND shadow_pnl > 0)::bigint AS wins,
       count(*) FILTER (WHERE shadow_status='resolved' AND shadow_peak IS NOT NULL AND mark_price > 0
         AND ((side='buy' AND shadow_peak > mark_price) OR (side='sell' AND shadow_peak < mark_price)))::bigint AS peaked,
       count(DISTINCT date_trunc('day', shadow_resolved_at)) FILTER (WHERE shadow_status='resolved')::bigint AS days,
       -- Each trade re-priced from the risk the PAPER sizer used to the risk the LIVE
       -- executor would use. Both scale by conviction (high 2x, low 0.5x, 6% ceiling), so
       -- with the two base rates equal this ratio is 1 and live == paper — which is the
       -- point: the columns agreeing is the evidence that live now sizes like paper.
       -- They diverge the moment kraken_margin_live_max_risk_pct differs from the paper
       -- base, which is exactly when the distinction matters again.
       COALESCE(sum(shadow_pnl * (LEAST(6.0, $1::float * CASE conviction WHEN 'high' THEN 2.0 WHEN 'low' THEN 0.5 ELSE 1.0 END)
         / LEAST(6.0, $2::float * CASE conviction WHEN 'high' THEN 2.0 WHEN 'low' THEN 0.5 ELSE 1.0 END)))
         FILTER (WHERE shadow_status='resolved'),0)::float AS livenet,
       COALESCE(sum(shadow_pnl) FILTER (WHERE shadow_status='resolved'),0)::float AS total,
       avg(shadow_pnl) FILTER (WHERE shadow_status='resolved' AND shadow_pnl > 0) AS avgwin,
       avg(shadow_pnl) FILTER (WHERE shadow_status='resolved' AND shadow_pnl <= 0) AS avgloss,
       count(*) FILTER (WHERE side IN ('buy','sell') AND COALESCE(shadow_status,'open')='open')::bigint AS open,
       COALESCE(sum(shadow_fees) FILTER (WHERE shadow_status='resolved'),0)::float AS fees,
       avg(shadow_pnl) FILTER (WHERE shadow_status='resolved') AS meanpnl,
       stddev_samp(shadow_pnl) FILTER (WHERE shadow_status='resolved') AS stdpnl,
       -- The SAME statistics on the live-priced series, because the VERDICT is gated on
       -- them. While live bet flat and paper bet by conviction these moved materially
       -- (all-v2 t went -0.72 -> -2.51); now that live is conviction-scaled they coincide.
       -- Keep the separate computation: it is what will catch the next divergence between
       -- what the record measures and what the executor would actually do.
       avg(shadow_pnl * (LEAST(6.0, $1::float * CASE conviction WHEN 'high' THEN 2.0 WHEN 'low' THEN 0.5 ELSE 1.0 END)
         / LEAST(6.0, $2::float * CASE conviction WHEN 'high' THEN 2.0 WHEN 'low' THEN 0.5 ELSE 1.0 END)))
         FILTER (WHERE shadow_status='resolved') AS livemean,
       stddev_samp(shadow_pnl * (LEAST(6.0, $1::float * CASE conviction WHEN 'high' THEN 2.0 WHEN 'low' THEN 0.5 ELSE 1.0 END)
         / LEAST(6.0, $2::float * CASE conviction WHEN 'high' THEN 2.0 WHEN 'low' THEN 0.5 ELSE 1.0 END)))
         FILTER (WHERE shadow_status='resolved') AS livestd
     FROM tradingview_alerts
     WHERE ${SIM_COHORT_SQL}
     GROUP BY COALESCE(source,'manual')`,
    liveRiskPct, paperRiskPct,
  );
  return rows
    .map((r) => {
      const resolved = Number(r.resolved);
      const net = r.total || 0;
      const liveNet = r.livenet || 0;
      // ⚠️ THE VERDICT IS JUDGED ON THE LIVE-PRICED SERIES, not the paper one.
      // Live now scales by conviction the same way paper does (shared margin-live-risk.ts),
      // so with equal base rates the two series coincide and t matches. Keep the separate
      // computation: it is what will catch the next divergence if kraken_margin_live_max_risk_pct
      // is set differently from the paper base. Judging on paper sizing would credit a
      // strategy for an edge the live path would not actually take.
      const tStat = resolved > 1 && r.livemean != null && r.livestd != null && r.livestd > 0
        ? (r.livemean * Math.sqrt(resolved)) / r.livestd
        : null;
      // Kept for reference/debugging: what the paper sizing would have claimed.
      const paperTStat = resolved > 1 && r.meanpnl != null && r.stdpnl != null && r.stdpnl > 0
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
        liveNet,
        fees: r.fees || 0,
        grossPnl: net + (r.fees || 0),   // net + fees = gross (before-fee P&L)
        tStat,
        paperTStat,
        // Gate on the LIVE net and the LIVE t-stat — the money that would actually be made,
        // judged at the significance the live sizing would actually achieve.
        verdict: strategyVerdict(resolved, liveNet, tStat, Number(r.days)),
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
     WHERE side IN ('buy','sell') AND ${SIM_COHORT_SQL}
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
  simVersion: string;   // measurement cohort — the log shows all cohorts, labeled
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
    shadow_status: string | null; shadow_reason: string | null; sim_version: string | null;
  }[]>(
    `SELECT id, time, source, symbol, side, leverage, conviction, mark_price,
            shadow_exit, shadow_pnl, shadow_unrealized, shadow_status, shadow_reason, sim_version
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
    simVersion: r.sim_version ?? SIM_VERSION,
  }));
}
