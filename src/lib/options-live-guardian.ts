// THE OPTIONS GUARDIAN'S RULES — pure functions, no I/O, so every rule is a unit test. The runner
// (scripts/robinhood/live-desk.ts) feeds them broker facts and acts on the answers. Rules are
// deliberately few for the first live week: the point of Monday is a proven order path on one
// contract, not a strategy claim.
import type { StructureKind } from "./options-structures";
import type { LiveContract, OwnedOptionsPosition } from "./options-live-policy";
import { OPTIONS_LADDER_RULES, ddTier } from "./options-risk-ladder";

export const OPTIONS_LIVE_RULES = {
  premiumStopFrac: 0.5,     // close when the structure is worth half what we paid
  // No fixed target (Sep 14 2026, was 2×): a capped win is the one outcome that cannot ever be large.
  // Once the structure has been worth 1.5× entry, a trail replaces it — exit when the mark gives back
  // half of the best gain seen (entry + (peak − entry) × 0.5). A spread at its full width exits: nothing left to earn.
  trailArmMult: 1.5,
  trailLockFrac: 0.5,
  exitBeforeDte: 7,         // close inside the last week regardless (gamma/assignment window)
  staleEntryMinutes: 15,    // an unfilled entry is cancelled after this
  drawdownHaltUsd: 300,     // the halt's dollar floor: entries disarm at the larger of this and 20% under the high (options-risk-ladder.ts ddTier)
  maxEntriesPerDay: 1,      // open slots come from the ladder (slotsFor): one, a second after ten closed live trades with the divergence check green
  entryKinds: ["long_call", "long_put", "call_debit", "put_debit"] as StructureKind[],   // debit only: max loss = what we paid
};

/** What the guardian remembers about a structure it opened, beside the legs the policy needs. */
export interface OwnedPositionRecord extends OwnedOptionsPosition {
  kind: StructureKind; direction: "debit" | "credit"; entryPrice: number; width: number; openedAtMs: number; expiry: string; underlying: string;
  /** Best executable close net seen since entry — the trail's anchor. Absent on records written before the trail existed. */
  peakNet?: number;
  /** Next ex-dividend date (YYYY-MM-DD) and the short leg's strike, stamped at fill for the ex-dividend exit rule (Sep 15 2026). */
  exDivAt?: string | null;
  exDivSource?: "scheduled" | "projected";
  shortStrike?: number | null;
}

/** Executable net price to CLOSE a debit structure now: sell the long at its bid, buy the short back at its ask. */
export function closeNetBid(pos: OwnedPositionRecord, contracts: LiveContract[]): number | null {
  const by = new Map(contracts.map((c) => [c.optionId, c]));
  let net = 0;
  for (const leg of pos.legs) {
    const c = by.get(leg.optionId);
    if (!c) return null;
    net += leg.side === "long" ? c.bid : -c.ask;
  }
  return Math.floor(net * 100 + 1e-8) / 100;
}
export function dteOf(expiry: string, nowMs: number): number {
  return (Date.parse(`${expiry}T20:00:00Z`) - nowMs) / 86_400_000;
}
export interface ExitDecision { exit: boolean; reason: string; limitPrice: number | null; markNet: number | null; /** The peak the caller must persist on the owned record. */ peakNet?: number }
export function exitDecision(pos: OwnedPositionRecord, contracts: LiveContract[], nowMs: number, rules = OPTIONS_LIVE_RULES): ExitDecision {
  if (pos.direction !== "debit") return { exit: false, reason: "credit structures are not managed by this guardian version", limitPrice: null, markNet: null };
  const net = closeNetBid(pos, contracts);
  if (net == null) return { exit: false, reason: "quote missing for a leg", limitPrice: null, markNet: null };
  const dte = dteOf(pos.expiry, nowMs);
  const entry = pos.entryPrice, peak = Math.max(pos.peakNet ?? entry, net);
  const limit = net > 0 ? Math.min(net, pos.width > 0 ? pos.width : net) : null;
  if (net <= entry * rules.premiumStopFrac) return { exit: limit != null, reason: limit != null ? `premium stop: ${net.toFixed(2)} ≤ ${(entry * rules.premiumStopFrac).toFixed(2)}` : "expiring worthless, no bid", limitPrice: limit, markNet: net, peakNet: peak };
  if (pos.width > 0 && net >= pos.width) return { exit: true, reason: `max value: spread is worth its full ${pos.width.toFixed(2)} width`, limitPrice: limit, markNet: net, peakNet: peak };
  if (peak >= entry * rules.trailArmMult) {
    const floor = entry + (peak - entry) * rules.trailLockFrac;
    if (net <= floor) return { exit: true, reason: `trail: ${net.toFixed(2)} ≤ ${floor.toFixed(2)} after a peak of ${peak.toFixed(2)} (entry ${entry.toFixed(2)})`, limitPrice: limit, markNet: net, peakNet: peak };
  }
  if (dte <= rules.exitBeforeDte) return { exit: limit != null, reason: limit != null ? `time exit: ${dte.toFixed(1)} days to expiry` : "expiring worthless, no bid", limitPrice: limit, markNet: net, peakNet: peak };
  return { exit: false, reason: `holding: mark ${net.toFixed(2)} vs entry ${entry.toFixed(2)}, peak ${peak.toFixed(2)}${peak >= entry * rules.trailArmMult ? " (trail armed)" : ""}, ${dte.toFixed(1)} dte`, limitPrice: null, markNet: net, peakNet: peak };
}

/** Executable net price to OPEN a debit structure now: buy the long at its ask, sell the short at its bid. */
export function openNetAsk(legs: { optionId: string; side: "buy" | "sell" }[], contracts: LiveContract[]): number | null {
  const by = new Map(contracts.map((c) => [c.optionId, c]));
  let net = 0;
  for (const leg of legs) {
    const c = by.get(leg.optionId);
    if (!c) return null;
    net += leg.side === "buy" ? c.ask : -c.bid;
  }
  return Math.ceil(net * 100 - 1e-8) / 100;
}

/** Account drawdown halt: the desk disarms itself at tier 4 of the ladder — the larger of $300 and 20% under its high-water mark. */
export function drawdownHalt(totalValue: number, high: number, rules = OPTIONS_LIVE_RULES): { halt: boolean; newHigh: number } {
  const tier = ddTier(totalValue, high, { ...OPTIONS_LADDER_RULES, ddHaltFloorUsd: rules.drawdownHaltUsd });
  return { halt: tier.halt, newHigh: tier.newHigh };
}

/** The ET calendar day (YYYY-MM-DD) a timestamp falls on — entries per day are counted in ET. */
export function etDay(ms: number): string {
  const p = Object.fromEntries(new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(new Date(ms)).map((x) => [x.type, x.value]));
  return `${p.year}-${p.month}-${p.day}`;
}
