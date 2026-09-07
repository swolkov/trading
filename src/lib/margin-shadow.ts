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
import { pairBase, isUsMarginSymbol, US_MARGIN_SYMBOLS_SQL } from "@/lib/kraken-pairs";
import { getKrakenOHLC } from "@/lib/kraken-margin";
import {
  LIVE_RISK_DEFAULT_PCT,
  liveRiskFraction,
  parseLiveRiskBasePct,
} from "@/lib/margin-live-risk";
import { RETIRED_AUTO_SOURCES, TWIN_SOURCES } from "@/lib/margin-auto-plans";

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
// ENTRY is a TAKER fee (Sep 6 2026): the live executor enters at MARKET
// (kraken_margin_maker_entries=false — a post-only bid rarely fills a breakout), and the
// first two real fills paid 0.215% and 0.223% per side. Paper already charges the 0.1%
// entry chase (a chase IS a market order); charging a maker fee on top of it flattered every
// sleeve by ~0.1% of notional per trade. Rows resolved before this change keep the fee they
// were scored with (fees are written at resolution); the shift is well inside one trade's
// noise (≈$11 on a $10.7k paper position vs a ≈$430 per-trade standard deviation), so the
// v2 cohort stands.
const ENTRY_FEE = 0.0025;   // ~0.25% entry (market / taker — what live actually pays)
const TAKER = 0.0025;       // ~0.25% exit (stop/target = market / taker)
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
    "live_txid text",                      // the Kraken ORDER txid when this row was also traded LIVE
    "live_exec_note text",                 // the executor's note for that attempt (sent / refused why)
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

// THE RECORD = current measurement cohort AND a pair the live book can actually trade.
// Every statistic that feeds a verdict (scoreboard, strategy table, edges, milestones)
// reads through this predicate. Paper trades on non-US pairs are still opened by nothing
// (the scanner universe is US-only now), still RESOLVED by the evaluator (an open trade
// must reach its finish), still visible in the log (badged), but never counted — a
// strategy cannot earn REAL EDGE on coins the executor would refuse. Found Sep 5 2026:
// 19 of 37 scanned coins were untradeable and carried every dollar of the loss.
export const RECORD_SQL = `${SIM_COHORT_SQL} AND ${US_MARGIN_SYMBOLS_SQL}`;

// When the universe fix shipped. The exclusion above is exogenous (Kraken's list, not
// P&L), so the surviving pre-fix trades are valid — but they were re-qualified after the
// fact, and the arming gate should be read knowing how much of the sample is forward-only.
// strategyBreakdown reports the count of resolved trades ENTERED after this moment.
export const UNIVERSE_FIX_AT = "2026-09-05T17:00:00Z";
// When the auto-paper policy narrowed to high-conviction 5m/15m LONGS, not stretched
// (Sep 4 2026 16:59 UTC). Trades entered before it were chosen under the old rule (any
// high-conviction breakout, any timeframe, both directions) and re-qualified after the fact;
// the forward-only slice is the honest test of the rule as it stands. candidateDetail()
// reports it beside the pooled row.
export const POLICY_CUT_AT = "2026-09-04T17:00:00Z";

// PRE-REGISTERED CUTS of the live candidate (registered Sep 7 2026, before the samples exist,
// so no cut can be chosen after seeing it): forward-only, by timeframe, by entry window (UTC).
// A cut is READ only at SLICE_MIN_RESOLVED resolved trades; below that it is "watching",
// whatever colour it shows. Three cuts of one sleeve is a small family — the multiple-
// comparison risk is stated on the page, not hidden.
export const SLICES_PREREGISTERED_AT = "2026-09-07";
export const SLICE_MIN_RESOLVED = 30;
const ENTRY_HOUR_SQL = `extract(hour from (time AT TIME ZONE 'UTC'))`;
export const ENTRY_WINDOW_SQL = `CASE WHEN ${ENTRY_HOUR_SQL} < 6 THEN '00–06 UTC' WHEN ${ENTRY_HOUR_SQL} < 12 THEN '06–12 UTC' WHEN ${ENTRY_HOUR_SQL} < 18 THEN '12–18 UTC' ELSE '18–24 UTC' END`;

export interface ShadowResolution {
  id: number; symbol: string; side: string; entry: number; exit: number;
  pnl: number; pnlPct: number; reason: string; leverage: number; conviction: string | null;
  source: string | null;   // which sleeve — so Slack can label experiment twins as not-the-record
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
export interface ExitProfile {
  maxHoldH: number; oneR: number; carry: boolean;
  tightAfterR?: number; tightTrailR?: number;   // once the peak reaches tightAfterR, trail tightTrailR behind it (default 1R)
  launchH?: number; launchMinR?: number;        // failure to launch: still below launchMinR after launchH hours → close
}
/**
 * Paper's managed exit as ONE pure function (the guardian mirrors the default form in
 * managedStopTarget): breakeven once +1R, then trail 1R behind the peak — or, for a
 * profile that says so, a tighter trail once the peak passes tightAfterR. Ratchet only.
 */
export function managedStop(dir: number, entry: number, peak: number, stopPx: number, oneR: number, p?: Pick<ExitProfile, "tightAfterR" | "tightTrailR">): number {
  if (!(oneR > 0)) return stopPx;
  const peakR = (dir * (peak - entry)) / oneR;
  if (peakR < 1) return stopPx;
  const trailR = p?.tightAfterR != null && p?.tightTrailR != null && peakR >= p.tightAfterR ? p.tightTrailR : 1;
  const trail = peak - dir * oneR * trailR;
  const candidate = dir > 0 ? Math.max(entry, trail) : Math.min(entry, trail);
  return dir > 0 ? Math.max(stopPx, candidate) : Math.min(stopPx, candidate);
}
export function launchStopDue(p: Pick<ExitProfile, "launchH" | "launchMinR">, ageH: number, peakR: number): boolean {
  return p.launchH != null && p.launchMinR != null && ageH >= p.launchH && peakR < p.launchMinR;
}
export function exitParams(source: string | null, lev: number, entry: number): ExitProfile {
  if (source === "swing-spot") return { maxHoldH: 24 * 14, oneR: entry * 0.06, carry: false };
  if (source === "swing-lev") return { maxHoldH: 24 * 4, oneR: entry * 0.04, carry: true };
  // Fast-breakout A/B: same entries, different stop width — the scoreboard decides which earns
  // more. 'fast-tight' cuts a failed break fast (~2%, resolves in minutes-hours); 'scanner' is
  // the wide 6% control. BOTH RETIRED (Sep 1 / Sep 4). Exit profiles stay so already-open
  // trades resolve and the record remains on the scoreboard as evidence.
  if (source === "fast-tight") return { maxHoldH: MAX_HOLD_H, oneR: entry * 0.02, carry: lev > 1 };
  // Liquidity-sweep fade — mean-reversion: stop just beyond the swept wick (2.5%), quick
  // resolution (a real reversal moves fast; if it doesn't revert, the "sweep" was a true break).
  if (source === "sweep-fade") return { maxHoldH: 24, oneR: entry * 0.025, carry: lev > 1 };
  // Selective (high-conviction only): a better setup earns a bit more room (3% stop) + the
  // managed exit banks the green (breakeven at +1R, then trails). Fewer of these = tiny fee drag.
  if (source === "selective") return { maxHoldH: MAX_HOLD_H, oneR: entry * 0.03, carry: lev > 1 };
  // SELECTIVE ×5 SIZE — pre-registered experiment (Spencer, Sep 6 2026): the SAME entries and
  // the SAME container as the live candidate, but sized at 5× the risk (15% base, 30% on high
  // conviction) with 5× leverage — "use more of the account". Scored with the same fees and
  // rollover. It exists to answer, with numbers, whether bigger size beats the policy after
  // the drawdowns. It can never trade live unless armed by name; note that live's 15%
  // drawdown breaker would halt after ONE full loss at this size.
  if (source === "selective-x5") return { maxHoldH: MAX_HOLD_H, oneR: entry * 0.03, carry: lev > 1 };
  // PRE-REGISTERED TWINS (Sep 7 2026, see margin-auto-plans.ts): the candidate's container
  // with ONE change each. selective-btc is the same container under a regime filter.
  if (source === "selective-tight") return { maxHoldH: MAX_HOLD_H, oneR: entry * 0.03, carry: lev > 1, tightAfterR: 2, tightTrailR: 0.5 };
  if (source === "selective-launch") return { maxHoldH: MAX_HOLD_H, oneR: entry * 0.03, carry: lev > 1, launchH: 8, launchMinR: 0.5 };
  if (source === "selective-btc") return { maxHoldH: MAX_HOLD_H, oneR: entry * 0.03, carry: lev > 1 };
  if (source === "selective-majors") return { maxHoldH: MAX_HOLD_H, oneR: entry * 0.03, carry: lev > 1 };
  // TSMOM (Sep 7 2026, margin-regime.ts): daily time-series momentum on the majors — the
  // horizon the literature finds robust. 8% stop, breakeven-then-trail, 14-day time stop.
  if (source === "tsmom") return { maxHoldH: 24 * 14, oneR: entry * 0.08, carry: lev > 1 };
  // TradingView strategy sleeves ("tv:<name>") are scored in the SAME container as the live
  // candidate (3% / 48h / managed exit) so their record is directly comparable and, if one
  // is armed, live reproduces exactly what paper measured.
  if (source && source.startsWith("tv:")) return { maxHoldH: MAX_HOLD_H, oneR: entry * 0.03, carry: lev > 1 };
  // SELECTIVE-SWING — RETIRED Sep 4 2026. Direct test of the Sep 3 conviction finding
  // (high setups average a +9.4% peak). Same high-conviction entries as `selective`,
  // swing room (5% stop / 4d). Result: 22 resolved, t=−3.8, −$4.1k — the peak was real
  // and the container handed it back. Exit profile stays for open trades.
  if (source === "selective-swing") return { maxHoldH: 24 * 4, oneR: entry * 0.05, carry: lev > 1 };
  return { maxHoldH: MAX_HOLD_H, oneR: entry * (0.3 / lev), carry: lev > 1 };
}

// RISK-BASED SIZING — mirrors the LIVE executor (margin-executor.ts:273-280): size the position
// so the INITIAL stop loses at most maxRiskPct of a reference account = a hard MAX LOSS per
// trade. A tighter stop → a BIGGER position for the SAME dollar risk (the real lever). Capped by
// leverage (can't hold more than lev × equity). This makes paper P&L read like real risk-managed
// trading — realistic size, fixed downside — instead of an arbitrary fixed stake.
export const SIZE_MULTIPLIER: Record<string, number> = { "selective-x5": 5 };
// EXPERIMENT TWINS ride the live candidate's signals at a different size. They are the SAME
// trades again, so pooling them with the record would count every candidate trade twice (at
// 3.5× the weight) in the headline totals, the conviction table, the edges by direction and
// coin, the milestone reports, and the daily lessons. They keep their own scoreboard row and
// the log; every POOLED statistic reads through this predicate instead of RECORD_SQL.
export const EXPERIMENT_SOURCES: string[] = [...Object.keys(SIZE_MULTIPLIER), ...TWIN_SOURCES];
export const POOLED_SQL = `${RECORD_SQL} AND COALESCE(source,'manual') NOT IN (${EXPERIMENT_SOURCES.map((s) => `'${s}'`).join(",")})`;
export function positionNotional(source: string | null, lev: number, entry: number, refEquity: number, maxRiskPct: number): number {
  const { oneR } = exitParams(source, lev, entry);
  maxRiskPct = maxRiskPct * (SIZE_MULTIPLIER[source ?? ""] ?? 1);
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
  // A webhook reserves its alert row before executing; if that request died (or was rate
  // limited) the row stays 'pending' with no price. It can never resolve — void it so it
  // never lingers as a phantom open trade.
  await prisma.$executeRawUnsafe(
    `UPDATE tradingview_alerts SET shadow_status='void', shadow_reason='pending alert never priced'
     WHERE exec_note IN ('pending','rate limited') AND mark_price IS NULL AND COALESCE(shadow_status,'open')='open' AND time < now() - interval '10 minutes'`,
  ).catch(() => {});
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
    const profile = exitParams(r.source, lev, entry);   // per-strategy exit profile
    const { maxHoldH, oneR, carry } = profile;
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
        const feeFrac = ENTRY_FEE + TAKER + (carry ? rollPeriods * rollover4h(r.symbol) : 0);
        const netPct = -feeFrac;
        const pnl = netPct * notional;
        const affected = await prisma.$executeRawUnsafe(
          `UPDATE tradingview_alerts SET shadow_status='resolved', shadow_exit=$1, shadow_pnl=$2, shadow_reason=$3, shadow_resolved_at=now(), shadow_fees=$5 WHERE id=$4 AND COALESCE(shadow_status,'open')='open'`,
          entry, pnl, `${timeStopLabel} (no price)`, r.id, feeFrac * notional,
        );
        if (affected === 0) continue;
        resolved.push({ id: r.id, symbol: r.symbol, side: r.side, entry, exit: entry, pnl, pnlPct: netPct, reason: `${timeStopLabel} (no price)`, leverage: lev, conviction: r.conviction, source: r.source });
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
    // Breakeven once +1R, then trail behind the peak — ratchet only (never loosen). The
    // trail width is the profile's (1R for the record; selective-tight narrows after +2R).
    const ratchet = () => { stopPx = managedStop(dir, entry, peak, stopPx, oneR, profile); };
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
    // Failure to launch (selective-launch only): still short of +launchMinR after launchH
    // hours → close at the last price and free the slot. Other profiles never take this path.
    if (exit == null && launchStopDue(profile, ageH, (dir * (peak - entry)) / oneR)) {
      exit = now;
      reason = `launch stop (${profile.launchH}h, <${profile.launchMinR}R)`;
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
      const uNet = uGross - ENTRY_FEE - TAKER - (carry ? uRoll * rollover4h(r.symbol) : 0);
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
    const feeFrac = ENTRY_FEE + TAKER + (carry ? rollPeriods * rollover4h(r.symbol) : 0);
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
    resolved.push({ id: r.id, symbol: r.symbol, side: r.side, entry, exit, pnl, pnlPct: netPct, reason, leverage: lev, conviction: r.conviction, source: r.source });
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
  nonUsOpen: number;      // current-cohort trades on pairs a US account cannot margin-trade:
  nonUsResolved: number;  // resolved to their finish and logged, but excluded from every
                          // statistic above (the live book could never have taken them)
}
export async function shadowScore(): Promise<ShadowScore> {
  await ensureShadowColumns();
  const [agg] = await prisma.$queryRawUnsafe<{ resolved: bigint; wins: bigint; total: number | null; open: bigint; openfloat: number | null }[]>(
    `SELECT
       count(*) FILTER (WHERE shadow_status='resolved')::bigint AS resolved,
       count(*) FILTER (WHERE shadow_status='resolved' AND shadow_pnl > 0)::bigint AS wins,
       COALESCE(sum(shadow_pnl) FILTER (WHERE shadow_status='resolved'),0)::float AS total,
       count(*) FILTER (WHERE side IN ('buy','sell') AND mark_price > 0 AND COALESCE(shadow_status,'open')='open')::bigint AS open,
       COALESCE(sum(shadow_unrealized) FILTER (WHERE side IN ('buy','sell') AND mark_price > 0 AND COALESCE(shadow_status,'open')='open'),0)::float AS openfloat
     FROM tradingview_alerts WHERE ${POOLED_SQL}`,
  );
  const [wl] = await prisma.$queryRawUnsafe<{ avgwin: number | null; avgloss: number | null }[]>(
    `SELECT
       avg(shadow_pnl) FILTER (WHERE shadow_status='resolved' AND shadow_pnl > 0) AS avgwin,
       avg(shadow_pnl) FILTER (WHERE shadow_status='resolved' AND shadow_pnl <= 0) AS avgloss
     FROM tradingview_alerts WHERE ${POOLED_SQL}`,
  );
  const tiers = await prisma.$queryRawUnsafe<{ tier: string; resolved: bigint; wins: bigint; total: number | null }[]>(
    `SELECT COALESCE(conviction,'untagged') AS tier,
       count(*)::bigint AS resolved,
       count(*) FILTER (WHERE shadow_pnl > 0)::bigint AS wins,
       COALESCE(sum(shadow_pnl),0)::float AS total
     FROM tradingview_alerts WHERE shadow_status='resolved' AND ${POOLED_SQL}
     GROUP BY COALESCE(conviction,'untagged')`,
  );
  const [nonUs] = await prisma.$queryRawUnsafe<{ open: bigint; resolved: bigint }[]>(
    // The complement of the record within the current cohort: what the universe fix
    // excluded. Shown so the exclusion is visible on the page, never silent.
    `SELECT
       count(*) FILTER (WHERE side IN ('buy','sell') AND COALESCE(shadow_status,'open')='open')::bigint AS open,
       count(*) FILTER (WHERE shadow_status='resolved')::bigint AS resolved
     FROM tradingview_alerts WHERE ${SIM_COHORT_SQL} AND NOT (${US_MARGIN_SYMBOLS_SQL})`,
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
    nonUsOpen: Number(nonUs.open),
    nonUsResolved: Number(nonUs.resolved),
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
  forwardResolved: number;   // of `resolved`, how many were ENTERED after UNIVERSE_FIX_AT
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
  days: number;           // distinct resolution days — the independence guard in the verdict
  verdict: string;        // rule-based: gathering / not paying / promising (could be luck) / REAL EDGE
}

// Rule-based verdict — the honest "does this work" call. Guards against reading luck as edge:
// needs a real sample (30+) AND positive net AND statistical significance (t≥2, ~95% it's not
// zero) before it says "REAL EDGE". Below t=2 a positive result could easily be luck — say so.
// The t-stat assumes independent trades, but crypto coins move together — 30 wins resolved in
// one correlated day are closer to ONE bet than thirty. So REAL EDGE additionally requires the
// resolutions to span 7+ distinct days; until then a significant result stays "promising".
function strategyVerdict(source: string, resolved: number, net: number, tStat: number | null, days: number): string {
  if (RETIRED_AUTO_SOURCES.has(source)) {
    return net <= 0 ? "retired — not paying" : "retired — no new entries";
  }
  if (resolved < 30) return `gathering (${resolved}/30)`;
  if (net <= 0) return "not paying";
  if (tStat != null && tStat >= 2) {
    if (days < 7) return `promising — significant, needs ${7 - days} more day${7 - days === 1 ? "" : "s"} of data`;
    return "REAL EDGE — significant";
  }
  return "promising (could be luck)";
}
const STRATEGY_LABELS: Record<string, string> = {
  scanner: "Fast — wide 6% stop — RETIRED Sep 4 (spray, not paying)",
  "fast-tight": "Fast — tight 2% stop — RETIRED Sep 1 (proven loser)",
  "swing-lev": "Leveraged swing — PAUSED Sep 4 (not the live candidate)",
  "swing-spot": "Spot swing — PAUSED Sep 4 (not the live candidate)",
  "sweep-fade": "Liquidity-sweep fade — RETIRED Sep 3 (proven loser)",
  selective: "Selective — high-conviction 5m/15m longs, 3% / 48h",
  "selective-x5": "Selective ×5 SIZE — the SAME trades again at 5× the risk (15%/30%), 5× leverage — experiment, never live, not pooled",
  "selective-swing": "Selective SWING — RETIRED Sep 4 (5%/4d give-back)",
  "selective-tight": "Selective TIGHT TRAIL — same trades, trail 0.5R after +2R — twin (Sep 7), not pooled",
  "selective-launch": "Selective LAUNCH STOP — same trades, closed if <+0.5R after 8h — twin (Sep 7), not pooled",
  "selective-btc": "Selective in BTC UP-REGIME only — same trades, opened only above BTC's 20-day average — twin (Sep 7), not pooled",
  "selective-majors": "Selective on the MAJORS only — same rule, BTC / ETH / SOL signals only — twin (Sep 7), not pooled",
  tsmom: "Daily trend (tsmom) — majors, 20-day momentum, 8% / 14d — new sleeve (Sep 7), paper only",
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
    meanpnl: number | null; stdpnl: number | null; peaked: bigint; days: bigint; fwd: bigint;
    livenet: number | null; livemean: number | null; livestd: number | null;
  }[]>(
    `SELECT COALESCE(source,'manual') AS source,
       count(*) FILTER (WHERE shadow_status='resolved')::bigint AS resolved,
       count(*) FILTER (WHERE shadow_status='resolved' AND shadow_pnl > 0)::bigint AS wins,
       count(*) FILTER (WHERE shadow_status='resolved' AND shadow_peak IS NOT NULL AND mark_price > 0
         AND ((side='buy' AND shadow_peak > mark_price) OR (side='sell' AND shadow_peak < mark_price)))::bigint AS peaked,
       count(DISTINCT date_trunc('day', shadow_resolved_at)) FILTER (WHERE shadow_status='resolved')::bigint AS days,
       count(*) FILTER (WHERE shadow_status='resolved' AND time > '${UNIVERSE_FIX_AT}'::timestamptz)::bigint AS fwd,
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
       count(*) FILTER (WHERE side IN ('buy','sell') AND mark_price > 0 AND COALESCE(shadow_status,'open')='open')::bigint AS open,
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
     WHERE ${RECORD_SQL}
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
        label: STRATEGY_LABELS[r.source] ?? (r.source.startsWith("tv:") ? `TradingView — ${r.source.slice(3)} (3% / 48h)` : r.source),
        resolved,
        wins: Number(r.wins),
        hitRate: resolved > 0 ? Number(r.wins) / resolved : null,
        avgWin: r.avgwin || 0,
        avgLoss: r.avgloss || 0,
        expectancy: resolved > 0 ? net / resolved : null,
        totalPnl: net,
        open: Number(r.open),
        peakedGreen: Number(r.peaked),
        forwardResolved: Number(r.fwd),
        liveNet,
        fees: r.fees || 0,
        grossPnl: net + (r.fees || 0),   // net + fees = gross (before-fee P&L)
        tStat,
        paperTStat,
        // Gate on the LIVE net and the LIVE t-stat — the money that would actually be made,
        // judged at the significance the live sizing would actually achieve.
        days: Number(r.days),
        verdict: strategyVerdict(r.source, resolved, liveNet, tStat, Number(r.days)),
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
     WHERE side IN ('buy','sell') AND ${POOLED_SQL}
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
  usTradeable: boolean; // false = a pair the live book cannot margin-trade; logged, not counted
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
    usTradeable: isUsMarginSymbol(r.symbol),
  }));
}

// LIVE CANDIDATE DETAIL — the per-trade view the daily synthesis and its lessons read.
// The scoreboard row is one pooled number; this is the same sleeve sliced the ways that
// decide whether the pooled number can be trusted: forward-only (entered after the policy
// cut), by timeframe, by resolution day (one big day ≈ one bet), and the last N trades with
// their peak and exit reason (the give-back, trade by trade). Read-only, RECORD_SQL scoped.
export interface CandidateSlice { key: string; resolved: number; wins: number; hitRate: number | null; net: number; tStat: number | null; days: number; open: number }
export interface CandidateTrade {
  id: number; symbol: string; timeframe: string | null; conviction: string | null; opened: string;
  resolvedAt: string | null; peakPct: number | null; reason: string | null; pnl: number | null;
}
export interface CandidateDetail {
  source: string;
  forward: CandidateSlice | null;              // entered after POLICY_CUT_AT
  byTimeframe: CandidateSlice[];
  byEntryWindow: CandidateSlice[];             // 6-hour UTC windows of the ENTRY time (pre-registered cut)
  byDay: { day: string; resolved: number; net: number }[];   // UTC resolution days
  recent: CandidateTrade[];
}
const TF_SQL = `COALESCE(substring(note from '(5m|15m|1h|4h|1d)'), '?')`;
export async function candidateDetail(source: string, limit = 30): Promise<CandidateDetail> {
  await ensureShadowColumns();
  type SliceRow = { k: string; resolved: bigint; wins: bigint; net: number | null; meanpnl: number | null; stdpnl: number | null; days: bigint; open: bigint };
  // groupExpr / extraWhere are fixed strings chosen below — never user input.
  const slice = async (groupExpr: string, extraWhere: string): Promise<CandidateSlice[]> => {
    const rows = await prisma.$queryRawUnsafe<SliceRow[]>(
      `SELECT ${groupExpr} AS k,
         count(*) FILTER (WHERE shadow_status='resolved')::bigint AS resolved,
         count(*) FILTER (WHERE shadow_status='resolved' AND shadow_pnl > 0)::bigint AS wins,
         COALESCE(sum(shadow_pnl) FILTER (WHERE shadow_status='resolved'),0)::float AS net,
         avg(shadow_pnl) FILTER (WHERE shadow_status='resolved') AS meanpnl,
         stddev_samp(shadow_pnl) FILTER (WHERE shadow_status='resolved') AS stdpnl,
         count(DISTINCT date_trunc('day', shadow_resolved_at AT TIME ZONE 'UTC')) FILTER (WHERE shadow_status='resolved')::bigint AS days,
         count(*) FILTER (WHERE side IN ('buy','sell') AND mark_price > 0 AND COALESCE(shadow_status,'open')='open')::bigint AS open
       FROM tradingview_alerts
       WHERE source=$1 AND side IN ('buy','sell') AND ${RECORD_SQL} ${extraWhere}
       GROUP BY 1`,
      source,
    );
    return rows.map((r) => {
      const resolved = Number(r.resolved);
      return {
        key: String(r.k), resolved, wins: Number(r.wins),
        hitRate: resolved > 0 ? Number(r.wins) / resolved : null,
        net: r.net || 0,
        tStat: resolved > 1 && r.meanpnl != null && r.stdpnl != null && r.stdpnl > 0 ? (r.meanpnl * Math.sqrt(resolved)) / r.stdpnl : null,
        days: Number(r.days), open: Number(r.open),
      };
    });
  };
  const [fwd, byTimeframe, byWindow, dayRows, recentRows] = await Promise.all([
    slice(`'forward'`, `AND time > '${POLICY_CUT_AT}'::timestamptz`),
    slice(TF_SQL, ""),
    slice(ENTRY_WINDOW_SQL, ""),
    prisma.$queryRawUnsafe<{ day: string; resolved: bigint; net: number | null }[]>(
      `SELECT to_char(date_trunc('day', shadow_resolved_at AT TIME ZONE 'UTC'), 'YYYY-MM-DD') AS day,
         count(*)::bigint AS resolved, COALESCE(sum(shadow_pnl),0)::float AS net
       FROM tradingview_alerts WHERE source=$1 AND shadow_status='resolved' AND ${RECORD_SQL}
       GROUP BY 1 ORDER BY 1`,
      source,
    ),
    prisma.$queryRawUnsafe<{ id: number; symbol: string; tf: string; conviction: string | null; time: Date; shadow_resolved_at: Date | null; peakpct: number | null; shadow_reason: string | null; shadow_pnl: number | null }[]>(
      `SELECT id, symbol, ${TF_SQL} AS tf, conviction, time, shadow_resolved_at, shadow_reason, shadow_pnl,
         CASE WHEN shadow_peak IS NOT NULL AND mark_price > 0
              THEN (CASE WHEN side='buy' THEN shadow_peak / mark_price - 1 ELSE 1 - shadow_peak / mark_price END) * 100 END AS peakpct
       FROM tradingview_alerts WHERE source=$1 AND shadow_status='resolved' AND ${RECORD_SQL}
       ORDER BY shadow_resolved_at DESC LIMIT $2`,
      source, Math.max(1, Math.min(200, limit)),
    ),
  ]);
  const order: Record<string, number> = { "5m": 0, "15m": 1, "1h": 2, "4h": 3, "1d": 4 };
  return {
    source,
    forward: fwd[0] ?? null,
    byTimeframe: byTimeframe.sort((a, b) => (order[a.key] ?? 9) - (order[b.key] ?? 9)),
    byEntryWindow: byWindow.sort((a, b) => a.key.localeCompare(b.key)),
    byDay: dayRows.map((d) => ({ day: d.day, resolved: Number(d.resolved), net: d.net || 0 })),
    recent: recentRows.map((r) => ({
      id: r.id, symbol: r.symbol, timeframe: r.tf === "?" ? null : r.tf, conviction: r.conviction,
      opened: r.time.toISOString(), resolvedAt: r.shadow_resolved_at?.toISOString() ?? null,
      peakPct: r.peakpct, reason: r.shadow_reason, pnl: r.shadow_pnl,
    })),
  };
}
