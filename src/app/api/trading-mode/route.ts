import { prisma } from "@/lib/db";

// ============ VIEW MODE API ============
// Controls which account data the dashboard DISPLAYS (demo vs live).
// Freely switchable — no password needed. This does NOT affect agent execution.
// Agent execution mode is controlled separately via /agents config page
// which writes to trading_mode_* keys.

const VALID_TYPES = ["options", "futures", "stocks"] as const;

export async function GET() {
  try {
    const modes: Record<string, string> = {};
    for (const type of VALID_TYPES) {
      const config = await prisma.agentConfig.findUnique({ where: { key: `view_mode_${type}` } });
      modes[type] = config?.value || "paper";
    }

    return Response.json({ modes });
  } catch (error) {
    return Response.json({ error: String(error) }, { status: 500 });
  }
}

export async function POST(request: Request) {
  try {
    const body = await request.json();
    const { type, mode } = body;

    // Validate type
    if (!VALID_TYPES.includes(type)) {
      return Response.json({ error: `Invalid type: ${type}. Must be: ${VALID_TYPES.join(", ")}` }, { status: 400 });
    }

    // Validate mode
    if (mode !== "paper" && mode !== "live") {
      return Response.json({ error: "Mode must be 'paper' or 'live'" }, { status: 400 });
    }

    // Update the view mode only — agent execution reads trading_mode_* separately
    await prisma.agentConfig.upsert({
      where: { key: `view_mode_${type}` },
      update: { value: mode },
      create: { key: `view_mode_${type}`, value: mode },
    });

    return Response.json({ success: true, type, mode, message: `${type} view switched to ${mode.toUpperCase()}` });
  } catch (error) {
    return Response.json({ error: String(error) }, { status: 500 });
  }
}
