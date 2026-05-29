/**
 * Forward performance tracking for registered strategies.
 *
 * Each time a registry strategy fires, log an opening row into StrategyTrade. The admin view
 * reads these to display trade-counts and (eventually) profit factor per (account, strategy).
 *
 * NOTE: this is the OPEN-side hook. Close-side updates (exit price, P&L, R-multiple) will be
 * wired in a follow-up via the existing fill cron — for now, rows stay status="open" until
 * manually closed, and admin display shows trade COUNT rather than profit factor.
 *
 * SAFETY: all writes are wrapped in try/catch; failures never block engine flow.
 */

import { prisma } from "./db";
import type { AccountKey } from "./strategy-assignments";
import type { StrategySignal } from "./strategies/types";

export async function logRegistryTradeOpen(args: {
  accountKey: AccountKey;
  strategyId: string;
  symbol: string;
  signal: StrategySignal;
  contracts: number;
}) {
  try {
    const { accountKey, strategyId, symbol, signal, contracts } = args;
    const stopDistance = Math.abs(signal.entryPrice - signal.stopPrice);
    const targetDistance = Math.abs(signal.targetPrice - signal.entryPrice);
    await prisma.strategyTrade.create({
      data: {
        strategyId,
        accountKey,
        symbol,
        direction: signal.direction,
        entryPrice: signal.entryPrice,
        contracts,
        stopDistance,
        targetDistance,
        status: "open",
        reason: signal.reason,
      },
    });
  } catch (e) {
    // Table missing or DB hiccup — never break the engine.
    if (process.env.NODE_ENV !== "production") {
      console.warn(`[strategy-performance] logRegistryTradeOpen failed:`, e instanceof Error ? e.message : e);
    }
  }
}

export interface StrategyPerfSummary {
  strategyId: string;
  accountKey: string;
  trades: number;
  open: number;
  closed: number;
  pf: number | null;
  rTotal: number;
  lastTradeAt: Date | null;
}

/** Aggregate forward-performance rows by (account, strategy). Safe if table doesn't exist. */
export async function getPerformanceSummary(): Promise<StrategyPerfSummary[]> {
  try {
    const trades = await prisma.strategyTrade.findMany({
      orderBy: { openedAt: "desc" },
    });
    const byKey = new Map<string, StrategyTrade[]>();
    for (const t of trades) {
      const key = `${t.accountKey}::${t.strategyId}`;
      if (!byKey.has(key)) byKey.set(key, []);
      byKey.get(key)!.push(t);
    }
    const out: StrategyPerfSummary[] = [];
    for (const [key, group] of byKey) {
      const [accountKey, strategyId] = key.split("::");
      const closed = group.filter((t) => t.status === "closed");
      const wins = closed.filter((t) => (t.pnl ?? 0) > 0).reduce((s, t) => s + (t.pnl ?? 0), 0);
      const losses = Math.abs(closed.filter((t) => (t.pnl ?? 0) < 0).reduce((s, t) => s + (t.pnl ?? 0), 0));
      const pf = losses > 0 ? wins / losses : wins > 0 ? Infinity : null;
      const rTotal = closed.reduce((s, t) => s + (t.rMultiple ?? 0), 0);
      out.push({
        strategyId,
        accountKey,
        trades: group.length,
        open: group.length - closed.length,
        closed: closed.length,
        pf: pf === Infinity ? null : pf,
        rTotal,
        lastTradeAt: group[0]?.openedAt ?? null,
      });
    }
    return out;
  } catch {
    return [];
  }
}

// Minimal type for the aggregation above — kept local to avoid leaking Prisma types broadly.
type StrategyTrade = Awaited<ReturnType<typeof prisma.strategyTrade.findMany>>[number];
