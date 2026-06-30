import { runOptionsAgent, getOptionsScoreboard } from "@/lib/options-agent";
import { prisma } from "@/lib/db";

export const maxDuration = 120;

const CONFIG_KEYS = [
  "options_enabled",
  "options_account_size",
  "options_max_risk_usd",
  "options_risk_per_trade_pct",
  "options_max_positions",
  "options_max_trades_per_day",
  "options_min_conviction",
  "options_min_dte",
  "options_max_dte",
  "options_weekly_loss_budget_usd",
  "options_account_floor_usd",
  "options_universe",
  "options_cron_last_run",
];

// Read-only status for the /options page: config + honest scoreboard + last run. Cheap, no auth.
export async function GET() {
  try {
    const rows = await prisma.agentConfig.findMany({ where: { key: { in: CONFIG_KEYS } } });
    const config: Record<string, string> = {};
    for (const r of rows) config[r.key] = r.value;
    const scoreboard = await getOptionsScoreboard();
    return Response.json({
      enabled: config.options_enabled === "paper" || config.options_enabled === "live",
      mode: config.options_enabled === "live" ? "live" : "paper",
      config,
      scoreboard,
      lastRun: config.options_cron_last_run || null,
    });
  } catch (error) {
    return Response.json({ error: String(error) }, { status: 500 });
  }
}

// Manual trigger (auth-gated). POST ?dry=1 runs a scan WITHOUT placing orders (returns would-be
// trades); POST with no query runs one live tick. Used for testing/verification.
export async function POST(request: Request) {
  const authHeader = request.headers.get("authorization");
  if (!process.env.CRON_SECRET || authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }
  try {
    const dry = new URL(request.url).searchParams.get("dry") === "1";
    const result = await runOptionsAgent({ dry });
    return Response.json(result);
  } catch (error) {
    console.error("[/api/options-agent POST]", error);
    return Response.json({ error: String(error) }, { status: 500 });
  }
}
