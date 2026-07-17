import { prisma } from "./db";

// LIVE per-edge performance for the futures admin — "what's actually working" in real money.
// Splits realized live futures closes into the 3 gated edges the engine trades, with a DIRECTION
// attached (the edge-scoreboard only split by symbol, so it couldn't tell the new index long from the
// overbought short). We use ONLY live_* rows and pair each entry (live_long/live_short) to its exit,
// which both attaches direction AND sidesteps the live_/futures_ double-log dedup problem entirely.

export interface EdgeStat {
  key: string;
  name: string;
  blurb: string;
  trades: number;
  wins: number;
  losses: number;
  winRate: number;
  net: number;
  lastTs: string | null;
  recent: { ts: string; sym: string; dir: "long" | "short"; exit: string; pnl: number }[];
}

const dirOf = (action: string): "long" | "short" | null =>
  action === "live_long" ? "long" : action === "live_short" ? "short" : null;

export async function getEdgePerformance(): Promise<{ since: string; edges: EdgeStat[]; totalNet: number; totalTrades: number }> {
  const sinceRow = await prisma.agentConfig.findUnique({ where: { key: "edge_scoreboard_since" } });
  const since = sinceRow?.value ? new Date(sinceRow.value) : new Date(0);

  const rows = await prisma.autoTradeLog.findMany({
    where: { symbol: { in: ["FUT:MGC", "FUT:MNQ", "FUT:MES"] }, action: { startsWith: "live_" }, createdAt: { gte: since } },
    orderBy: { createdAt: "asc" },
    take: 1000,
  });

  // Pair entries → exits per symbol so each realized P&L carries the direction it was taken in.
  const openDir: Record<string, "long" | "short" | null> = {};
  type Close = { ts: Date; sym: string; dir: "long" | "short"; exit: string; pnl: number };
  const closes: Close[] = [];
  for (const r of rows) {
    const d = dirOf(r.action);
    if (d) { openDir[r.symbol] = d; continue; }   // entry — remember the direction we opened in
    if (r.pnl == null) continue;                  // not a realized close
    const dir = openDir[r.symbol];
    if (!dir) continue;                           // exit with no matching in-window entry — skip
    closes.push({ ts: r.createdAt, sym: r.symbol, dir, exit: r.action.replace(/^live_/, ""), pnl: r.pnl });
    openDir[r.symbol] = null;
  }

  const DEFS = [
    { key: "gold_long", name: "Gold RSI — oversold LONG", blurb: "MGC — buy RSI<25 oversold bounce (long side of the flagship edge).", match: (c: Close) => c.sym === "FUT:MGC" && c.dir === "long" },
    { key: "gold_short", name: "Gold RSI — overbought SHORT", blurb: "MGC — short RSI>75 overbought fade (short side of the flagship edge).", match: (c: Close) => c.sym === "FUT:MGC" && c.dir === "short" },
    { key: "index_short", name: "Index overbought-short", blurb: "MNQ/MES — short at RSI≥80. The overbought fade.", match: (c: Close) => (c.sym === "FUT:MNQ" || c.sym === "FUT:MES") && c.dir === "short" },
    { key: "index_long", name: "Index trend-long (NEW)", blurb: "MNQ/MES — buy EMA9 pullbacks ONLY in a confirmed uptrend (price>200-EMA). Validated across the 2022 bear (PF 1.22, +both halves). Awaiting first live fills.", match: (c: Close) => (c.sym === "FUT:MNQ" || c.sym === "FUT:MES") && c.dir === "long" },
  ];

  const edges: EdgeStat[] = DEFS.map((e) => {
    const t = closes.filter(e.match);
    const net = t.reduce((s, c) => s + c.pnl, 0);
    const wins = t.filter((c) => c.pnl > 0).length;
    const losses = t.filter((c) => c.pnl < 0).length;
    return {
      key: e.key, name: e.name, blurb: e.blurb,
      trades: t.length, wins, losses,
      winRate: t.length ? wins / t.length : 0,
      net,
      lastTs: t.length ? t[t.length - 1].ts.toISOString() : null,
      recent: [...t].reverse().slice(0, 8).map((c) => ({ ts: c.ts.toISOString(), sym: c.sym.replace("FUT:", ""), dir: c.dir, exit: c.exit, pnl: c.pnl })),
    };
  });

  return { since: since.toISOString(), totalNet: edges.reduce((s, e) => s + e.net, 0), totalTrades: edges.reduce((s, e) => s + e.trades, 0), edges };
}
