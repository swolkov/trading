import { prisma } from "@/lib/db";

/**
 * Returns all account states + the actual trading mode (not just view mode) for the admin page.
 * Helps surface the 3-layer truth Spencer needs to see at a glance:
 *   1. trading_mode_futures (DB)   — does the engine actually trade live? gated by password
 *   2. view_mode_futures   (DB)   — which account does the dashboard display? free to toggle
 *   3. StrategyAssignment        — which strategies run on which account
 */

interface AccountInfo {
  key: string;
  label: string;
  broker: "Tradovate" | "Alpaca";
  balance: number | null;
  realizedPnl: number | null;
  unrealizedPnl: number | null;
  positions: number | null;
  // Mode state
  viewMode: "paper" | "live";
  tradingMode: "paper" | "live" | "disabled";
  liveTradingActivated: boolean; // tradingMode === "live"
}

async function getMode(key: string, defaultVal: "paper" | "live" | "disabled" = "paper") {
  const row = await prisma.agentConfig.findUnique({ where: { key } });
  const v = row?.value;
  if (v === "live" || v === "paper" || v === "disabled") return v;
  return defaultVal;
}

async function getLatestBalance(prefix: string): Promise<number | null> {
  // Find most recent daily-balance row
  const today = new Date().toISOString().slice(0, 10);
  const row = await prisma.agentConfig.findUnique({ where: { key: `${prefix}${today}` } });
  if (row?.value) {
    const n = parseFloat(row.value);
    if (!isNaN(n)) return n;
  }
  // Fallback: any balance row for the prefix, most recent
  const all = await prisma.agentConfig.findMany({
    where: { key: { startsWith: prefix } },
    orderBy: { key: "desc" },
    take: 1,
  });
  if (all[0]?.value) {
    const n = parseFloat(all[0].value);
    if (!isNaN(n)) return n;
  }
  return null;
}

export async function GET() {
  try {
    const [
      futuresView, futuresTradingRaw,
      stocksView, stocksTradingRaw,
      cryptoView, cryptoTradingRaw,
      optionsView,
      demoFutBalance, liveFutBalance,
    ] = await Promise.all([
      getMode("view_mode_futures"),
      getMode("trading_mode_futures"),
      getMode("view_mode_stocks"),
      getMode("trading_mode_stocks"),
      getMode("view_mode_crypto"),
      getMode("trading_mode_crypto"),
      getMode("view_mode_options"),
      getLatestBalance("daily_balance_"),
      getLatestBalance("live_daily_balance_"),
    ]);

    const accounts: AccountInfo[] = [
      {
        key: "demo-futures",
        label: "Demo Futures",
        broker: "Tradovate",
        balance: demoFutBalance,
        realizedPnl: null,
        unrealizedPnl: null,
        positions: null,
        viewMode: futuresView === "live" ? "live" : "paper",
        tradingMode: futuresTradingRaw,
        liveTradingActivated: false, // demo is always paper
      },
      {
        key: "live-futures",
        label: "Live Futures",
        broker: "Tradovate",
        balance: liveFutBalance,
        realizedPnl: null,
        unrealizedPnl: null,
        positions: null,
        viewMode: futuresView === "live" ? "live" : "paper",
        tradingMode: futuresTradingRaw,
        liveTradingActivated: futuresTradingRaw === "live",
      },
      {
        key: "paper-stocks",
        label: "Stocks (Paper)",
        broker: "Alpaca",
        balance: null,
        realizedPnl: null,
        unrealizedPnl: null,
        positions: null,
        viewMode: stocksView === "live" ? "live" : "paper",
        tradingMode: stocksTradingRaw,
        liveTradingActivated: stocksTradingRaw === "live",
      },
      {
        key: "paper-crypto",
        label: "Crypto Spot (Paper)",
        broker: "Alpaca",
        balance: null,
        realizedPnl: null,
        unrealizedPnl: null,
        positions: null,
        viewMode: cryptoView === "live" ? "live" : "paper",
        tradingMode: cryptoTradingRaw,
        liveTradingActivated: cryptoTradingRaw === "live",
      },
    ];

    return Response.json({
      accounts,
      summary: {
        anyLiveTrading: accounts.some((a) => a.liveTradingActivated),
        futuresLiveActivated: futuresTradingRaw === "live",
        viewingLive: futuresView === "live",
      },
      raw: {
        futuresView, futuresTradingRaw,
        stocksView, stocksTradingRaw,
        cryptoView, cryptoTradingRaw,
        optionsView,
      },
    });
  } catch (e) {
    return Response.json({ error: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
}
