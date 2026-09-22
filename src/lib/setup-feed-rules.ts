// THE SETUP FEED — pure rules (Sep 22 2026). The Pine study marks Spencer's own entry on 5-minute bars (opening
// range + VWAP set the side; the setup is the higher low / lower high of the pullback) and posts it here. It is
// INFORMATION for his read, never a signal to any executor: on 15 years of 1-minute data this exact rule is about
// break-even before costs and negative after (scripts/pullback-study.ts, 0 of 12 cells survive). So every setup is
// SCORED — what a plain 2R bracket on it did, and whether he took it and what he made — so his read on top of it is
// measured, not assumed. Pure; unit-tested.
import { INSTRUMENTS, etParts, type Bar, type RoomSymbol } from "@/lib/trading-room-rules";

export const SETUP_CONTRACTS = 20;           // his minimum
export const SETUP_FEE_RT = 2.06;            // measured on his account, Sep 18
const ROOT_TO_SYMBOL: Record<string, RoomSymbol> = { ES: "MES", MES: "MES", NQ: "MNQ", MNQ: "MNQ", GC: "MGC", MGC: "MGC" };

export interface Setup {
  id: string;             // symbol|side|bar — the chart's own 5-minute bar, so a retry is one setup
  symbol: RoomSymbol;
  side: 1 | -1;
  at: string;             // ISO, the 5-minute bar's OPEN (it closed 5 minutes later)
  price: number;          // that bar's close
  stop: number;
  orh: number | null;
  orl: number | null;
  vwap: number | null;
}
export type ParsedSetup = { ok: true; setup: Setup } | { ok: false; reason: string };

export function parseSetup(body: unknown): ParsedSetup {
  if (typeof body !== "object" || body === null) return { ok: false, reason: "not an object" };
  const b = body as Record<string, unknown>;
  if (b.room !== "trading" || b.kind !== "setup") return { ok: false, reason: "not a setup message" };
  const symbol = ROOT_TO_SYMBOL[String(b.symbol ?? "").toUpperCase().replace(/[^A-Z]/g, "")];
  if (!symbol) return { ok: false, reason: `symbol '${String(b.symbol ?? "")}' is not one of ES/NQ/GC or their micros` };
  const side = b.side === "long" ? 1 : b.side === "short" ? -1 : 0;
  if (!side) return { ok: false, reason: "side must be long or short" };
  const num = (x: unknown): number | null => { const n = typeof x === "number" ? x : typeof x === "string" && x.trim() !== "" ? Number(x) : NaN; return Number.isFinite(n) ? n : null; };
  const price = num(b.price), stop = num(b.stop), bar = num(b.bar);
  if (price == null || price <= 0 || stop == null || stop <= 0) return { ok: false, reason: "price/stop missing" };
  if ((price - stop) * side <= 0) return { ok: false, reason: "stop is not on the loss side" };
  if (bar == null || bar < 1e12) return { ok: false, reason: "bar time missing" };
  const at = new Date(bar).toISOString();
  return { ok: true, setup: { id: `${symbol}|${side === 1 ? "L" : "S"}|${at}`, symbol, side: side as 1 | -1, at, price, stop, orh: num(b.orh), orl: num(b.orl), vwap: num(b.vwap) } };
}

const f = (s: RoomSymbol, x: number) => x.toFixed(s === "MGC" ? 1 : 2);
const usd = (x: number) => `$${Math.abs(Math.round(x)).toLocaleString("en-US")}`;

/** Fees + 1 tick of slippage each way, as a share of the stop per contract. */
export function setupCostShare(symbol: RoomSymbol, riskPts: number): number {
  const spec = INSTRUMENTS[symbol];
  return (SETUP_FEE_RT + 2 * spec.tick * spec.pointValue) / (riskPts * spec.pointValue);
}

export function setupText(s: Setup): string {
  const spec = INSTRUMENTS[s.symbol];
  const riskPts = (s.price - s.stop) * s.side;
  const riskUsd = riskPts * spec.pointValue * SETUP_CONTRACTS;
  const r2 = s.price + 2 * s.side * riskPts;
  const cs = setupCostShare(s.symbol, riskPts);
  const what = s.side === 1 ? "higher low above VWAP after an opening-range break" : "lower high below VWAP after an opening-range break";
  return [
    `🔎 ${s.symbol} ${what} · ${etParts(Date.parse(s.at) + 5 * 60_000).hhmm} ET close ${f(s.symbol, s.price)}`,
    `   stop ${f(s.symbol, s.stop)} (${riskPts.toFixed(2)} pts) → ${SETUP_CONTRACTS} ${s.symbol} risk ${usd(riskUsd)} · +2R ${f(s.symbol, r2)}${cs >= 0.2 ? ` · fees+slip ${Math.round(cs * 100)}% of the stop` : ""}`,
    `   Your read, not a call — this setup alone was break-even before costs over 15 yrs. Every one is scored.`,
  ].join("\n");
}

export interface Outcome { status: "open" | "done" | "no-data"; r?: number; usd?: number; how?: "target" | "stop" | "flat"; exitAt?: string }

/**
 * What a plain 2R bracket did on this setup, on 1-minute bars: enter at the open of the first minute after the
 * 5-minute bar closed (1 tick worse), stop 1 tick worse, target only if traded THROUGH, a bar touching both is the
 * stop, flat 5 minutes before the session ends. 20 contracts, $2.06 each round trip. "open" = not decided yet.
 */
export function resolveOutcome(s: Setup, bars: Bar[], nowMs: number): Outcome {
  const spec = INSTRUMENTS[s.symbol];
  const closeMs = Date.parse(s.at) + 5 * 60_000;
  const dayKey = etParts(closeMs).dayKey;
  const flatH = spec.rthClose - 5 / 60;
  const after = bars.filter((b) => b.t >= closeMs).sort((a, b) => a.t - b.t);
  const entryBar = after[0];
  if (!entryBar || entryBar.t - closeMs > 10 * 60_000) return nowMs - closeMs > 3 * 3_600_000 ? { status: "no-data" } : { status: "open" };
  const fill = entryBar.o + s.side * spec.tick;
  const riskPts = (fill - s.stop) * s.side;
  if (!(riskPts > 0)) return { status: "done", r: -1, usd: -(SETUP_FEE_RT * SETUP_CONTRACTS), how: "stop", exitAt: new Date(entryBar.t).toISOString() };
  const tgt = fill + 2 * s.side * riskPts;
  const done = (px: number, how: Outcome["how"], t: number): Outcome => {
    const usdNet = (px - fill) * s.side * spec.pointValue * SETUP_CONTRACTS - SETUP_FEE_RT * SETUP_CONTRACTS;
    return { status: "done", r: usdNet / (riskPts * spec.pointValue * SETUP_CONTRACTS), usd: usdNet, how, exitAt: new Date(t).toISOString() };
  };
  let last: Bar | null = null;
  for (const b of after) {
    const p = etParts(b.t);
    if (p.dayKey !== dayKey || p.hourFrac >= flatH) return last ? done(last.c - s.side * spec.tick, "flat", last.t) : { status: "no-data" };
    if (b !== entryBar && (s.side === 1 ? b.o <= s.stop : b.o >= s.stop)) return done(b.o - s.side * spec.tick, "stop", b.t);
    if (s.side === 1 ? b.l <= s.stop : b.h >= s.stop) return done(s.stop - s.side * spec.tick, "stop", b.t);
    if (s.side === 1 ? b.h > tgt : b.l < tgt) return done(tgt, "target", b.t);
    last = b;
  }
  // Bars end before the trade did: decided only once the session is over.
  const sessionOver = etParts(nowMs).dayKey !== dayKey || etParts(nowMs).hourFrac >= spec.rthClose;
  return sessionOver && last ? done(last.c - s.side * spec.tick, "flat", last.t) : { status: "open" };
}

export interface ScoredSetup { symbol: RoomSymbol; side: 1 | -1; r: number | null; usd: number | null; taken: boolean; hisUsd: number | null }
export function recapText(dayKey: string, rows: ScoredSetup[]): string | null {
  if (!rows.length) return null;
  const scored = rows.filter((r) => r.r != null);
  const sumR = scored.reduce((a, r) => a + r.r!, 0), sumUsd = scored.reduce((a, r) => a + (r.usd ?? 0), 0);
  const taken = rows.filter((r) => r.taken), hisUsd = taken.reduce((a, r) => a + (r.hisUsd ?? 0), 0);
  const sign = (x: number) => (x < 0 ? "−" : "+");
  return `📊 Setups ${dayKey}: ${rows.length} flagged · a plain 2R bracket on all ${scored.length} scored = ${sign(sumR)}${Math.abs(sumR).toFixed(1)}R (${sign(sumUsd)}${usd(sumUsd)} at 20)` +
    ` · you took ${taken.length}${taken.length ? ` (${sign(hisUsd)}${usd(hisUsd)})` : ""}`;
}
