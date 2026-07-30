import { prisma } from "@/lib/db";
import { REALTIME_EDGES, isEdgeEnabled, type EngineMode } from "@/lib/realtime-edges";

/**
 * "Today's plan" read model for the Futures admin — answers *what will the engine actually do
 * today, and at what size*.
 *
 * DESIGN RULE: this route does NOT recompute ATR, RSI or position size. Those come from the
 * engine's own heartbeat snapshot (futures_engine_heartbeat_<mode>.symbols), because a second copy
 * of that maths in the web app would drift from the engine and start quietly lying — the exact
 * class of bug this codebase has been burned by. Engine computes, panel renders.
 *
 * What IS derived here is the SCHEDULE: which edges are armed in which session window. That comes
 * from the edge registry + the DB switches, i.e. the same source the engine gates on.
 */
export const dynamic = "force-dynamic";

/** Session windows in ET, matching getSessionName() in futures-realtime.ts. */
const WINDOWS: { session: string; label: string; from: string; to: string }[] = [
  { session: "eth_asia", label: "Asia", from: "22:00", to: "03:00" },
  { session: "eth_europe", label: "London", from: "03:00", to: "09:00" },
  { session: "open", label: "Open", from: "09:30", to: "09:45" },
  { session: "morning", label: "Morning", from: "09:45", to: "12:00" },
  { session: "midday", label: "Midday", from: "12:00", to: "14:00" },
  { session: "afternoon", label: "Afternoon", from: "14:00", to: "15:45" },
  { session: "close", label: "Close", from: "15:45", to: "16:00" },
  { session: "eth_evening", label: "Evening", from: "16:00", to: "22:00" },
];

/** getSizeMultiplier() for LIVE, mirrored: 0 means the session cannot trade that symbol at all. */
function liveSizeMult(session: string, isMetal: boolean, equity: number): number {
  if (session === "halt") return 0;
  if (session === "morning" || session === "afternoon") return 1.0;
  if (session === "midday") return 0.5;
  if (isMetal && equity >= 3000 && (session === "eth_evening" || session === "eth_europe")) return 1.0;
  return 0;
}

/** Does any enabled edge match this symbol-class in this session? Uses the real registry matcher. */
function armedEdges(session: string, mode: EngineMode, cfg: Record<string, string | undefined>) {
  const probes = [
    { sym: "MGC", setupType: "extreme_rsi_bounce", direction: "long" as const, rsi: 20 },
    { sym: "MGC", setupType: "extreme_rsi_bounce", direction: "short" as const, rsi: 85 },
    { sym: "MES", setupType: "extreme_rsi_bounce", direction: "short" as const, rsi: 85 },
    { sym: "MES", setupType: "trend_continuation", direction: "long" as const, rsi: 50 },
  ];
  const hits: { key: string; name: string }[] = [];
  for (const p of probes) {
    const edge = REALTIME_EDGES.find((e) => e.matches({ ...p, session }));
    if (edge && isEdgeEnabled(edge.key, mode, cfg) && !hits.some((h) => h.key === edge.key)) {
      hits.push({ key: edge.key, name: edge.name });
    }
  }
  return hits;
}

export async function GET(req: Request) {
  try {
    const mode = (new URL(req.url).searchParams.get("mode") === "demo" ? "demo" : "live") as EngineMode;

    const rows = await prisma.agentConfig.findMany();
    const cfg: Record<string, string | undefined> = {};
    for (const r of rows) cfg[r.key] = r.value;

    const hbRaw = cfg[`futures_engine_heartbeat_${mode}`];
    const hb = hbRaw ? JSON.parse(hbRaw) : null;
    const hbAgeSec = hb?.timestamp ? Math.round((Date.now() - Date.parse(hb.timestamp)) / 1000) : null;
    const equity = Number(hb?.equity ?? 0);

    // Schedule: for each session window, which edges are armed and at what size multiplier.
    const schedule = WINDOWS.map((w) => {
      const edges = armedEdges(w.session, mode, cfg);
      const metalMult = liveSizeMult(w.session, true, equity);
      const indexMult = liveSizeMult(w.session, false, equity);
      // An edge only truly trades if its session ALSO has a non-zero size multiplier for that class.
      const live = edges.filter((e) => {
        const isMetal = e.key.startsWith("gold");
        return (isMetal ? metalMult : indexMult) > 0;
      });
      return { ...w, edges: live, metalMult, indexMult, tradable: live.length > 0 };
    });

    // Per-symbol state straight from the engine — no recomputation here.
    const syms = (hb?.symbols ?? {}) as Record<string, Record<string, number | string | boolean | null>>;
    const symbols = Object.entries(syms).map(([sym, s]) => ({
      sym,
      ...s,
      snapshotAgeSec: typeof s.at === "number" ? Math.round((Date.now() - s.at) / 1000) : null,
    }));

    return Response.json({
      mode,
      engine: hb
        ? { alive: hbAgeSec !== null && hbAgeSec < 180, ageSec: hbAgeSec, session: hb.session, mdHealth: hb.mdHealth,
            positions: hb.positions, dailyTrades: hb.dailyTrades, dailyPnl: hb.dailyPnl }
        : null,
      risk: hb
        ? { equity, riskPerTrade: hb.riskPerTrade ?? null, dailyLossLimit: hb.dailyLossLimit ?? null,
            maxTradesPerDay: hb.maxTradesPerDay ?? null, maxContractsPerTrade: hb.maxContractsPerTrade ?? null }
        : null,
      schedule,
      symbols,
      edges: REALTIME_EDGES.map((e) => ({
        key: e.key, name: e.name, blurb: e.blurb,
        enabled: isEdgeEnabled(e.key, mode, cfg),
      })),
    });
  } catch (e) {
    return Response.json({ error: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
}
