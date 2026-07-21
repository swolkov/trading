import { prisma } from "./db";
import { getTradovateAccountSummary } from "./tradovate";
import { reconcileCapitalFlows, netFlowsAfterInception } from "./capital-flows";
import { getRealtimeEdgePerformance } from "./edge-performance";

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

export async function getLiveFuturesPnl(): Promise<LiveFuturesPnl> {
  // Starting capital (re-baselined on each real deposit).
  const scRow = await prisma.agentConfig.findUnique({ where: { key: "starting_capital_live" } }).catch(() => null);
  const startingCapital = scRow?.value ? parseFloat(scRow.value) : 4821;

  // Broker balance (netLiq) — authoritative. Guard the known "account resolution crossed to demo"
  // leak (a live netLiq wildly above the live capital) the same way the positions route does.
  let currentBalance = startingCapital;
  let ok = false;
  try {
    const s = await getTradovateAccountSummary("live");
    const nl = s.netLiq || s.balance || 0;
    if (nl > 0 && nl < startingCapital * 20) { currentBalance = nl; ok = true; }
  } catch { /* broker unreachable — ok stays false */ }

  // Net deposits/withdrawals since inception, so a funding transfer never reads as profit.
  let netDeposits = 0;
  try {
    const incRow = await prisma.agentConfig.findUnique({ where: { key: "strategy_inception" } });
    const inception = incRow?.value || "2026-07-10";
    const r = await reconcileCapitalFlows("live", {});
    netDeposits = netFlowsAfterInception(r.flows, inception);
  } catch { /* leave 0 — not flow-adjusted this call */ }

  // Round-trips + win rate from paired closes (incident already excluded in the edge perf).
  let roundTrips = 0, wins = 0;
  try {
    const perf = await getRealtimeEdgePerformance("live");
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
