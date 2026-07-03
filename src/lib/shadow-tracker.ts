/**
 * AI-Veto Shadow Tracker — resolver.
 *
 * Every setup the live/demo futures engine graded but did NOT trade (AI-rejected,
 * pattern-blocked, no-verdict) is logged to the ShadowTrade table with its would-be
 * entry/stop/target. This resolver marks each open shadow trade to REAL price and
 * scores the counterfactual: would the vetoed setup have won or lost?
 *
 * Aggregate net-R across resolved shadow trades answers the one unmeasured question
 * in the system — is the AI veto saving money (net-R strongly negative → good vetoes)
 * or leaving it on the table (net-R positive → the veto is costing us)?
 *
 * HONEST CAVEATS (documented, surfaced in the UI):
 *  - Counterfactual: the trade never actually filled. We assume a fill at the signal
 *    price and first-touch stop/target resolution.
 *  - 5-minute bars → if a single bar's range spans BOTH stop and target, we resolve
 *    pessimistically (stop first). This biases AGAINST "the veto cost us money," i.e.
 *    it is conservative against our own hypothesis — the honest direction.
 *  - We replicate the engine's core exits (stop, target, 30-min-no-1R time-exit) but
 *    NOT its trailing/scaling/pyramiding. Runners are therefore slightly understated.
 */

import { prisma } from "@/lib/db";
import { getFuturesIntradayBars } from "@/lib/futures-data";

// Mirror the engine (futures-realtime.ts): time-exit a trade that hasn't reached +1R
// within 30 minutes; otherwise let it ride to stop/target inside a bounded window.
const TIME_EXIT_MIN = 30;
const MAX_HOLD_MIN = 240; // 4h ceiling; after this we expire-mark to last price
// Don't finalize a setup that's too fresh to have any post-signal bars yet.
const MIN_AGE_MIN = 8;
// Bar width. We only use bars whose INTERVAL is fully after the signal, because Tradovate
// stamps bars at their CLOSE time (Yahoo at open) — a bar stamped just after the signal can
// still contain pre-signal price action and cause look-ahead. Dropping one bar costs ≤5 min,
// already covered by MIN_AGE_MIN.
const BAR_MS = 5 * 60_000;

type Bar = { tMs: number; h: number; l: number; c: number };

/** Normalize a Tradovate/Yahoo bar timestamp to epoch-ms. */
function toMs(t: number): number {
  return t < 1e12 ? t * 1000 : t;
}

interface Resolution {
  status: "win" | "loss" | "expired";
  exitPrice: number;
  rMultiple: number;
  exitReason: "target" | "stop" | "time_exit" | "eod";
}

/**
 * Walk post-signal bars and resolve a single counterfactual trade.
 * Returns null if there isn't enough data yet (leave it open for the next pass).
 */
export function resolveAgainstBars(
  t: { direction: string; entry: number; stop: number; target: number; createdAtMs: number },
  bars: Bar[],
  nowMs: number,
): Resolution | null {
  const long = t.direction === "long";
  const stopDist = Math.abs(t.entry - t.stop);
  if (stopDist <= 0) return null;
  const rWin = Math.abs(t.target - t.entry) / stopDist;

  // Only bars whose full interval is AFTER the signal (no look-ahead — bars are close- or
  // open-stamped depending on source; requiring start > signal is safe for both).
  const post = bars.filter((b) => b.tMs - BAR_MS >= t.createdAtMs).sort((a, b) => a.tMs - b.tMs);
  const ageMin = (nowMs - t.createdAtMs) / 60_000;
  if (post.length === 0) {
    // No post-signal bars yet. If it's already older than the max window, expire flat.
    return ageMin >= MAX_HOLD_MIN
      ? { status: "expired", exitPrice: t.entry, rMultiple: 0, exitReason: "expired" as never }
      : null;
  }

  let reached1R = false;
  for (const b of post) {
    const elapsed = (b.tMs - t.createdAtMs) / 60_000;

    // First-touch stop/target within this bar. Pessimistic on ambiguous bars: stop wins.
    const hitStop = long ? b.l <= t.stop : b.h >= t.stop;
    const hitTarget = long ? b.h >= t.target : b.l <= t.target;
    if (hitStop) return { status: "loss", exitPrice: t.stop, rMultiple: -1, exitReason: "stop" };
    if (hitTarget) return { status: "win", exitPrice: t.target, rMultiple: rWin, exitReason: "target" };

    // Track max favorable excursion for the engine's 30-min time-exit rule.
    const fav = long ? b.h - t.entry : t.entry - b.l;
    if (fav >= stopDist) reached1R = true;

    // Engine's time-exit: ≥30 min in and never reached +1R → cut at this bar's close.
    if (elapsed >= TIME_EXIT_MIN && !reached1R) {
      const r = ((long ? b.c - t.entry : t.entry - b.c) / stopDist);
      return { status: r >= 0 ? "expired" : "loss", exitPrice: b.c, rMultiple: r, exitReason: "time_exit" };
    }

    // Hard ceiling — expire-mark to this close.
    if (elapsed >= MAX_HOLD_MIN) {
      const r = ((long ? b.c - t.entry : t.entry - b.c) / stopDist);
      return { status: r > 0 ? "win" : r < 0 ? "loss" : "expired", exitPrice: b.c, rMultiple: r, exitReason: "eod" };
    }
  }

  // Ran out of bars without a touch. Only finalize once we're past the max window;
  // otherwise keep it open so later bars can resolve it.
  if (ageMin >= MAX_HOLD_MIN) {
    const last = post[post.length - 1];
    const r = ((long ? last.c - t.entry : t.entry - last.c) / stopDist);
    return { status: r > 0 ? "win" : r < 0 ? "loss" : "expired", exitPrice: last.c, rMultiple: r, exitReason: "eod" };
  }
  return null;
}

/** Resolve all open shadow trades old enough to have post-signal price data. */
export async function resolveOpenShadowTrades(): Promise<{ scanned: number; resolved: number; details: string[] }> {
  const nowMs = Date.now();
  const open = await prisma.shadowTrade.findMany({
    where: { status: "open" },
    orderBy: { createdAt: "asc" },
    take: 200,
  });

  // Group by symbol+mode so we fetch each symbol's bars once.
  const byKey = new Map<string, typeof open>();
  for (const t of open) {
    const ageMin = (nowMs - new Date(t.createdAt).getTime()) / 60_000;
    if (ageMin < MIN_AGE_MIN) continue; // too fresh — no bars yet
    const k = `${t.mode}|${t.symbol}`;
    (byKey.get(k) ?? byKey.set(k, []).get(k)!).push(t);
  }

  const details: string[] = [];
  let resolved = 0;

  for (const [k, trades] of byKey) {
    const [mode, symbol] = k.split("|");
    let bars: Bar[] = [];
    try {
      // Gold bars are market-wide — no account/mode override needed (Tradovate → Yahoo fallback).
      const raw = await getFuturesIntradayBars(symbol, "5m", "5d");
      bars = raw.map((b) => ({ tMs: toMs(b.t), h: b.h, l: b.l, c: b.c }));
    } catch (err) {
      details.push(`${symbol}: bar fetch failed (${err instanceof Error ? err.message : err})`);
      continue;
    }
    if (bars.length === 0) { details.push(`${symbol}: no bars`); continue; }

    for (const t of trades) {
      const res = resolveAgainstBars(
        { direction: t.direction, entry: t.entry, stop: t.stop, target: t.target, createdAtMs: new Date(t.createdAt).getTime() },
        bars,
        nowMs,
      );
      if (!res) continue;
      await prisma.shadowTrade.update({
        where: { id: t.id },
        data: {
          status: res.status,
          exitPrice: res.exitPrice,
          rMultiple: res.rMultiple,
          exitReason: res.exitReason,
          resolvedAt: new Date(),
        },
      }).catch(() => {});
      resolved++;
      details.push(`${mode} ${symbol} ${t.direction} ${t.setupType} → ${res.status} (${res.rMultiple >= 0 ? "+" : ""}${res.rMultiple.toFixed(2)}R, ${res.exitReason})`);
    }
  }

  return { scanned: open.length, resolved, details };
}

export interface ShadowScoreboard {
  mode: string;
  resolved: number;
  open: number;
  wins: number;
  losses: number;
  winRate: number;      // over resolved with a directional outcome
  netR: number;         // sum of rMultiple over resolved
  avgR: number;
  // Interpretation for the UI: net-R of the setups the veto BLOCKED.
  // netR < 0 → veto is saving money (good). netR > 0 → veto is costing money.
  verdict: "veto_helping" | "veto_costing" | "inconclusive";
}

/** Aggregate the counterfactual scoreboard for a mode ("live" | "demo"). */
export async function getShadowScoreboard(mode: string): Promise<ShadowScoreboard> {
  const rows = await prisma.shadowTrade.findMany({ where: { mode } });
  const resolved = rows.filter((r) => r.status !== "open");
  const open = rows.length - resolved.length;
  const netR = resolved.reduce((s, r) => s + (r.rMultiple ?? 0), 0);
  // Win-rate is measured over DECISIVE exits only (hit target vs hit stop). Time-exits and
  // expiries still count toward net-R but aren't a clean win/loss, so they're excluded from WR.
  const wins = resolved.filter((r) => r.exitReason === "target").length;
  const losses = resolved.filter((r) => r.exitReason === "stop").length;
  const decided = wins + losses;

  let verdict: ShadowScoreboard["verdict"] = "inconclusive";
  if (resolved.length >= 15) verdict = netR < -1 ? "veto_helping" : netR > 1 ? "veto_costing" : "inconclusive";

  return {
    mode,
    resolved: resolved.length,
    open,
    wins,
    losses,
    winRate: decided > 0 ? wins / decided : 0,
    netR,
    avgR: resolved.length > 0 ? netR / resolved.length : 0,
    verdict,
  };
}
