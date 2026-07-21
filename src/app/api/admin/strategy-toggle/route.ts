import { prisma } from "@/lib/db";
import { REALTIME_EDGES, edgeFlagKey } from "@/lib/realtime-edges";

/**
 * Per-edge, per-engine on/off switch for the realtime futures engine.
 *
 * Writes agentConfig `edge_<key>_<mode>` = "true" | "false". The engine reads this on its next
 * config-refresh cycle (~30s) and gates trades accordingly (see src/lib/realtime-edges.ts).
 *
 * SAFETY: turning an edge ON for LIVE (real money) requires the live password — same guard as the
 * kill switch. Turning anything OFF, or any DEMO change, is unguarded (you can always stop / test).
 */

const LIVE_PASSWORD = process.env.LIVE_TRADING_PASSWORD || "golive";

export async function POST(request: Request) {
  try {
    const body = await request.json().catch(() => ({}));
    const { key, mode, enabled, password } = body as {
      key?: string;
      mode?: "demo" | "live";
      enabled?: boolean;
      password?: string;
    };

    if (!key || !REALTIME_EDGES.some((e) => e.key === key)) {
      return Response.json({ error: `unknown edge key: ${key}` }, { status: 400 });
    }
    if (mode !== "demo" && mode !== "live") {
      return Response.json({ error: "mode must be 'demo' or 'live'" }, { status: 400 });
    }
    if (typeof enabled !== "boolean") {
      return Response.json({ error: "enabled must be a boolean" }, { status: 400 });
    }

    // Promoting an edge to LIVE (real money) is password-gated. Disabling live, or any demo change, is free.
    if (mode === "live" && enabled === true) {
      if (!password || password !== LIVE_PASSWORD) {
        return Response.json({ error: "Live password required to enable an edge on real money" }, { status: 403 });
      }
    }

    const flag = edgeFlagKey(key, mode);
    const value = enabled ? "true" : "false";
    await prisma.agentConfig.upsert({
      where: { key: flag },
      update: { value },
      create: { key: flag, value },
    });

    return Response.json({ ok: true, key, mode, enabled, flag });
  } catch (e) {
    return Response.json({ error: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
}
