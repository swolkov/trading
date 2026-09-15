// THE OPTIONS TRADE CARD (D5, Sep 15 2026) — pure, no I/O.
//
// Two things, both explanations rather than decisions:
//  1. `structureComparison` lays the researched families side by side (cost, max loss/gain, return on
//     risk, breakeven, net greeks, IV vs realized, payoff at the market's expected move, theta drag) and
//     says which one the prompt's long-vs-spread rule would pick — a single leg only when it costs no
//     more than 1.15× the best spread AND pays at least as much per dollar at the expected move. The
//     LIVE desk keeps choosing by the existing IV/RV family rule (PR #166); when the two disagree the
//     card says so under `disagreement` and the existing rule still wins. Stamp and measure.
//  2. `buildOptionsTradeCard` is the prompt's TOP-5 / LIVE TRADE OUTPUT in one record: every number the
//     desk knew at the moment of the decision, including the natural (openNetAsk) against the mark and
//     the fill it expects, the target, the invalidation level (the 20-session range edge the guardian
//     watches) and the 0–100 score labelled for what it is — a paper ranker, not a gate.
// Nothing here changes which trade the desk enters, its size, or any gate.
import { OPTIONS_DESK_RULES, type ResearchCandidate, type ResearchContract } from "./options-desk-model";
import { invalidationLevel } from "./options-live-guardian";
import { directionOfKind, type Direction } from "./options-market-state";
import type { OptionsGrade } from "./options-risk-ladder";

export const OPTIONS_CARD_RULES = {
  singleMaxCostMult: 1.15,   // a single leg may cost at most this × the best spread's cost to be preferred
  topN: 5,
};
export type StructureFamily = "single" | "spread";
export const familyOf = (kind: string): StructureFamily => (kind.startsWith("long_") ? "single" : "spread");
const r2 = (x: number) => Math.round(x * 100) / 100;
const r4 = (x: number) => Math.round(x * 10000) / 10000;
const fin = (x: unknown): x is number => typeof x === "number" && Number.isFinite(x);

export interface StructureRow {
  kind: string; family: StructureFamily; expiry: string; strikes: number[];
  cost: number;                    // planned loss incl. the fee reserve — what the desk risks
  maxLoss: number; maxGain: number | null;   // null = uncapped (a long call)
  returnOnRisk: number | null;     // maxGain ÷ maxLoss
  breakeven: number | null;
  netTheta: number | null; netDelta: number | null;
  iv: number | null; ivOverRv: number | null;
  payoffAtMove: number | null; thetaDrag: number | null;
  /** (payoff at the expected move − theta drag) ÷ cost: the screen's own ranking number. */
  payoffPerDollar: number | null;
}
export interface StructureComparison {
  rows: StructureRow[];
  bestSingle: StructureRow | null; bestSpread: StructureRow | null;
  /** The prompt's rule: single when cost ≤ 1.15× the best spread's AND payoff per dollar ≥ the spread's; else the spread. */
  chosen: { family: StructureFamily; kind: string | null; reason: string };
  /** The live desk's rule (IV ÷ realized ≤ 1.15 → single): the family the screen ranks first. */
  existingRule: { family: StructureFamily; kind: string | null; reason: string };
  /** Set when the two rules would pick differently. The existing rule still wins; this is measured, not acted on. */
  disagreement: string | null;
}
/** Breakeven at expiry for a debit structure: long strike ± the debit. */
export function breakevenOf(kind: string, longStrike: number, debit: number): number | null {
  if (!fin(longStrike) || !fin(debit)) return null;
  return r2(kind.startsWith("call") || kind === "long_call" ? longStrike + debit : longStrike - debit);
}
function legsOf(c: ResearchCandidate, contracts: ResearchContract[]): { long: ResearchContract | undefined; short: ResearchContract | undefined } {
  const by = new Map(contracts.map((k) => [k.id, k]));
  return { long: by.get(c.legs[0]), short: c.legs[1] ? by.get(c.legs[1]) : undefined };
}
export function structureRow(c: ResearchCandidate, contracts: ResearchContract[] = []): StructureRow {
  const { long, short } = legsOf(c, contracts);
  const debit = c.limit;
  const netTheta = long?.theta != null && (!short || short.theta != null) ? r4(long.theta - (short?.theta ?? 0)) : null;
  const netDelta = long?.delta != null && (!short || short.delta != null) ? r4(long.delta - (short?.delta ?? 0)) : null;
  const payoffPerDollar = c.payoffAtMoveUsd == null || !(c.plannedLoss > 0) ? null : r4((c.payoffAtMoveUsd - (c.thetaDragUsd ?? 0)) / c.plannedLoss);
  return {
    kind: c.kind, family: familyOf(c.kind), expiry: c.expiry, strikes: [...c.strikes],
    cost: c.plannedLoss, maxLoss: c.plannedLoss, maxGain: c.maxProfit,
    returnOnRisk: c.maxProfit == null || !(c.plannedLoss > 0) ? null : r2(c.maxProfit / c.plannedLoss),
    breakeven: breakevenOf(c.kind, c.strikes[0], debit),
    netTheta, netDelta, iv: c.atmIv, ivOverRv: c.ivToRealized,
    payoffAtMove: c.payoffAtMoveUsd, thetaDrag: c.thetaDragUsd, payoffPerDollar,
  };
}
/** Side-by-side comparison of the researched families for ONE symbol; `candidates` are the screen's rows for that name (screen order). */
export function structureComparison(candidates: ResearchCandidate[], contracts: ResearchContract[] = [], rules = OPTIONS_CARD_RULES): StructureComparison {
  const rows = candidates.map((c) => structureRow(c, contracts));
  const best = (family: StructureFamily) => rows.filter((r) => r.family === family && r.payoffPerDollar != null).sort((a, b) => b.payoffPerDollar! - a.payoffPerDollar! || a.cost - b.cost)[0] ?? null;
  const bestSingle = best("single"), bestSpread = best("spread");
  const none = { family: "spread" as StructureFamily, kind: null, reason: "no structure with a payoff at the expected move" };
  let chosen: StructureComparison["chosen"];
  if (!bestSingle && !bestSpread) chosen = none;
  else if (!bestSpread) chosen = { family: "single", kind: bestSingle!.kind, reason: "no spread on file — the single leg by default" };
  else if (!bestSingle) chosen = { family: "spread", kind: bestSpread.kind, reason: "no single leg on file — the spread by default" };
  else {
    const costOk = bestSingle.cost <= rules.singleMaxCostMult * bestSpread.cost;
    const payOk = bestSingle.payoffPerDollar! >= bestSpread.payoffPerDollar!;
    const costLine = `single $${bestSingle.cost} vs spread $${bestSpread.cost} (limit ${rules.singleMaxCostMult}× = $${r2(rules.singleMaxCostMult * bestSpread.cost)})`;
    const payLine = `payoff per $ at the expected move ${bestSingle.payoffPerDollar} vs ${bestSpread.payoffPerDollar}`;
    chosen = costOk && payOk
      ? { family: "single", kind: bestSingle.kind, reason: `single leg: ${costLine}; ${payLine} — uncapped upside at no more than 15% extra cost` }
      : { family: "spread", kind: bestSpread.kind, reason: `spread: ${!costOk ? `the single costs more than ${rules.singleMaxCostMult}× the spread (${costLine})` : ""}${!costOk && !payOk ? "; " : ""}${!payOk ? `the spread pays more per dollar at the expected move (${payLine})` : ""}` };
  }
  // The live rule (PR #166): IV ÷ 20-day realized ≤ 1.15 → single leg, else (or unknown) spread. The screen sorts that family first
  // and takes its best row; with nothing in that family it falls through to the other, which the reason says.
  const first = rows.find((r) => r.payoffPerDollar != null) ?? rows[0] ?? null;
  const ivrv = first?.ivOverRv ?? null, limit = OPTIONS_DESK_RULES.singleLegMaxIvToRealized;
  const preferred: StructureFamily = ivrv != null && ivrv <= limit ? "single" : "spread";
  const taken = (preferred === "single" ? bestSingle : bestSpread) ?? first;
  const existingRule = taken
    ? { family: taken.family, kind: taken.kind, reason: `${ivrv == null ? "implied vs realized vol unavailable → spreads preferred" : `implied ÷ realized ${ivrv}× ${ivrv <= limit ? "≤" : ">"} ${limit} → ${preferred === "single" ? "single leg" : "spread"} preferred`}${taken.family === preferred ? "" : ` (none on file — the ${taken.family} is taken)`}` }
    : none;
  const disagreement = chosen.kind && existingRule.kind && chosen.family !== existingRule.family
    ? `the cost/payoff comparison would take the ${chosen.family} (${chosen.kind}); the live IV/RV rule takes the ${existingRule.family} (${existingRule.kind}) and wins — stamped for measurement`
    : null;
  return { rows, bestSingle, bestSpread, chosen, existingRule, disagreement };
}

export type CardSource = "research" | "entry" | "refusal";
export type CardAction = "RESEARCH" | "ENTER" | "REFUSED";
export interface TradeCardInput {
  source: CardSource; candidate: ResearchCandidate;
  /** The research snapshot's contracts, for the legs' greeks. */
  contracts?: ResearchContract[];
  /** Live re-pricing at the decision (absent on research cards): natural = openNetAsk, mark = net mid, expectedFill = the limit sent. */
  live?: { natural: number | null; mark: number | null; expectedFill: number | null } | null;
  quantity?: number; grade?: OptionsGrade | null; cap?: number | null; equity?: number | null;
  feeReserveUsd?: number;
  /** The 0–100 paper ranker's number for this structure. null before D7 scores it. */
  score?: number | null;
  action: CardAction; gate?: string | null;
  comparison?: StructureComparison | null;
  at?: string;
}
export interface OptionsTradeCard {
  at: string; source: CardSource; action: CardAction; gate: string | null;
  symbol: string; direction: Direction; structure: string; setup: string; expiry: string; dte: number; dteBucket: string; strikes: number[];
  natural: number | null; mark: number | null; expectedFill: number | null;
  contracts: number; debitUsd: number; maxLossUsd: number; maxGainUsd: number | null; breakeven: number | null;
  pctEquityAtRisk: number | null; riskReward: number | null; riskRewardAtMove: number | null;
  delta: number | null; theta: number | null; iv: number | null; ivOverRv: number | null;
  expectedMovePct: number | null; expectedMoveLevel: number | null;
  target: { level: number | null; basis: "short strike" | "expected move" };
  invalidation: { level: number | null; rangeLow: number; rangeHigh: number };
  expectedHoldDays: number; thetaDragUsd: number | null; chase: number | null; deltaBand: string;
  grade: OptionsGrade | null; cap: number | null;
  confidence: { score: number | null; label: "paper ranker" };
  earnings: { class: string; at: string | null }; exDivAt: string | null;
  market: ResearchCandidate["market"];
  comparison: StructureComparison | null;
  text: string;
}
/** DTE to the 20:00Z close, the guardian's convention. */
const dteAt = (expiry: string, atMs: number) => Math.round((Date.parse(`${expiry}T20:00:00Z`) - atMs) / 86_400_000 * 10) / 10;

export function buildOptionsTradeCard(input: TradeCardInput): OptionsTradeCard {
  const c = input.candidate, at = input.at ?? new Date().toISOString(), atMs = Date.parse(at);
  const direction = directionOfKind(c.kind), quantity = input.quantity ?? 1, fee = input.feeReserveUsd ?? c.feeReserve;
  const live = input.live ?? null;
  // Debit per contract: the fill the desk expects (its limit) when re-priced live, else the research limit.
  const debit = live?.expectedFill != null && live.expectedFill > 0 ? live.expectedFill : c.limit;
  const debitUsd = r2(debit * 100 * quantity), maxLossUsd = r2((debit * 100 + fee) * quantity);
  const width = c.strikes.length === 2 ? Math.abs(c.strikes[0] - c.strikes[1]) : 0;
  const maxGainUsd = c.legs.length === 2 ? r2((width - debit) * 100 * quantity - fee * quantity) : c.kind === "long_put" ? r2((c.strikes[0] - debit) * 100 * quantity - fee * quantity) : null;
  const emLevel = c.expectedMovePct == null ? null : r2(c.spot * (1 + (direction === "bullish" ? 1 : -1) * c.expectedMovePct / 100));
  const target: OptionsTradeCard["target"] = c.legs.length === 2 ? { level: c.strikes[1], basis: "short strike" } : { level: emLevel, basis: "expected move" };
  const row = structureRow(c, input.contracts ?? []);
  const equity = input.equity ?? null;
  const card: Omit<OptionsTradeCard, "text"> = {
    at, source: input.source, action: input.action, gate: input.gate ?? null,
    symbol: c.symbol, direction, structure: c.kind, setup: c.setup, expiry: c.expiry, dte: dteAt(c.expiry, atMs), dteBucket: c.dteBucket, strikes: [...c.strikes],
    natural: live?.natural ?? null, mark: live?.mark ?? null, expectedFill: live?.expectedFill ?? null,
    contracts: quantity, debitUsd, maxLossUsd, maxGainUsd, breakeven: breakevenOf(c.kind, c.strikes[0], debit),
    pctEquityAtRisk: equity != null && equity > 0 ? r2(maxLossUsd / equity * 100) : null,
    riskReward: maxGainUsd == null || !(maxLossUsd > 0) ? null : r2(maxGainUsd / maxLossUsd),
    riskRewardAtMove: c.payoffAtMoveUsd == null || !(c.plannedLoss > 0) ? null : r2(c.payoffAtMoveUsd / c.plannedLoss),
    delta: row.netDelta, theta: row.netTheta, iv: c.atmIv, ivOverRv: c.ivToRealized,
    expectedMovePct: c.expectedMovePct, expectedMoveLevel: emLevel, target,
    invalidation: { level: invalidationLevel(direction, c.rangeLow, c.rangeHigh), rangeLow: c.rangeLow, rangeHigh: c.rangeHigh },
    expectedHoldDays: c.expectedHoldDays, thetaDragUsd: c.thetaDragUsd, chase: c.chase, deltaBand: c.deltaBand,
    grade: input.grade ?? null, cap: input.cap ?? null,
    confidence: { score: input.score ?? null, label: "paper ranker" },
    earnings: { class: c.earningsClass, at: c.earningsAt }, exDivAt: c.exDivAt, market: c.market,
    comparison: input.comparison ?? null,
  };
  return { ...card, text: renderOptionsTradeCard(card) };
}
const n = (x: number | null | undefined, d = 2, unit = "") => (x == null ? "unknown" : `${x.toFixed(d)}${unit}`);
const usd = (x: number | null | undefined) => (x == null ? "unknown" : `$${x.toFixed(0)}`);
/** The card as text — the Slack entry page and the desk log carry this. */
export function renderOptionsTradeCard(c: Omit<OptionsTradeCard, "text">): string {
  const head = c.action === "ENTER" ? "ENTER" : c.action === "REFUSED" ? `REFUSED — ${c.gate ?? "gate unnamed"}` : "RESEARCH";
  const lines = [
    `${head} · ${c.symbol} ${c.direction} · ${c.structure.replaceAll("_", " ")} ${c.strikes.join("/")} exp ${c.expiry} (${c.dte.toFixed(1)} DTE, ${c.dteBucket})`,
    `price: natural ${n(c.natural)} · mark ${n(c.mark)} · expected fill ${n(c.expectedFill)} · ${c.contracts} contract${c.contracts === 1 ? "" : "s"} · debit ${usd(c.debitUsd)}`,
    `risk: max loss ${usd(c.maxLossUsd)} incl. fees${c.pctEquityAtRisk != null ? ` (${c.pctEquityAtRisk}% of equity)` : ""} · max gain ${c.maxGainUsd == null ? "uncapped" : usd(c.maxGainUsd)} · R:R ${c.riskReward == null ? "uncapped" : n(c.riskReward)} · payoff at the expected move ${c.riskRewardAtMove == null ? "unknown" : `${n(c.riskRewardAtMove)}× the risk`}`,
    `greeks: delta ${n(c.delta, 2)} · theta ${n(c.theta, 4)}/day · IV ${c.iv == null ? "unknown" : `${(c.iv * 100).toFixed(0)}%`} (${c.ivOverRv == null ? "IV/RV unknown" : `${c.ivOverRv}× realized`}) · theta over the hold ${usd(c.thetaDragUsd)}`,
    `levels: breakeven ${n(c.breakeven)} · expected move ±${n(c.expectedMovePct, 1, "%")} (${n(c.expectedMoveLevel)}) · target ${n(c.target.level)} (${c.target.basis}) · invalidation ${n(c.invalidation.level)} (range ${c.invalidation.rangeLow}–${c.invalidation.rangeHigh})`,
    `plan: hold ≤${c.expectedHoldDays}d · grade ${c.grade ?? "—"}${c.cap != null ? ` cap ${usd(c.cap)}` : ""} · score ${c.confidence.score ?? "—"} (${c.confidence.label}) · chase ${c.chase ?? "unknown"} · delta band ${c.deltaBand} · earnings ${c.earnings.class}${c.earnings.at ? ` ${c.earnings.at}` : ""} · ex-div ${c.exDivAt ?? "none"}`,
  ];
  if (c.comparison) {
    lines.push(`structure: ${c.comparison.existingRule.reason}${c.comparison.disagreement ? ` · ⚠ ${c.comparison.disagreement}` : ` · comparison agrees (${c.comparison.chosen.reason})`}`);
  }
  return lines.join("\n");
}
/** The top-N research cards, one per candidate in screen order (the screen already ranks). */
export function researchTradeCards(candidates: ResearchCandidate[], contracts: ResearchContract[], opts: { equity?: number | null; scores?: Map<string, number | null>; at?: string } = {}, rules = OPTIONS_CARD_RULES): OptionsTradeCard[] {
  const bySymbol = new Map<string, ResearchCandidate[]>();
  for (const c of candidates) bySymbol.set(c.symbol, [...(bySymbol.get(c.symbol) ?? []), c]);
  return candidates.slice(0, rules.topN).map((c) => buildOptionsTradeCard({
    source: "research", candidate: c, contracts, equity: opts.equity ?? null, action: "RESEARCH",
    score: opts.scores?.get(candidateKey(c)) ?? null, comparison: structureComparison(bySymbol.get(c.symbol) ?? [c], contracts), at: opts.at,
  }));
}
export const candidateKey = (c: { symbol: string; kind: string; expiry: string; strikes: number[] }) => `${c.symbol}:${c.kind}:${c.expiry}:${c.strikes.join("/")}`;
