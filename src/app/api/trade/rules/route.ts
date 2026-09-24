import { prisma } from "@/lib/db";
import { COPILOT_ENABLED_KEY, COPILOT_STATE_KEY } from "@/lib/copilot";
import { dayRulesView, type SavedCopilotState } from "@/lib/day-rules";

// HIS DAY RULES, READ-ONLY — where the day stands (window, trades, losses, cooldown, hands off), from the state the
// co-pilot cron saves every 15 seconds. This route only reads that row; it never writes it and never calls the broker.
export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const rows = await prisma.agentConfig.findMany({ where: { key: { in: [COPILOT_STATE_KEY, COPILOT_ENABLED_KEY] } } });
    const raw = rows.find((r) => r.key === COPILOT_STATE_KEY)?.value ?? null;
    let saved: SavedCopilotState | null = null;
    if (raw) { try { saved = JSON.parse(raw) as SavedCopilotState; } catch { saved = null; } }
    const enabled = rows.find((r) => r.key === COPILOT_ENABLED_KEY)?.value !== "false";
    return Response.json(dayRulesView(saved, Date.now(), enabled));
  } catch (e) { return Response.json({ error: String(e).slice(0, 200) }, { status: 500 }); }
}
