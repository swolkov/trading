/**
 * Realtime-engine edge registry — the single source of truth for the intraday edges the
 * live/demo futures engine (src/services/futures-realtime.ts) is allowed to trade, PLUS an
 * independent on/off switch for each edge on each engine (demo and live).
 *
 * WHY THIS EXISTS
 *   The engine's trade gate used to hardcode the edge allow-list, so demo and live ran the
 *   exact same set — there was no way to test a NEW edge on demo without also risking it live,
 *   and no clean "promote to live" action. This registry makes each edge independently
 *   toggleable per engine, so the pipeline is:  backtest → demo switch ON → (validate execution)
 *   → promote: live switch ON.
 *
 * SAFETY / NO-SURPRISE DESIGN
 *   - The switch is ADDITIVE. When a switch flag is absent from config (the initial state), the
 *     edge falls back to its registry default — and the three current live edges default to ON
 *     for BOTH demo and live, so wiring this in changes live behaviour by exactly nothing.
 *   - A NEW edge added here defaults to demo=ON, live=OFF, so it can never reach real money until
 *     it is deliberately promoted.
 *   - Default-DENY on no match: a setup that matches no registered edge is skipped, identical to
 *     the old hardcoded gate. Unknown edge keys resolve to disabled.
 *
 * This file is pure data + pure functions (no prisma / no next imports) so it can be imported by
 * BOTH the Railway engine and the Next admin.
 */

export type EdgeSymbolClass = "metals" | "index";
export type EngineMode = "demo" | "live";

export interface EdgeMatchCtx {
  sym: string;
  setupType: string;
  direction: "long" | "short";
  rsi: number;
}

export interface RealtimeEdge {
  key: string;
  name: string;
  blurb: string;
  symbolClass: EdgeSymbolClass;
  /** Backtest / durability evidence, shown on the admin control board. */
  evidence: string;
  defaultDemo: boolean;
  defaultLive: boolean;
  /** Does an evaluated setup belong to this edge? (the actual edge logic — mirrors the engine gate) */
  matches: (m: EdgeMatchCtx) => boolean;
}

const METALS = new Set(["MGC", "GC"]);
const INDEX_LONG_SYMS = new Set(["NQ", "MNQ", "ES", "MES"]);

export function edgeSymbolClass(sym: string): EdgeSymbolClass {
  return METALS.has(sym) ? "metals" : "index";
}

/**
 * The registered intraday edges. These reproduce the engine's previous hardcoded allow-list
 * EXACTLY, so switching the gate over to this registry is behaviour-preserving by default.
 */
export const REALTIME_EDGES: RealtimeEdge[] = [
  {
    key: "gold_rsi_bounce",
    name: "Gold RSI-bounce",
    blurb: "MGC/GC — buy deep-oversold / sell deep-overbought RSI extremes (both directions).",
    symbolClass: "metals",
    evidence:
      "Flagship edge. Durable across a 26-yr daily gold test (oversold PF 1.58, positive in every 5-yr block, 2000–2026); live PF ~1.5 over 60d. Every other gold setup loses OOS and is gated off.",
    defaultDemo: true,
    defaultLive: true,
    matches: (m) => edgeSymbolClass(m.sym) === "metals" && m.setupType === "extreme_rsi_bounce",
  },
  {
    key: "index_overbought_short",
    name: "Index overbought-short",
    blurb: "MNQ/MES — short when RSI ≥ 80 (the overbought fade).",
    symbolClass: "index",
    evidence:
      "The original OOS index edge: RSI≥80 short, PF 1.4–1.8 out-of-sample (12k-trade walk-forward). Index longs and every other index setup lose OOS.",
    defaultDemo: true,
    defaultLive: true,
    matches: (m) =>
      edgeSymbolClass(m.sym) === "index" && m.setupType === "extreme_rsi_bounce" && m.direction === "short" && m.rsi >= 80,
  },
  {
    key: "index_trend_long",
    name: "Index trend-long",
    blurb: "MNQ/MES — buy EMA9 pullbacks ONLY in a confirmed uptrend (price > 200-EMA).",
    symbolClass: "index",
    evidence:
      "4.5-yr Databento backtest incl. the 2022 bear: filtered long PF 1.22 pooled, positive in BOTH train (1.15) and test (1.31); NQ 1.24 / ES 1.18. The SAME long below the 200-EMA loses (PF 0.55) — the regime filter is the edge.",
    defaultDemo: true,
    defaultLive: true,
    matches: (m) =>
      INDEX_LONG_SYMS.has(m.sym) && m.setupType === "trend_continuation" && m.direction === "long",
  },
];

/** Find the registered edge an evaluated setup belongs to, or null (→ default-deny / skip). */
export function matchEdge(ctx: EdgeMatchCtx): RealtimeEdge | null {
  return REALTIME_EDGES.find((e) => e.matches(ctx)) ?? null;
}

/** Config flag key for an edge's on/off switch on a given engine. */
export function edgeFlagKey(edgeKey: string, mode: EngineMode): string {
  return `edge_${edgeKey}_${mode}`;
}

/** All switch flag keys (both modes, all edges) — for the engine's config query. */
export function allEdgeFlagKeys(): string[] {
  return REALTIME_EDGES.flatMap((e) => [edgeFlagKey(e.key, "demo"), edgeFlagKey(e.key, "live")]);
}

/**
 * Is an edge enabled on a given engine? Reads the switch flag from a config map; when the flag is
 * absent (initial state) it falls back to the edge's registry default. Unknown edge → disabled.
 */
export function isEdgeEnabled(edgeKey: string, mode: EngineMode, cfg: Record<string, string | undefined>): boolean {
  const def = REALTIME_EDGES.find((e) => e.key === edgeKey);
  if (!def) return false; // unknown edge → default-deny
  const v = cfg[edgeFlagKey(edgeKey, mode)];
  if (v === "true") return true;
  if (v === "false") return false;
  return mode === "live" ? def.defaultLive : def.defaultDemo;
}

// ---- View-models shared by the admin control board AND the Futures-page inline switch list, so the
// two control surfaces can never drift. Built server-side by getEdgeSwitchboard() (edge-performance.ts).
export interface EdgePerfLite {
  net: number;
  trades: number;
  wins: number;
  losses: number;
  winRate: number;
}
export interface EdgeSwitchVM {
  key: string;
  name: string;
  blurb: string;
  evidence: string;
  symbolClass: EdgeSymbolClass;
  demoEnabled: boolean;
  liveEnabled: boolean;
  demoPerf: EdgePerfLite | null;
  livePerf: EdgePerfLite | null;
}
