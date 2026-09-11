// THE PROP ACCOUNT'S RULES AS PURE ARITHMETIC — Tradeify 247, $100k 2-Step, verified from
// help.tradeify247.co on 2026-09-11 and replayed in scripts/backtest-prop.ts.
//
//   · daily loss limit  3% of ACCOUNT SIZE, measured from the 22:00 UTC closing-balance
//     snapshot, checked against LIVE EQUITY (open P&L counts) — a hard breach, account closed
//   · max drawdown      6% of account size, STATIC from the starting balance, never moves,
//     live equity — a hard breach
//   · phases            +10% then +5% of account size (closed balance); funded keeps the floors
//   · inactivity        30 consecutive days without a trade breaches; warning at 28
//
// Everything that decides whether a trade may be placed and how big it is lives here, with
// no I/O, so it can be tested to the dollar. The executor and guardian call these; nothing
// else may reinvent them. A breach is the whole account, so every number here errs small.

export interface PropPlan {
  accountSize: number;
  dailyLossPct: number;      // fraction of accountSize
  maxDrawdownPct: number;    // fraction of accountSize, static from start
  targets: number[];         // fraction of accountSize per evaluation phase, in order
  resetHourUtc: number;      // the trading day rolls at this UTC hour
  inactivityDays: number;    // breach after this many days without a trade
}

export const TRADEIFY_2STEP_100K: PropPlan = {
  accountSize: 100_000,
  dailyLossPct: 0.03,
  maxDrawdownPct: 0.06,
  targets: [0.10, 0.05],
  resetHourUtc: 22,
  inactivityDays: 30,
};

// SIZING DEFAULTS — the 1.5% rung from the replay: 0 breaches in 60 runs at ≤2%, and 2% ran
// within $135 of the daily limit. Risk is a fixed fraction of ACCOUNT SIZE (the limits are
// fixed dollars, so the bet must be too — compounding up into a static floor is how prop
// accounts die). The cushion step lets a funded account that has built a buffer above its
// floor risk a little more; it never exceeds PROP_RISK_MAX_PCT.
export const PROP_RISK_BASE_PCT = 1.5;
export const PROP_RISK_MAX_PCT = 2.0;
export const PROP_RISK_STEP_AT_CUSHION_PCT = 10;   // cushion (equity − max floor) ≥ 10% of size → step up
export const PROP_STOP_FRAC = 0.04;                 // swing-lev's container: 4% initial stop
export const PROP_SLIP_FRAC = 0.003;                // stop-fill allowance on their feed (replay used 0.2%)
export const PROP_FEE_RT_FRAC = 0.0008;             // 0.04% per side, both sides, on notional
export const PROP_BASIS_FRAC = 0.003;               // Kraken price (where the stop is anchored) vs DXtrade fill
export const PROP_MIN_MARGIN_PCT = 0.005;           // a stop-out must leave ≥ 0.5% of size above the binding floor
export const PROP_ROOM_BUFFER = 0.9;                // never plan to use more than 90% of the room left
export const PROP_MIN_FIT_FRAC = 0.25;              // refuse rather than place a trade under ¼ size
export const PROP_MAX_ENTRIES_PER_DAY = 1;          // the daily 3% is the binding rule — one bet per day
export const PROP_KEEPALIVE_AFTER_DAYS = 27;        // one day inside the 28-day warning

export interface PropFloors {
  dailyFloor: number;   // equity may not touch this today
  maxFloor: number;     // equity may never touch this
}

// A snapshot taken this long after the reset is an ESTIMATE: the balance may already have
// moved since 22:00 UTC, and Tradeify measures from the true reset balance. Estimated days
// carry this buffer above the daily floor FOR SIZING (one 2%-rung stop-out with slippage), so
// the desk under-sizes rather than over-sizes. Breach detection always uses the real floors —
// a buffered floor would read a single ordinary loss as a breach and auto-disarm the desk.
export const PROP_LATE_SNAPSHOT_MS = 10 * 60_000;
export const PROP_ESTIMATED_SNAPSHOT_BUFFER_PCT = 0.022;   // of account size

/** The two equity floors as Tradeify enforces them. `snapshotBalance` = closed balance at the last 22:00 UTC reset. */
export function propFloors(plan: PropPlan, snapshotBalance: number): PropFloors {
  return {
    dailyFloor: snapshotBalance - plan.accountSize * plan.dailyLossPct,
    maxFloor: plan.accountSize * (1 - plan.maxDrawdownPct),
  };
}

/** The floors SIZING plans against: the real ones, lifted by the buffer on an estimated day. */
export function sizingFloors(plan: PropPlan, floors: PropFloors, estimated: boolean): PropFloors {
  return estimated ? { ...floors, dailyFloor: floors.dailyFloor + plan.accountSize * PROP_ESTIMATED_SNAPSHOT_BUFFER_PCT } : floors;
}

/** Milliseconds since the most recent reset. */
export function msSinceReset(plan: PropPlan, nowMs: number): number {
  return 86_400_000 - msToNextReset(plan, nowMs);
}

export interface PropRoom {
  dailyRoom: number;    // dollars of equity above today's floor
  maxRoom: number;      // dollars of equity above the static floor
  room: number;         // the binding one
  cushionPct: number;   // maxRoom as a % of account size
}

export function propRoom(plan: PropPlan, equity: number, floors: PropFloors): PropRoom {
  const dailyRoom = equity - floors.dailyFloor;
  const maxRoom = equity - floors.maxFloor;
  return { dailyRoom, maxRoom, room: Math.min(dailyRoom, maxRoom), cushionPct: (maxRoom / plan.accountSize) * 100 };
}

export type PropBreachState = "ok" | "warn" | "urgent" | "breached";

/** How close live equity is to a hard breach. `warn` at 50% of a limit used up, `urgent` at 80%. */
export function propBreachState(plan: PropPlan, equity: number, floors: PropFloors): PropBreachState {
  const r = propRoom(plan, equity, floors);
  if (r.dailyRoom <= 0 || r.maxRoom <= 0) return "breached";
  const dailyUsed = 1 - r.dailyRoom / (plan.accountSize * plan.dailyLossPct);
  const maxUsed = 1 - r.maxRoom / (plan.accountSize * plan.maxDrawdownPct);
  const used = Math.max(dailyUsed, maxUsed);
  if (used >= 0.8) return "urgent";
  if (used >= 0.5) return "warn";
  return "ok";
}

export interface PropSizingInput {
  plan: PropPlan;
  equity: number;
  floors: PropFloors;
  riskBasePct?: number;       // default PROP_RISK_BASE_PCT
  riskMaxPct?: number;        // default PROP_RISK_MAX_PCT
  stopFrac: number;           // initial stop distance as a fraction of entry
  slipFrac?: number;          // default PROP_SLIP_FRAC
  entriesToday: number;
  maxEntriesPerDay?: number;  // default PROP_MAX_ENTRIES_PER_DAY
  openPositions: number;
  maxPositions?: number;      // default 1
}

export interface PropSizing {
  ok: boolean;
  reason: string;
  riskUsd: number;        // dollars lost if the stop fills with slippage
  notionalUsd: number;    // position size
  riskPct: number;        // the rung actually used, % of account size
}

/**
 * The size of the next trade, or a refusal. Order of checks is deliberate: slots and the
 * per-day cap are policy (cheap to explain), the room fit is arithmetic, and the ¼-size
 * floor stops the desk from placing a trade too small to matter but big enough to breach
 * on a gap.
 */
export function propSize(i: PropSizingInput): PropSizing {
  const plan = i.plan;
  const no = (reason: string): PropSizing => ({ ok: false, reason, riskUsd: 0, notionalUsd: 0, riskPct: 0 });
  if (!(i.equity > 0) || !Number.isFinite(i.equity)) return no("equity unreadable");
  if (!(i.stopFrac > 0) || i.stopFrac >= 0.5) return no(`stop ${i.stopFrac} out of range`);
  const maxPositions = i.maxPositions ?? 1;
  if (i.openPositions >= maxPositions) return no(`slots full (${i.openPositions}/${maxPositions})`);
  const maxEntries = i.maxEntriesPerDay ?? PROP_MAX_ENTRIES_PER_DAY;
  if (i.entriesToday >= maxEntries) return no(`daily entry cap reached (${i.entriesToday}/${maxEntries})`);

  const room = propRoom(plan, i.equity, i.floors);
  if (room.room <= 0) return no("no room — at or below a floor");

  // Hard ceiling here too, not only in config parsing: no caller can ask this function for
  // more than the replay's tested maximum.
  const base = Math.min(PROP_RISK_MAX_PCT, i.riskBasePct ?? PROP_RISK_BASE_PCT);
  const cap = Math.min(PROP_RISK_MAX_PCT, Math.max(base, i.riskMaxPct ?? PROP_RISK_MAX_PCT));
  // The cushion step: a buffer above the static floor earns a bigger rung, capped.
  const stepped = room.cushionPct >= PROP_RISK_STEP_AT_CUSHION_PCT ? cap : base;
  const riskPct = Math.min(cap, stepped);
  const wanted = plan.accountSize * (riskPct / 100);

  // A stop-out costs the planned risk PLUS slippage, both fees and the Kraken→DXtrade basis on
  // the whole notional. Fit that inside the room with a proportional buffer AND an absolute
  // margin — after a loss the room is small and "10% of what is left" is tens of dollars.
  // Size DOWN rather than refuse, unless the fit is tiny.
  const slip = i.slipFrac ?? PROP_SLIP_FRAC;
  const lossPerRisk = 1 + (slip + PROP_FEE_RT_FRAC + PROP_BASIS_FRAC) / i.stopFrac;   // total loss ÷ planned risk
  const usable = Math.min(room.room * PROP_ROOM_BUFFER, room.room - plan.accountSize * PROP_MIN_MARGIN_PCT);
  const fit = usable / lossPerRisk;
  const risk = Math.min(wanted, fit);
  if (risk < wanted * PROP_MIN_FIT_FRAC) return no(`room too small — ${Math.round(Math.max(0, fit))} of ${Math.round(wanted)} fits`);
  const notional = risk / i.stopFrac;
  return { ok: true, reason: risk < wanted ? `sized down to fit today's room` : `full ${riskPct}% rung`, riskUsd: risk, notionalUsd: notional, riskPct: (risk / plan.accountSize) * 100 };
}

/** The trading-day key (YYYY-MM-DD of the day that STARTED at the last resetHourUtc). */
export function propDayKey(plan: PropPlan, nowMs: number): string {
  const shifted = new Date(nowMs - plan.resetHourUtc * 3600_000);
  return shifted.toISOString().slice(0, 10);
}

/** Milliseconds until the next reset — for display and for the guardian's snapshot timing. */
export function msToNextReset(plan: PropPlan, nowMs: number): number {
  const d = new Date(nowMs);
  const next = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), plan.resetHourUtc, 0, 0, 0);
  return next > nowMs ? next - nowMs : next + 86_400_000 - nowMs;
}

/** True once the account has gone quiet long enough that a keep-alive trade is due. */
export function keepAliveDue(lastTradeMs: number | null, nowMs: number, afterDays = PROP_KEEPALIVE_AFTER_DAYS): boolean {
  if (lastTradeMs == null) return false;
  return nowMs - lastTradeMs >= afterDays * 86_400_000;
}

export interface PhaseProgress {
  phase: number;          // 1-based; targets.length + 1 = funded
  label: string;
  target: number | null;  // dollars of closed profit needed this phase, null when funded
  progress: number | null;// 0..1
  remaining: number | null;
}

/** Where the account stands in its evaluation, from its closed balance and the phase it is in. */
export function phaseProgress(plan: PropPlan, phase: number, balance: number): PhaseProgress {
  if (phase > plan.targets.length) return { phase, label: "funded", target: null, progress: null, remaining: null };
  const target = plan.accountSize * plan.targets[phase - 1];
  const made = balance - plan.accountSize;
  return {
    phase,
    label: `phase ${phase} of ${plan.targets.length}`,
    target,
    progress: Math.max(0, Math.min(1, made / target)),
    remaining: Math.max(0, target - made),
  };
}

/** Quantity in units, rounded DOWN to the instrument's increment (never up — up risks more). */
export function unitsFor(notionalUsd: number, price: number, increment: number): number {
  if (!(price > 0) || !(notionalUsd > 0)) return 0;
  const raw = notionalUsd / price;
  if (!(increment > 0)) return Math.floor(raw * 1e6) / 1e6;
  return Math.floor(raw / increment) * increment;
}

/** Decimal places implied by a step (0.01 → 2). */
export function decimalsOf(step: number): number {
  if (!(step > 0)) return 8;
  return Math.max(0, Math.min(12, Math.round(-Math.log10(step))));
}

/**
 * Quantity as the exact decimal string the venue expects. `Math.floor(raw / step) * step`
 * carries float tails (57 × 0.01 = 0.5700000000000001) that a strict parser rejects — and a
 * lenient one might round UP. Format to the step's decimals; never more size than planned.
 */
export function fmtQty(units: number, step: number): string {
  const d = decimalsOf(step);
  // +1e-9 absorbs float noise (0.57 × 100 = 56.99999…) so a clean value is not cut a step short.
  const floored = Math.floor(units * 10 ** d + 1e-9) / 10 ** d;
  return floored.toFixed(d);
}

/** Round a price DOWN to the instrument's tick for a long stop (never above the intended level). */
export function stopPriceFor(entry: number, stopFrac: number, tick: number): number {
  const raw = entry * (1 - stopFrac);
  if (!(tick > 0)) return raw;
  const decimals = Math.max(0, Math.min(12, Math.round(-Math.log10(tick))));
  return Number((Math.floor(raw / tick) * tick).toFixed(decimals));
}
