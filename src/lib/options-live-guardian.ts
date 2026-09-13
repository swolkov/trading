// THE OPTIONS GUARDIAN'S RULES — pure functions, no I/O, so every rule is a unit test. The runner
// (scripts/robinhood/live-desk.ts) feeds them broker facts and acts on the answers. Rules are
// deliberately few for the first live week: the point of Monday is a proven order path on one
// contract, not a strategy claim.
import type { StructureKind } from "./options-structures";
import type { LiveContract, OwnedOptionsPosition } from "./options-live-policy";

export const OPTIONS_LIVE_RULES = {
  premiumStopFrac: 0.5,     // close when the structure is worth half what we paid
  premiumTargetMult: 2.0,   // close when it is worth double
  exitBeforeDte: 7,         // close inside the last week regardless (gamma/assignment window)
  staleEntryMinutes: 15,    // an unfilled entry is cancelled after this
  drawdownHaltUsd: 300,     // account value this far under its high → disarm entries (20% of $1,500)
  maxEntriesPerDay: 1,
  maxOpenPositions: 1,
  entryKinds: ["long_call", "long_put", "call_debit", "put_debit"] as StructureKind[],   // debit only: max loss = what we paid
};

/** What the guardian remembers about a structure it opened, beside the legs the policy needs. */
export interface OwnedPositionRecord extends OwnedOptionsPosition {
  kind: StructureKind; direction: "debit" | "credit"; entryPrice: number; width: number; openedAtMs: number; expiry: string; underlying: string;
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
export interface ExitDecision { exit: boolean; reason: string; limitPrice: number | null; markNet: number | null }
export function exitDecision(pos: OwnedPositionRecord, contracts: LiveContract[], nowMs: number, rules = OPTIONS_LIVE_RULES): ExitDecision {
  if (pos.direction !== "debit") return { exit: false, reason: "credit structures are not managed by this guardian version", limitPrice: null, markNet: null };
  const net = closeNetBid(pos, contracts);
  if (net == null) return { exit: false, reason: "quote missing for a leg", limitPrice: null, markNet: null };
  const dte = dteOf(pos.expiry, nowMs);
  const limit = net > 0 ? Math.min(net, pos.width > 0 ? pos.width : net) : null;
  if (net <= pos.entryPrice * rules.premiumStopFrac) return { exit: limit != null, reason: limit != null ? `premium stop: ${net.toFixed(2)} ≤ ${(pos.entryPrice * rules.premiumStopFrac).toFixed(2)}` : "worthless: no bid to sell into, letting it expire", limitPrice: limit, markNet: net };
  if (net >= pos.entryPrice * rules.premiumTargetMult) return { exit: true, reason: `target: ${net.toFixed(2)} ≥ ${(pos.entryPrice * rules.premiumTargetMult).toFixed(2)}`, limitPrice: limit, markNet: net };
  if (dte <= rules.exitBeforeDte) return { exit: limit != null, reason: limit != null ? `time exit: ${dte.toFixed(1)} days to expiry` : "expiring worthless, no bid", limitPrice: limit, markNet: net };
  return { exit: false, reason: `holding: mark ${net.toFixed(2)} vs entry ${pos.entryPrice.toFixed(2)}, ${dte.toFixed(1)} dte`, limitPrice: null, markNet: net };
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

/** Account drawdown halt: the desk disarms itself when value falls this far under its high-water mark. */
export function drawdownHalt(totalValue: number, high: number, rules = OPTIONS_LIVE_RULES): { halt: boolean; newHigh: number } {
  const newHigh = Math.max(high, totalValue);
  return { halt: totalValue < newHigh - rules.drawdownHaltUsd, newHigh };
}

/** The ET calendar day (YYYY-MM-DD) a timestamp falls on — entries per day are counted in ET. */
export function etDay(ms: number): string {
  const p = Object.fromEntries(new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(new Date(ms)).map((x) => [x.type, x.value]));
  return `${p.year}-${p.month}-${p.day}`;
}
