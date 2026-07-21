import { prisma } from "@/lib/db";
import { getTradovateAccountSummary, checkTradovateAuth } from "@/lib/tradovate";

/**
 * Comprehensive account state for the admin dashboard. Returns:
 *  - Realtime broker balance (Tradovate live query, falls back to daily_balance_* DB cache)
 *  - Today's realized + unrealized P&L per account
 *  - Risk utilization (% of daily loss limit consumed)
 *  - 30-day daily P&L history (for sparklines)
 *  - 3-layer mode state (view / trading / per-strategy assignment)
 *
 * Futures (Tradovate) only — the Alpaca equities/options brokerage was removed.
 */

interface AccountInfo {
  key: string;
  label: string;
  broker: "Tradovate";
  // Capital state
  balance: number | null;
  balanceSource: "broker_live" | "daily_cache" | "unavailable";
  unrealizedPnl: number;
  // P&L
  todayPnl: number;
  todayTrades: number;
  // Risk
  dailyLossLimitPct: number; // configured % of equity
  riskUsedPct: number;       // 0..100, today's loss as % of daily limit
  drawdownPct: number;       // % from session-start balance
  // Mode
  viewMode: "paper" | "live";
  tradingMode: "paper" | "live" | "disabled";
  liveTradingActivated: boolean;
  // Time series
  pnlSparkline: number[]; // last 30 days of daily P&L (oldest → newest)
}

async function getConfig(key: string, defaultVal = ""): Promise<string> {
  const row = await prisma.agentConfig.findUnique({ where: { key } });
  return row?.value ?? defaultVal;
}

async function getMode(key: string, defaultVal: "paper" | "live" | "disabled" = "paper") {
  const v = await getConfig(key);
  if (v === "live" || v === "paper" || v === "disabled") return v;
  return defaultVal;
}

async function getBalanceHistory(prefix: string, days: number): Promise<{ date: string; balance: number }[]> {
  const out: { date: string; balance: number }[] = [];
  // Query all balance keys (efficient: indexed prefix scan)
  const all = await prisma.agentConfig.findMany({
    where: { key: { startsWith: prefix } },
    orderBy: { key: "asc" },
  });
  for (const row of all) {
    const date = row.key.slice(prefix.length); // "YYYY-MM-DD"
    const balance = parseFloat(row.value);
    if (!isNaN(balance)) out.push({ date, balance });
  }
  // Keep last N days
  out.sort((a, b) => a.date.localeCompare(b.date));
  return out.slice(-days);
}

function computeDailyPnl(history: { date: string; balance: number }[]): number[] {
  const pnl: number[] = [];
  for (let i = 1; i < history.length; i++) {
    pnl.push(history[i].balance - history[i - 1].balance);
  }
  return pnl;
}

async function getTodayPnl(mode: "paper" | "live"): Promise<{ pnl: number; trades: number }> {
  const start = new Date();
  start.setHours(0, 0, 0, 0);
  const symbols = mode === "live" ? ["FUT:MES", "FUT:MNQ", "FUT:BFF"] : ["FUT:ES", "FUT:NQ", "FUT:GC", "FUT:MBT", "FUT:MET", "FUT:BFF", "FUT:MXR", "FUT:MSL"];
  const logs = await prisma.autoTradeLog.findMany({
    where: { symbol: { in: symbols }, createdAt: { gte: start }, pnl: { not: null } },
  });
  const pnl = logs.reduce((s, l) => s + (l.pnl ?? 0), 0);
  return { pnl, trades: logs.length };
}

async function getBrokerBalance(mode: "paper" | "live"): Promise<{ balance: number; unrealized: number; source: "broker_live" } | null> {
  try {
    const auth = await checkTradovateAuth(mode);
    if (!auth.authenticated) return null;
    const summary = await getTradovateAccountSummary(mode);
    return { balance: summary.balance, unrealized: summary.unrealizedPnl ?? 0, source: "broker_live" };
  } catch {
    return null;
  }
}

export async function GET() {
  try {
    const [
      futuresView, futuresTrading,
      demoLossLimit, liveLossLimit,
      demoHistory, liveHistory,
      demoToday, liveToday,
      demoBrokerLive, liveBrokerLive,
    ] = await Promise.all([
      getMode("view_mode_futures"),
      getMode("trading_mode_futures"),
      getConfig("futures_daily_loss_limit_pct", "8"),
      getConfig("live_futures_daily_loss_limit_pct", "8"),
      getBalanceHistory("daily_balance_", 30),
      getBalanceHistory("live_daily_balance_", 30),
      getTodayPnl("paper"),
      getTodayPnl("live"),
      getBrokerBalance("paper"),
      getBrokerBalance("live"),
    ]);

    const demoPnlSpark = computeDailyPnl(demoHistory);
    const livePnlSpark = computeDailyPnl(liveHistory);
    const demoDailyLimitPct = parseFloat(demoLossLimit) || 8;
    const liveDailyLimitPct = parseFloat(liveLossLimit) || 8;

    // Demo balance: prefer broker live, fall back to last cached
    const demoBalance = demoBrokerLive?.balance ?? demoHistory[demoHistory.length - 1]?.balance ?? null;
    const demoBalanceSource = demoBrokerLive ? "broker_live" : demoHistory.length > 0 ? "daily_cache" : "unavailable";
    const liveBalance = liveBrokerLive?.balance ?? liveHistory[liveHistory.length - 1]?.balance ?? null;
    const liveBalanceSource = liveBrokerLive ? "broker_live" : liveHistory.length > 0 ? "daily_cache" : "unavailable";

    // Today P&L: balance delta (source of truth) — DB trade sums double-log and are inflated
    // SOD = most recent daily_balance_* entry (written by engine before trading each day)
    const today = new Date().toISOString().slice(0, 10);
    const demoSodEntry = demoHistory.find((h) => h.date === today) ?? demoHistory[demoHistory.length - 1];
    const liveSodEntry = liveHistory.find((h) => h.date === today) ?? liveHistory[liveHistory.length - 1];
    // Balance delta, ALWAYS. Use the live broker balance when available, else the cached EOD balance —
    // but NEVER fall back to the DB trade sum (it double-logs and inflates ~3x). DB sum is a last resort
    // only when there is no balance history at all (a brand-new account).
    const demoTodayPnl = demoSodEntry && demoBalance != null ? demoBalance - demoSodEntry.balance : demoToday.pnl;
    const liveTodayPnl = liveSodEntry && liveBalance != null ? liveBalance - liveSodEntry.balance : liveToday.pnl;

    const demoEquity = demoBalance ?? 50_000;
    const liveEquity = liveBalance ?? 1_000;
    const demoMaxLoss = demoEquity * (demoDailyLimitPct / 100);
    const liveMaxLoss = liveEquity * (liveDailyLimitPct / 100);
    const demoRiskUsed = demoTodayPnl < 0 ? Math.min(100, Math.abs(demoTodayPnl) / demoMaxLoss * 100) : 0;
    const liveRiskUsed = liveTodayPnl < 0 ? Math.min(100, Math.abs(liveTodayPnl) / liveMaxLoss * 100) : 0;

    // Drawdown vs session-start (yesterday's EOD balance)
    const demoStartBal = demoHistory[demoHistory.length - 2]?.balance ?? demoEquity;
    const liveStartBal = liveHistory[liveHistory.length - 2]?.balance ?? liveEquity;
    const demoDrawdown = demoStartBal > 0 ? ((demoEquity - demoStartBal) / demoStartBal) * 100 : 0;
    const liveDrawdown = liveStartBal > 0 ? ((liveEquity - liveStartBal) / liveStartBal) * 100 : 0;

    const accounts: AccountInfo[] = [
      {
        key: "demo-futures",
        label: "Demo Futures",
        broker: "Tradovate",
        balance: demoBalance,
        balanceSource: demoBalanceSource as AccountInfo["balanceSource"],
        unrealizedPnl: demoBrokerLive?.unrealized ?? 0,
        todayPnl: demoTodayPnl,
        todayTrades: demoToday.trades,
        dailyLossLimitPct: demoDailyLimitPct,
        riskUsedPct: demoRiskUsed,
        drawdownPct: demoDrawdown,
        viewMode: futuresView === "live" ? "live" : "paper",
        tradingMode: futuresTrading,
        liveTradingActivated: false,
        pnlSparkline: demoPnlSpark,
      },
      {
        key: "live-futures",
        label: "Live Futures",
        broker: "Tradovate",
        balance: liveBalance,
        balanceSource: liveBalanceSource as AccountInfo["balanceSource"],
        unrealizedPnl: liveBrokerLive?.unrealized ?? 0,
        todayPnl: liveTodayPnl,
        todayTrades: liveToday.trades,
        dailyLossLimitPct: liveDailyLimitPct,
        riskUsedPct: liveRiskUsed,
        drawdownPct: liveDrawdown,
        viewMode: futuresView === "live" ? "live" : "paper",
        tradingMode: futuresTrading,
        liveTradingActivated: futuresTrading === "live",
        pnlSparkline: livePnlSpark,
      },
    ];

    return Response.json({
      accounts,
      summary: {
        anyLiveTrading: accounts.some((a) => a.liveTradingActivated),
        futuresLiveActivated: futuresTrading === "live",
        viewingLive: futuresView === "live",
      },
    });
  } catch (e) {
    return Response.json({ error: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
}
