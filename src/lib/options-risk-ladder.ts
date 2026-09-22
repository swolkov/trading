// THE SIZE LADDER, DRAWDOWN TIERS, CLUSTER AND RESERVE RULES for the options live desk (Sep 15 2026).
// Pure functions, no I/O: the runner (scripts/robinhood/live-desk.ts) feeds them the account, the
// candidate and what is already owned, and hands the answer to the Codex-reviewed core as the policy
// it must enforce. Grades are RULE-BASED — "Strong" is a breakout with the market aligned, a tight
// market and a payoff at the expected move worth 1.5× the risk; "A+" stays locked until the 0–100
// score has proven it ranks (options_score_promoted="true"). Nothing here places an order.
import { groupOf } from "./options-model";
import { OPTIONS_LIVE_HARD_LIMITS } from "./options-live-policy";
import { directionOfKind, type Direction } from "./options-market-state";

export type OptionsGrade = "Normal" | "Strong" | "A+";
/** Max loss per trade by grade: the dollar floor for a small account, or the share of equity once it has grown. */
// SIZE (Sep 22 2026, Spencer's call): raised one rung. At $1,500 the dollar floors and the percentages
// agree, so these ARE the caps today — Normal $150, Strong $225, A+ $300. The reserve below is what
// stops three of them being open at once; the drawdown halt is what stops a bad week.
export const OPTIONS_LADDER: Record<OptionsGrade, { usd: number; pct: number }> = {
  Normal: { usd: 150, pct: 0.10 },
  Strong: { usd: 225, pct: 0.15 },
  "A+": { usd: 300, pct: 0.20 },
};
export const OPTIONS_LADDER_RULES = {
  strongSetups: ["20-session breakout", "20-session breakdown"],
  strongMaxSpreadPct: 5,          // the structure's widest leg, bid/ask as % of mid
  strongPayoffMult: 1.5,          // payoff at the market's expected move ≥ this × the planned loss
  aPlusMinScore: 80,
  ddTierPcts: [5, 10, 15, 20],    // drawdown from the high-water mark, in %: tier 1 / 2 / 3 / 4
  ddTierMults: [1, 1, 0.5, 0.25, 0],
  ddHaltFloorUsd: 450,            // the halt is never tighter than this many dollars under the high (300 → 450 Sep 22 2026: at the bigger rungs $300 was two losers, which halted the desk on an ordinary week)
  ddHaltPct: 0.20,
  reserveMaxFrac: 0.35,           // open max loss + the new trade's max loss ≤ this share of equity (0.25 → 0.35 Sep 22 2026, so the bigger rungs still leave room for three names)
  // SLOTS (Sep 20 2026, Spencer's call): the desk takes every name that clears the screen, up to `defaultSlots`
  // at once (AgentConfig options_live_slots can lower or raise it, never past maxSlots). The reserve rule above
  // is the real ceiling — at $1,500 that is $375 at risk, i.e. three Normal trades or two Strong — and the
  // cluster rule keeps them from being one bet. The divergence check, once it has `slotUnlockClosedTrades`
  // closed live trades to read, throttles the desk back to one slot while it is red.
  slotUnlockClosedTrades: 10,
  defaultSlots: 3,
  maxSlots: 4,
};
const round2 = (x: number) => Math.round(x * 100) / 100;

export interface GradeCandidate {
  setup: string; kind: string; market: { aligned: boolean | null };
  spreadPct: number | null; payoffAtMoveUsd: number | null; plannedLoss: number; score?: number | null;
}
export interface GradeVerdict { grade: OptionsGrade; reasons: string[] }
/** Rule-based grade. `promoted` is the AgentConfig switch the score earns; without it (or without a score ≥80) A+ is capped at Strong. */
export function gradeFor(c: GradeCandidate, promoted: boolean, rules = OPTIONS_LADDER_RULES): GradeVerdict {
  const reasons: string[] = [];
  if (!rules.strongSetups.includes(c.setup)) reasons.push(`setup "${c.setup}" is not a breakout`);
  if (c.market.aligned !== true) reasons.push(c.market.aligned == null ? "market alignment unknown" : "market not aligned with the direction");
  if (c.spreadPct == null || !(c.spreadPct <= rules.strongMaxSpreadPct)) reasons.push(`spread ${c.spreadPct == null ? "unknown" : `${c.spreadPct}%`} > ${rules.strongMaxSpreadPct}%`);
  if (c.payoffAtMoveUsd == null || !(c.plannedLoss > 0) || c.payoffAtMoveUsd < rules.strongPayoffMult * c.plannedLoss) reasons.push(`payoff at the expected move ${c.payoffAtMoveUsd == null ? "unknown" : `$${c.payoffAtMoveUsd}`} < ${rules.strongPayoffMult}× the $${c.plannedLoss} risk`);
  if (reasons.length) return { grade: "Normal", reasons };
  if (promoted && typeof c.score === "number" && c.score >= rules.aPlusMinScore) return { grade: "A+", reasons: [`score ${c.score} ≥ ${rules.aPlusMinScore} with the score promoted`] };
  return { grade: "Strong", reasons: [promoted ? `score ${c.score ?? "missing"} < ${rules.aPlusMinScore}` : "A+ locked until the score is promoted"] };
}
/** Max loss for a grade at this equity: the larger of the dollar floor and the equity share, never above the armed ceiling. */
export function maxLossFor(grade: OptionsGrade, equity: number | null, ceiling = Number.POSITIVE_INFINITY): number {
  const rung = OPTIONS_LADDER[grade];
  const byEquity = equity != null && Number.isFinite(equity) && equity > 0 ? rung.pct * equity : 0;
  return round2(Math.min(ceiling, Math.max(rung.usd, byEquity)));
}

export interface DrawdownTier { tier: 0 | 1 | 2 | 3 | 4; mult: number; label: string; ddPct: number; ddUsd: number; halt: boolean; haltAtUsd: number; newHigh: number }
/** Where the account sits under its high-water mark. Sizing is scaled by `mult`; tier 4 (halt) is the larger of $300 and 20% of the high. */
export function ddTier(totalValue: number, high: number, rules = OPTIONS_LADDER_RULES): DrawdownTier {
  const newHigh = Math.max(high, totalValue);
  const ddUsd = Math.max(0, newHigh - totalValue), ddPct = newHigh > 0 ? ddUsd / newHigh * 100 : 0;
  const haltAtUsd = Math.max(rules.ddHaltFloorUsd, rules.ddHaltPct * newHigh);
  const halt = ddUsd >= haltAtUsd;
  let tier: 0 | 1 | 2 | 3 | 4 = halt ? 4 : 0;
  if (!halt) for (const [i, pct] of rules.ddTierPcts.entries()) if (ddPct >= pct) tier = Math.min(3, i + 1) as 1 | 2 | 3;
  const labels = ["normal", "caution: 5% under the high", "half size: 10% under the high", "quarter size: 15% under the high", `halted: ${OPTIONS_LADDER_RULES.ddHaltPct * 100}% (or $${OPTIONS_LADDER_RULES.ddHaltFloorUsd}) under the high`];
  return { tier, mult: rules.ddTierMults[tier], label: labels[tier], ddPct: round2(ddPct), ddUsd: round2(ddUsd), halt, haltAtUsd: round2(haltAtUsd), newHigh };
}

export type OptionsCluster = "ai-datacenter" | "semis" | "megacap" | "fintech" | "consumer" | "index" | "speculative" | "crypto-proxy" | "materials" | "energy";
/** Names the paper universe never carried, or carried under a different reading, grouped for the live desk. */
const LOCAL_CLUSTERS: Record<string, OptionsCluster> = {
  RIOT: "crypto-proxy", MARA: "crypto-proxy", COIN: "crypto-proxy", MSTR: "crypto-proxy",
  F: "consumer", RIVN: "consumer", AAL: "consumer", CCL: "consumer", NCLH: "consumer", T: "consumer", PFE: "consumer", WBD: "consumer", DKNG: "consumer",
  NFLX: "megacap", SOFI: "fintech",
};
/** A name outside both maps (a discovery name, say) is `speculative`: two unmapped names in the same direction are still one bet. */
export function clusterOf(symbol: string): OptionsCluster {
  return LOCAL_CLUSTERS[symbol] ?? groupOf(symbol) ?? "speculative";
}
export interface ClusterLeg { symbol: string; kind: string }
const TECH_BETA: OptionsCluster[] = ["semis", "megacap"];
const word = (d: Direction) => (d === "bullish" ? "call" : "put");
/** Same direction in the same cluster, or an index ETF beside any semis/megacap name in the same direction, is ONE bet — a second is refused. */
export function clusterRisk(owned: ClusterLeg[], candidate: ClusterLeg): { refused: boolean; reason: string | null } {
  const cDir = directionOfKind(candidate.kind), cCluster = clusterOf(candidate.symbol);
  for (const o of owned) {
    if (directionOfKind(o.kind) !== cDir) continue;
    const oCluster = clusterOf(o.symbol);
    const same = oCluster === cCluster;
    const techPair = (oCluster === "index" && TECH_BETA.includes(cCluster)) || (cCluster === "index" && TECH_BETA.includes(oCluster));
    if (same || techPair) return { refused: true, reason: `cluster: ${o.symbol} ${word(cDir)} + ${candidate.symbol} ${word(cDir)} would be one ${techPair ? "tech" : cCluster} bet — refused` };
  }
  return { refused: false, reason: null };
}

/** Everything at risk at once — open max loss plus the new trade's — stays inside a quarter of the account. */
export function reserveOk(totalAtRiskUsd: number, equity: number | null, rules = OPTIONS_LADDER_RULES): boolean {
  return equity != null && Number.isFinite(equity) && equity > 0 && totalAtRiskUsd <= rules.reserveMaxFrac * equity;
}
export function reserveRefusal(openMaxLossUsd: number, newMaxLossUsd: number, equity: number | null, rules = OPTIONS_LADDER_RULES): string | null {
  if (equity == null || !Number.isFinite(equity) || equity <= 0) return "reserve: account value unknown — cannot size against it";
  if (reserveOk(openMaxLossUsd + newMaxLossUsd, equity, rules)) return null;
  return `reserve: $${Math.round(openMaxLossUsd)} already at risk + $${Math.round(newMaxLossUsd)} would exceed ${rules.reserveMaxFrac * 100}% of $${Math.round(equity).toLocaleString("en-US")}`;
}
/** The wanted slot count (default 3, capped at maxSlots) — cut to one while the divergence check is red with enough closed trades to mean it. */
/** CONTRACTS PER STRUCTURE (Sep 21 2026). The count never sets the risk — the grade's cap does — it only decides how much of
 *  that cap a cheap structure may use. Until the desk has `slotUnlockClosedTrades` closed live trades with the divergence check
 *  green, a Normal trade is one contract and a Strong/A+ trade at most two (the first live weeks prove the order path, not size).
 *  Once earned, Normal may take two as well — always inside the cap, never past the core's hard limit (`OPTIONS_LIVE_HARD_LIMITS.maxQuantity`,
 *  two): the core refuses any policy above it, so the ladder is bound to that constant rather than allowed to drift past it. */
export const OPTIONS_CONTRACT_RULES = {
  maxContracts: OPTIONS_LIVE_HARD_LIMITS.maxQuantity,
  before: { Normal: 1, Strong: 2, "A+": 2 } as Record<OptionsGrade, number>,
  earned: { Normal: 2, Strong: 2, "A+": 2 } as Record<OptionsGrade, number>,
};
export function contractsFor(p: { grade: OptionsGrade; perContractUsd: number; capUsd: number; closedLiveTrades: number; divergenceGreen: boolean }, rules = OPTIONS_LADDER_RULES, cr = OPTIONS_CONTRACT_RULES): number {
  if (!(p.perContractUsd > 0) || !(p.capUsd >= p.perContractUsd)) return 0;
  const earned = p.closedLiveTrades >= rules.slotUnlockClosedTrades && p.divergenceGreen;
  const byGrade = Math.min(cr.maxContracts, (earned ? cr.earned : cr.before)[p.grade]);
  return Math.max(1, Math.min(byGrade, Math.floor(p.capUsd / p.perContractUsd + 1e-9)));
}
export function slotsFor(closedLiveTrades: number, divergenceGreen: boolean, wanted = OPTIONS_LADDER_RULES.defaultSlots, rules = OPTIONS_LADDER_RULES): number {
  const cap = Math.min(rules.maxSlots, Math.max(1, Number.isFinite(wanted) ? Math.round(wanted) : rules.defaultSlots));
  if (closedLiveTrades >= rules.slotUnlockClosedTrades && !divergenceGreen) return 1;
  return cap;
}
