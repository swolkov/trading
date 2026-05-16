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
  trade_options: "true", // true = options-only mode, false = stocks only
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
  futures_risk_per_trade_pct: "5", // % of equity per trade
  futures_daily_loss_limit_pct: "10", // % daily max loss
  futures_max_drawdown_pct: "15", // % drawdown kill switch
  futures_max_contracts: "6", // Max contracts per trade
  futures_max_total_contracts: "10", // Max total contracts across all
  futures_max_trades_per_day: "3", // Base limit per day
  futures_atr_stop_multiplier: "1.5",
  futures_atr_target_multiplier: "3.5",
  futures_simulated_equity: "7000", // Simulated live capital ($)
};

export async function GET() {
  try {
    const configs = await prisma.agentConfig.findMany();
    const result: Record<string, string> = { ...DEFAULTS };
    for (const c of configs) {
      result[c.key] = c.value;
    }
    return Response.json(result);
  } catch (error) {
    console.error("[/api/agent/config GET]", error);
    return Response.json(DEFAULTS);
  }
}

export async function POST(request: Request) {
  try {
    const updates: Record<string, string> = await request.json();
    for (const [key, value] of Object.entries(updates)) {
      if (key in DEFAULTS) {
        await prisma.agentConfig.upsert({
          where: { key },
          update: { value: String(value) },
          create: { key, value: String(value) },
        });
      }
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
