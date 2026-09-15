// BTC-SHOCK VETO (Sep 15 2026) — the prompts' "BTC leadership" rule, as a VETO on alt entries
// only. When BTC has just moved ≥3% in an hour (the same threshold as the guardian's fast-move
// alert) or printed an hourly range ≥2.5× its ATR, alts are not entered AGAINST the shock for
// the next hour: a shock down vetoes alt longs, a shock up vetoes alt shorts. BTC itself is
// never vetoed (a BTC breakout during a BTC move is the trade, not the trap), and nothing here
// touches the paper record — the paper row still opens and is stamped btc_state so the veto's
// value can be measured before it is trusted.
//
// Pure: bars in, state out. The scan route computes it once per tick from the BTC 5m/1h bars
// scanUniverse() already fetched, carries the `until` across ticks in margin_scan_state, and
// skips executeAlert for a vetoed alt signal. Missing or short bars → no veto, state "unknown":
// an unreadable BTC chart never blocks the executor (the executor has its own gates), and the
// stamp says the veto had no opinion.
import type { KrakenBar } from "@/lib/kraken-margin";

/** ±3% in an hour — the guardian's fast-move alert threshold, so the two agree by construction. */
export const SHOCK_MOVE_PCT = 0.03;
/** An hourly bar whose range is ≥2.5× the 1h ATR(14) of the bars before it. */
export const SHOCK_RANGE_ATR = 2.5;
/** How long a shock vetoes counter-direction alt entries, from the tick that saw it. */
export const SHOCK_HOLD_MIN = 60;
/** AgentConfig off switch. Default ON; only the literal "false" disables it. Unreadable → ON. */
export const BTC_VETO_KEY = "kraken_margin_btc_veto";

export type ShockDir = "up" | "down" | null;
export type BtcTrend = "up" | "down" | "flat";
export interface BtcShockState {
  at: string;
  barsOk: boolean;              // false = the 5m or 1h series was missing/short — no opinion
  move1hPct: number | null;     // last 5m close ÷ the close 12 bars back − 1
  rangeAtrMult: number | null;  // newest completed 1h bar's range ÷ ATR14 of the bars before it
  shock: ShockDir;              // the shock in force (fresh this tick, or carried from a prior tick)
  trend: BtcTrend;              // 1h close vs its 20-bar mean — display/stamp only
  until: string | null;         // ISO; the veto stands while now < until
}
/** What the scan route persists between ticks (margin_scan_state.btcShock). */
export interface BtcShockCarry { shock: ShockDir; until: string | null }

function wilderAtr14(bars: KrakenBar[]): number {
  if (bars.length < 15) return NaN;
  const tr: number[] = [];
  for (let i = 1; i < bars.length; i++) {
    const p = bars[i - 1].c;
    tr.push(Math.max(bars[i].h - bars[i].l, Math.abs(bars[i].h - p), Math.abs(bars[i].l - p)));
  }
  let a = tr.slice(0, 14).reduce((s, x) => s + x, 0) / 14;
  for (let i = 14; i < tr.length; i++) a = (a * 13 + tr[i]) / 14;
  return a;
}

/**
 * The shock read for THIS tick. `shock` is set when either trigger fires; `until` is
 * now + SHOCK_HOLD_MIN in that case, else null. Carry-over from earlier ticks is carryShock().
 */
export function btcShock(m5: KrakenBar[], h1: KrakenBar[], nowMs: number = Date.now()): BtcShockState {
  const at = new Date(nowMs).toISOString();
  const m5Ok = Array.isArray(m5) && m5.length >= 13 && m5[m5.length - 1].c > 0 && m5[m5.length - 13].c > 0;
  const h1Ok = Array.isArray(h1) && h1.length >= 17 && h1[h1.length - 1].c > 0;
  if (!m5Ok && !h1Ok) return { at, barsOk: false, move1hPct: null, rangeAtrMult: null, shock: null, trend: "flat", until: null };

  const move1hPct = m5Ok ? m5[m5.length - 1].c / m5[m5.length - 13].c - 1 : null;

  let rangeAtrMult: number | null = null;
  let rangeDir: ShockDir = null;
  let trend: BtcTrend = "flat";
  if (h1Ok) {
    // The newest 1h row is the forming bar; the completed bar before it is the one judged, against
    // the ATR of the bars before THAT (so the shock bar cannot inflate its own yardstick).
    const completed = h1[h1.length - 2];
    const atr = wilderAtr14(h1.slice(0, -2));
    if (Number.isFinite(atr) && atr > 0 && completed) {
      rangeAtrMult = (completed.h - completed.l) / atr;
      rangeDir = completed.c >= completed.o ? "up" : "down";
    }
    const closes = h1.slice(-20).map((b) => b.c);
    const sma = closes.reduce((s, x) => s + x, 0) / closes.length;
    const last = h1[h1.length - 1].c;
    trend = last > sma ? "up" : last < sma ? "down" : "flat";
  }

  let shock: ShockDir = null;
  if (move1hPct != null && Math.abs(move1hPct) >= SHOCK_MOVE_PCT) shock = move1hPct > 0 ? "up" : "down";
  else if (rangeAtrMult != null && rangeAtrMult >= SHOCK_RANGE_ATR) shock = rangeDir;
  const until = shock ? new Date(nowMs + SHOCK_HOLD_MIN * 60_000).toISOString() : null;
  return { at, barsOk: true, move1hPct, rangeAtrMult, shock, trend, until };
}

/**
 * Merge this tick's read with the veto carried from earlier ticks: a fresh shock always wins
 * (and restarts the clock); otherwise a prior veto stands until its `until`; expired → clear.
 */
export function carryShock(fresh: BtcShockState, prior: BtcShockCarry | null | undefined, nowMs: number = Date.now()): BtcShockState {
  if (fresh.shock) return fresh;
  const priorUntil = prior?.until ? Date.parse(prior.until) : NaN;
  if (prior?.shock && Number.isFinite(priorUntil) && priorUntil > nowMs) return { ...fresh, shock: prior.shock, until: prior.until };
  return { ...fresh, shock: null, until: null };
}

/** The btc_state stamp on a paper row: unknown | calm | shock-up | shock-down. */
export function btcStateStamp(state: Pick<BtcShockState, "barsOk" | "shock">): string {
  if (!state.barsOk) return "unknown";
  return state.shock ? `shock-${state.shock}` : "calm";
}

const hhmmZ = (iso: string) => `${iso.slice(11, 16)}Z`;

/**
 * Is THIS entry vetoed? Long vetoed on a shock down, short on a shock up, only while the veto
 * stands, and never for BTC itself. Returns the note the scan route writes into look[].
 */
export function altEntryVetoed(
  state: Pick<BtcShockState, "shock" | "until" | "move1hPct" | "rangeAtrMult">,
  side: "buy" | "sell",
  coin: string,
  nowMs: number = Date.now(),
): { vetoed: boolean; note: string | null } {
  if (!state.shock || !state.until) return { vetoed: false, note: null };
  if (coin.toUpperCase() === "BTC" || coin.toUpperCase() === "XBT") return { vetoed: false, note: null };
  const untilMs = Date.parse(state.until);
  if (!Number.isFinite(untilMs) || untilMs <= nowMs) return { vetoed: false, note: null };
  const against = (state.shock === "down" && side === "buy") || (state.shock === "up" && side === "sell");
  if (!against) return { vetoed: false, note: null };
  const how = state.move1hPct != null && Math.abs(state.move1hPct) >= SHOCK_MOVE_PCT
    ? `${state.move1hPct > 0 ? "+" : "−"}${(Math.abs(state.move1hPct) * 100).toFixed(1)}%/1h`
    : `${(state.rangeAtrMult ?? 0).toFixed(1)}× ATR hourly range`;
  return { vetoed: true, note: `BTC shock ${state.shock} ${how} — alt ${side === "buy" ? "longs" : "shorts"} vetoed until ${hhmmZ(state.until)}` };
}

/** The guardian's fast-move line suffix: "alt longs vetoed until 14:32Z" for a BTC move `dir`. */
export function fastMoveVetoSuffix(dir: "up" | "down", nowMs: number = Date.now()): string {
  return `alt ${dir === "down" ? "longs" : "shorts"} vetoed until ${hhmmZ(new Date(nowMs + SHOCK_HOLD_MIN * 60_000).toISOString())}`;
}

/** Pure: the raw key value → is the veto on? Only the literal "false" turns it off. */
export function btcVetoEnabled(raw: string | null | undefined): boolean {
  return raw !== "false";
}
