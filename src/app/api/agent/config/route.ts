import { prisma } from "@/lib/db";
import { requireOwnerUser } from "@/auth/owner";

const DEFAULTS: Record<string, string> = {
  strategy: "balanced", // aggressive, balanced, conservative
  enabled: "true",
  max_positions: "10",
  max_per_sector: "3",
  max_position_pct: "7",
  min_score: "55",
  min_confidence: "60",
  stop_loss_atr: "2.0",
  take_profit_pct: "25",
  cash_reserve_pct: "20",
  max_daily_trades: "6",
  trade_options: "true", // legacy — kept for backward compat
  options_mode: "paper", // disabled, paper, live — options entry gate mode
  options_stop_loss_pct: "40",
  options_profit_pct: "50",
  focus_symbols: "", // comma-separated watchlist for agent to prioritize
  blacklist: "", // comma-separated symbols to never trade
  cooldown_hours: "12",
  notification_webhook: "", // Legacy: Slack/Discord webhook URL (fallback)
  webhook_futures: "", // Slack webhook for #futures channel
  webhook_options: "", // Slack webhook for #options channel
  webhook_general: "", // Slack webhook for #general channel (errors + stocks)
  daily_loss_limit: "500", // Stop trading if daily loss exceeds this $
  daily_spend_cap: "2000", // Max $ spent on new trades per day
  max_options_exposure: "5000", // Max total $ in options at any time
  per_trade_max: "500", // Never spend more than this on one trade
  drawdown_kill_pct: "10", // Pause agent if account drops this % from peak
  stocks_enabled: "paper", // disabled, paper, live — stock entry gate mode
  stock_min_score: "65", // Min analysis score for stock entries
  stock_min_confidence: "70", // Min confidence % for stock entries
  // Futures agent rules (read by futures-agent.ts at runtime)
  futures_mode: "demo", // disabled, demo, live — futures entry gate mode
  futures_risk_per_trade_pct: "8", // 8% of $1K = $80 per trade
  futures_daily_loss_limit_pct: "15", // 15% daily max loss ($150 on $1K) — ONLY hard stop
  futures_max_drawdown_pct: "25", // 25% drawdown kill switch ($250 on $1K)
  futures_max_contracts: "3", // Up to 3 MES on A+ setups
  futures_max_total_contracts: "4", // Max total contracts across all positions
  futures_max_trades_per_day: "6", // Conviction is primary gate, not trade count
  futures_atr_stop_multiplier: "1.5",
  futures_atr_target_multiplier: "4.0", // 4:1 R:R — let winners run
  futures_simulated_equity: "1000", // $1K live capital — grows with account
  // Live futures engine ($1K REAL money) — SEPARATE, conservative config the LIVE engine reads.
  // (Matches LIVE_DEFAULTS in futures-realtime.ts. The demo engine reads the futures_* keys above.)
  live_futures_risk_per_trade_pct: "5",
  live_futures_daily_loss_limit_pct: "8",
  live_futures_max_drawdown_pct: "15",
  live_futures_max_contracts: "3",
  live_futures_max_total_contracts: "4",
  live_futures_max_trades_per_day: "6",
  live_futures_max_positions: "2",
  live_futures_atr_stop_multiplier: "1.5",
  live_futures_atr_target_multiplier: "4.0",
  live_futures_simulated_equity: "0",
  live_futures_symbols: "MGC,MNQ,MES",
};

const NUMERIC_KEYS = new Set([
  "max_positions", "max_per_sector", "max_position_pct", "min_score", "min_confidence",
  "stop_loss_atr", "take_profit_pct", "cash_reserve_pct", "max_daily_trades",
  "options_stop_loss_pct", "options_profit_pct", "cooldown_hours", "daily_loss_limit",
  "daily_spend_cap", "max_options_exposure", "per_trade_max", "drawdown_kill_pct",
  "stock_min_score", "stock_min_confidence",
  "futures_risk_per_trade_pct", "futures_daily_loss_limit_pct", "futures_max_drawdown_pct",
  "futures_max_contracts", "futures_max_total_contracts", "futures_max_trades_per_day",
  "futures_atr_stop_multiplier", "futures_atr_target_multiplier", "futures_simulated_equity",
  "live_futures_risk_per_trade_pct", "live_futures_daily_loss_limit_pct", "live_futures_max_drawdown_pct",
  "live_futures_max_contracts", "live_futures_max_total_contracts", "live_futures_max_trades_per_day",
  "live_futures_max_positions", "live_futures_atr_stop_multiplier", "live_futures_atr_target_multiplier",
  "live_futures_simulated_equity",
]);
const INTEGER_KEYS = new Set([
  "max_positions", "max_per_sector", "max_daily_trades", "futures_max_contracts",
  "futures_max_total_contracts", "futures_max_trades_per_day", "live_futures_max_contracts",
  "live_futures_max_total_contracts", "live_futures_max_trades_per_day", "live_futures_max_positions",
]);
const PERCENTAGE_KEYS = new Set([
  "max_position_pct", "min_score", "min_confidence", "take_profit_pct", "cash_reserve_pct",
  "options_stop_loss_pct", "options_profit_pct", "drawdown_kill_pct", "stock_min_score", "stock_min_confidence",
  "futures_risk_per_trade_pct", "futures_daily_loss_limit_pct", "futures_max_drawdown_pct",
  "live_futures_risk_per_trade_pct", "live_futures_daily_loss_limit_pct", "live_futures_max_drawdown_pct",
]);
const POSITIVE_KEYS = new Set([
  "stop_loss_atr", "futures_atr_stop_multiplier", "futures_atr_target_multiplier",
  "live_futures_atr_stop_multiplier", "live_futures_atr_target_multiplier",
]);
const ENUM_VALUES: Record<string, readonly string[]> = {
  strategy: ["aggressive", "balanced", "conservative"],
  options_mode: ["disabled", "paper", "live"],
  futures_mode: ["disabled", "demo", "live"],
  stocks_enabled: ["disabled", "paper", "live"],
};
const BOOLEAN_KEYS = new Set(["enabled", "trade_options"]);

export async function GET() {
  try {
    const configs = await prisma.agentConfig.findMany();
    const result: Record<string, string> = { ...DEFAULTS };
    for (const c of configs) {
      result[c.key] = c.value;
    }
    // Derive mode selectors from trading_mode keys if not explicitly set
    if (!result.options_mode || result.options_mode === DEFAULTS.options_mode) {
      const tradeOpt = result.trade_options;
      const tradingMode = result.trading_mode_options;
      if (tradeOpt === "false") result.options_mode = "disabled";
      else if (tradingMode === "live") result.options_mode = "live";
      else result.options_mode = "paper";
    }
    if (!result.futures_mode || result.futures_mode === DEFAULTS.futures_mode) {
      const tradingMode = result.trading_mode_futures;
      if (tradingMode === "live") result.futures_mode = "live";
      else if (tradingMode === "disabled") result.futures_mode = "disabled";
      else result.futures_mode = "demo";
    }
    return Response.json(result);
  } catch (error) {
    console.error("[/api/agent/config GET]", error);
    return Response.json(DEFAULTS);
  }
}

export async function POST(request: Request) {
  const unauthorized = await requireOwnerUser();
  if (unauthorized) return unauthorized;

  try {
    const body = await request.json() as Record<string, string> & { livePassword?: string };
    const { livePassword, ...updates } = body;
    if (!process.env.LIVE_TRADING_PASSWORD) {
      return Response.json({ error: "Admin trading password is not configured" }, { status: 503 });
    }
    if (livePassword !== process.env.LIVE_TRADING_PASSWORD) {
      return Response.json({ error: "Admin trading password required to change engine settings" }, { status: 403 });
    }

    const unknownKeys = Object.keys(updates).filter((key) => !(key in DEFAULTS));
    if (unknownKeys.length > 0) {
      return Response.json({ error: `Unknown config key(s): ${unknownKeys.join(", ")}` }, { status: 400 });
    }

    for (const [key, allowed] of Object.entries(ENUM_VALUES)) {
      if (key in updates && !allowed.includes(String(updates[key]))) {
        return Response.json({ error: `${key} must be one of: ${allowed.join(", ")}` }, { status: 400 });
      }
    }
    for (const key of BOOLEAN_KEYS) {
      if (key in updates && !["true", "false"].includes(String(updates[key]))) {
        return Response.json({ error: `${key} must be true or false` }, { status: 400 });
      }
    }

    if (updates.live_futures_symbols) {
      const symbols = updates.live_futures_symbols.split(",").map((symbol) => symbol.trim().toUpperCase()).filter(Boolean);
      if (symbols.some((symbol) => !["MGC", "MNQ", "MES"].includes(symbol))) {
        return Response.json({ error: "Live symbol whitelist may contain only MGC, MNQ and MES" }, { status: 400 });
      }
      updates.live_futures_symbols = symbols.join(",");
    }

    // Validate every accepted numeric field. Number() rejects partial strings such as "0junk".
    for (const key of NUMERIC_KEYS) {
      if (key in updates) {
        const raw = String(updates[key]).trim();
        const num = Number(raw);
        if (!raw || !Number.isFinite(num) || num < 0 || (POSITIVE_KEYS.has(key) && num <= 0)
          || (INTEGER_KEYS.has(key) && !Number.isInteger(num)) || (PERCENTAGE_KEYS.has(key) && num > 100)) {
          return Response.json({ error: `Invalid numeric value for ${key}` }, { status: 400 });
        }
      }
    }

    for (const [key, value] of Object.entries(updates)) {
      if (key in DEFAULTS) {
        await prisma.agentConfig.upsert({
          where: { key },
          update: { value: String(value) },
          create: { key, value: String(value) },
        });
      }
    }
    // Sync mode selectors to trading_mode keys used by the engines
    if (updates.options_mode) {
      const modeVal = updates.options_mode === "live" ? "live" : "paper";
      const enabled = updates.options_mode !== "disabled";
      await prisma.agentConfig.upsert({ where: { key: "trading_mode_options" }, update: { value: modeVal }, create: { key: "trading_mode_options", value: modeVal } });
      await prisma.agentConfig.upsert({ where: { key: "trade_options" }, update: { value: String(enabled) }, create: { key: "trade_options", value: String(enabled) } });
    }
    if (updates.futures_mode) {
      const modeVal = updates.futures_mode === "live" ? "live" : updates.futures_mode === "disabled" ? "disabled" : "paper";
      await prisma.agentConfig.upsert({ where: { key: "trading_mode_futures" }, update: { value: modeVal }, create: { key: "trading_mode_futures", value: modeVal } });
    }
    if (updates.stocks_enabled) {
      const modeVal = updates.stocks_enabled === "live" ? "live" : updates.stocks_enabled === "disabled" ? "disabled" : "paper";
      await prisma.agentConfig.upsert({ where: { key: "trading_mode_stocks" }, update: { value: modeVal }, create: { key: "trading_mode_stocks", value: modeVal } });
    }

    return Response.json({ success: true });
  } catch (error) {
    console.error("[/api/agent/config POST]", error);
    return Response.json(
      { error: error instanceof Error ? error.message : "Failed" },
      { status: 500 }
    );
  }
}
