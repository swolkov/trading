import { prisma } from "@/lib/db";

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
  futures_risk_per_trade_pct: "5", // % of equity per trade (aggressive small-account)
  futures_daily_loss_limit_pct: "15", // % daily max loss
  futures_max_drawdown_pct: "25", // % drawdown kill switch
  futures_max_contracts: "3", // Max contracts per initial entry (pyramid adds more)
  futures_max_total_contracts: "6", // Max total contracts across all
  futures_max_trades_per_day: "3", // Base limit per day
  futures_atr_stop_multiplier: "1.5",
  futures_atr_target_multiplier: "4.0", // 4:1 R:R — need big winners at low WR
  futures_simulated_equity: "1000", // Live capital ($) — grows with account
};

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
      else result.futures_mode = "demo";
    }
    return Response.json(result);
  } catch (error) {
    console.error("[/api/agent/config GET]", error);
    return Response.json(DEFAULTS);
  }
}

export async function POST(request: Request) {
  // Auth check: require CRON_SECRET for config changes
  const authHeader = request.headers.get("authorization");
  if (
    !process.env.CRON_SECRET ||
    authHeader !== `Bearer ${process.env.CRON_SECRET}`
  ) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const updates: Record<string, string> = await request.json();

    // Validate numeric values to prevent dangerous configs
    const numericKeys = ["max_positions", "max_per_sector", "futures_max_contracts", "futures_max_total_contracts", "futures_max_trades_per_day", "daily_loss_limit", "daily_spend_cap", "max_options_exposure", "per_trade_max"];
    for (const key of numericKeys) {
      if (key in updates) {
        const num = parseFloat(updates[key]);
        if (isNaN(num) || num < 0) {
          return Response.json({ error: `Invalid value for ${key}: must be a positive number` }, { status: 400 });
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
      const modeVal = updates.futures_mode === "live" ? "live" : "paper";
      await prisma.agentConfig.upsert({ where: { key: "trading_mode_futures" }, update: { value: modeVal }, create: { key: "trading_mode_futures", value: modeVal } });
    }
    if (updates.stocks_enabled) {
      const modeVal = updates.stocks_enabled === "live" ? "live" : "paper";
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
