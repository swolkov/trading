import { prisma } from "@/lib/db";
import { REALTIME_EDGES, type EngineMode } from "@/lib/realtime-edges";
import { activeVaultGates } from "@/lib/vault-session-gates";
import { evaluateFuturesEntryGates } from "@/lib/futures-admin-state";

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
function armedEdges(session: string, runtimeEnabled: Set<string>) {
  const setupTypes = ["extreme_rsi_bounce", "failed_ib_breakout", "gap_fill", "ib_extension", "or_breakout", "range_bounce", "trend_continuation", "vwap_bounce", "vwap_reclaim"];
  const probes = ["MGC", "MES"].flatMap((sym) => setupTypes.flatMap((setupType) =>
    (["long", "short"] as const).flatMap((direction) => [20, 50, 77, 85].map((rsi) => ({ sym, setupType, direction, rsi })))));
  const hits: { key: string; name: string }[] = [];
  for (const p of probes) {
    const edge = REALTIME_EDGES.find((e) => e.matches({ ...p, session }));
    if (edge && runtimeEnabled.has(edge.key) && !hits.some((h) => h.key === edge.key)) {
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
    const runtimeEnabled = new Set<string>(Array.isArray(hb?.enabledEdges) ? hb.enabledEdges : []);
    const tradingModeRaw = cfg.trading_mode_futures;
    const tradingMode = tradingModeRaw === "live" || tradingModeRaw === "disabled" ? tradingModeRaw : "paper";
    const entryGates = evaluateFuturesEntryGates(mode, tradingMode, hb);

    // Schedule: for each session window, which edges are armed and at what size multiplier.
    const schedule = WINDOWS.map((w) => {
      const edges = armedEdges(w.session, runtimeEnabled);
      const metalMult = liveSizeMult(w.session, true, equity);
      const indexMult = liveSizeMult(w.session, false, equity);
      // An edge only truly trades if its session ALSO has a non-zero size multiplier for that class.
      const live = edges.filter((e) => {
        const isMetal = e.key.startsWith("gold");
        return (isMetal ? metalMult : indexMult) > 0;
      });
      return { ...w, edges: live, metalMult, indexMult, tradable: entryGates.entriesAllowed && live.length > 0 };
    });

    // Which symbol CLASSES actually have an armed edge in the session running right now. Without
    // this the panel would print a tradable size for a session that has no edge armed at all —
    // technically the size it *would* use, but read as "ready to go". Both must be true to trade.
    const currentWindow = schedule.find((w) => w.session === hb?.session) ?? null;
    const armedNow = {
      metals: !!currentWindow?.edges.some((e) => e.key.startsWith("gold")),
      index: !!currentWindow?.edges.some((e) => !e.key.startsWith("gold")),
    };

    // Per-symbol state straight from the engine — no recomputation here.
    const syms = (hb?.symbols ?? {}) as Record<string, Record<string, number | string | boolean | null>>;
    const symbols = Object.entries(syms).map(([sym, s]) => ({
      sym,
      ...s,
      snapshotAgeSec: typeof s.at === "number" ? Math.round((Date.now() - s.at) / 1000) : null,
      edgeArmedNow: sym.includes("GC") ? armedNow.metals : armedNow.index,
    }));

    // VAULT SESSION GATES — the synthesis agent can block a whole session automatically (currently
    // midday at 27% win rate). Surfaced because it is otherwise INVISIBLE: the engine returns from
    // onBarClose before indicators are computed, so a blocked session looks identical to a quiet one.
    // If a future synthesis run ever emits mid_morning or first_30_min under 30%, it would shut off
    // live's primary window and this is the only place that would say so.
    let vaultGates: { session: string; label: string; winRate: number; effect: string }[] = [];
    try {
      const doc = await prisma.vaultDocument.findFirst({ where: { path: { contains: "anti-patterns" } } });
      if (doc?.content) vaultGates = activeVaultGates(doc.content);
    } catch { /* vault is advisory — never break the panel */ }

    return Response.json({
      mode,
      entryGates,
      vaultGates,
      engine: hb
        ? { alive: entryGates.alive, ageSec: hbAgeSec, session: hb.session, mdHealth: hb.mdHealth,
            ready: hb.ready, deploymentId: hb.deploymentId, strategyVersion: hb.strategyVersion,
            liveTradingArmed: hb.liveTradingArmed, operatorTradingEnabled: hb.operatorTradingEnabled,
            riskConfigHealthy: hb.riskConfigHealthy, enabledEdges: hb.enabledEdges,
            positions: hb.positions, dailyTrades: hb.dailyTrades, dailyPnl: hb.dailyPnl }
        : null,
      risk: hb
        ? { equity, riskPerTrade: hb.riskPerTrade ?? null, dailyLossLimit: hb.dailyLossLimit ?? null,
            maxTradesPerDay: hb.maxTradesPerDay ?? null, maxContractsPerTrade: hb.maxContractsPerTrade ?? null }
        : null,
      schedule,
      armedNow,
      symbols,
      edges: REALTIME_EDGES.map((e) => ({
        key: e.key, name: e.name, blurb: e.blurb,
        enabled: runtimeEnabled.has(e.key),
      })),
    });
  } catch (e) {
    return Response.json({ error: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
}
