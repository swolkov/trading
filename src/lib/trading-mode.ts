import { prisma } from "./db";

export type TradingMode = "paper" | "live";
export type TradeType = "options" | "futures" | "stocks" | "crypto";

// Cache mode for 60 seconds to avoid hitting DB on every API call
let modeCache: Record<string, { mode: TradingMode; expires: number }> = {};

// Trading mode — controls agent EXECUTION (which server agents trade on).
// Gated by /agents page config. Do NOT use for display purposes.
export async function getTradingMode(type: TradeType): Promise<TradingMode> {
  const cached = modeCache[type];
  if (cached && Date.now() < cached.expires) return cached.mode;

  try {
    const config = await prisma.agentConfig.findUnique({ where: { key: `trading_mode_${type}` } });
    const mode = (config?.value === "live" ? "live" : "paper") as TradingMode;
    modeCache[type] = { mode, expires: Date.now() + 60000 };
    return mode;
  } catch {
    return "paper"; // always default to paper
  }
}

// View mode — controls which account data the DASHBOARD displays.
// Freely switchable, no password. Does NOT affect agent execution.
let viewCache: Record<string, { mode: TradingMode; expires: number }> = {};

export function invalidateViewCache(type?: TradeType) {
  if (type) { delete viewCache[type]; } else { viewCache = {}; }
}

export async function getViewMode(type: TradeType): Promise<TradingMode> {
  const cached = viewCache[type];
  if (cached && Date.now() < cached.expires) return cached.mode;

  try {
    const config = await prisma.agentConfig.findUnique({ where: { key: `view_mode_${type}` } });
    const mode = (config?.value === "live" ? "live" : "paper") as TradingMode;
    viewCache[type] = { mode, expires: Date.now() + 60000 };
    return mode;
  } catch {
    return "paper";
  }
}

// Get IBKR config based on current mode
export async function getIBKRConfig(): Promise<{
  baseUrl: string;
  accountId: string;
  isLive: boolean;
}> {
  const mode = await getTradingMode("futures");

  if (mode === "live" && process.env.IBKR_LIVE_BASE_URL) {
    return {
      baseUrl: process.env.IBKR_LIVE_BASE_URL,
      accountId: process.env.IBKR_LIVE_ACCOUNT_ID || process.env.IBKR_ACCOUNT_ID || "",
      isLive: true,
    };
  }

  return {
    baseUrl: process.env.IBKR_BASE_URL || "https://localhost:5000/v1/api",
    accountId: process.env.IBKR_ACCOUNT_ID || "",
    isLive: false,
  };
}
