import { prisma } from "./db";
import { getTradovateAccountSummary } from "./tradovate";
import { reconcileCapitalFlows, netFlowsAfterInception } from "./capital-flows";
import { getRealtimeEdgePerformance, getFuturesCloses } from "./edge-performance";

/**
 * SINGLE SOURCE OF TRUTH for live-futures P&L.
 *
 * The ONLY correct measure of real-money P&L is the broker account balance delta:
 *   netPnl = netLiq − startingCapital − netDepositsSinceInception
 * NOT a sum of autoTradeLog rows (an event log double-logs, includes scale-outs, and carries the
 * Jul 16-17 orphaned-bracket incident phantom — that's the source of the inflated "+$366").
 *
 * Every "realized / net / total live P&L" surface (Orders header, Track Record header, Command
 * Center) must call this so the number always equals the broker and never drifts between pages.
 * Trade-row sums are reserved for clearly-labeled per-edge/per-trade DETAIL only.
 *
 * The dollar figure is balance-based; the trade COUNT + win rate come from paired round-trips
 * (entries→exits, incident window already excluded in getRealtimeEdgePerformance).
 */
// ── STARTING-CAPITAL BASELINE ────────────────────────────────────────────────────────────────────
// Every P&L number on every page is `balance − thisNumber − deposits`, so if two code paths disagree
// about it they report different P&L for the same account at the same moment. They DID: this module
// fell back to 4821 while /api/futures/positions fell back to 1025 — a $3,796 spread, i.e. the live
// account reading as +$3,475 on one page and −$321 on another whenever the config row was missing.
//
// The account's real history is why both numbers existed and why neither is a safe guess: it opened
// near $1,025, traded down to ~$821 by late May, took a $4,000 ACH on 2026-07-11, and was rebaselined
// to ~$4,821 with `strategy_inception = 2026-07-10`. The 1025 fallback is simply pre-funding, left
// behind. A baseline that moved by 4.7x is exactly the kind of number that must never be guessed.
//
// So: ONE resolver, and it reports whether the value is real. Callers that show money must degrade to
// "—" when `configured` is false rather than render a number that is off by the size of the account.
export const STARTING_CAPITAL_KEY = { live: "starting_capital_live", demo: "starting_capital_demo" } as const;
/** Last-resort display baselines. Only ever used to keep a layout from breaking — never to state P&L,
 *  because `configured: false` is what callers must branch on. */
const STARTING_CAPITAL_FALLBACK = { live: 4821, demo: 50000 } as const;

export async function getStartingCapital(mode: "live" | "demo" = "live"): Promise<{ value: number; configured: boolean }> {
  try {
    const row = await prisma.agentConfig.findUnique({ where: { key: STARTING_CAPITAL_KEY[mode] } });
    const parsed = row?.value != null ? parseFloat(row.value) : NaN;
    if (Number.isFinite(parsed) && parsed > 0) return { value: parsed, configured: true };
  } catch { /* fall through to the unconfigured answer */ }
  return { value: STARTING_CAPITAL_FALLBACK[mode], configured: false };
}

export interface LiveFuturesPnl {
  ok: boolean;              // false if the broker balance was unreachable — callers should show "—", not a guess
  netPnl: number;          // authoritative: netLiq − startingCapital − netDeposits
  currentBalance: number;  // broker netLiq
  startingCapital: number;
  netDeposits: number;     // deposits/withdrawals since inception (so funding transfers never count as P&L)
  roundTrips: number;      // completed trades (paired closes), NOT log rows
  wins: number;
  winRate: number;
}

// Balance-based P&L for either engine. Demo mirrors live's tracking exactly (own starting capital,
// own inception, own broker account) so the demo forward-test is measured the same honest way.
// NOTE the broker-mode mapping: the demo Tradovate account is TradingMode "paper" (there is no
// "demo"); our own live/demo convention only drives the trade-log symbol set + prefix.
export async function getFuturesPnl(mode: "live" | "demo" = "live"): Promise<LiveFuturesPnl> {
  const brokerMode = mode === "live" ? "live" : "paper";
  const { value: startingCapital, configured } = await getStartingCapital(mode);

  // Broker balance (netLiq) — authoritative. Guard the known "account resolution crossed accounts"
  // leak (a netLiq wildly above this account's capital) the same way the positions route does.
  let currentBalance = startingCapital;
  // An unconfigured baseline can never produce a trustworthy P&L — netPnl would be the account's
  // distance from a guess. Start not-ok so callers render "—"; a reachable broker cannot rescue it.
  let ok = configured;
  try {
    const s = await getTradovateAccountSummary(brokerMode);
    const nl = s.netLiq || s.balance || 0;
    // `configured` still gates ok: a live balance against a guessed baseline is a confident wrong
    // number, which is worse than "—". Both must hold.
    if (nl > 0 && nl < startingCapital * 20) { currentBalance = nl; ok = configured; }
  } catch { /* broker unreachable — ok stays false */ }

  // Net deposits/withdrawals since inception, so a funding transfer never reads as profit.
  let netDeposits = 0;
  try {
    const incKey = mode === "live" ? "strategy_inception" : "demo_scoreboard_since";
    const incRow = await prisma.agentConfig.findUnique({ where: { key: incKey } });
    const inception = incRow?.value || (mode === "live" ? "2026-07-10" : "2026-07-22");
    const r = await reconcileCapitalFlows(brokerMode, {});
    netDeposits = netFlowsAfterInception(r.flows, inception);
  } catch { /* leave 0 — not flow-adjusted this call */ }

  // Round-trips + win rate from paired closes (incident already excluded in the edge perf).
  let roundTrips = 0, wins = 0;
  try {
    const perf = await getRealtimeEdgePerformance(mode);
    for (const k of Object.keys(perf)) { roundTrips += perf[k].trades; wins += perf[k].wins; }
  } catch { /* leave zeros */ }

  return {
    ok,
    netPnl: currentBalance - startingCapital - netDeposits,
    currentBalance,
    startingCapital,
    netDeposits,
    roundTrips,
    wins,
    winRate: roundTrips ? wins / roundTrips : 0,
  };
}

// Back-compat wrapper — live is the default everywhere it was called before.
export function getLiveFuturesPnl(): Promise<LiveFuturesPnl> { return getFuturesPnl("live"); }

// Full live-futures performance-panel stats — the ONE authoritative source for the Futures page's
// Performance card. `netPnl` is the balance-based account truth; EVERY trade statistic (count, win
// rate, avg win/loss, best/worst, recent-window sums) is derived from the SAME clean round-trip set
// (getFuturesCloses, incident-excluded), so best/worst can't disagree with the counts and the panel
// can't show a total that reconciles to nothing.
export interface LiveFuturesStats {
  ok: boolean;
  netPnl: number;          // ACCOUNT total (broker balance delta) — the authoritative headline
  currentBalance: number;
  startingCapital: number;
  netDeposits: number;
  roundTrips: number;      // clean paired closes (incident excluded), NOT log rows
  wins: number;
  losses: number;
  winRate: number;
  realizedSum: number;     // sum of clean closes — the trade-sum; differs from netPnl by fees + incident
  avgWin: number;
  avgLoss: number;
  best: { pnl: number; sym: string } | null;
  worst: { pnl: number; sym: string } | null;
  last24h: number;
  last7d: number;
  last30d: number;
}

export async function getFuturesStats(mode: "live" | "demo" = "live"): Promise<LiveFuturesStats> {
  const [base, closes] = await Promise.all([
    getFuturesPnl(mode),
    getFuturesCloses(mode).catch(() => [] as Awaited<ReturnType<typeof getFuturesCloses>>),
  ]);
  const wins = closes.filter((c) => c.pnl > 0);
  const losses = closes.filter((c) => c.pnl < 0);
  const avgWin = wins.length ? wins.reduce((s, c) => s + c.pnl, 0) / wins.length : 0;
  const avgLoss = losses.length ? losses.reduce((s, c) => s + c.pnl, 0) / losses.length : 0;
  let best: { pnl: number; sym: string } | null = null;
  let worst: { pnl: number; sym: string } | null = null;
  for (const c of closes) {
    const sym = c.sym.replace("FUT:", "");
    if (!best || c.pnl > best.pnl) best = { pnl: c.pnl, sym };
    if (!worst || c.pnl < worst.pnl) worst = { pnl: c.pnl, sym };
  }
  const now = Date.now(), DAY = 86_400_000;
  const sumSince = (ms: number) => closes.filter((c) => c.ts.getTime() >= ms).reduce((s, c) => s + c.pnl, 0);
  return {
    ok: base.ok,
    netPnl: base.netPnl,
    currentBalance: base.currentBalance,
    startingCapital: base.startingCapital,
    netDeposits: base.netDeposits,
    roundTrips: closes.length,
    wins: wins.length,
    losses: losses.length,
    winRate: closes.length ? wins.length / closes.length : 0,
    realizedSum: closes.reduce((s, c) => s + c.pnl, 0),
    avgWin,
    avgLoss,
    best,
    worst,
    last24h: sumSince(now - DAY),
    last7d: sumSince(now - 7 * DAY),
    last30d: sumSince(now - 30 * DAY),
  };
}

// Back-compat wrapper — live is the default everywhere it was called before.
export function getLiveFuturesStats(): Promise<LiveFuturesStats> { return getFuturesStats("live"); }
