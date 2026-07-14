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
import { getDatabentoIntradayBars } from "@/lib/databento";
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

// $ per point for each contract, so we can translate R into real dollars.
const POINT_VALUE: Record<string, number> = { MGC: 10, GC: 100, MNQ: 2, MES: 5, NQ: 20, ES: 50, YM: 5, MYM: 0.5 };

/**
 * Translate a resolved counterfactual into real dollars using the SAME sizing the engine would
 * actually have used: contracts = min(maxContracts, floor(riskTarget / per-contract-stop-risk)).
 * `sizing` must reflect the live account's real caps (live trades 1 micro — live_futures_max_contracts),
 * NOT a stale hardcoded value, or the "would have won/lost" numbers come out several times too big.
 */
export function shadowDollars(
  t: { symbol: string; entry: number; stop: number; rMultiple: number },
  sizing: { riskPct: number; maxContracts: number },
  equity: number,
): { contracts: number; dollarPnl: number } {
  const { riskPct, maxContracts } = sizing;
  const pv = POINT_VALUE[t.symbol] ?? 10;
  const perContractRisk = Math.abs(t.entry - t.stop) * pv;
  if (perContractRisk <= 0 || equity <= 0) return { contracts: 1, dollarPnl: 0 };
  const riskTarget = equity * (riskPct / 100);
  const contracts = Math.max(1, Math.min(maxContracts, Math.floor(riskTarget / perContractRisk)));
  return { contracts, dollarPnl: t.rMultiple * perContractRisk * contracts };
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

  // Fetch the live account equity once so we can translate R into real dollars. Demo uses its
  // simulated equity. Best-effort — if the balance call fails we fall back to a sane default.
  let liveEquity = 1104;
  try {
    const { getTradovateAccountSummary } = await import("@/lib/tradovate");
    const s = await getTradovateAccountSummary("live");
    if (s?.netLiq > 0) liveEquity = s.netLiq;
  } catch { /* keep fallback */ }
  // Live sizing must mirror the REAL live caps (1 micro), read from DB so it never drifts stale.
  let liveMaxContracts = 1, liveRiskPct = 6;
  try {
    const cfg = await prisma.agentConfig.findMany({ where: { key: { in: ["live_futures_max_contracts", "live_futures_risk_per_trade_pct"] } } });
    const mc = parseInt(cfg.find((c) => c.key === "live_futures_max_contracts")?.value ?? "");
    const rp = parseFloat(cfg.find((c) => c.key === "live_futures_risk_per_trade_pct")?.value ?? "");
    if (Number.isFinite(mc) && mc > 0) liveMaxContracts = mc;
    if (Number.isFinite(rp) && rp > 0) liveRiskPct = rp;
  } catch { /* keep defaults (1 micro / 6%) */ }
  const equityFor = (mode: string) => (mode === "live" ? liveEquity : 59_000);
  const sizingFor = (mode: string) =>
    mode === "live" ? { riskPct: liveRiskPct, maxContracts: liveMaxContracts } : { riskPct: 7, maxContracts: 10 };

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
      // Databento FIRST — it's the same real-time source the engine trades on. The Tradovate/Yahoo
      // path (getFuturesIntradayBars) 404s on gold and Yahoo's GC=F 5m feed runs hours stale, which
      // silently expired every trade at 0R. Databento (present on Vercel) covers the signal window.
      let raw = await getDatabentoIntradayBars(symbol, "5m", "5d").catch(() => []);
      if (raw.length === 0) raw = await getFuturesIntradayBars(symbol, "5m", "5d").catch(() => []);
      bars = raw.map((b) => ({ tMs: toMs(b.t), h: b.h, l: b.l, c: b.c }));
    } catch (err) {
      details.push(`${symbol}: bar fetch failed (${err instanceof Error ? err.message : err})`);
      continue;
    }
    if (bars.length === 0) { details.push(`${symbol}: no bars`); continue; }
    // Guard against a stale feed silently expiring everything: if the newest bar is hours old,
    // skip this pass rather than mark trades to dead data. They stay open for a later, healthy pass.
    const newestAgeMin = (nowMs - Math.max(...bars.map((b) => b.tMs))) / 60_000;
    if (newestAgeMin > 90) { details.push(`${symbol}: freshest bar ${Math.round(newestAgeMin)}min stale — skipping`); continue; }

    for (const t of trades) {
      const res = resolveAgainstBars(
        { direction: t.direction, entry: t.entry, stop: t.stop, target: t.target, createdAtMs: new Date(t.createdAt).getTime() },
        bars,
        nowMs,
      );
      if (!res) continue;
      const { contracts, dollarPnl } = shadowDollars(
        { symbol, entry: t.entry, stop: t.stop, rMultiple: res.rMultiple },
        sizingFor(mode),
        equityFor(mode),
      );
      await prisma.shadowTrade.update({
        where: { id: t.id },
        data: {
          status: res.status,
          exitPrice: res.exitPrice,
          rMultiple: res.rMultiple,
          exitReason: res.exitReason,
          contracts,
          dollarPnl,
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
  resolved: number;     // DISTINCT MOVES (de-clustered) — what you could actually trade
  rawSignals: number;   // raw 5-min signals before de-clustering (for transparency)
  open: number;
  wins: number;
  losses: number;
  winRate: number;      // over resolved with a directional outcome
  netR: number;         // sum of rMultiple over distinct moves
  netDollars: number;   // sum of counterfactual $ P&L over distinct moves (real sizing)
  avgR: number;
  // Interpretation for the UI: net-R of the setups the veto BLOCKED.
  // netR < 0 → veto is saving money (good). netR > 0 → veto is costing money.
  verdict: "veto_helping" | "veto_costing" | "inconclusive";
}

const CLUSTER_WINDOW_MS = 30 * 60_000;   // same-direction signals within 30 min = the same move

// De-cluster: the engine re-fires a signal every 5-min bar during a trend, so one market move logs as
// many "trades" — but you'd only take ONE position per move. Collapse consecutive same-(symbol,direction)
// signals within the window into a single realistic entry, keeping the FIRST (no cherry-picking a better
// re-entry). Without this, a single gold run counts 10-12× and wildly inflates the counterfactual.
function deClusterMoves<T extends { symbol: string; direction: string; createdAt: Date }>(rows: T[]): T[] {
  const sorted = [...rows].sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
  const kept: T[] = [];
  const lastTs: Record<string, number> = {};
  for (const r of sorted) {
    const key = `${r.symbol}|${r.direction}`;
    const ts = r.createdAt.getTime();
    const prev = lastTs[key];
    lastTs[key] = ts;                                   // advance the chain even for skipped signals
    if (prev != null && ts - prev < CLUSTER_WINDOW_MS) continue;   // same move → skip the repeat
    kept.push(r);
  }
  return kept;
}

/** Aggregate the counterfactual scoreboard for a mode ("live" | "demo"), de-clustered to real moves. */
export async function getShadowScoreboard(mode: string): Promise<ShadowScoreboard> {
  const rows = await prisma.shadowTrade.findMany({ where: { mode } });
  const resolvedRaw = rows.filter((r) => r.status !== "open");
  const open = rows.length - resolvedRaw.length;
  const moves = deClusterMoves(resolvedRaw);            // one realistic entry per move
  const netR = moves.reduce((s, r) => s + (r.rMultiple ?? 0), 0);
  const netDollars = moves.reduce((s, r) => s + (r.dollarPnl ?? 0), 0);
  // Win-rate over DECISIVE exits only (hit target vs hit stop); time-exits/expiries excluded from WR.
  const wins = moves.filter((r) => r.exitReason === "target").length;
  const losses = moves.filter((r) => r.exitReason === "stop").length;
  const decided = wins + losses;

  // Verdict only on a real sample of distinct MOVES (not raw signals), with a wider neutral band so a
  // handful of clustered trades can't trip a scary conclusion.
  let verdict: ShadowScoreboard["verdict"] = "inconclusive";
  if (moves.length >= 30) verdict = netR < -2 ? "veto_helping" : netR > 2 ? "veto_costing" : "inconclusive";

  return {
    mode,
    resolved: moves.length,
    rawSignals: resolvedRaw.length,
    open,
    wins,
    losses,
    winRate: decided > 0 ? wins / decided : 0,
    netR,
    netDollars,
    avgR: moves.length > 0 ? netR / moves.length : 0,
    verdict,
  };
}
