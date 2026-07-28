import { prisma } from "./db";
import { REALTIME_EDGES, isEdgeEnabled, type EdgeSwitchVM } from "./realtime-edges";

// LIVE per-edge performance for the futures admin — "what's actually working" in real money.
// Splits realized live futures closes into the 3 gated edges the engine trades, with a DIRECTION
// attached (the edge-scoreboard only split by symbol, so it couldn't tell the new index long from the
// overbought short). We use ONLY live_* rows and pair each entry (live_long/live_short) to its exit,
// which both attaches direction AND sidesteps the live_/futures_ double-log dedup problem entirely.

export interface EdgeStat {
  key: string;
  name: string;
  blurb: string;
  trades: number;
  wins: number;
  losses: number;
  winRate: number;
  net: number;
  lastTs: string | null;
  recent: { ts: string; sym: string; dir: "long" | "short"; exit: string; pnl: number }[];
  /** Is this edge currently switched ON for this engine? The scoreboard shows HISTORICAL results, so
   *  without this a card for a disabled edge reads as though it is still trading. */
  enabled: boolean;
  /** Set when an edge is only partly on (e.g. trend-long runs mornings but not afternoons). */
  statusNote?: string;
}

const dirOf = (action: string): "long" | "short" | null =>
  action === "live_long" ? "long" : action === "live_short" ? "short" : null;

export async function getEdgePerformance(mode: "live" | "demo" = "live"): Promise<{ since: string; edges: EdgeStat[]; totalNet: number; totalTrades: number }> {
  // Mode-aware so the SAME scoreboard works for the demo shadow-test. Live = MGC/MNQ/MES micros +
  // live_ prefix + edge_scoreboard_since; demo = GC/NQ/ES full-size + futures_ prefix +
  // demo_scoreboard_since (independent inception, so demo can be reset without touching live).
  const prefix = mode === "live" ? "live" : "futures";
  const goldSym = mode === "live" ? "FUT:MGC" : "FUT:GC";
  const idxSyms = mode === "live" ? ["FUT:MNQ", "FUT:MES"] : ["FUT:NQ", "FUT:ES"];
  const dispGold = mode === "live" ? "MGC" : "GC";
  const dispIdx = mode === "live" ? "MNQ/MES" : "NQ/ES";

  const sinceKey = mode === "demo" ? "demo_scoreboard_since" : "edge_scoreboard_since";
  let sinceRow = await prisma.agentConfig.findUnique({ where: { key: sinceKey } });
  if (!sinceRow && mode === "demo") sinceRow = await prisma.agentConfig.findUnique({ where: { key: "edge_scoreboard_since" } });
  const since = sinceRow?.value ? new Date(sinceRow.value) : new Date(0);

  // Jul 16-17 INCIDENT WINDOW — an orphaned-bracket bug tangled the (live) trade rows here. Their net
  // P&L is still in the ACCOUNT balance (the authoritative total); just excluded from per-edge "what
  // works". Harmless no-op for demo (demo_scoreboard_since starts after it).
  const INCIDENT_START = Date.parse("2026-07-16T22:00:00Z");
  const INCIDENT_END = Date.parse("2026-07-17T06:00:00Z");
  const rows = (await prisma.autoTradeLog.findMany({
    where: { symbol: { in: [goldSym, ...idxSyms] }, action: { startsWith: `${prefix}_` }, createdAt: { gte: since } },
    orderBy: { createdAt: "asc" },
    take: 1000,
  })).filter((r) => { const t = r.createdAt.getTime(); return t < INCIDENT_START || t >= INCIDENT_END; });

  const dirFor = (action: string): "long" | "short" | null =>
    action === `${prefix}_long` ? "long" : action === `${prefix}_short` ? "short" : null;

  // Pair entries → exits per symbol so each realized P&L carries the direction it was taken in.
  const openDir: Record<string, "long" | "short" | null> = {};
  type Close = { ts: Date; sym: string; dir: "long" | "short"; exit: string; pnl: number };
  const closes: Close[] = [];
  for (const r of rows) {
    const d = dirFor(r.action);
    if (d) { openDir[r.symbol] = d; continue; }   // entry — remember the direction we opened in
    if (r.pnl == null) continue;                  // not a realized close
    const dir = openDir[r.symbol];
    if (!dir) continue;                           // exit with no matching in-window entry — skip
    closes.push({ ts: r.createdAt, sym: r.symbol, dir, exit: r.action.replace(new RegExp(`^${prefix}_`), ""), pnl: r.pnl });
    openDir[r.symbol] = null;
  }

  const isIdx = (s: string) => idxSyms.includes(s);
  const DEFS = [
    { key: "gold_long", name: "Gold RSI — oversold LONG", blurb: `${dispGold} — buy RSI<25 oversold bounce (long side of the flagship edge).`, match: (c: Close) => c.sym === goldSym && c.dir === "long" },
    { key: "gold_short", name: "Gold RSI — overbought SHORT", blurb: `${dispGold} — short RSI>75 overbought fade, MORNINGS only. 3-yr rebuild: morning PF 1.72 (both halves) vs afternoon 1.92/train 0.86, evening 1.15/train 0.76, Europe 0.96/train 0.58 — so every off-peak hour is switched off.`, match: (c: Close) => c.sym === goldSym && c.dir === "short" },
    { key: "index_short", name: "Index overbought-short", blurb: `${dispIdx} — short at RSI≥80. The overbought fade, afternoon excluded: ES 0.46 / NQ 0.71 after 14:00 ET, the worst cell on both symbols.`, match: (c: Close) => isIdx(c.sym) && c.dir === "short" },
    // Blurb corrected 2026-07-25: it previously claimed "PF 1.22, +both halves" from a backtest whose
    // script no longer exists. An engine-exact rebuild with full trade management could not reproduce
    // that — it measured ES 0.74 / NQ 0.90, negative in BOTH halves over 3 years. What IS robust is
    // the time-of-day split: mornings beat afternoons in 51 of 57 tests across 19 instruments.
    { key: "index_long", name: "Index trend-long", blurb: `${dispIdx} — buy EMA9 pullbacks in a confirmed uptrend (price>200-EMA), MORNINGS only. 3-yr rebuild: morning ES 0.80 / NQ 1.02 vs afternoon 0.63 / 0.69, so the afternoon half is switched off.`, match: (c: Close) => isIdx(c.sym) && c.dir === "long" },
  ];

  // Which registry edges back each scoreboard card, so a disabled edge can be labelled as such.
  const REGISTRY_FOR: Record<string, string[]> = {
    gold_long: ["gold_long"],
    gold_short: ["gold_short", "gold_short_offpeak"],
    index_short: ["index_overbought_short", "index_overbought_short_pm"],
    index_long: ["index_trend_long", "index_trend_long_pm"],
  };
  const flagRows = await prisma.agentConfig
    .findMany({ where: { key: { startsWith: "edge_" } } })
    .catch(() => [] as { key: string; value: string }[]);
  const flags: Record<string, string | undefined> = {};
  for (const r of flagRows) flags[r.key] = r.value;
  const statusOf = (scoreboardKey: string) => {
    const keys = REGISTRY_FOR[scoreboardKey] ?? [];
    const on = keys.filter((k) => isEdgeEnabled(k, mode === "demo" ? "demo" : "live", flags));
    if (!keys.length) return { enabled: true, statusNote: undefined };
    if (on.length === keys.length) return { enabled: true, statusNote: undefined };
    if (on.length === 0) return { enabled: false, statusNote: undefined };
    // Partly on: say WHICH half is live, per card — a generic note would misdescribe gold, whose
    // disabled half is every off-peak hour, not just the afternoon.
    const PARTIAL_NOTE: Record<string, string> = {
      gold_short: "mornings only (09:45–12:00 ET) — midday, afternoon, evening and Europe switched off",
      index_short: "afternoon half switched off — mornings and midday only",
      index_long: "mornings only — afternoon half switched off",
    };
    return { enabled: true, statusNote: PARTIAL_NOTE[scoreboardKey] ?? "partly switched off" };
  };

  const edges: EdgeStat[] = DEFS.map((e) => {
    const t = closes.filter(e.match);
    const net = t.reduce((s, c) => s + c.pnl, 0);
    const wins = t.filter((c) => c.pnl > 0).length;
    const losses = t.filter((c) => c.pnl < 0).length;
    return {
      key: e.key, name: e.name, blurb: e.blurb,
      trades: t.length, wins, losses,
      winRate: t.length ? wins / t.length : 0,
      net,
      lastTs: t.length ? t[t.length - 1].ts.toISOString() : null,
      recent: [...t].reverse().slice(0, 8).map((c) => ({ ts: c.ts.toISOString(), sym: c.sym.replace("FUT:", ""), dir: c.dir, exit: c.exit, pnl: c.pnl })),
      ...statusOf(e.key),
    };
  });

  return { since: since.toISOString(), totalNet: edges.reduce((s, e) => s + e.net, 0), totalTrades: edges.reduce((s, e) => s + e.trades, 0), edges };
}

// Per-REGISTRY-EDGE realized performance for a given engine (demo or live), keyed by the
// realtime-edges.ts keys so the strategy control board can show each edge's demo vs live results
// side by side. Live reads live_* rows on the micros (MGC/MNQ/MES); demo reads futures_* rows on the
// full-size contracts (GC/NQ/ES). Same entry→exit pairing (attaches direction, sidesteps double-logs).
export interface RealtimeEdgePerf {
  key: string;
  net: number;
  trades: number;
  wins: number;
  losses: number;
  winRate: number;
  lastTs: string | null;
}

export interface FuturesClose { ts: Date; sym: string; dir: "long" | "short"; pnl: number }

// Paired entry→exit closes for an engine (live/demo), Jul 16-17 incident window excluded. THE shared
// basis for per-edge perf AND the account-stats panel, so trade count / best / worst / win-rate can
// never diverge between surfaces (that divergence was the "best = worst = +$86" bug — best/worst were
// read from session-scoped Tradovate fills while the counts came from the DB).
export async function getFuturesCloses(mode: "live" | "demo"): Promise<FuturesClose[]> {
  const prefix = mode === "live" ? "live" : "futures";
  const goldSyms = mode === "live" ? ["FUT:MGC"] : ["FUT:GC"];
  const indexSyms = mode === "live" ? ["FUT:MNQ", "FUT:MES"] : ["FUT:NQ", "FUT:ES"];
  const allSyms = [...goldSyms, ...indexSyms];
  // Live and demo have INDEPENDENT inception dates so demo can be reset for a fresh forward-test without
  // touching live's track record. Demo reads demo_scoreboard_since (falls back to the shared key if unset).
  const sinceKey = mode === "demo" ? "demo_scoreboard_since" : "edge_scoreboard_since";
  let sinceRow = await prisma.agentConfig.findUnique({ where: { key: sinceKey } });
  if (!sinceRow && mode === "demo") sinceRow = await prisma.agentConfig.findUnique({ where: { key: "edge_scoreboard_since" } });
  const since = sinceRow?.value ? new Date(sinceRow.value) : new Date(0);
  const dir = (action: string): "long" | "short" | null =>
    action === `${prefix}_long` ? "long" : action === `${prefix}_short` ? "short" : null;
  const INCIDENT_START = Date.parse("2026-07-16T22:00:00Z");
  const INCIDENT_END = Date.parse("2026-07-17T06:00:00Z");
  const rows = (await prisma.autoTradeLog.findMany({
    where: { symbol: { in: allSyms }, action: { startsWith: `${prefix}_` }, createdAt: { gte: since } },
    orderBy: { createdAt: "asc" },
    take: 2000,
  })).filter((r) => { const t = r.createdAt.getTime(); return t < INCIDENT_START || t >= INCIDENT_END; });

  const openDir: Record<string, "long" | "short" | null> = {};
  const closes: FuturesClose[] = [];
  for (const r of rows) {
    const d = dir(r.action);
    if (d) { openDir[r.symbol] = d; continue; }
    if (r.pnl == null) continue;
    const od = openDir[r.symbol];
    if (!od) continue;
    closes.push({ ts: r.createdAt, sym: r.symbol, dir: od, pnl: r.pnl });
    openDir[r.symbol] = null;
  }
  return closes;
}

export async function getRealtimeEdgePerformance(mode: "live" | "demo"): Promise<Record<string, RealtimeEdgePerf>> {
  const goldSyms = mode === "live" ? ["FUT:MGC"] : ["FUT:GC"];
  const indexSyms = mode === "live" ? ["FUT:MNQ", "FUT:MES"] : ["FUT:NQ", "FUT:ES"];
  const closes = await getFuturesCloses(mode);

  const isGold = (s: string) => goldSyms.includes(s);
  const isIndex = (s: string) => indexSyms.includes(s);
  // Keys MUST match src/lib/realtime-edges.ts, or the control board silently shows no results for an
  // edge. Gold was split by direction on 2026-07-25 (gold_rsi_bounce -> gold_long + gold_short); this
  // bucket still said "gold_rsi_bounce", so every gold trade landed on a key no registered edge has
  // and the board showed gold as having never traded.
  // KNOWN GAP: three edges are now split by SESSION (index_trend_long/_pm, index_overbought_short/_pm
  // and gold_short/_offpeak), but a FuturesClose carries no entry session, so each pair's trades all
  // bucket to the morning key. Live no longer takes any of the off-peak halves, so this self-corrects
  // going forward and only back-dated rows are merged; demo, which runs every half, stays merged.
  // Closing it properly needs an entry-session column on the close record — not worth a migration
  // while the off-peak halves are live-disabled.
  const bucket = (c: FuturesClose): string | null =>
    isGold(c.sym) ? (c.dir === "long" ? "gold_long" : "gold_short")
    : isIndex(c.sym) && c.dir === "short" ? "index_overbought_short"
    : isIndex(c.sym) && c.dir === "long" ? "index_trend_long"
    : null;

  const out: Record<string, RealtimeEdgePerf> = {};
  const ensure = (k: string) => (out[k] ??= { key: k, net: 0, trades: 0, wins: 0, losses: 0, winRate: 0, lastTs: null });
  for (const c of closes) {
    const k = bucket(c);
    if (!k) continue;
    const e = ensure(k);
    e.net += c.pnl; e.trades++;
    if (c.pnl > 0) e.wins++; else if (c.pnl < 0) e.losses++;
    e.lastTs = c.ts.toISOString();
  }
  for (const k of Object.keys(out)) out[k].winRate = out[k].trades ? out[k].wins / out[k].trades : 0;
  return out;
}

// Single source of truth for the edge control surfaces: each registered edge with its current
// demo/live switch state + demo/live realized results. Used by BOTH the admin control board and the
// Futures-page inline switch list so they can never show different states. Order = registry order
// (priority #1..N). Best-effort: a DB hiccup on any part degrades to defaults / empty perf, never throws.
export async function getEdgeSwitchboard(): Promise<EdgeSwitchVM[]> {
  const [flagRows, livePerf, demoPerf] = await Promise.all([
    prisma.agentConfig.findMany({ where: { key: { startsWith: "edge_" } } }).catch(() => [] as { key: string; value: string }[]),
    getRealtimeEdgePerformance("live").catch(() => ({}) as Record<string, RealtimeEdgePerf>),
    getRealtimeEdgePerformance("demo").catch(() => ({}) as Record<string, RealtimeEdgePerf>),
  ]);
  const cfg: Record<string, string | undefined> = {};
  for (const r of flagRows) cfg[r.key] = r.value;
  const lite = (p?: RealtimeEdgePerf) =>
    p ? { net: p.net, trades: p.trades, wins: p.wins, losses: p.losses, winRate: p.winRate } : null;
  return REALTIME_EDGES.map((e) => ({
    key: e.key,
    name: e.name,
    blurb: e.blurb,
    evidence: e.evidence,
    symbolClass: e.symbolClass,
    demoEnabled: isEdgeEnabled(e.key, "demo", cfg),
    liveEnabled: isEdgeEnabled(e.key, "live", cfg),
    demoPerf: lite(demoPerf[e.key]),
    livePerf: lite(livePerf[e.key]),
  }));
}
