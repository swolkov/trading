// THE OPTIONS DESK BRIEF (D8, Sep 15 2026) — pure, no I/O.
//
// The prompt's LIVE TRADE OUTPUT as one text: ACCOUNT / MARKET / TOP 5 / BEST TRADE / ACTION / CONDITIONAL
// ORDERS. `ACTION` says ENTER NOW only when the best structure passes every live gate on STAMPED data —
// through the same functions the entry tick calls (spansEarnings, marketVeto, chaseCheck on the signal-day
// bar, clusterRisk, gradeFor/maxLossFor, reserveRefusal, ddTier, an open slot), never a re-implementation;
// what the tick alone can check (entries/day, the last-30-minutes rule, the intraday SPY shock, the broker's
// own earnings confirm, the slot count) is NAMED in the action line so ENTER NOW is honest about its limits.
// Credit spreads never reach the brief: every row passes `liveEnterableKinds` (debit only), as the tick's do.
// WAIT FOR TRIGGER when a Trend-watch name sits within 2% of its range edge or a breakout was refused
// for chasing; otherwise NO TRADE. The conditional line per watch name is the rule the tick executes.
import { OPTIONS_DESK_RULES, liveEnterableKinds, researchSignals, screenResearchContracts, type OptionsResearch, type ResearchCandidate, type StrategySignal } from "./options-desk-model";
import { OPTIONS_EVENT_RULES, spansEarnings } from "./options-events";
import { dteOf } from "./options-live-guardian";
import { OPTIONS_MARKET_RULES, chaseCheck, directionOfKind, marketState, marketVeto, type IndexState, type MarketStamp } from "./options-market-state";
import { OPTIONS_LADDER_RULES, clusterRisk, ddTier, gradeFor, maxLossFor, reserveRefusal, type ClusterLeg, type DrawdownTier } from "./options-risk-ladder";
import { optionsOpportunityScore, scoreInputsFor } from "./options-score";
import { buildOptionsTradeCard, candidateKey, structureComparison, type OptionsTradeCard } from "./options-trade-card";

export const OPTIONS_BRIEF_RULES = { triggerDistancePct: 2, topN: 5, sectionOrder: ["ACCOUNT", "MARKET", "TOP 5", "BEST TRADE", "ACTION", "CONDITIONAL ORDERS"] as const,
  /** What only the entry tick can check — named on every ENTER NOW. */
  tickOnlyChecks: "not checked here: entries today vs the daily limit, the last-30-minutes rule, the intraday SPY shock, the broker's live earnings date, the exact slot count" };
export type BriefAction = "ENTER NOW" | "WAIT FOR TRIGGER" | "NO TRADE";
export interface BriefGate { name: string; pass: boolean; note: string }
export interface WatchLine {
  symbol: string; direction: "bullish" | "bearish"; close: number; rangeLow: number; rangeHigh: number; distancePct: number; withinTrigger: boolean;
  structure: { kind: string; strikes: number[]; expiry: string; debit: number } | null; maxDebitUsd: number; earningsNote: string; line: string;
}
export interface OptionsBriefInput {
  at: string;
  account: { equity: number | null; buyingPower: number | null; atRiskUsd: number; accountAt: string | null; ddTier: DrawdownTier | null; armed: boolean; verified: boolean; cap: number };
  market: MarketStamp & { volRegime: string; catalystsToday: string[]; vetoOn: boolean };
  cards: OptionsTradeCard[]; best: OptionsTradeCard | null; bestNote: string; gates: BriefGate[];
  watch: WatchLine[]; chaseWait: string[];
  action: { action: BriefAction; reason: string };
}
export interface BriefContext {
  research: OptionsResearch | null; equity: number | null; buyingPower: number | null; accountAt: string | null;
  ceiling: number | null; feeReserveUsd: number; promoted: boolean; armed: boolean; verified: boolean; vetoOn: boolean;
  owned: (ClusterLeg & { atRiskUsd: number })[]; equityHigh: number | null; vix: number | null;
  ivRanks?: Record<string, number | null>; now: number;
  /** Open slots the desk would grant this tick (slotsFor); absent → the ladder's default. */
  slots?: number;
}
const r2 = (x: number) => Math.round(x * 100) / 100;
const usd = (x: number | null | undefined, d = 0) => (x == null ? "unknown" : `$${x.toFixed(d)}`);
export const volRegimeOf = (vix: number | null): string => (vix == null ? "unknown (VIX unavailable)" : vix < 15 ? `low (VIX ${vix})` : vix < 20 ? `normal (VIX ${vix})` : vix < 30 ? `elevated (VIX ${vix})` : `high (VIX ${vix})`);

/** The action truth table. ENTER NOW needs a best structure passing every gate; WAIT FOR TRIGGER needs a watch name at its edge or a chase refusal. */
export function deriveOptionsAction(i: { best: boolean; gatesPass: boolean; watchNear: string[]; chaseWait: string[]; failed: string[] }): { action: BriefAction; reason: string } {
  if (i.best && i.gatesPass) return { action: "ENTER NOW", reason: `the best structure passes every stamped gate — ${OPTIONS_BRIEF_RULES.tickOnlyChecks}` };
  if (i.chaseWait.length) return { action: "WAIT FOR TRIGGER", reason: `${i.chaseWait.join(", ")} moved ≥${OPTIONS_MARKET_RULES.chaseMaxRatio}× the implied daily move — not chasing` };
  if (i.watchNear.length) return { action: "WAIT FOR TRIGGER", reason: `${i.watchNear.join(", ")} within ${OPTIONS_BRIEF_RULES.triggerDistancePct}% of the range edge — enter only on the close beyond it` };
  if (i.best) return { action: "NO TRADE", reason: `best structure refused: ${i.failed.join("; ") || "gate failed"}` };
  return { action: "NO TRADE", reason: "no 20-session breakout with a structure under the cap" };
}
/** Distance from the close to the edge the signal must clear (positive = still inside the range). */
export const edgeDistancePct = (s: Pick<StrategySignal, "direction" | "close" | "rangeLow" | "rangeHigh">): number =>
  r2(s.direction === "bullish" ? (s.rangeHigh / s.close - 1) * 100 : (1 - s.rangeLow / s.close) * 100);

/** Assembles the brief from a research snapshot and the desk's state. Pure: everything comes in through `ctx`. */
export function buildOptionsBrief(ctx: BriefContext): OptionsBriefInput {
  const at = new Date(ctx.now).toISOString();
  const data = ctx.research, equity = ctx.equity, ceiling = ctx.ceiling ?? 0;
  const tier = equity != null && ctx.equityHigh != null ? ddTier(equity, ctx.equityHigh) : null, mult = tier?.mult ?? 1;
  // The screen runs at the widest cap any grade could earn this tick — the entry tick's exact formula.
  const cap = r2(maxLossFor(ctx.promoted ? "A+" : "Strong", equity, ceiling) * mult);
  const stamp = marketState({ SPY: data?.bars.SPY, QQQ: data?.bars.QQQ }, ctx.vix, ctx.now);
  const today = at.slice(0, 10);
  const catalystsToday = Object.entries(data?.events ?? {}).flatMap(([s, e]) => [...(e.earningsAt === today ? [`${s} earnings${e.earningsTiming ? ` (${e.earningsTiming})` : ""}`] : []), ...(e.exDivAt === today ? [`${s} ex-dividend`] : [])]);
  const market = { spy: stamp.spy, qqq: stamp.qqq, vix: stamp.vix, volRegime: volRegimeOf(stamp.vix), catalystsToday, vetoOn: ctx.vetoOn };
  const atRiskUsd = r2(ctx.owned.reduce((s, o) => s + o.atRiskUsd, 0));
  const account = { equity, buyingPower: ctx.buyingPower, atRiskUsd, accountAt: ctx.accountAt, ddTier: tier, armed: ctx.armed, verified: ctx.verified, cap };
  const empty = (bestNote: string): OptionsBriefInput => ({ at, account, market, cards: [], best: null, bestNote, gates: [], watch: [], chaseWait: [], action: deriveOptionsAction({ best: false, gatesPass: false, watchNear: [], chaseWait: [], failed: [] }) });
  if (!data) return empty("no broker research on file");
  if (!(cap > 0) || ctx.buyingPower == null || !(ctx.buyingPower > 0)) return empty(`no cap (${cap}) or buying power (${ctx.buyingPower ?? "unknown"}) to screen against`);
  const all = liveEnterableKinds(screenResearchContracts(data, cap, ctx.buyingPower, ctx.now, { vix: ctx.vix, includeWatch: true }));
  const scoreOf = (c: ResearchCandidate) => optionsOpportunityScore(scoreInputsFor(c, data.contracts, ctx.ivRanks?.[c.symbol] ?? null)).score;
  const scores = new Map(all.map((c) => [candidateKey(c), scoreOf(c)]));
  const breakouts = all.filter((c) => !c.refusedBy), watchRows = all.filter((c) => c.refusedBy === "no breakout");
  const bySymbol = (c: ResearchCandidate) => breakouts.filter((x) => x.symbol === c.symbol);
  const cardOf = (c: ResearchCandidate) => buildOptionsTradeCard({ source: "research", candidate: c, contracts: data.contracts, equity, feeReserveUsd: ctx.feeReserveUsd, score: scores.get(candidateKey(c)) ?? null, action: "RESEARCH", comparison: structureComparison(bySymbol(c), data.contracts), at });
  // TOP 5 by score (the ranker's view); BEST = what the tick would take: the first of the screen's top three passing every stamped gate.
  const cards = [...breakouts].sort((a, b) => (scores.get(candidateKey(b)) ?? 0) - (scores.get(candidateKey(a)) ?? 0)).slice(0, OPTIONS_BRIEF_RULES.topN).map(cardOf);
  const ownedLegs: ClusterLeg[] = ctx.owned.map((o) => ({ symbol: o.symbol, kind: o.kind }));
  const gatesFor = (c: ResearchCandidate): BriefGate[] => {
    const direction = directionOfKind(c.kind), earnings = spansEarnings(c.symbol, c.expiry, data.events, ctx.now), veto = marketVeto(stamp, direction, c.symbol);
    const cluster = clusterRisk(ownedLegs, { symbol: c.symbol, kind: c.kind }), grade = gradeFor(c, ctx.promoted), gradeCap = r2(maxLossFor(grade.grade, equity, ceiling) * mult);
    const reserve = reserveRefusal(atRiskUsd, c.plannedLoss, equity), dte = dteOf(c.expiry, ctx.now);
    // The tick's own chaseCheck on the signal-day bar (close vs the prior close, timestamped now so it is not "stale"); the tick re-runs it on a live quote.
    const rows = data.bars[c.symbol] ?? [], prev = rows.at(-2)?.close;
    const chase = chaseCheck(prev != null && prev > 0 ? { last: c.spot, previousClose: prev, atMs: ctx.now } : null, c.atmIv, c.symbol, ctx.now);
    const slots = ctx.slots ?? OPTIONS_LADDER_RULES.defaultSlots;
    return [
      { name: "armed", pass: ctx.armed && ctx.verified, note: ctx.armed ? (ctx.verified ? "armed and verified" : "armed, adapter unverified") : "desk disarmed" },
      { name: "drawdown tier", pass: mult > 0, note: tier ? `${tier.label} ×${tier.mult}` : "no account value on file — tier unknown, sizing ×1" },
      { name: "slot", pass: ctx.owned.length < slots, note: ctx.owned.length < slots ? `${ctx.owned.length} of ${slots} slots used` : `${ctx.owned.length} of ${slots} slots used — WAIT, the tick's slot count (slotsFor) decides` },
      { name: "earnings", pass: earnings.permitted, note: earnings.note },
      { name: "market veto", pass: !ctx.vetoOn || !veto.vetoed, note: ctx.vetoOn ? veto.reason : "veto switched off" },
      { name: "chase", pass: !chase.vetoed, note: `${chase.reason} (signal-day bar; re-checked live at the tick)` },
      { name: "cluster", pass: !cluster.refused, note: cluster.reason ?? `no ${direction} bet in the same cluster` },
      { name: "ladder cap", pass: c.plannedLoss <= gradeCap, note: `${grade.grade} cap ${usd(gradeCap, 2)} vs ${usd(c.plannedLoss, 2)} planned loss (${grade.reasons[0]})` },
      { name: "reserve", pass: reserve == null, note: reserve ?? `${usd(atRiskUsd)} at risk + ${usd(c.plannedLoss)} inside 25% of ${usd(equity)}` },
      { name: "expiry window", pass: dte >= OPTIONS_DESK_RULES.minDte && dte <= OPTIONS_DESK_RULES.maxDte, note: `${dte.toFixed(1)} DTE` },
    ];
  };
  const chaseWait = [...new Set(breakouts.filter((c) => c.chase != null && c.chase >= OPTIONS_MARKET_RULES.chaseMaxRatio).map((c) => c.symbol))];
  let best: OptionsTradeCard | null = null, gates: BriefGate[] = [], bestNote = "no 20-session breakout with a structure under the cap";
  for (const c of breakouts.slice(0, 3)) { const g = gatesFor(c); if (g.every((x) => x.pass)) { best = cardOf(c); gates = g; bestNote = "passes every stamped gate — the tick re-checks the intraday SPY shock and the broker's earnings date live"; break; } }
  if (!best && breakouts.length) { best = cardOf(breakouts[0]); gates = gatesFor(breakouts[0]); bestNote = `the screen's first choice; refused by ${gates.filter((g) => !g.pass).map((g) => g.name).join(", ")}`; }
  // Conditional orders: every Trend-watch name, with the structure the screen would build for it at the Normal cap.
  const normalCap = r2(maxLossFor("Normal", equity, ceiling) * mult);
  const watch: WatchLine[] = researchSignals(data.bars, ctx.now).filter((s) => s.setup === "Trend watch" && s.direction !== "neutral").map((s) => {
    const direction = s.direction as "bullish" | "bearish", top = watchRows.find((c) => c.symbol === s.symbol && c.plannedLoss <= normalCap) ?? watchRows.find((c) => c.symbol === s.symbol) ?? null;
    const distancePct = edgeDistancePct(s), withinTrigger = distancePct >= 0 && distancePct <= OPTIONS_BRIEF_RULES.triggerDistancePct;
    const earnings = top ? spansEarnings(s.symbol, top.expiry, data.events, ctx.now) : null;
    const earningsNote = earnings ? earnings.note : OPTIONS_EVENT_RULES.indexEtfs.includes(s.symbol) ? "index ETF — no earnings" : "no structure on file to check earnings against";
    const structure = top ? { kind: top.kind, strikes: [...top.strikes], expiry: top.expiry, debit: top.limit } : null;
    const line = structure
      ? `enter ${structure.kind.replaceAll("_", " ")} ${structure.strikes.join("/")} ${structure.expiry} only if ${s.symbol} closes ${direction === "bullish" ? "above" : "below"} ${direction === "bullish" ? s.rangeHigh : s.rangeLow} with SPY/QQQ constructive and no earnings before ${structure.expiry}; max loss incl. fee ${usd(normalCap, 2)}`
      : `no structure under the ${usd(normalCap)} cap on file for ${s.symbol} — nothing to enter on a close ${direction === "bullish" ? "above" : "below"} ${direction === "bullish" ? s.rangeHigh : s.rangeLow}`;
    return { symbol: s.symbol, direction, close: s.close, rangeLow: s.rangeLow, rangeHigh: s.rangeHigh, distancePct, withinTrigger, structure, maxDebitUsd: normalCap, earningsNote, line };
  }).sort((a, b) => a.distancePct - b.distancePct);
  const action = deriveOptionsAction({ best: !!best, gatesPass: gates.length > 0 && gates.every((g) => g.pass), watchNear: watch.filter((w) => w.withinTrigger).map((w) => w.symbol), chaseWait, failed: gates.filter((g) => !g.pass).map((g) => `${g.name}: ${g.note}`) });
  return { at, account, market, cards, best, bestNote, gates, watch, chaseWait, action };
}
const idx = (name: string, s: IndexState) => (s.regime === "unknown" ? `${name} unknown` : `${name} ${s.close} ${s.regime} its 20-day ${s.sma20}${s.sma50 != null ? ` (50-day ${s.sma50})` : ""}, ${s.dayPct != null && s.dayPct >= 0 ? "+" : ""}${s.dayPct}% on ${s.day}`);
/** The six sections, in order, as text. */
export function renderOptionsBrief(b: OptionsBriefInput): string {
  const a = b.account;
  const lines: string[] = [
    `OPTIONS DESK BRIEF — ${b.at.slice(0, 16).replace("T", " ")}Z`,
    "", "ACCOUNT",
    `equity ${usd(a.equity)}${a.accountAt ? ` (snapshot ${a.accountAt.slice(0, 16).replace("T", " ")}Z)` : " (no snapshot)"} · buying power ${usd(a.buyingPower)} · at risk ${usd(a.atRiskUsd)} · screen cap ${usd(a.cap)}${a.ddTier ? ` · ${a.ddTier.label} ×${a.ddTier.mult}` : ""} · ${a.armed ? (a.verified ? "ARMED" : "armed, adapter unverified") : "DISARMED"}`,
    "", "MARKET",
    `${idx("SPY", b.market.spy)} · ${idx("QQQ", b.market.qqq)} · vol ${b.market.volRegime} · catalysts today: ${b.market.catalystsToday.join(", ") || "none among researched names"} · veto ${b.market.vetoOn ? "on" : "off"}`,
    "", "TOP 5",
    ...(b.cards.length ? b.cards.map((c, i) => `${i + 1}. [${c.confidence.score ?? "—"}] ${c.text.split("\n")[0].replace(/^RESEARCH · /, "")} · max loss ${usd(c.maxLossUsd)} · payoff at the expected move ${c.riskRewardAtMove == null ? "unknown" : `${c.riskRewardAtMove}×`}`) : ["none — no breakout structure under the cap"]),
    "", "BEST TRADE",
    ...(b.best ? [b.bestNote, b.best.text.replace(/^RESEARCH · /, ""), ...b.gates.map((g) => `${g.pass ? "✓" : "✗"} ${g.name}: ${g.note}`)] : [b.bestNote]),
    "", "ACTION",
    `${b.action.action} — ${b.action.reason}`,
    "", "CONDITIONAL ORDERS",
    ...(b.watch.length ? b.watch.map((w) => `${w.symbol} ${w.direction} at ${w.close} (${w.distancePct}% from ${w.direction === "bullish" ? w.rangeHigh : w.rangeLow}${w.withinTrigger ? ", AT THE TRIGGER" : ""}): ${w.line}${w.structure ? ` · ${w.earningsNote}` : ""}`) : ["no Trend-watch names"]),
  ];
  return lines.join("\n");
}
