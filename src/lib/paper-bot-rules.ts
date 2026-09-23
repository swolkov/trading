// THE PAPER BOT — pure rules (Sep 23 2026). Spencer asked for a bot that trades beside him, 3–5 trades a day, sized
// 10–20 micros. It trades on PAPER ONLY: no order path exists anywhere in this module or its I/O. Its entries are the
// setups his own Pine study posts (the higher low / lower high of the pullback, ORB + VWAP side — his rule, mechanised);
// its exits are the runner plan the co-pilot coaches; its day rules are the ones he chose for himself. It exists to
// answer one question with live data and zero money: does this rule, traded with perfect discipline, beat costs?
// Priors (said up front so the result is read honestly): 15 yr of 1-minute data put this exact entry at about
// break-even before costs (scripts/pullback-study.ts, 0 of 12 cells survive), and every exit rule is fair before costs
// (147k random-entry trades). The bar to go live is 40+ paper trades still positive after costs.
//
// SIZE: fixed dollar risk, not "confidence". No clue tested predicts which trades win (133k trades, all 30–34% vs a
// fair 33%), so sizing on confidence would be sizing at random. His chart's stops sit at the pullback's extreme — ~10
// pts on MES, ~100 on MNQ, ~9 on MGC — so a flat 10–20 micros would risk $500–$4,000 a trade. Contracts are therefore
// floor($400 ÷ risk per contract), capped at 20; a setup whose stop is too wide for even 1 contract is skipped.
import { INSTRUMENTS, etDayStartMs, etParts, type Bar, type RoomSymbol } from "@/lib/trading-room-rules";
import type { Setup } from "@/lib/setup-feed-rules";

export const BOT_RISK_USD = 400;             // ≈ his median risk per trade (Sep 20–23: $410)
export const BOT_MAX_CONTRACTS = 20;
export const BOT_MAX_TRADES = 5;             // his day rules
export const BOT_MAX_LOSSES = 2;
export const BOT_COOLDOWN_MS = 600_000;
export const BOT_FEE_RT = 2.06;              // measured on his account
export const BOT_TAKE_R = 2;                 // the runner plan
export const BOT_RUNNER_SHARE = 0.25;
export const BOT_TRAIL_START_R = 5;
export const BOT_TRAIL_R = 5;

export type BotHow = "stop" | "target" | "runner stop" | "runner trail" | "flat";
export interface PaperTrade {
  id: string;                 // = the setup's id
  symbol: RoomSymbol;
  side: 1 | -1;
  at: string;                 // the setup's 5-minute bar (open)
  /** open = waiting on bars (or on an earlier trade to finish) · done · skipped (a rule said no) · no-data. */
  status: "open" | "done" | "skipped" | "no-data";
  skip?: string;
  entered?: boolean;          // true once the entry fill exists (status may still be open)
  entryMs?: number;
  contracts?: number;
  runner?: number;
  entry?: number;
  stop?: number;
  riskUsd?: number;
  freeMs?: number;            // when the trade stopped risking money (its +2R sale; the runner rides at breakeven)
  exitMs?: number;
  how?: BotHow;
  usd?: number;               // net of fees
  grossUsd?: number;
  r?: number;                 // net usd ÷ risk usd
  peakR?: number;
  tradeNo?: number;           // n-th trade of its trading day
}

/** The trading day a moment belongs to: the session that opens at 18:00 ET counts as the next calendar day. */
export function botDay(ms: number): string { return etParts(ms + 6 * 3_600_000).dayKey; }

/** Contracts for a stop distance: floor($400 ÷ $risk per contract), max 20. 0 = too wide for even one. */
export function botContracts(symbol: RoomSymbol, riskPts: number): number {
  const perContract = riskPts * INSTRUMENTS[symbol].pointValue;
  if (!(perContract > 0)) return 0;
  return Math.min(BOT_MAX_CONTRACTS, Math.floor(BOT_RISK_USD / perContract));
}

export function botRunner(contracts: number): number { return contracts >= 4 ? Math.floor(contracts * BOT_RUNNER_SHARE) : 0; }

/**
 * One setup traded with the runner plan on 1-minute bars (same fill model as the setup feed's 2R bracket): enter at
 * the open of the first minute after the 5-minute bar closed, 1 tick worse; stop fills 1 tick worse (or at the open,
 * 1 tick worse, when a bar gaps through it); the +2R target fills only if traded THROUGH; a bar touching both stop and
 * target is the stop; flat 5 minutes before the session's close. At +2R: sell all but a quarter (the runner; none
 * under 4 contracts); the runner's stop goes to entry, and once the trade has been +5R it trails 5R behind the best
 * price. Pure — no gating here (see runPaperBot).
 */
export function simulateTrade(s: Setup, bars: Bar[], nowMs: number): Omit<PaperTrade, "tradeNo"> {
  const base = { id: s.id, symbol: s.symbol, side: s.side, at: s.at };
  const spec = INSTRUMENTS[s.symbol];
  const closeMs = Date.parse(s.at) + 5 * 60_000;
  const dayKey = etParts(closeMs).dayKey;
  const flatH = spec.rthClose - 5 / 60;
  const after = bars.filter((b) => b.t >= closeMs).sort((a, b) => a.t - b.t);
  const eb = after[0];
  if (!eb || eb.t - closeMs > 10 * 60_000) return nowMs - closeMs > 3 * 3_600_000 ? { ...base, status: "no-data" } : { ...base, status: "open" };
  const d = s.side, tick = spec.tick, pv = spec.pointValue;
  const fill = eb.o + d * tick;
  const riskPts = (fill - s.stop) * d;
  if (!(riskPts > 0)) return { ...base, status: "skipped", skip: "opened past the stop" };
  const contracts = botContracts(s.symbol, riskPts);
  if (contracts < 1) return { ...base, status: "skipped", skip: `stop too wide (${riskPts.toFixed(2)} pts = $${Math.round(riskPts * pv)} for 1 micro)` };
  const runner = botRunner(contracts), sell = contracts - runner;
  const riskUsd = riskPts * pv * contracts;
  const tgt = fill + BOT_TAKE_R * d * riskPts;
  const entered = { ...base, entered: true, entryMs: eb.t, contracts, runner, entry: fill, stop: s.stop, riskUsd };

  let took = false, open = contracts, gross = 0, stopPx = s.stop, peak = 0;
  const close = (qty: number, px: number) => { gross += (px - fill) * d * pv * qty; open -= qty; };
  let freeMs: number | undefined;
  const finish = (how: BotHow, t: number): Omit<PaperTrade, "tradeNo"> => {
    const usd = gross - BOT_FEE_RT * contracts;
    return { ...entered, status: "done", freeMs, exitMs: t, how, grossUsd: gross, usd, r: usd / riskUsd, peakR: peak / riskPts };
  };
  let last: Bar | null = null;
  for (const b of after) {
    const p = etParts(b.t);
    if (p.dayKey !== dayKey || p.hourFrac >= flatH) {
      if (!last) return { ...base, status: "no-data" };
      close(open, last.c - d * tick);
      return finish("flat", last.t);
    }
    // gap through the working stop at the bar's open (never on the entry bar: its open IS the fill)
    if (b !== eb && (d === 1 ? b.o <= stopPx : b.o >= stopPx)) { close(open, b.o - d * tick); return finish(took ? "runner stop" : "stop", b.t); }
    if (d === 1 ? b.l <= stopPx : b.h >= stopPx) { close(open, stopPx - d * tick); return finish(took ? (stopPx !== fill ? "runner trail" : "runner stop") : "stop", b.t); }
    if (!took && (d === 1 ? b.h > tgt : b.l < tgt)) {
      close(sell, tgt);
      took = true; freeMs = b.t;
      if (open <= 0) return finish("target", b.t);
      stopPx = fill;                                          // the runner can no longer lose
      // the same minute also traded back through entry: order inside a bar is unknown, so assume the stop (not on the
      // entry minute, which opens a tick through the fill by construction — its low is the start of the move)
      if (b !== eb && (d === 1 ? b.l <= fill : b.h >= fill)) { close(open, fill - d * tick); return finish("runner stop", b.t); }
    }
    peak = Math.max(peak, ((d === 1 ? b.h : b.l) - fill) * d);
    if (took && peak >= BOT_TRAIL_START_R * riskPts) {
      const trail = fill + d * (peak - BOT_TRAIL_R * riskPts);
      stopPx = d === 1 ? Math.max(stopPx, trail) : Math.min(stopPx, trail);
    }
    last = b;
  }
  // Bars end before the trade did (Yahoo runs ~10 min behind). Flat on the last bar only when that bar is from the
  // flat window itself and the session is 30+ minutes over — never a guessed exit from a stalled feed (a final row is
  // never recomputed). A feed that never fills the gap leaves the trade as no-data a day later, not a made-up P&L.
  const flatMs = etDayStartMs(dayKey, spec.rthClose);
  if (nowMs >= flatMs + 30 * 60_000 && last && last.t >= flatMs - 15 * 60_000) { close(open, last.c - d * tick); return finish("flat", last.t); }
  if (nowMs >= flatMs + 24 * 3_600_000) return { ...entered, freeMs, status: "no-data", skip: "no bars to close it" };   // still a trade that happened (counts for the day); no P&L
  return { ...entered, status: "open", freeMs };
}

/** What a final row carries forward into the day's gating. */
export interface Settled { id: string; symbol?: RoomSymbol; status: PaperTrade["status"]; entered?: boolean; entryMs?: number; freeMs?: number; exitMs?: number; grossUsd?: number; tradeNo?: number }

/**
 * The bot's day, in setup order. Risk: one trade AT RISK at a time (across all markets) — once a trade has sold at
 * +2R its runner rides at breakeven and risks nothing, so the next setup may be taken, but never in the same market
 * while that runner is still open (a real account holds one net position per contract). Max 5 trades a trading day,
 * done after 2 losing trades (lost money on price), 10 minutes off after a loss. Final rows in `settled` are trusted
 * as stored. Anything that could change a later decision and isn't decided yet holds every later setup open, so
 * decisions always happen in the day's order. A setup that reached the server 15+ minutes after its bar (`late`) is
 * skipped: a later setup may already have been decided without it.
 */
export function runPaperBot(setups: Setup[], bars: Partial<Record<RoomSymbol, Bar[]>>, settled: Map<string, Settled>, nowMs: number, late: Set<string> = new Set()): PaperTrade[] {
  const out: PaperTrade[] = [];
  const day = new Map<string, { trades: number; losses: number; lastLossExitMs: number | null }>();
  let atRiskUntil: number | null = null;                       // when the latest trade stopped risking money
  const runnerUntil = new Map<RoomSymbol, number>();           // a market's runner exit (Infinity = still riding)
  let blocked = false;
  for (const s of [...setups].sort((a, b) => Date.parse(a.at) - Date.parse(b.at) || a.id.localeCompare(b.id))) {
    const key = botDay(Date.parse(s.at) + 5 * 60_000);
    const dstate = day.get(key) ?? { trades: 0, losses: 0, lastLossExitMs: null };
    day.set(key, dstate);
    const base = { id: s.id, symbol: s.symbol, side: s.side, at: s.at };
    const prior = settled.get(s.id);
    const entryMs = Date.parse(s.at) + 5 * 60_000;
    let t: PaperTrade;
    if (prior && prior.status !== "open") {
      t = { ...base, status: prior.status, entered: prior.entered, entryMs: prior.entryMs, freeMs: prior.freeMs, exitMs: prior.exitMs, grossUsd: prior.grossUsd, tradeNo: prior.tradeNo };
    } else if (blocked) {
      out.push({ ...base, status: "open" });
      continue;
    } else if ((runnerUntil.get(s.symbol) ?? -Infinity) === Infinity && !(atRiskUntil != null && atRiskUntil > entryMs)) {
      out.push({ ...base, status: "open" });   // same market, runner still riding, its exit unknown yet: wait
      blocked = true;
      continue;
    } else {
      const skip = (why: string): PaperTrade => ({ ...base, status: "skipped", skip: why });
      if (late.has(s.id)) t = skip("arrived late — decided out of order would be a guess");
      else if (atRiskUntil != null && atRiskUntil > entryMs) t = skip("already in a trade");
      else if ((runnerUntil.get(s.symbol) ?? -Infinity) > entryMs) t = skip(`${s.symbol} runner still open`);
      else if (dstate.losses >= BOT_MAX_LOSSES) t = skip(`${BOT_MAX_LOSSES} losses today`);
      else if (dstate.trades >= BOT_MAX_TRADES) t = skip(`${BOT_MAX_TRADES} trades today`);
      else if (dstate.lastLossExitMs != null && entryMs - dstate.lastLossExitMs < BOT_COOLDOWN_MS) t = skip("10-minute cooldown after a loss");
      else {
        const b = bars[s.symbol];
        t = b ? { ...simulateTrade(s, b, nowMs), tradeNo: dstate.trades + 1 } : { ...base, status: "open" };
      }
    }
    out.push(t);
    if (t.entered) {
      dstate.trades += 1;
      if (t.status === "open") {
        if (t.freeMs == null) { blocked = true; continue; }       // still at risk: its outcome changes what comes next
        atRiskUntil = Math.max(atRiskUntil ?? 0, t.freeMs);       // free: can't be a loss; only its market waits
        runnerUntil.set(t.symbol, Infinity);
        continue;
      }
      atRiskUntil = Math.max(atRiskUntil ?? 0, t.freeMs ?? t.exitMs ?? 0);
      if (t.freeMs != null && t.exitMs != null) runnerUntil.set(t.symbol, t.exitMs);
      if ((t.grossUsd ?? 0) < 0) { dstate.losses += 1; dstate.lastLossExitMs = t.exitMs ?? null; }
    } else if (t.status === "open") {
      blocked = true;
    }
  }
  return out;
}

// ---- Slack text ------------------------------------------------------------------------------------------------
const px = (s: RoomSymbol, x: number) => x.toFixed(s === "MGC" ? 1 : 2);
const usd = (x: number) => `${x < 0 ? "−" : "+"}$${Math.abs(Math.round(x)).toLocaleString("en-US")}`;
const side = (d: 1 | -1) => (d === 1 ? "LONG" : "SHORT");

export function botEntryText(t: PaperTrade): string {
  return `🤖 PAPER bot · ${t.symbol} ${side(t.side)} ${t.contracts} @ ${px(t.symbol, t.entry!)} · stop ${px(t.symbol, t.stop!)} (risk $${Math.round(t.riskUsd!).toLocaleString("en-US")}) · trade ${t.tradeNo} of ${BOT_MAX_TRADES} today${t.runner ? ` · at +2R sells ${t.contracts! - t.runner}, ${t.runner} ride` : " · all out at +2R"} · no real order`;
}
export function botExitText(t: PaperTrade): string {
  return `🤖 PAPER bot · ${t.symbol} ${side(t.side).toLowerCase()} ${t.contracts} closed (${t.how}) · ${usd(t.usd!)} (${t.r! < 0 ? "−" : "+"}${Math.abs(t.r!).toFixed(2)}R after fees) · best it got +${(t.peakR ?? 0).toFixed(1)}R`;
}
export function botSkipText(t: PaperTrade): string {
  return `🤖 PAPER bot · skipped ${t.symbol} ${side(t.side).toLowerCase()} — ${t.skip}`;
}

export interface BotDayRow { usd: number | null; status: string }
/** The recap line: today and the running total vs the bar to go live. */
export function botRecapText(today: BotDayRow[], all: BotDayRow[], hisTodayUsd: number | null): string {
  const done = (rows: BotDayRow[]) => rows.filter((r) => r.status === "done" && r.usd != null);
  const sum = (rows: BotDayRow[]) => done(rows).reduce((a, r) => a + r.usd!, 0);
  const n = done(all).length;
  return `🤖 PAPER bot today: ${done(today).length} trades ${usd(sum(today))}${hisTodayUsd != null ? ` (you: ${usd(hisTodayUsd)})` : ""} · since start: ${n} trades ${usd(sum(all))} after fees · live only after 40+ trades still positive (${Math.min(n, 40)}/40)`;
}
