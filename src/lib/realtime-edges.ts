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
  /** Engine session name ("morning" | "midday" | "afternoon" | "eth_evening" | "eth_europe" | ...).
   *  Lets an edge be scoped to the hours it actually works in. Optional only so a caller predating
   *  session-scoping still compiles — but an omitted session is treated as NOT the good session, so
   *  it routes to the live-disabled half and is DENIED. Never rely on omitting it. */
  session?: string;
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

/**
 * SESSION-SCOPED EDGES — read this before adding one.
 *
 * A session-split edge is a PAIR: the good hours and the rest. Each half is `session === X` and
 * `session !== X`, which makes them mutually exclusive (matchEdge takes the first hit, so an overlap
 * would silently pick one) and exhaustive (no setup can fall through both).
 *
 * FAIL-SAFE DIRECTION: an ABSENT/unknown session resolves to `!== X`, i.e. the OFF-PEAK half, which
 * is the live-DISABLED one. So a caller that forgets to pass a session gets DENIED, never a live
 * trade. The earlier version treated a missing session as the *enabled* half — the wrong way round,
 * and the same shape of mistake that let a stale build trade an evening gold short on 2026-07-28.
 */
/** 09:45–12:00 ET. Gold's only both-halves-positive SHORT cell (PF 1.72). */
const GOLD_SHORT_SESSION = "morning";
/** 03:00–09:00 ET, London. Gold's only both-halves-positive LONG cell (PF 1.37, n=310 — the largest
 *  passing sample of any gold cell). London is gold's most liquid stretch outside NY. */
const GOLD_LONG_SESSION = "eth_europe";

export function edgeSymbolClass(sym: string): EdgeSymbolClass {
  return METALS.has(sym) ? "metals" : "index";
}

/**
 * The registered intraday edges. These reproduce the engine's previous hardcoded allow-list
 * EXACTLY, so switching the gate over to this registry is behaviour-preserving by default.
 */
export const REALTIME_EDGES: RealtimeEdge[] = [
  // The gold RSI-bounce used to be ONE edge covering both directions. Split 2026-07-25 because the
  // two sides behave completely differently intraday, and only one switch could express that.
  // Split 2026-07-28. Gold long was one edge across all hours and measured PF 0.71 — but that pooled
  // number hid the fact that ONE session carries a real edge and the rest drag it under. A NEW key is
  // used for the good half deliberately: `edge_gold_long_live` is already "false" in the DB, so
  // reusing it would have kept London switched off, while `gold_long_europe` has no stale flag and
  // resolves from its registry default.
  {
    key: "gold_long_europe",
    name: "Gold RSI — oversold LONG (London)",
    blurb: "MGC/GC — buy deep-oversold RSI extremes (RSI<25) during London hours, 03:00–09:00 ET.",
    symbolClass: "metals",
    evidence:
      "The BEST cell in the entire 12-cell gold grid and one of only two that survive both halves: PF 1.37 over 310 trades (train 1.19 / test 1.51) — the largest passing sample of any gold cell, and steadier across halves than the morning short (1.10/2.46) that already trades live. London is gold's most liquid stretch outside NY. NOTE the pooled gold-long number (PF 0.71) is dragged down entirely by the other sessions — see gold_long.",
    defaultDemo: true,
    defaultLive: true,
    matches: (m) =>
      edgeSymbolClass(m.sym) === "metals" && m.setupType === "extreme_rsi_bounce" && m.direction === "long" &&
      m.session === GOLD_LONG_SESSION,
  },
  {
    key: "gold_long",
    name: "Gold RSI — oversold LONG (outside London)",
    blurb: "MGC/GC — the same RSI<25 oversold buy, taken outside 03:00–09:00 ET.",
    symbolClass: "metals",
    evidence:
      "The losing hours of the gold long, and where the pooled PF 0.71 (0.67 train / 0.72 test, 572 trades) actually comes from. Engine-exact 3-yr by session: morning 0.53 — the single worst of all 12 gold cells — midday 0.73, afternoon 0.73, eth_evening 0.83, eth_asia 0.87. Not one is positive. Switched OFF on live 2026-07-25, left ON for demo. NOTE the 26-yr DAILY gold oversold-long (PF 1.58) does not transfer here: it was the no-stop variant, and it fails once a stop is attached.",
    defaultDemo: true,
    // defaultLive was TRUE until 2026-07-29 — a losing half defaulting ON for real money, held off
    // only by `edge_gold_long_live=false` in the DB. That made a single DB row load-bearing safety:
    // delete or reset it and live immediately trades the worst cell in the gold grid (PF 0.53). The
    // registry's own rule is that anything unproven on live defaults OFF, so the default now matches
    // the evidence and the DB flag is merely redundant. No behaviour change today.
    defaultLive: false,
    matches: (m) =>
      edgeSymbolClass(m.sym) === "metals" && m.setupType === "extreme_rsi_bounce" && m.direction === "long" &&
      m.session !== GOLD_LONG_SESSION,
  },
  {
    key: "gold_short",
    name: "Gold RSI — overbought SHORT",
    blurb: "MGC/GC — fade deep-overbought RSI extremes (RSI>75).",
    symbolClass: "metals",
    evidence:
      "MORNING ONLY (09:45–12:00 ET) as of 2026-07-28. Engine-exact 3-yr test, all 12 gold session×direction cells: the morning short is one of only TWO that survive both halves — PF 1.72 (1.10 train / 2.46 test) over 117 trades. Every other gold short session fails its train half: afternoon 1.92 (0.86), eth_evening 1.15 (0.76), midday 1.03 (0.74), eth_europe 0.96 (0.58). Live corroborates: gold is −$92 over 10 trades while the morning book is +$329.",
    defaultDemo: true,
    defaultLive: true,
    matches: (m) =>
      edgeSymbolClass(m.sym) === "metals" && m.setupType === "extreme_rsi_bounce" && m.direction === "short" &&
      m.session === GOLD_SHORT_SESSION,
  },
  // Split out 2026-07-28, same reasoning as the index morning/afternoon split: the off-peak gold
  // shorts are a different trade from the morning one, and only a separate switch can express that.
  {
    key: "gold_short_offpeak",
    name: "Gold RSI — overbought SHORT (off-peak)",
    blurb: "MGC/GC — the same RSI>75 fade, but taken outside 09:45–12:00 ET.",
    symbolClass: "metals",
    evidence:
      "The losing hours of the gold short. Engine-exact 3-yr, full management: afternoon PF 1.92 but train 0.86, eth_evening 1.15 (train 0.76), midday 1.03 (train 0.74), eth_europe 0.96 (train 0.58), eth_asia 0.87 (train 0.56) — not one passes both halves. Live: the evening book is −$28 over 7 trades and the afternoon −$83 over 7. Switched OFF for live 2026-07-28, left ON for demo to keep collecting evidence.",
    defaultDemo: true,
    defaultLive: false,
    matches: (m) =>
      edgeSymbolClass(m.sym) === "metals" && m.setupType === "extreme_rsi_bounce" && m.direction === "short" &&
      m.session !== GOLD_SHORT_SESSION,
  },
  {
    key: "index_overbought_short",
    name: "Index overbought-short",
    blurb: "MNQ/MES — short when RSI ≥ 80 (the overbought fade).",
    symbolClass: "index",
    evidence:
      "⛔ LIVE-OFF AND IT SHOULD STAY OFF — re-verified 2026-07-29. Engine-exact 3-yr (index-edge-validation.ts, 24h rolling 200-bar buffer, full management, the registry gate modelled exactly) says this edge LOSES IN EVERY SESSION ON BOTH SYMBOLS: ES overall PF 0.58 n=183 net -$1,291 (train 0.45 / test 0.73) — morning 0.61, midday 0.63, afternoon 0.50; NQ overall PF 0.82 n=172 net -$889 (train 0.71 / test 0.97) — morning 0.75, midday 0.97, afternoon 0.74. Combined -$2,180 over 355 trades. ⚠️ THIS TEXT USED TO CLAIM 'PF 1.4-1.8 out-of-sample (12k-trade walk-forward)' AND 'Re-enabled on live 2026-07-28 after the shadow tracker showed 4W/1L +$824'. Both misled a 2026-07-29 audit into recommending it be switched back ON. The 1.4-1.8 predates the engine-exact harness (idealised fills, not the engine's real 1.5-ATR stop / 3.5-ATR target management); the shadow +$824 was n=5, which is noise (see the scoreboard rule: t>2 or it is luck); and the 're-enable' never took effect because edge_index_overbought_short_live=false already existed in the DB — correctly, as it turns out. Do NOT re-enable without fresh engine-exact evidence that beats these numbers.",
    defaultDemo: true,
    // Was TRUE, held off only by a DB flag. Given the numbers above, the default must not be the
    // thing standing between a PF 0.58 edge and real money — same fix as gold_long / index_trend_long_pm.
    defaultLive: false,
    matches: (m) =>
      edgeSymbolClass(m.sym) === "index" && m.setupType === "extreme_rsi_bounce" && m.direction === "short" && m.rsi >= 80 &&
      m.session !== "afternoon",
  },
  // Split out 2026-07-28. This was the LAST way an index trade could still open in the afternoon
  // once index_trend_long_pm was switched off — and the afternoon is the worst cell of the three.
  {
    key: "index_overbought_short_pm",
    name: "Index overbought-short — afternoon",
    blurb: "MNQ/MES — the same RSI≥80 short, but taken after 14:00 ET.",
    symbolClass: "index",
    evidence:
      "The worst session for this edge on BOTH symbols. Engine-exact 3-yr with full management: ES afternoon PF 0.46 (0.30 train / 0.67 test) vs morning 0.57 and midday 0.83; NQ afternoon 0.71 (0.72 / 0.70) vs morning 0.81 and midday 1.01. Consistent with the broader finding that mornings beat afternoons in 51 of 57 tests across 19 instruments, and with the live book (afternoon −$83 over 7 trades).",
    defaultDemo: true,
    defaultLive: false,
    matches: (m) =>
      edgeSymbolClass(m.sym) === "index" && m.setupType === "extreme_rsi_bounce" && m.direction === "short" && m.rsi >= 80 &&
      m.session === "afternoon",
  },
  {
    key: "index_trend_long",
    name: "Index trend-long — morning",
    blurb: "MNQ/MES — buy EMA9 pullbacks in a confirmed uptrend (price > 200-EMA), morning only.",
    symbolClass: "index",
    evidence:
      "4.5-yr Databento backtest incl. the 2022 bear: filtered long PF 1.22 pooled, positive in BOTH train (1.15) and test (1.31); NQ 1.24 / ES 1.18. The SAME long below the 200-EMA loses (PF 0.55) — the regime filter is the edge.",
    defaultDemo: true,
    defaultLive: true,
    matches: (m) =>
      INDEX_LONG_SYMS.has(m.sym) && m.setupType === "trend_continuation" && m.direction === "long" &&
      m.session !== "afternoon",
  },
  // Split out 2026-07-25. The setup itself only fires in "morning" or "afternoon", and the two are
  // not the same trade: the afternoon half loses in BOTH halves on BOTH symbols.
  {
    key: "index_trend_long_pm",
    name: "Index trend-long — afternoon",
    blurb: "MNQ/MES — the same EMA9-pullback long, but taken after 14:00 ET.",
    symbolClass: "index",
    evidence:
      "The losing half of the trend-long edge. Engine-exact 3-yr test with full management: ES PF 0.63 (0.64 train / 0.61 test), NQ PF 0.69 (0.71 / 0.67) — negative in both halves on both symbols across 1,608 trades, while the MORNING half is 0.80 (ES) and 1.02 (NQ). Same instrument, same setup, same model: the hours are the difference.",
    defaultDemo: true,
    // defaultLive was TRUE until 2026-07-29 — same latent trap as gold_long: negative in BOTH halves
    // on BOTH symbols across 1,608 trades, yet defaulting ON for real money and held off only by
    // `edge_index_trend_long_pm_live=false` in the DB. Default now matches the evidence, so the DB
    // flag is redundant rather than load-bearing. No behaviour change today.
    defaultLive: false,
    matches: (m) =>
      INDEX_LONG_SYMS.has(m.sym) && m.setupType === "trend_continuation" && m.direction === "long" &&
      m.session === "afternoon",
  },
  // ── PROMOTED TO DEMO 2026-08-05 — evidence-gathering, NOT a validated edge ──────────────────
  // The shadow tracker flagged this as the strongest unexplained signal in 2,036 declined setups,
  // and it is the only one where the two engines AGREE independently on the same instrument and
  // side: MES live n=23 +$3,766 t 3.01, ES demo n=23 +$96,180 t 2.97, with the long side carrying
  // it on both (live t 1.69 / demo t 3.20) and the SHORT side flat-to-negative on both. Gold is
  // NEGATIVE on live (-$1,008 over 87), so this is scoped to the index only.
  //
  // WHY IT IS NOT LIVE. Those numbers are COUNTERFACTUAL — no fills, zero slippage, and simplified
  // management (no breakeven, no 1.1R trail). The engine-exact harness cannot arbitrate yet either:
  // corrected, it returns PF 1.33 but on n=26 in three years against ~23 on MES in a month, a ~33x
  // frequency gap that says the model does not reproduce the engine. Two untrustworthy sources do
  // not make a trustworthy answer.
  //
  // Demo settles all three objections at once and at zero risk: real fills (slippage), real
  // management (the full ladder), and real frequency. That is faster and more conclusive than
  // fixing the harness. Promote to live ONLY on demo evidence that survives both halves — this is
  // the 5th promising signal to reach this stage and four of the previous four died here.
  {
    key: "index_or_breakout_long",
    name: "Index opening-range breakout — LONG (demo trial)",
    blurb: "MNQ/MES — buy the break above the RTH opening range on >1.5x volume, morning only.",
    symbolClass: "index",
    evidence:
      "NOT VALIDATED — on demo to gather real fills. Shadow (counterfactual, no slippage): MES live n=23 +$3,766 t 3.01; ES demo n=23 +$96,180 t 2.97; long side carries it on both engines, short side flat-to-negative, gold negative on live. Engine-exact harness gives PF 1.33 (n=26, train 0.94 / test 2.38) — fails the train half AND fires 33x less often than live, so it cannot arbitrate. 98% of these signals clear the R:R>=2 gate (median 4.89), so unlike gap_fill the shadow figure is not an R:R artifact. Demo answers slippage, management and frequency at once.",
    defaultDemo: true,
    defaultLive: false,
    matches: (m) =>
      INDEX_LONG_SYMS.has(m.sym) && m.setupType === "or_breakout" && m.direction === "long",
  },
  {
    key: "index_overbought_short_75to80",
    name: "Index overbought-short — RSI 75-80 band (demo trial)",
    blurb: "MNQ/MES — fade RSI 75-80 overbought (below the >=80 gate the base edge requires).",
    symbolClass: "index",
    evidence:
      "NOT VALIDATED — demo trial armed 2026-08-10 by the promotion radar's FIRST scan: blocked index extreme_rsi_bounce/short (which is exactly the 75-80 band, since >=80 already trades) is t=3.96 over 69 resolved shadow counterfactuals on demo (+$161,929 at demo sizing, no slippage). The base >=80 edge is separately +$7,588 over 30 REAL demo fills, so the family works; the question this trial answers with real fills is whether the softer band survives slippage and management. Live stays OFF until the standard bar (t>2 on real fills + review).",
    defaultDemo: true,
    defaultLive: false,
    matches: (m) =>
      INDEX_LONG_SYMS.has(m.sym) && m.setupType === "extreme_rsi_bounce" && m.direction === "short" &&
      m.rsi >= 75 && m.rsi < 80,
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
