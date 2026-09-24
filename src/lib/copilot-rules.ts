// THE CO-PILOT — pure rules (Sep 22 2026). Spencer trades; the co-pilot watches his LIVE position every 15 seconds
// and talks in Slack. It never places, changes or cancels an order. Every nudge comes from his own fills
// (Sep 20–22, 71 round trips, scratchpad replay/style.js):
//   • 11 trades reached +1R and finished red: −$5,011 — the give-back.
//   • first sale inside 2 minutes: 23 trades, −$5,441 · first sale after 10+ minutes: 15 trades, +$6,007.
//   • sold off in pieces: 8 trades, 8 winners, +$7,031.
// THE RUNNER PLAN (Sep 23, his 109 trips + 147k random-entry trades over 15 years): every exit rule is a fair bet before
// costs — runners buy SHAPE, not money. His 109: his hands −$2,434 · all out at +2R +$4,654 · ¾ out at +2R with a ¼
// runner (breakeven stop, trailing 5R once +5R) +$6,255. 15 yr: once +2R, the runner reaches 10R+ about 1 time in 20;
// tight 2–3R trails never caught one. He chose this plan ("make the most, be consistent, get in crazy runners").
// Pure: state + one snapshot of the account in → next state + the lines to post out. Unit-tested.
import { INSTRUMENTS, ROOM_SYMBOLS, etParts, type RoomSymbol } from "@/lib/trading-room-rules";

export const ENTRY_STOP_GRACE_MS = 45_000;   // an entry with no stop gets its card (with the warning) after this long
export const STOP_SETTLE_MS = 10_000;        // a moved stop is announced once it has held still this long (he drags stops)
export const QUICK_EXIT_MS = 120_000;
export const GIVEBACK_FROM_R = 1;
export const GIVEBACK_TO_R = 0.25;
export const REENTRY_MS = 180_000;           // Sep 20–22: 23 entries inside 3 min of the last exit = −$3,918; the other 48 = +$4,222
export const COST_SHARE_FLAG = 0.2;          // fees + slip at ≥ 20% of the stop: the 15-year test's losing tight-stop third
const FEE_RT_PER_CONTRACT = 2.06;            // measured on his account, Sep 18
export const TAKE_AT_R = 2;                  // the plan: most of the position comes off here
export const RUNNER_SHARE = 0.25;            // …and a quarter stays on as the runner (none under 4 contracts)
export const TRAIL_START_R = 5;              // the runner's stop starts trailing once the trade has been +5R
export const TRAIL_R = 5;                    // …5R behind the best price (tighter trails never caught a runner)
export const TRAIL_STEP_R = 1;               // a new runner-stop message only when it has moved up another 1R

// ---- HIS DAY RULES (Sep 23, after −$2,471 on 25 trades; he asked for them: "do it all"). Messages only. ----
// This week's 109 trips (trading day = 18:00 ET → 17:00 ET): first 5 trades of each day −$400 · trades 6+ −$2,034 ·
// before the 2nd loss of the day −$237 · after it −$2,197 · MES +$5,577 · MNQ −$3,664 · MGC −$4,347 ·
// held 10+ min: 27 trades +$9,020 · out inside 2 min: 35 trades −$8,634 · back in < 3 min after a loss: 24 trades −$3,499.
export const DAY_MAX_TRADES = 5;
export const DAY_MAX_LOSSES = 2;
export const COOLDOWN_AFTER_LOSS_MS = 600_000;
export const HANDS_OFF_MS = 600_000;
export const PLAN_SYMBOL: RoomSymbol = "MES";
/** The trading day a moment belongs to: the session that opens at 18:00 ET counts as the next calendar day. */
export function tradingDay(ms: number): string { return etParts(ms + 6 * 3_600_000).dayKey; }
/** The six day rules, checked on every trade (no tap needed). Entry-time checks are frozen when the position appears. */
export interface EntryRules { mes: boolean; window: boolean; cooled: boolean; dayOk: boolean }
export const DISCIPLINE_RULES = 6;
export interface Discipline { symbol: RoomSymbol; side: 1 | -1; openedMs: number; score: number; broken: string[] }
/** Score a closed trip: the four entry checks + a real stop (fees+slip < 20% of it) + hands off 10 min (unless +2R). */
export function disciplineOf(sym: RoomSymbol, t: Trip, handsOff: boolean): Discipline | null {
  const e = t.entryRules;
  if (!e) return null;   // state saved before the rule existed
  // a stop the co-pilot never had the chance to see is unknown, not missing: never held against him
  const stopOk = !t.ordersSeen || !!(t.riskPts && t.riskPts > 0 && costShare(sym, t.riskPts) < COST_SHARE_FLAG);
  const checks: [boolean, string][] = [[e.mes, "not MES"], [e.window, "outside 9:30 AM–2 PM"], [e.cooled, "< 10 min after a loss"],
    [e.dayOk, "past 5 trades / 2 losses"], [stopOk, "no stop or too tight"], [handsOff, "out by hand < 10 min"]];
  const broken = checks.filter(([ok]) => !ok).map(([, why]) => why);
  return { symbol: sym, side: t.side, openedMs: t.openedMs, score: DISCIPLINE_RULES - broken.length, broken };
}
export function disciplineLine(d: Discipline): string {
  return d.broken.length ? `   📏 Discipline ${d.score}/${DISCIPLINE_RULES} — broke: ${d.broken.join(" · ")}` : `   📏 By the book ${d.score}/${DISCIPLINE_RULES}`;
}
export interface DayTally { key: string; trades: number; losses: number; netUsd: number; doneSaid?: boolean }

/** Breakeven as a price he can actually enter: his average rounded to the tick on the safe side (up for a long). */
export function breakevenPx(sym: RoomSymbol, side: 1 | -1, avg: number): number {
  const tick = INSTRUMENTS[sym].tick, n = avg / tick;
  return Math.round((side === 1 ? Math.ceil(n - 1e-9) : Math.floor(n + 1e-9)) * tick * 1e6) / 1e6;
}

/** How the plan splits a position at +2R. */
export function runnerSplit(qty: number): { sell: number; runner: number } {
  const runner = qty >= 4 ? Math.floor(qty * RUNNER_SHARE) : 0;
  return { sell: qty - runner, runner };
}

export interface CopilotPosition { symbol: RoomSymbol; netPos: number; netPrice: number }
/** `trailing`: a trailing stop — its price is the STARTING level (the broker trails it server-side), so it is never announced as current. */
export interface CopilotOrder { orderId: number; symbol: RoomSymbol; action: "Buy" | "Sell"; kind: "stop" | "limit"; price: number; qty: number; trailing?: boolean }
export interface CopilotFill { symbol: RoomSymbol; action: "Buy" | "Sell"; qty: number; price: number; ms: number }
export interface CopilotSnapshot {
  nowMs: number;
  positions: CopilotPosition[];
  /** Working orders; null when they were not read this poll (the rules then keep the last known stop). */
  orders: CopilotOrder[] | null;
  /** Last price per symbol when it can be known (from the account's open P&L, or a fresh chart alert). */
  prices: Partial<Record<RoomSymbol, number>>;
  /** Fills since the previous poll — read only when a position's size changed. */
  fills: CopilotFill[];
  /** Stop orders the broker REJECTED in the last few minutes (Sep 22: a buy stop placed under the market left 20 MNQ naked). */
  rejectedStops?: CopilotOrder[];
  /** His own journal record for this market at this time of day — read only when a new position appears. */
  records?: Partial<Record<RoomSymbol, { label: string; n: number; netUsd: number; since: string }>>;
}

export interface Trip {
  side: 1 | -1;
  qty: number;
  maxQty: number;
  entryPx: number;          // average price when the co-pilot first saw the position
  avg: number;              // the broker's current average
  openedMs: number;
  initialStop: number | null;
  riskPts: number | null;   // entry → initial stop, when the stop sits on the loss side
  stop: number | null;      // last announced stop
  trailing: boolean;        // the stop is a broker-side trailing stop (its price moves without a new order version)
  pendingStop: { px: number | null; sinceMs: number } | null;
  target: number | null;
  announced: boolean;
  noStopWarned: boolean;
  stopGoneWarned: boolean;
  hit1R: boolean;
  hit2R: boolean;
  giveBackWarned: boolean;
  peakR: number;
  hit5R?: boolean;           // optional: state saved before the runner plan has no such field
  realizedUsd?: number;      // $ banked on partial sales so far (gross)
  guards?: string[];         // day-rule lines for the entry card
  entryRules?: EntryRules;   // the day rules as they stood when the position appeared
  ordersSeen?: boolean;      // at least one orders read succeeded during this trip (else the stop rule is unknown, not failed)
  trailPx?: number | null;   // the runner stop last announced by the plan
  reduced: boolean;
  lastPrice: number | null;
  reentrySec: number | null;   // seconds since the previous exit, when it was inside REENTRY_MS
  rejectedSeen?: number[];     // rejected stop order ids already announced
  record: { label: string; n: number; netUsd: number; since: string } | null;
}
export interface CopilotState { trips: Partial<Record<RoomSymbol, Trip>>; lastCloseMs?: number; lastCloseLoss?: boolean; day?: DayTally }

// ---- formatting ---------------------------------------------------------------------------------
const dp = (s: RoomSymbol) => (s === "MGC" ? 1 : 2);
export const px = (s: RoomSymbol, x: number) => x.toFixed(dp(s));
const usd = (x: number) => `$${Math.abs(Math.round(x)).toLocaleString("en-US")}`;
const signedUsd = (x: number) => `${x < 0 ? "−" : "+"}${usd(x)}`;
const signedR = (r: number) => `${r < 0 ? "−" : "+"}${Math.abs(r).toFixed(1)}R`;
const sideWord = (d: 1 | -1) => (d === 1 ? "LONG" : "SHORT");
export function duration(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  return s < 60 ? `${s}s` : s < 3600 ? `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, "0")}s` : `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;
}

/** Points → R for this trip, or null when the trip has no loss-side initial stop. */
export function rAt(t: Trip, price: number): number | null {
  return t.riskPts && t.riskPts > 0 ? ((price - t.entryPx) * t.side) / t.riskPts : null;
}

/** The protective stop for a position: working stop orders on the closing side. The one nearest the market fires first. */
export function protectiveStop(orders: CopilotOrder[], sym: RoomSymbol, side: 1 | -1): { px: number; qty: number; trailing: boolean } | null {
  const closing = side === 1 ? "Sell" : "Buy";
  const stops = orders.filter((o) => o.symbol === sym && o.kind === "stop" && o.action === closing && o.qty > 0 && Number.isFinite(o.price));
  if (!stops.length) return null;
  const px0 = side === 1 ? Math.max(...stops.map((o) => o.price)) : Math.min(...stops.map((o) => o.price));
  return { px: px0, qty: stops.reduce((a, o) => a + o.qty, 0), trailing: stops.some((o) => o.trailing) };
}
/** The first profit target: working limit orders on the closing side, beyond the average. */
export function firstTarget(orders: CopilotOrder[], sym: RoomSymbol, side: 1 | -1, avg: number): number | null {
  const closing = side === 1 ? "Sell" : "Buy";
  const lim = orders.filter((o) => o.symbol === sym && o.kind === "limit" && o.action === closing && (o.price - avg) * side > 0).map((o) => o.price);
  if (!lim.length) return null;
  return side === 1 ? Math.min(...lim) : Math.max(...lim);
}

function newTrip(p: CopilotPosition, nowMs: number): Trip {
  const side: 1 | -1 = p.netPos > 0 ? 1 : -1;
  return {
    side, qty: Math.abs(p.netPos), maxQty: Math.abs(p.netPos), entryPx: p.netPrice, avg: p.netPrice, openedMs: nowMs,
    initialStop: null, riskPts: null, stop: null, trailing: false, pendingStop: null, target: null,
    announced: false, noStopWarned: false, stopGoneWarned: false, hit1R: false, hit2R: false, hit5R: false, trailPx: null, giveBackWarned: false, peakR: 0, reduced: false, lastPrice: null,
    reentrySec: null, record: null,
  };
}

/** What the position shows open right now: the broker's average against the price, on the size held. */
function openUsd(sym: RoomSymbol, t: Trip, price: number): number {
  return (price - t.avg) * t.side * INSTRUMENTS[sym].pointValue * t.qty;
}

function riskUsd(sym: RoomSymbol, t: Trip, stopPx: number, qty: number): number {
  return (t.avg - stopPx) * t.side * INSTRUMENTS[sym].pointValue * qty;   // > 0 = at risk, < 0 = locked in
}

/** The time-of-day bucket his record is kept in (ET). Sep 20–22: MES open→2 PM +$5,745 · MNQ after 2 PM −$2,666. */
export function timeBucket(ms: number): string {
  const h = etParts(ms).hourFrac;
  return h >= 18 || h < 8 ? "overnight (6 PM–8 AM ET)" : h < 9.5 ? "pre-open (8–9:30 AM ET)" : h < 11.5 ? "open to 11:30 AM ET" : h < 14 ? "11:30 AM–2 PM ET" : "2–5 PM ET";
}

/** Fees (measured) + one tick of slippage each way, as a share of the risk per contract. */
export function costShare(sym: RoomSymbol, riskPts: number): number {
  const spec = INSTRUMENTS[sym];
  return (FEE_RT_PER_CONTRACT + 2 * spec.tick * spec.pointValue) / (riskPts * spec.pointValue);
}

function entryCard(sym: RoomSymbol, t: Trip): string {
  const head = `🟢 ${sym} ${sideWord(t.side)} ${t.qty} @ ${px(sym, t.avg)}`;
  const extra: string[] = [...(t.guards ?? [])];
  if (t.reentrySec != null && !extra.some((g) => g.includes("after a LOSS"))) extra.push(`   ⏱ back in ${t.reentrySec}s after your last exit. Sep 20–22: 23 re-entries inside 3 min = −$3,918; the other 48 trades = +$4,222.`);
  if (t.record && t.record.n >= 3) extra.push(`   📒 your record, ${sym} ${t.record.label}: ${t.record.n} trades · ${signedUsd(t.record.netUsd)} (since ${t.record.since})`);
  const tail = extra.length ? `\n${extra.join("\n")}` : "";
  if (t.stop == null) return `${head}\n   ⚠️ NO STOP on ${t.qty} ${sym}. Nothing limits this trade.${tail}`;
  const risk = riskUsd(sym, t, t.stop, t.qty);
  if (!(t.riskPts && t.riskPts > 0)) return `${head} · stop ${px(sym, t.stop)} is already past entry — locks ${usd(-risk)}${tail}`;
  const r1 = t.entryPx + t.side * t.riskPts, r2 = t.entryPx + 2 * t.side * t.riskPts;
  const tgt = t.target != null ? ` · your target ${px(sym, t.target)} (${signedR(rAt(t, t.target)!)})` : "";
  const cs = costShare(sym, t.riskPts);
  const cost = cs >= COST_SHARE_FLAG ? `\n   💸 fees + 1-tick slip = ${Math.round(cs * 100)}% of this stop. Tight stops lost in your trades (≤ $20/contract: −$2,227) and over 15 years.` : "";
  const { sell, runner } = runnerSplit(t.qty);
  const plan = runner > 0
    ? `plan: at +2R sell ${sell}, stop on the last ${runner} → breakeven ${px(sym, breakevenPx(sym, t.side, t.avg))} · runner trails ${TRAIL_R}R once +${TRAIL_START_R}R`
    : "plan: all out at +2R";
  return `${head} · ${t.trailing ? "trailing stop from" : "stop"} ${px(sym, t.stop)} = ${usd(risk)} (1R)\n   +1R ${px(sym, r1)} · +2R ${px(sym, r2)}${tgt} · ${plan}${cost}${tail}`;
}

function exitPrice(fills: CopilotFill[], sym: RoomSymbol, side: 1 | -1): number | null {
  const closing = side === 1 ? "Sell" : "Buy";
  const f = fills.filter((x) => x.symbol === sym && x.action === closing);
  const q = f.reduce((a, x) => a + x.qty, 0);
  return q > 0 ? f.reduce((a, x) => a + x.price * x.qty, 0) / q : null;
}

/** How a trip ended: at its stop, at its target, or by hand. */
function exitKind(sym: RoomSymbol, t: Trip, exitPx: number | null): { stopped: boolean; targeted: boolean; byHand: boolean } {
  const tick = INSTRUMENTS[sym].tick;
  const near = (lvl: number | null | undefined) => exitPx != null && lvl != null && Math.abs(exitPx - lvl) <= 2 * tick;
  // A stop he just dragged (not yet announced) that then filled is still a stop-out.
  const stopped = near(t.stop) || near(t.pendingStop?.px);
  const targeted = !stopped && near(t.target);
  // A trailing stop's live level is unknown to the co-pilot, so an exit it can't place is not called "by hand".
  return { stopped, targeted, byHand: !stopped && !targeted && !t.trailing };
}

function closeLine(sym: RoomSymbol, t: Trip, exitPx: number | null, nowMs: number, fromFills: boolean): string {
  const held = nowMs - t.openedMs;
  const r = exitPx != null ? rAt(t, exitPx) : null;
  const tick = INSTRUMENTS[sym].tick;
  const { stopped, targeted, byHand } = exitKind(sym, t, exitPx);
  const how = stopped ? "stopped out" : targeted ? "target filled" : t.trailing ? "closed (trailing stop or by hand)" : "closed by hand";
  const parts = [`🏁 ${sym} ${sideWord(t.side).toLowerCase()} ${t.maxQty} ${how} after ~${duration(held)}${exitPx != null ? ` @ ${px(sym, exitPx)}` : ""}${r != null ? ` · ${signedR(r)}` : ""}`];
  if (byHand && fromFills && held < HANDS_OFF_MS && !(r != null && r >= 2)) parts.push(`   Out by hand after ${duration(held)} — your rule is hands off for 10 minutes. This week: 35 trades out inside 2 min = −$8,634; 27 held 10+ min = +$9,020.`);
  const wholeTrade = exitPx != null ? (t.realizedUsd ?? 0) + (exitPx - t.avg) * t.side * INSTRUMENTS[sym].pointValue * t.qty : null;
  if (t.hit1R && r != null && r < 0 && (wholeTrade == null || wholeTrade < 0)) parts.push(`   It was +${t.peakR.toFixed(1)}R and finished red. Sep 20–22: 11 trades did that = −$5,011.`);
  // Only a real runner (the plan left one, he is down to it), only on a fill price (a stale last price could be a stop
  // fill), and only on trips that were given the plan (saved state from before it has hit5R/trailPx undefined).
  const runner = runnerSplit(t.maxQty).runner;
  const ruleStop = t.trailPx ?? (t.hit2R ? t.avg : null);
  if (byHand && fromFills && t.hit2R && t.hit5R !== undefined && runner > 0 && t.qty <= runner && ruleStop != null && exitPx != null && (exitPx - ruleStop) * t.side > 2 * tick)
    parts.push(`   The runner went out by hand — the plan's stop was ${px(sym, ruleStop)}. Once +2R, about 1 runner in 20 goes on to 10R+ (15-yr test).`);
  return parts.join("\n");
}

/** One poll. Returns the next state and the lines to post (already grouped per symbol). */
/** gradeAsks: entries whose card went out this poll — the I/O posts the A/B/C grade links for each. */
export interface GradeAsk { symbol: RoomSymbol; side: 1 | -1; openedMs: number; closed?: boolean }
export function step(prev: CopilotState, snap: CopilotSnapshot): { state: CopilotState; messages: string[]; gradeAsks: GradeAsk[]; discipline: Discipline[] } {
  const trips: Partial<Record<RoomSymbol, Trip>> = { ...prev.trips };
  const messages: string[] = [];
  const gradeAsks: GradeAsk[] = [];
  const discipline: Discipline[] = [];
  let lastCloseMs = prev.lastCloseMs;
  let lastCloseLoss = prev.lastCloseLoss;
  const dayKey = tradingDay(snap.nowMs);
  const day: DayTally = prev.day && prev.day.key === dayKey ? { ...prev.day } : { key: dayKey, trades: 0, losses: 0, netUsd: 0 };
  for (const sym of ROOM_SYMBOLS) {
    const lines: string[] = [];
    const pos = snap.positions.find((p) => p.symbol === sym && p.netPos !== 0) ?? null;
    let t = trips[sym] ? { ...trips[sym]! } : null;

    // ---- position lifecycle ----
    if (t && (!pos || Math.sign(pos.netPos) !== t.side)) {
      const filled = exitPrice(snap.fills, sym, t.side);
      const exitPx = filled ?? t.lastPrice;
      const shown = t.announced || snap.nowMs - t.openedMs >= 5_000;
      if (shown) lines.push(closeLine(sym, t, exitPx, snap.nowMs, filled != null));
      if (shown) {
        // hands off: only a real fill price can say "by hand" (unknown exit → not held against him)
        const r = filled != null ? rAt(t, filled) : null;
        const handsOff = !(filled != null && exitKind(sym, t, filled).byHand && snap.nowMs - t.openedMs < HANDS_OFF_MS && !(r != null && r >= 2));
        const d = disciplineOf(sym, t, handsOff);
        if (d) { lines.push(disciplineLine(d)); discipline.push(d); }
      }
      // a quick trade that closed before its card went out never got the grade ask — ask now, or C would look better than it is
      if (!t.announced && snap.nowMs - t.openedMs >= 5_000) gradeAsks.push({ symbol: sym, side: t.side, openedMs: t.openedMs, closed: true });
      // The day's tally, only from a real fill price (a stale poll price can turn a stop-out into a "win").
      // A LOSS = lost money on price (gross < 0): a breakeven scratch is not a loss just because of fees.
      if (filled == null) {
        lastCloseLoss = false;
        if (t.announced) lines.push("   (couldn't read the exit fills — this trade isn't counted in today's losses)");
      } else {
        const gross = (t.realizedUsd ?? 0) + (filled - t.avg) * t.side * INSTRUMENTS[sym].pointValue * t.qty;
        day.netUsd += gross - FEE_RT_PER_CONTRACT * t.maxQty;
        lastCloseLoss = gross < 0;
        if (gross < 0) {
          day.losses += 1;
          if (day.losses === DAY_MAX_LOSSES && !day.doneSaid) {
            day.doneSaid = true;
            lines.push(`🛑 That's ${DAY_MAX_LOSSES} losses today (day ≈ ${signedUsd(day.netUsd)}). Your rule: done for the day. This week, trades taken after the 2nd loss of the day = −$2,197; before it = −$237.`);
          }
        }
      }
      lastCloseMs = snap.nowMs;
      t = null;
    }
    if (!t && pos) {
      t = newTrip(pos, snap.nowMs);
      if (lastCloseMs != null && snap.nowMs - lastCloseMs < REENTRY_MS) t.reentrySec = Math.max(1, Math.round((snap.nowMs - lastCloseMs) / 1000));
      day.trades += 1;
      const g: string[] = [];
      if (day.losses >= DAY_MAX_LOSSES) g.push(`   ⛔ You already have ${day.losses} losses today — your rule says done for the day.`);
      g.push(day.trades > DAY_MAX_TRADES
        ? `   ⛔ Trade ${day.trades} today — your limit is ${DAY_MAX_TRADES}. This week: first 5 trades of each day = −$400; trades 6+ = −$2,034.`
        : `   🧮 Trade ${day.trades} of ${DAY_MAX_TRADES} today`);
      if (lastCloseLoss && lastCloseMs != null && snap.nowMs - lastCloseMs < COOLDOWN_AFTER_LOSS_MS)
        g.push(`   ⛔ Back in ${duration(snap.nowMs - lastCloseMs)} after a LOSS — your rule is 10 minutes. This week: back in < 3 min after a loss = 24 trades −$3,499.`);
      const hh = etParts(snap.nowMs).hourFrac;
      if (hh >= 14 && hh < 17) g.push(`   ⏰ After 2 PM ET. Sep 20–23: 20 trades after 2 PM = −$4,234 (25% win); 9:30–noon = 20 trades +$3,688.`);
      if (sym !== PLAN_SYMBOL) g.push(`   📌 Not MES — your plan is MES only for now (this week MES +$5,577 · MNQ −$3,664 · MGC −$4,347).`);
      t.guards = g;
      t.entryRules = { mes: sym === PLAN_SYMBOL, window: hh >= 9.5 && hh < 14,
        cooled: !(lastCloseLoss && lastCloseMs != null && snap.nowMs - lastCloseMs < COOLDOWN_AFTER_LOSS_MS),
        dayOk: day.trades <= DAY_MAX_TRADES && day.losses < DAY_MAX_LOSSES };
      t.record = snap.records?.[sym] ?? null;
    }
    if (!t) { delete trips[sym]; if (lines.length) messages.push(lines.join("\n")); continue; }
    const p = pos!;
    const cardAt = lines.length;   // a flip's close line stays ahead of the new entry card
    const qty = Math.abs(p.netPos);
    const price0 = snap.prices[sym] ?? t.lastPrice;
    if (qty !== t.qty) {
      const delta = qty - t.qty;
      const fillsPx = delta > 0 ? exitPrice(snap.fills, sym, (t.side * -1) as 1 | -1) : exitPrice(snap.fills, sym, t.side);
      if (t.announced) {
        if (delta > 0) {
          const risk = t.stop != null ? riskUsd(sym, { ...t, avg: p.netPrice }, t.stop, qty) : null;
          lines.push(`➕ ${sym} added ${delta}${fillsPx != null ? ` @ ${px(sym, fillsPx)}` : ""} → ${qty} @ avg ${px(sym, p.netPrice)}${risk != null ? ` · ${risk >= 0 ? `risk to stop ${usd(risk)}` : `stop locks ${usd(-risk)}`}` : " · no stop"}`);
        } else {
          const r = fillsPx != null ? rAt(t, fillsPx) : null;
          lines.push(`➖ ${sym} sold ${-delta}${fillsPx != null ? ` @ ${px(sym, fillsPx)}` : ""}${r != null ? ` (${signedR(r)})` : ""} · ${qty} left${t.stop != null ? ` · stop ${px(sym, t.stop)}` : ""}`);
        }
      }
      if (delta < 0) {
        t.reduced = true;
        const soldPx = fillsPx ?? price0;
        if (soldPx != null) t.realizedUsd = (t.realizedUsd ?? 0) + (soldPx - t.avg) * t.side * INSTRUMENTS[sym].pointValue * -delta;
      }
      t.qty = qty; t.maxQty = Math.max(t.maxQty, qty);
    }
    t.avg = p.netPrice;

    // ---- orders: stop and target ----
    if (snap.orders) {
      t.ordersSeen = true;
      const s = protectiveStop(snap.orders, sym, t.side);
      t.target = firstTarget(snap.orders, sym, t.side, t.avg);
      if (s) t.trailing = s.trailing;
      if (s && t.initialStop == null) {
        t.initialStop = s.px;
        const rp = (t.entryPx - s.px) * t.side;
        t.riskPts = rp > 0 ? rp : null;
        t.stop = s.px; t.pendingStop = null;
        if (t.announced && t.noStopWarned) lines.push(`🛡 ${sym} stop placed ${px(sym, s.px)} · ${riskUsd(sym, t, s.px, t.qty) >= 0 ? `risk ${usd(riskUsd(sym, t, s.px, t.qty))}` : `locks ${usd(-riskUsd(sym, t, s.px, t.qty))}`}`);
      } else if (t.initialStop != null) {
        const seen = s ? s.px : null;
        if (seen === t.stop) t.pendingStop = null;
        else if (!t.pendingStop || t.pendingStop.px !== seen) t.pendingStop = { px: seen, sinceMs: snap.nowMs };
        else if (snap.nowMs - t.pendingStop.sinceMs >= STOP_SETTLE_MS) {
          if (seen == null) {
            if (!t.stopGoneWarned) lines.push(`⚠️ ${sym} your stop is gone — ${t.qty} ${sym} with nothing under it.`);
            t.stopGoneWarned = true;
          } else {
            const risk = riskUsd(sym, t, seen, t.qty);
            const atBe = Math.abs(seen - t.avg) <= INSTRUMENTS[sym].tick;
            lines.push(`🛡 ${sym} stop → ${px(sym, seen)} · ${atBe ? "breakeven" : risk > 0 ? `risk ${usd(risk)}` : `locks ${usd(-risk)}`}${s && s.qty < t.qty ? ` · covers ${s.qty} of ${t.qty}` : ""}`);
            t.stopGoneWarned = false;
          }
          t.stop = seen; t.pendingStop = null;
        }
      }
    }

    // ---- a stop the broker rejected: said at once, loudly, with the reason he can act on ----
    for (const o of snap.rejectedStops ?? []) {
      if (o.symbol !== sym || o.action !== (t.side === 1 ? "Sell" : "Buy") || (t.rejectedSeen ?? []).includes(o.orderId)) continue;
      t.rejectedSeen = [...(t.rejectedSeen ?? []), o.orderId];
      const has = snap.orders ? protectiveStop(snap.orders, sym, t.side) : null;
      const where = t.side === 1 ? "BELOW" : "ABOVE";
      lines.push(`🚨 ${sym}: Tradovate REJECTED your stop (${o.action} Stop ${px(sym, o.price)} ×${o.qty}).${has ? ` Another stop is working at ${px(sym, has.px)}.` : ` You are ${sideWord(t.side)} ${t.qty} ${sym} with NO STOP.`} A ${t.side === 1 ? "sell" : "buy"} stop must sit ${where} the market when placed.`);
      if (!has) t.noStopWarned = true;
    }

    // ---- the entry card: once the stop is known, or after the grace period without one ----
    if (!t.announced && (t.stop != null || snap.nowMs - t.openedMs >= ENTRY_STOP_GRACE_MS)) {
      lines.splice(cardAt, 0, entryCard(sym, t));
      t.announced = true;
      gradeAsks.push({ symbol: sym, side: t.side, openedMs: t.openedMs });
      t.noStopWarned = t.stop == null;
    }

    // ---- price: +1R, +2R, give-back ----
    const price = snap.prices[sym];
    if (price != null && Number.isFinite(price)) {
      t.lastPrice = price;
      const r = rAt(t, price);
      if (r != null && t.announced) {
        t.peakR = Math.max(t.peakR, r);
        if (!t.hit1R && r >= 1) {
          t.hit1R = true;
          lines.push(`📍 ${sym} +1R at ${px(sym, price)} (${signedUsd(openUsd(sym, t, price))} open)${t.reduced || r >= TAKE_AT_R ? "" : ` · nothing to do yet — the plan sells at +2R ${px(sym, t.entryPx + TAKE_AT_R * t.side * t.riskPts!)}`}`);
        }
        if (!t.hit2R && r >= 2) {
          t.hit2R = true;
          const runner = runnerSplit(t.maxQty).runner;
          const be = px(sym, breakevenPx(sym, t.side, t.avg));
          const todo = runner === 0 ? " — the plan: all out here"
            : t.qty > runner ? ` — sell ${t.qty - runner} now, move the stop on the last ${runner} to breakeven ${be}`
            : ` — keep the runner: stop on what's left → breakeven ${be}`;
          lines.push(`🎯 ${sym} +2R at ${px(sym, price)} (${signedUsd(openUsd(sym, t, price))} open)${todo}`);
        }
        // The runner: once +5R, its stop trails 5R behind the best price; say each new level once it has moved 1R.
        if (t.hit2R && t.peakR >= TRAIL_START_R) {
          const tick = INSTRUMENTS[sym].tick;
          const lockR = t.peakR - TRAIL_R;
          const lvl = Math.round((t.avg + t.side * lockR * t.riskPts!) / tick) * tick;   // breakeven = his real average
          const lastR = t.trailPx != null ? ((t.trailPx - t.avg) * t.side) / t.riskPts! : null;
          if (!t.hit5R || (lastR != null && lockR - lastR >= TRAIL_STEP_R)) {
            lines.push(!t.hit5R
              ? `🚀 ${sym} +${t.peakR.toFixed(1)}R — runner stop → ${px(sym, lvl)} (${lockR <= 0.05 ? "breakeven" : `locks ${signedR(lockR)}`}); from here it trails ${TRAIL_R}R behind the best price`
              : `🚀 ${sym} runner stop → ${px(sym, lvl)} (locks ${signedR(lockR)}) · best so far ${signedR(t.peakR)}`);
            t.hit5R = true; t.trailPx = lvl;
          }
        }
        const beOrBetter = t.stop != null && (t.stop - t.avg) * t.side >= 0;
        if (!t.giveBackWarned && t.peakR >= GIVEBACK_FROM_R && r <= GIVEBACK_TO_R && !beOrBetter) {
          t.giveBackWarned = true;
          lines.push(`↩️ ${sym} was +${t.peakR.toFixed(1)}R, now ${signedR(r)} and the stop is still under entry. 11 trades this week went from +1R to red (−$5,011).`);
        }
      }
    }

    trips[sym] = t;
    if (lines.length) messages.push(lines.join("\n"));
  }
  return { state: { trips, lastCloseMs, lastCloseLoss, day }, messages, gradeAsks, discipline };
}

/** The price implied by the account's open P&L — exact when ONE room symbol is open (the P&L is account-wide). */
export function priceFromOpenPnl(positions: CopilotPosition[], openPnl: number | null): Partial<Record<RoomSymbol, number>> {
  const open = positions.filter((p) => p.netPos !== 0);
  if (openPnl == null || !Number.isFinite(openPnl) || open.length !== 1) return {};
  const p = open[0], spec = INSTRUMENTS[p.symbol];
  const raw = p.netPrice + openPnl / (p.netPos * spec.pointValue);
  return { [p.symbol]: Math.round(raw / spec.tick) * spec.tick };
}
