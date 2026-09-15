// AFTER THE DECISION (D5, Sep 15 2026): the live desk's trade cards, the vault Decisions/ line and
// the card text for the Slack entry page. Everything here runs once the core has answered — it can
// fail without touching an order, and the caller `.catch`es it. Nothing here is read by the entry gate.
import type { OptionsResearch, ResearchCandidate } from "../../src/lib/options-desk-model";
import { buildOptionsTradeCard, structureComparison, type OptionsTradeCard } from "../../src/lib/options-trade-card";
import { saveOptionsTradeCards } from "../../src/lib/options-trade-card-store";
import type { OptionsGrade } from "../../src/lib/options-risk-ladder";
import { optionsOpportunityScore, scoreInputsFor } from "../../src/lib/options-score";
import { etDay } from "../../src/lib/options-live-guardian";
import { logDecision } from "../../src/lib/vault";

export interface LivePricing { natural: number | null; mark: number | null; expectedFill: number | null }
export interface RefusedCandidate { candidate: ResearchCandidate; gate: string }
export interface EntryDecisionInput {
  data: OptionsResearch | null;
  /** The structure the desk chose (null when every candidate was refused). */
  chosen: { candidate: ResearchCandidate; live: LivePricing; quantity: number; grade: OptionsGrade; cap: number } | null;
  /** The core's answer for the chosen structure: accepted = ENTER; anything else is a refusal carrying the reason. */
  result: { status: string; reason?: string } | null;
  refused: RefusedCandidate[];
  equity: number | null; feeReserveUsd: number;
  /** The 0–100 paper ranker for a candidate. Default: scored here from the snapshot's contracts (IV-rank listed as missing — the tick reads no archive). Stamp only, after the decision. */
  scoreOf?: (c: ResearchCandidate) => number | null;
  at?: string;
}
/** Builds the tick's cards (pure). The chosen structure's card is first when there is one. */
export function entryTickCards(input: EntryDecisionInput): OptionsTradeCard[] {
  const contracts = input.data?.contracts ?? [];
  const at = input.at ?? new Date().toISOString();
  const scoreOf = input.scoreOf ?? ((c: ResearchCandidate) => optionsOpportunityScore(scoreInputsFor(c, contracts, null)).score);
  const siblings = (c: ResearchCandidate) => [c, ...input.refused.map((r) => r.candidate).filter((r) => r.symbol === c.symbol && r !== c)];
  const cards: OptionsTradeCard[] = [];
  if (input.chosen) {
    const { candidate, live, quantity, grade, cap } = input.chosen;
    const accepted = input.result?.status === "accepted";
    cards.push(buildOptionsTradeCard({ source: accepted ? "entry" : "refusal", candidate, contracts, live, quantity, grade, cap, equity: input.equity, feeReserveUsd: input.feeReserveUsd,
      score: scoreOf(candidate), action: accepted ? "ENTER" : "REFUSED", gate: accepted ? null : `core ${input.result?.status ?? "no answer"}: ${input.result?.reason ?? "no reason"}`,
      comparison: structureComparison(siblings(candidate), contracts), at }));
  }
  for (const r of input.refused) {
    cards.push(buildOptionsTradeCard({ source: "refusal", candidate: r.candidate, contracts, equity: input.equity, feeReserveUsd: input.feeReserveUsd,
      score: scoreOf(r.candidate), action: "REFUSED", gate: r.gate, comparison: structureComparison(siblings(r.candidate), contracts), at }));
  }
  return cards;
}
/** The card builder that can never reach the runner: a throw inside it is logged and yields no cards, so the candidate stash, the fill
 *  page and the state write after it are untouched. */
export function safeEntryTickCards(input: EntryDecisionInput, log: (s: string) => void): OptionsTradeCard[] {
  try { return entryTickCards(input); }
  catch (e) { log(`trade cards: not built — ${String(e).slice(0, 160)}`); return []; }
}
/** SKIP lines already written to Decisions/ this process: one per symbol per ET day (an ENTRY always writes). */
const skipsWritten = new Set<string>();
export function skipAlreadyLogged(symbol: string, nowMs: number, seen = skipsWritten): boolean {
  const key = `${etDay(nowMs)}:${symbol}`;
  if (seen.has(key)) return true;
  seen.add(key);
  return false;
}
/** Persists the cards and writes the Decisions/ line. Each write is independent and swallowed into the log; the caller `.catch`es the rest. */
export async function persistEntryDecision(cards: OptionsTradeCard[], log: (s: string) => void, nowMs = Date.now()): Promise<void> {
  await saveOptionsTradeCards(cards)
    .then((n) => { if (n) log(`trade cards: ${n} written (${cards.map((c) => `${c.symbol} ${c.action}`).join(", ")})`); })
    .catch((e) => log(`trade cards: not written — ${String(e).slice(0, 160)}`));
  const first = cards[0];
  if (!first) return;
  if (first.action !== "ENTER" && skipAlreadyLogged(first.symbol, nowMs)) return;   // one SKIP per symbol per day, not one per refused tick
  const rationale = `${first.text.split("\n")[0]}${cards.length > 1 ? ` · ${cards.length - 1} other structure${cards.length === 2 ? "" : "s"} refused` : ""}`;
  await logDecision("options-desk", first.action === "ENTER" ? "ENTRY" : "SKIP", `OPT:${first.symbol}`, rationale, first.confidence.score ?? 0)
    .catch((e) => log(`decision log: not written — ${String(e).slice(0, 160)}`));
}
