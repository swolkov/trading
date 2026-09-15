// THE TRADE CARD (Sep 15 2026) — the prompt's EXACT LIVE TRADE OUTPUT, built once per entry
// decision from the numbers the executor has ALREADY computed, persisted whether the entry was
// sent, validated or refused, and announced (Slack margin_live + vault Decisions/) after the
// order is accepted.
//
// Three rules keep this off the money path:
//   1. buildTradeCard / renderTradeCard are PURE. They read nothing, decide nothing, and never
//      change a number the executor sizes with — the card DESCRIBES the order; it does not
//      shape it. The liquidation multiple, margin level and account-level distance here are
//      the same helpers the executor's gates already use (margin-live-risk.ts).
//   2. Every write (persistTradeCard, recordRefusal, announceTradeCard) is called AFTER
//      AddOrder and `.catch`ed by the caller. A failed write pages the operator through the
//      executor's own error handling; it never sits between a decision and the order, and it
//      never blocks one.
//   3. A refusal is a card too. The capacity ledger learned that a refusal living only in an
//      HTTP response is a rumour; this table is where "why did it not trade at 04:02?" is
//      answered with the size, margin level and liquidation distance it WOULD have had.
//
// Cost assumptions are stated, not hidden: fees are two taker sides at the paper model's
// 0.25% (pinned by test to margin-synthesis's MODEL_TAKER_FEE_PCT, the same constant
// margin-shadow's TAKER carries); financing is the paper model's per-coin 4h rollover across the
// container's whole horizon (the worst case — a trade that stops out early pays less);
// slippage is the replay's stop-fill assumption (scripts/backtest-portfolio.ts, SLIP default
// 0.007 — the number every risk-rung sweep was run with).
import { prisma } from "@/lib/db";
import { sendNotification } from "@/lib/notifications";
import { logDecision } from "@/lib/vault";
import { ensureMarginTables } from "@/lib/kraken-margin";
import { rollover4h } from "@/lib/margin-shadow";
import { LIQ_CUSHION, leverageThatFitsStop, projectedMarginLevel } from "@/lib/margin-live-risk";
import { liqBufferMultiple, setupGradeFor, type DdTier, type SetupGrade } from "@/lib/margin-risk-tiers";

/** One taker side, percent of notional — the paper model's exit fee (margin-shadow TAKER). */
export const CARD_FEE_PCT_SIDE = 0.25;
/** Stop-fill slippage, percent of notional — scripts/backtest-portfolio.ts `SLIP` default (0.007). */
export const EXPECTED_SLIP_PCT = 0.7;

export type TradeCardAction = "ENTER" | "VALIDATE" | "REFUSED";
export type CardRegime = "up" | "down" | "unknown";

export interface TradeCardInput {
  at?: string;
  symbol: string;
  side: "buy" | "sell";
  source: string;
  horizonH: number;                 // the container's time stop
  regime: CardRegime;               // BTC daily regime at decision time (the scan's readBtcRegime)
  entryPx: number;
  stopFrac: number;                 // the authorised 1R as a fraction of entry
  trailR: number;
  addAtR?: number | null;
  pairMaxLeverage: number;          // US-retail cap for the pair
  operatorMaxLeverage: number;      // the equity ladder ∧ kraken_margin_max_leverage
  leverage: number;                 // what the order carries
  notional: number;                 // 0 = refused before sizing
  equity: number;
  marginUsedNow: number;            // margin already posted by open positions
  grossNotionalNow: number;         // notional of open positions (for the account-level distance)
  conviction: string | null;
  score: number | null;             // the scan's conviction score today; B5's 0–100 opportunity score once stamped
  ddTier: DdTier;
  ddMult: number;
  eventMode: string;
  decayMult: number;
  action: TradeCardAction;
  reason?: string;
}

export interface TradeCard {
  at: string;
  symbol: string;
  side: "buy" | "sell";
  source: string;
  horizonH: number;
  regime: CardRegime;
  entryPx: number;
  stopPx: number;
  stopPct: number;
  trailRule: string;
  leveragePermitted: number;
  leverageUsed: number;
  notional: number;
  marginUsd: number;
  riskPct: number;                  // notional × stop ÷ equity — what the order ACTUALLY risks
  riskUsd: number;
  grade: SetupGrade;
  conviction: string | null;
  score: number | null;
  ddTier: DdTier;
  ddMult: number;
  eventMode: string;
  decayMult: number;
  liqPriceIsolated: number;
  liqDistIsolatedPct: number;
  liqMultipleVsStop: number;
  liqDistAccountPct: number | null; // (E − 0.4·M_after) ÷ G_after — null when nothing is sized
  marginLevelAfter: number | null;
  rr: null;                         // no fixed target on this desk (four TP variants lost)
  rrNote: string;
  expectedFeesUsd: number;
  expectedFinancingUsd: number;
  expectedSlippageUsd: number;
  action: TradeCardAction;
  reason?: string;
}

const fin = (n: number, d = 0) => (Number.isFinite(n) ? n : d);

/** Pure. Every field of the prompt's card from numbers the executor already holds. */
export function buildTradeCard(i: TradeCardInput): TradeCard {
  const stopFrac = fin(i.stopFrac);
  const leverage = Math.max(1, fin(i.leverage, 1));
  const notional = Math.max(0, fin(i.notional));
  const equity = fin(i.equity);
  const marginUsedNow = Math.max(0, fin(i.marginUsedNow));
  const grossNow = Math.max(0, fin(i.grossNotionalNow));
  const dir = i.side === "buy" ? 1 : -1;
  const stopPx = i.entryPx * (1 - dir * stopFrac);
  const trailRule = `breakeven at +1R, trail ${i.trailR}R` + (i.addAtR != null && i.addAtR > 0 ? `, add at +${i.addAtR}R` : "");
  const capBoth = Math.max(1, Math.min(fin(i.pairMaxLeverage, 1), fin(i.operatorMaxLeverage, 1)));
  const leveragePermitted = leverageThatFitsStop(stopFrac * 100, capBoth);
  const marginUsd = notional / leverage;
  const riskUsd = notional * stopFrac;
  const riskPct = equity > 0 ? (riskUsd / equity) * 100 : 0;
  const liqDistIsolated = LIQ_CUSHION / leverage;
  const marginAfter = marginUsedNow + marginUsd;
  const grossAfter = grossNow + notional;
  const liqDistAccountPct = notional > 0 && equity > 0 && grossAfter > 0 ? ((equity - 0.4 * marginAfter) / grossAfter) * 100 : null;
  const ml = projectedMarginLevel(equity, marginUsedNow, notional, leverage);
  const horizonH = Math.max(0, fin(i.horizonH));
  return {
    at: i.at ?? new Date().toISOString(),
    symbol: i.symbol,
    side: i.side,
    source: i.source,
    horizonH,
    regime: i.regime,
    entryPx: i.entryPx,
    stopPx,
    stopPct: stopFrac * 100,
    trailRule,
    leveragePermitted,
    leverageUsed: leverage,
    notional,
    marginUsd,
    riskPct,
    riskUsd,
    grade: setupGradeFor(i.conviction),
    conviction: i.conviction,
    score: i.score != null && Number.isFinite(i.score) ? i.score : null,
    ddTier: i.ddTier,
    ddMult: i.ddMult,
    eventMode: i.eventMode,
    decayMult: i.decayMult,
    liqPriceIsolated: i.entryPx * (1 - dir * liqDistIsolated),
    liqDistIsolatedPct: liqDistIsolated * 100,
    liqMultipleVsStop: liqBufferMultiple(stopFrac, leverage),
    liqDistAccountPct,
    marginLevelAfter: notional > 0 ? ml : null,
    rr: null,
    rrNote: `no fixed TP; ${i.trailR}R trail`,
    expectedFeesUsd: 2 * (CARD_FEE_PCT_SIDE / 100) * notional,
    expectedFinancingUsd: rollover4h(i.symbol) * Math.ceil(horizonH / 4) * notional,
    expectedSlippageUsd: (EXPECTED_SLIP_PCT / 100) * notional,
    action: i.action,
    ...(i.reason ? { reason: i.reason } : {}),
  };
}

const usd = (n: number | null) => (n == null || !Number.isFinite(n) ? "—" : `$${n.toFixed(n >= 1000 ? 0 : 2)}`);
const pctOf = (n: number | null, d = 2) => (n == null || !Number.isFinite(n) ? "—" : `${n.toFixed(d)}%`);
const px = (n: number) => (Number.isFinite(n) ? n.toFixed(n >= 100 ? 2 : 4) : "—");

/** A fixed-width Slack block carrying EVERY field, keyed by the card's own field names. */
export function renderTradeCard(c: TradeCard): string {
  const head = c.action === "ENTER" ? "🟢 LIVE ENTRY" : c.action === "VALIDATE" ? "🧪 VALIDATE-ONLY" : "⛔ REFUSED";
  const rows: [string, string][] = [
    ["at", c.at],
    ["symbol", `${c.symbol} ${c.side.toUpperCase()}`],
    ["side", c.side],
    ["source", c.source],
    ["horizonH", `${c.horizonH}h`],
    ["regime", c.regime],
    ["entryPx", px(c.entryPx)],
    ["stopPx", `${px(c.stopPx)} (stopPct ${pctOf(c.stopPct)})`],
    ["trailRule", c.trailRule],
    ["leveragePermitted", `${c.leveragePermitted}×`],
    ["leverageUsed", `${c.leverageUsed}×`],
    ["notional", usd(c.notional)],
    ["marginUsd", usd(c.marginUsd)],
    ["riskPct", `${pctOf(c.riskPct)} (riskUsd ${usd(c.riskUsd)})`],
    ["grade", `${c.grade} (conviction ${c.conviction ?? "unscored"})`],
    ["score", c.score == null ? "— (not yet scored)" : c.score.toFixed(0)],
    ["ddTier", `${String(c.ddTier)} (ddMult ×${c.ddMult})`],
    ["eventMode", `${c.eventMode}`],
    ["decayMult", `×${c.decayMult}`],
    ["liqPriceIsolated", `${px(c.liqPriceIsolated)} (liqDistIsolatedPct ${pctOf(c.liqDistIsolatedPct)}, liqMultipleVsStop ${Number.isFinite(c.liqMultipleVsStop) ? c.liqMultipleVsStop.toFixed(2) : "—"}×)`],
    ["liqDistAccountPct", pctOf(c.liqDistAccountPct, 1)],
    ["marginLevelAfter", c.marginLevelAfter == null ? "—" : `${c.marginLevelAfter.toFixed(0)}%`],
    ["rr", `${c.rr ?? "—"} (rrNote ${c.rrNote})`],
    ["expectedFeesUsd", usd(c.expectedFeesUsd)],
    ["expectedFinancingUsd", usd(c.expectedFinancingUsd)],
    ["expectedSlippageUsd", usd(c.expectedSlippageUsd)],
    ["action", c.action],
    ["reason", c.reason ?? "—"],
  ];
  const w = Math.max(...rows.map(([k]) => k.length));
  return `${head} — ${c.symbol} ${c.side.toUpperCase()} (${c.source})\n\`\`\`\n${rows.map(([k, v]) => `${k.padEnd(w)}  ${v}`).join("\n")}\n\`\`\``;
}

/** One line for the vault's Decisions/ log. */
export function tradeCardOneLiner(c: TradeCard): string {
  return `${c.action} ${c.symbol} ${c.side} (${c.source}, ${c.grade}) $${c.notional.toFixed(0)} at ${c.leverageUsed}× · stop ${c.stopPct.toFixed(2)}% · risk ${c.riskPct.toFixed(2)}% ($${c.riskUsd.toFixed(0)}) · liq ${c.liqMultipleVsStop.toFixed(2)}× stop / account ${c.liqDistAccountPct != null ? `${c.liqDistAccountPct.toFixed(1)}%` : "—"} · ML after ${c.marginLevelAfter != null ? `${c.marginLevelAfter.toFixed(0)}%` : "—"} · dd ${String(c.ddTier)} ×${c.ddMult} · event ${c.eventMode} · decay ×${c.decayMult}${c.reason ? ` · ${c.reason}` : ""}`;
}

// ---- I/O: every function below is called AFTER AddOrder and `.catch`ed by its caller. ----

/** Inserts the card; returns its id. Throws on a DB failure — the caller `.catch`es. */
export async function persistTradeCard(card: TradeCard, txid: string | null = null): Promise<number | null> {
  await ensureMarginTables();
  const rows = await prisma.$queryRawUnsafe<{ id: number }[]>(
    `INSERT INTO margin_trade_cards (at, symbol, side, source, action, reason, txid, card)
     VALUES ($1::timestamptz, $2, $3, $4, $5, $6, $7, $8::jsonb) RETURNING id`,
    card.at, card.symbol, card.side, card.source, card.action, card.reason ?? null, txid, JSON.stringify(card),
  );
  return rows[0]?.id ?? null;
}

/** A card-less refusal row: the entry never reached sizing, so there is no card to keep. */
export async function recordRefusal(symbol: string, side: string, source: string, reason: string): Promise<void> {
  await ensureMarginTables();
  await prisma.$executeRawUnsafe(
    `INSERT INTO margin_trade_cards (at, symbol, side, source, action, reason, txid, card) VALUES (now(), $1, $2, $3, 'REFUSED', $4, NULL, NULL)`,
    symbol, side, source, reason.slice(0, 400),
  );
}

/** Slack margin_live + vault Decisions/. Both best-effort; neither can throw out. */
export async function announceTradeCard(card: TradeCard, txid: string | null = null): Promise<void> {
  const type = card.action === "ENTER" ? "ENTRY" : card.action === "VALIDATE" ? "PAPER" : "SKIP";
  await sendNotification(`${renderTradeCard(card)}${txid ? `\ntxid ${txid}` : ""}`, "margin_live").catch(() => {});
  await logDecision("kraken-margin", type, card.symbol, tradeCardOneLiner(card), card.score ?? 0.5).catch(() => {});
}
