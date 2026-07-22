import { prisma } from "@/lib/db";
import { getLiveFuturesPnl } from "@/lib/live-pnl";

// ── DEMO-COPY SIMULATOR ───────────────────────────────────────────────────────
// Answers one question with real data: "If live had just copied demo's trades, would we
// be up like demo?" It replays demo's ACTUAL realized trades against the real live account
// ($4,821 funded) under live's rules (micro contracts + the 25% drawdown kill switch) and
// shows what actually would have happened. Read-only — pure computation over the trade log.
//
// Why demo ≠ live: demo trades FULL-SIZE (ES $50/pt, NQ $20/pt, GC $100/pt) on ~$60k of fake
// money with no real consequence to a −$18k week. Live trades micros (1/10 the $/pt) on real
// money with a hard 25% kill switch. Same signal, wildly different survivability.

const RATIO_TO_MICRO = (sym: string): number => {
  // Full-size → micro dollar-per-point ratio. ES→MES, NQ→MNQ, GC→MGC are all 10×.
  if (["ES", "NQ", "GC"].includes(sym)) return 10;
  if (sym.startsWith("M")) return 1; // already a micro
  return 10; // default: treat unknown as full-size
};

const START_CAPITAL_KEY = "starting_capital_live";
const KILL_DRAWDOWN = 0.25; // 25% trailing-from-peak drawdown = account killed (matches live max_dd)

interface SimTrade { date: string; sym: string; qty: number; demoPnl: number }
interface SimResult {
  finalEquity: number;
  netPnl: number;
  killed: boolean;
  killDate: string | null;
  killTradeNum: number | null;
  maxDrawdownPct: number;
  tradesTaken: number;   // trades before kill (or all)
  curve: { i: number; date: string; equity: number }[];
}

function simulate(trades: SimTrade[], start: number, perTradePnl: (t: SimTrade) => number): SimResult {
  let equity = start;
  let peak = start;
  let maxDD = 0;
  let killed = false;
  let killDate: string | null = null;
  let killTradeNum: number | null = null;
  let taken = 0;
  const curve: { i: number; date: string; equity: number }[] = [{ i: 0, date: trades[0]?.date ?? "", equity: start }];
  for (let i = 0; i < trades.length; i++) {
    if (killed) break;
    equity += perTradePnl(trades[i]);
    taken++;
    if (equity > peak) peak = equity;
    const dd = peak > 0 ? (peak - equity) / peak : 0;
    if (dd > maxDD) maxDD = dd;
    curve.push({ i: i + 1, date: trades[i].date, equity: Math.round(equity) });
    if (dd >= KILL_DRAWDOWN) {
      killed = true;
      killDate = trades[i].date;
      killTradeNum = i + 1;
    }
  }
  return {
    finalEquity: Math.round(equity),
    netPnl: Math.round(equity - start),
    killed,
    killDate,
    killTradeNum,
    maxDrawdownPct: Math.round(maxDD * 1000) / 10,
    tradesTaken: taken,
    curve,
  };
}

export async function GET() {
  try {
    const scRow = await prisma.agentConfig.findUnique({ where: { key: START_CAPITAL_KEY } });
    const startCapital = scRow?.value ? parseFloat(scRow.value) : 4821;

    // Demo realized trades (full-size). Shadow live-symbol rows were retagged to shadow_*, so
    // futures_* pnl rows here are genuine demo. Chronological for the equity replay. Entries carry
    // pnl=null (excluded); every row with pnl is a realized cash event — full closes AND scale-outs —
    // so a scaled trade correctly contributes each partial as its own step in the equity curve.
    const demoRows = await prisma.autoTradeLog.findMany({
      where: { symbol: { startsWith: "FUT:" }, action: { startsWith: "futures_" }, pnl: { not: null } },
      orderBy: { createdAt: "asc" },
      select: { symbol: true, qty: true, pnl: true, createdAt: true },
    });
    const trades: SimTrade[] = demoRows
      .filter((r) => (r.pnl ?? 0) !== 0)
      .map((r) => ({
        date: r.createdAt.toISOString().slice(0, 10),
        sym: r.symbol.replace("FUT:", ""),
        qty: r.qty > 0 ? r.qty : 1,
        demoPnl: r.pnl ?? 0,
      }));

    // Demo's own numbers (full-size, its own fake account) — the number Spencer watches.
    const demoTotal = trades.reduce((s, t) => s + t.demoPnl, 0);
    const sortedByPnl = [...trades].sort((a, b) => b.demoPnl - a.demoPnl);
    const top1 = sortedByPnl[0];
    const top3Sum = sortedByPnl.slice(0, 3).reduce((s, t) => s + t.demoPnl, 0);
    const wins = trades.filter((t) => t.demoPnl > 0).length;
    const losses = trades.filter((t) => t.demoPnl < 0).length;
    const grossWin = trades.filter((t) => t.demoPnl > 0).reduce((s, t) => s + t.demoPnl, 0);
    const grossLoss = Math.abs(trades.filter((t) => t.demoPnl < 0).reduce((s, t) => s + t.demoPnl, 0));

    // Scenario A — "copy demo at 1 micro" (live's actual rule: 1 micro per signal).
    //   live P&L = demo per-contract move ÷ (full→micro ratio). The realistic mirror.
    const copyMicro = simulate(trades, startCapital, (t) => t.demoPnl / t.qty / RATIO_TO_MICRO(t.sym));

    // Scenario B — "copy demo AND its sizing" (same contract COUNT, but micros).
    //   live P&L = demo P&L ÷ ratio. Generous (ignores that 8 NQ micros exceed margin on $4.8k)
    //   and it STILL blows through the kill switch.
    const copyMatched = simulate(trades, startCapital, (t) => t.demoPnl / RATIO_TO_MICRO(t.sym));

    // Live ACTUAL (edge-gated) — the disciplined path. This is REAL MONEY, so the dollar figure
    // must be the authoritative broker-balance delta (not a sum of autoTradeLog rows, which
    // double-log and carry the Jul 16-17 incident phantom). Trade count = clean paired round-trips.
    const inceptionRow = await prisma.agentConfig.findUnique({ where: { key: "strategy_inception" } });
    const inception = inceptionRow?.value ? new Date(inceptionRow.value) : new Date("2026-07-10");
    const live = await getLiveFuturesPnl();
    const liveActualPnl = live.ok ? live.netPnl : null;
    const liveActualTrades = live.roundTrips;

    return Response.json({
      startCapital,
      demo: {
        total: Math.round(demoTotal),
        trades: trades.length,
        wins,
        losses,
        winRate: wins + losses ? Math.round((wins / (wins + losses)) * 100) : 0,
        profitFactor: grossLoss > 0 ? Math.round((grossWin / grossLoss) * 100) / 100 : null,
        biggestWin: top1 ? { pnl: Math.round(top1.demoPnl), sym: top1.sym, qty: top1.qty, date: top1.date } : null,
        biggestWinShare: demoTotal !== 0 && top1 ? Math.round((top1.demoPnl / demoTotal) * 100) : null,
        totalWithoutTop1: Math.round(demoTotal - (top1?.demoPnl ?? 0)),
        totalWithoutTop3: Math.round(demoTotal - top3Sum),
      },
      copyMicro,
      copyMatched,
      liveActual: { netPnl: liveActualPnl != null ? Math.round(liveActualPnl * 100) / 100 : null, trades: liveActualTrades, sinceDate: inception.toISOString().slice(0, 10) },
      generatedAt: new Date().toISOString(),
    });
  } catch (error) {
    console.error("[/api/futures/demo-copy-sim]", error);
    return Response.json({ error: String(error) }, { status: 500 });
  }
}
