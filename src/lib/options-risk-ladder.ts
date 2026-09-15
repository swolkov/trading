// THE SIZE LADDER, DRAWDOWN TIERS, CLUSTER AND RESERVE RULES for the options live desk (Sep 15 2026).
// Pure functions, no I/O: the runner (scripts/robinhood/live-desk.ts) feeds them the account, the
// candidate and what is already owned, and hands the answer to the Codex-reviewed core as the policy
// it must enforce. Grades are RULE-BASED — "Strong" is a breakout with the market aligned, a tight
// market and a payoff at the expected move worth 1.5× the risk; "A+" stays locked until the 0–100
// score has proven it ranks (options_score_promoted="true"). Nothing here places an order.
import { groupOf } from "./options-paper-model";
import { directionOfKind, type Direction } from "./options-market-state";

export type OptionsGrade = "Normal" | "Strong" | "A+";
/** Max loss per trade by grade: the dollar floor for a small account, or the share of equity once it has grown. */
export const OPTIONS_LADDER: Record<OptionsGrade, { usd: number; pct: number }> = {
  Normal: { usd: 100, pct: 0.067 },
  Strong: { usd: 150, pct: 0.10 },
  "A+": { usd: 225, pct: 0.15 },
};
export const OPTIONS_LADDER_RULES = {
  strongSetups: ["20-session breakout", "20-session breakdown"],
  strongMaxSpreadPct: 5,          // the structure's widest leg, bid/ask as % of mid
  strongPayoffMult: 1.5,          // payoff at the market's expected move ≥ this × the planned loss
  aPlusMinScore: 80,
  ddTierPcts: [5, 10, 15, 20],    // drawdown from the high-water mark, in %: tier 1 / 2 / 3 / 4
  ddTierMults: [1, 1, 0.5, 0.25, 0],
  ddHaltFloorUsd: 300,            // the halt is never tighter than this many dollars under the high
  ddHaltPct: 0.20,
  reserveMaxFrac: 0.25,           // open max loss + the new trade's max loss ≤ this share of equity
  slotUnlockClosedTrades: 10,     // the second slot needs this many closed live trades with the divergence check green
  maxSlots: 2,
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
  const labels = ["normal", "caution: 5% under the high", "half size: 10% under the high", "quarter size: 15% under the high", "halted: 20% (or $300) under the high"];
  return { tier, mult: rules.ddTierMults[tier], label: labels[tier], ddPct: round2(ddPct), ddUsd: round2(ddUsd), halt, haltAtUsd: round2(haltAtUsd), newHigh };
}

export type OptionsCluster = "ai-datacenter" | "semis" | "megacap" | "fintech" | "consumer" | "index" | "speculative" | "crypto-proxy";
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
/** One slot; a second after ten closed live trades with the divergence check green. Never more than two. */
export function slotsFor(closedLiveTrades: number, divergenceGreen: boolean, rules = OPTIONS_LADDER_RULES): number {
  return Math.min(rules.maxSlots, 1 + (closedLiveTrades >= rules.slotUnlockClosedTrades && divergenceGreen ? 1 : 0));
}
