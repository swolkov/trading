// THE ANOMALY KILL SWITCH (Sep 15 2026) — the live book must look like what was authorised.
//
// Every other guard on this desk checks the account's NUMBERS (margin level, drawdown, loss
// cap). None checked that the position Kraken shows is the position the executor's trade card
// said it would open: the same leverage, the same size, a stop no worse than the one the
// guardian last ledgered. A position at 20× when the card said 9× — a hand-edited order, a
// venue quirk, a bug in the leverage fit — would sit there fully "protected" and pass every
// numeric gate while risking twice the cushion the stop was fitted to. And a position that is
// NOT in the ledger but has OUR stop beside it is a bot entry whose ledger write was lost: the
// guardian would neither manage it nor, before this, refrain from sweeping its only stop.
//
// The response to either is the same and deliberately blunt: page margin_urgent, write the
// finding to kraken_margin_anomaly, and let the executor refuse every NEW entry (STRICT read)
// until an operator has looked and cleared the key. Closes are never affected; the guardian
// keeps protecting. Pure module — the guardian supplies the book and the card.
import { LIVE_STOP_RATCHET_MIN_FRAC } from "@/lib/margin-live-risk";

export const ANOMALY_KEY = "kraken_margin_anomaly";
/** Notional may differ from the card by the entry chase and a partial fill; beyond this it is not the same trade. */
export const NOTIONAL_TOLERANCE = 0.10;

export interface BookForCard {
  txid: string;                 // the tranche's opening order txid
  leverage: number;             // Kraken's cost ÷ margin for the position
  notional: number;             // vol × entry price, as filled
  side: "long" | "short";
  restingStop: number | null;   // the best fixed stop of ours resting on the pair+side (null = none)
  ledgeredStop: number | null;  // the level the guardian last knew to be resting (managed.lastStopLevel)
  px: number;                   // current price, for the ratchet tolerance
}
export interface CardForCheck { leverageUsed: number; notional: number; side: "buy" | "sell" }

export interface BookCheck { ok: boolean; findings: string[] }

/**
 * Does the live tranche match its trade card? Leverage equal (Kraken reports cost ÷ margin,
 * rounded to the rung), notional within ±10% of the card's, side the card's, and the resting
 * stop no WORSE than the ledgered level by more than the ratchet tolerance (better is fine —
 * a stop only ever ratchets in the trade's favour; a stop that moved the other way was widened
 * by a hand or a bug, and "never widen a stop" is the one exit rule this desk has never broken).
 * A missing resting stop is NOT judged here — the naked-position guard owns that.
 */
export function bookMatchesCard(book: BookForCard, card: CardForCheck | null): BookCheck {
  const findings: string[] = [];
  if (card) {
    const lev = Math.round(book.leverage);
    if (Number.isFinite(book.leverage) && Number.isFinite(card.leverageUsed) && lev !== Math.round(card.leverageUsed)) {
      findings.push(`${book.txid}: leverage ${lev} vs authorised ${Math.round(card.leverageUsed)}`);
    }
    if (Number.isFinite(book.notional) && Number.isFinite(card.notional) && card.notional > 0 && Math.abs(book.notional - card.notional) > NOTIONAL_TOLERANCE * card.notional) {
      findings.push(`${book.txid}: notional $${book.notional.toFixed(0)} vs authorised $${card.notional.toFixed(0)} (±${(NOTIONAL_TOLERANCE * 100).toFixed(0)}%)`);
    }
    const cardSide = card.side === "buy" ? "long" : "short";
    if (book.side !== cardSide) findings.push(`${book.txid}: side ${book.side} vs authorised ${cardSide}`);
  }
  if (book.restingStop != null && book.ledgeredStop != null && book.restingStop > 0 && book.ledgeredStop > 0) {
    const tol = book.px > 0 ? book.px * LIVE_STOP_RATCHET_MIN_FRAC : 0;
    const worse = book.side === "long" ? book.restingStop < book.ledgeredStop - tol : book.restingStop > book.ledgeredStop + tol;
    if (worse) findings.push(`${book.txid}: resting stop ${book.restingStop} is WIDER than the ledgered ${book.ledgeredStop} (a stop only ratchets in the trade's favour)`);
  }
  return { ok: findings.length === 0, findings };
}

/**
 * A resting stop of ours beside a position that is NOT ours on the same pair+side, with no
 * position of ours there: a bot-shaped position the ledger does not know. Never swept as an
 * orphan; paged with the adopt instruction; the anomaly is set. `own` null = ownership was
 * unreadable this run — nothing can be judged, so nothing is flagged (the sweep is already
 * withheld in that state).
 */
export function unledgeredBesideOurStop(
  stop: { pair: string; side: string },
  positions: { ordertxid: string; id: string; pair: string; side: string }[],
  isOurs: ((p: { ordertxid: string; id: string }) => boolean) | null,
  samePair: (a: string, b: string) => boolean,
): { ordertxid: string; id: string }[] {
  if (!isOurs) return [];
  const closes = stop.side === "sell" ? "long" : "short";
  const onSide = positions.filter((p) => samePair(p.pair, stop.pair) && p.side === closes);
  if (!onSide.length || onSide.some((p) => isOurs(p))) return [];
  return onSide.map((p) => ({ ordertxid: p.ordertxid, id: p.id }));
}

/** Merge new findings into the stored anomaly value: one line each, de-duplicated, capped. */
export function mergeAnomaly(existing: string | null, findings: string[]): string {
  const lines = (existing ?? "").split("\n").map((l) => l.trim()).filter(Boolean);
  for (const f of findings) if (!lines.includes(f)) lines.push(f);
  return lines.slice(-20).join("\n");
}

/** The executor's read: any non-blank value refuses entries. */
export function anomalyActive(raw: string | null | undefined): boolean {
  return raw != null && raw.trim() !== "";
}
