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
  trade_options: "true",
  options_stop_loss_pct: "40",
  options_profit_pct: "50",
  focus_symbols: "", // comma-separated watchlist for agent to prioritize
  blacklist: "", // comma-separated symbols to never trade
  cooldown_hours: "12",
  notification_webhook: "", // Slack/Discord webhook URL
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
