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
 *     edge falls back to its registry default. Live defaults are fail-closed; explicit DB flags
 *     and the promotion gate are required before real money can trade an edge.
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
/** 09:45–12:00 ET. Research/demo candidate only; corrected replay fails stability. */
const GOLD_SHORT_SESSION = "morning";
/** 03:00–09:00 ET, London. Corrected replay rejects it; retained for demo evidence only. */
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
      "REJECTED FOR LIVE 2026-08-20. The older PF 1.37 claim used signal-bar closes, one-tick entry cost, and carried indicators across continuous-contract rolls. The corrected next-minute, measured-slippage, roll-safe replay produced PF 0.89 over 307 trades (train 0.74 / test 0.99), and the fresh May-Aug holdout produced PF 0.71. Keep demo-only until real demo fills meet the promotion bar.",
    defaultDemo: true,
    defaultLive: false,
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
      "REJECTED FOR LIVE 2026-08-20. Corrected replay produced PF 1.27 over 120 trades but failed stability badly (train 0.65 / test 2.20). The fresh May-Aug holdout had only 13 morning shorts, and real live fills were 1 win in 4 for -$188. Keep demo-only until real fills achieve t>2 with positive halves.",
    defaultDemo: true,
    defaultLive: false,
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
    key: "gold_trend_continuation",
    name: "Gold trend-continuation LONG (demo trial)",
    blurb: "MGC — buy a confirmed trend-continuation pullback; demo evidence only.",
    symbolClass: "metals",
    evidence:
      "NOT VALIDATED — added 2026-08-21 after 9 resolved MGC shadow marks were +$351.50 net counterfactual, but with no slippage and too little data to promote. The setup is deliberately MGC-only, demo-only, and must earn real fills before any live consideration.",
    defaultDemo: true,
    defaultLive: false,
    matches: (m) =>
      m.sym === "MGC" && m.setupType === "trend_continuation" && m.direction === "long",
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
      "4.5-yr Databento backtest incl. the 2022 bear: filtered long PF 1.22 pooled, positive in BOTH train (1.15) and test (1.31); NQ 1.24 / ES 1.18. The SAME long below the 200-EMA loses (PF 0.55) — the regime filter is the edge. DEMOTED FROM LIVE 2026-08-10 on realized expectancy (see below); the backtest figures above are why it stays on demo, not a licence for live.",
    defaultDemo: true,
    // DEMOTED FROM LIVE 2026-08-10 (the "trend off, risk down" decision). Until now that demotion
    // lived ONLY in `edge_index_trend_long_live=false` in the DB, while the registry still defaulted
    // the edge ON for real money — so losing the config row would silently re-arm a demoted edge on
    // the live account. That is the exact latent trap d8d57de fixed for gold_long and
    // index_trend_long_pm on 2026-07-29; this is the third instance of it.
    //
    // The new book (post 2026-08-10 19:45Z) is gold_long_europe + gold_short + index_overbought_short
    // — this edge is deliberately not in it. Default now matches the decision, so the DB flag is
    // redundant rather than load-bearing. Re-promotion goes through /promote-edge (demo rolling-20
    // expectancy > 0), not by editing this line.
    defaultLive: false,
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

  // ────────────────────────────────────────────────────────────────────────────────────────────
  // ORPHANED-SETUP DEMO TRIALS — added 2026-08-19 after a full-system audit found that 6 of the
  // engine's 9 setup detectors had NO registry entry at all. They fired, scored, passed their local
  // R:R checks, and were then discarded every single time on BOTH engines with "no registered edge"
  // — roughly 1,300 lines of detection logic that could never produce a fill, and (worse) no way to
  // ever learn whether they work, because shadow counterfactuals are recorded BEFORE the sizing and
  // R:R gates and carry no slippage, so they systematically overstate (the gap_fill lesson).
  //
  // These are DEMO-ONLY trials: defaultDemo true / defaultLive false. Their job is to convert
  // "unknown" into REAL FILLS with real slippage and real management. None may be promoted without
  // the standard bar — t>2 on real fills, both halves positive, plus review. Delete any that come
  // back dead rather than leaving them to bleed the research engine.
  {
    key: "gap_fill_trial",
    name: "Gap fill (demo trial)",
    blurb: "Fade the opening gap toward the prior close, first 30 min.",
    symbolClass: "index",
    evidence:
      "UNPROVEN, AND THE SHADOW NUMBER IS KNOWN TO LIE. Its counterfactuals looked outstanding (the 2026-07-25 audit called it the top research lead) but the 2026-07-29 re-measurement found the shadow row is written at recordDecision, BEFORE the R:R>=2.0 gate — and gap geometry means only 6.8-28.2% of gap_fills ever clear it (median R:R 1.10/0.88/0.63), because the stop is fixed at the opening gap while the target shrinks as the gap fills. Raw, it also loses. This trial exists to settle it with fills that pass every real gate, not to endorse it. Expect it to die; that is a useful result.",
    defaultDemo: true,
    defaultLive: false,
    matches: (m) => INDEX_LONG_SYMS.has(m.sym) && m.setupType === "gap_fill",
  },
  {
    key: "vwap_reclaim_trial",
    name: "VWAP reclaim (demo trial)",
    blurb: "Price closes back through VWAP after 5+ bars on one side.",
    symbolClass: "index",
    evidence:
      "UNPROVEN — no backtest, no fills, never registered. Chosen for a trial because it was the most FREQUENT orphaned setup in the live decline log (94 long + 6 short declines on live in 30 days), so it will reach a decision-grade sample fastest. Nominal geometry is 3.5 ATR target / 1.3 ATR stop = 2.69 R:R, which clears the hard gate by construction. NOTE its VWAP input changed on 2026-08-19 (anchor moved from the 02:00 ET accounting roll to the 09:30 RTH open), so any pre-2026-08-19 intuition about this setup is void.",
    defaultDemo: true,
    defaultLive: false,
    matches: (m) => INDEX_LONG_SYMS.has(m.sym) && m.setupType === "vwap_reclaim",
  },
  {
    key: "vwap_bounce_trial",
    name: "VWAP bounce (demo trial)",
    blurb: "Rejection candle off VWAP in the direction of the session trend.",
    symbolClass: "index",
    evidence:
      "UNPROVEN — no backtest, never registered. Trend-following complement to vwap_reclaim (which fades), so running both on demo separates 'VWAP is informative' from 'one direction of VWAP is informative'. 3.0 ATR target / 1.2 ATR stop = 2.5 R:R. Same 2026-08-19 VWAP-anchor caveat applies.",
    defaultDemo: true,
    defaultLive: false,
    matches: (m) => INDEX_LONG_SYMS.has(m.sym) && m.setupType === "vwap_bounce",
  },
  {
    key: "failed_ib_breakout_trial",
    name: "Failed IB breakout (demo trial)",
    blurb: "Fade a break of the opening range that gets rejected back inside.",
    symbolClass: "index",
    evidence:
      "UNPROVEN — no backtest, never registered. The one orphan with its OWN local R:R>=2.0 check before it even reaches the global gate, so its signals are pre-filtered for reward geometry. Its opening-range inputs were corrupted until 2026-08-19 on any day the engine restarted (preload bucketed days in UTC and seeded the OR from the 02:00 ET London hour), so this trial is also the first clean test of the OR itself.",
    defaultDemo: true,
    defaultLive: false,
    matches: (m) => INDEX_LONG_SYMS.has(m.sym) && m.setupType === "failed_ib_breakout",
  },
  {
    key: "ib_extension_trial",
    name: "IB extension (demo trial)",
    blurb: "Continuation beyond the opening range on expanding volume.",
    symbolClass: "index",
    evidence:
      "UNPROVEN — no backtest, never registered. Directional twin of failed_ib_breakout: one fades the OR break, the other rides it. Running both on demo is a controlled A/B on the same event, which is worth more than either alone. Same post-2026-08-19 caveat: OR data before that date was unreliable after restarts.",
    defaultDemo: true,
    defaultLive: false,
    matches: (m) => INDEX_LONG_SYMS.has(m.sym) && m.setupType === "ib_extension",
  },
  {
    key: "range_bounce_trial",
    name: "Range bounce (demo trial)",
    blurb: "Fade session/prior-day extremes on range days.",
    symbolClass: "index",
    evidence:
      "UNPROVEN — no backtest, never registered. ⚠️ KNOWN HOLE: its local R:R floor is 1.5 while the engine's hard gate is 2.0, so signals in the 1.5-2.0 band clear detection and then die silently in executeTrade. That gap is deliberate for now — it makes this trial a strict subset (only R:R>=2.0 range bounces trade), which is the version worth measuring anyway. Do not 'fix' the local floor to 2.0 without re-reading this note; the two numbers are testing different things.",
    defaultDemo: true,
    defaultLive: false,
    matches: (m) => INDEX_LONG_SYMS.has(m.sym) && m.setupType === "range_bounce",
  },
  {
    key: "gold_rsi_bounce_orphans_trial",
    name: "Gold non-RSI setups (demo trial)",
    blurb: "MGC/GC — the OR/VWAP/IB family on gold, which the registry only ever covered for index.",
    symbolClass: "metals",
    evidence:
      "UNPROVEN — gold is registered ONLY for extreme_rsi_bounce, so every other gold setup was discarded unmeasured (the live decline log shows these as 'gold trades RSI-bounce edge only'). Gold is also the single instrument with positive realized live P&L (+$109 over 25 fills, PF 1.15) while index micros are negative, so the question 'do gold's OTHER setups work?' is the highest-value unknown in the book. Excludes trend_continuation, which the engine deliberately skips for gold.",
    defaultDemo: true,
    defaultLive: false,
    matches: (m) =>
      METALS.has(m.sym) &&
      (m.setupType === "or_breakout" || m.setupType === "vwap_reclaim" || m.setupType === "vwap_bounce" ||
       m.setupType === "failed_ib_breakout" || m.setupType === "ib_extension" || m.setupType === "range_bounce"),
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

/**
 * Compare the edge set an engine actually resolved against the set the operator intended.
 *
 * Used by the post-deploy gate (scripts/verify-engine-ready.ts) as drift detection in BOTH
 * directions: an edge that armed itself without a decision, and an edge that was meant to be
 * trading but resolved off. Order-insensitive and duplicate-insensitive; returns null when they
 * agree, or a human-readable description of the difference when they do not.
 */
export function describeEdgeSetDrift(actual: readonly string[], expected: readonly string[]): string | null {
  const actualSet = new Set(actual);
  const expectedSet = new Set(expected);
  const unexpected = [...actualSet].filter((key) => !expectedSet.has(key)).sort();
  const missing = [...expectedSet].filter((key) => !actualSet.has(key)).sort();
  if (!unexpected.length && !missing.length) return null;
  const parts: string[] = [];
  if (unexpected.length) parts.push(`unexpectedly enabled: ${unexpected.join(", ")}`);
  if (missing.length) parts.push(`expected but disabled: ${missing.join(", ")}`);
  return parts.join("; ");
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
