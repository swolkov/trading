// SWING-LEV UNDER TRADEIFY 247's RULES — would the bot pass a $100k 2-Step eval, and what
// does a funded account pay?
//
//   npx tsx scripts/backtest-prop.ts            # sweep risk rungs × seeds
//   RISK=0.01 SEED=3 VERBOSE=1 npx tsx scripts/backtest-prop.ts
//
// Same signals, same exit container and same clock as backtest-portfolio.ts (the desk as it
// runs), but the ACCOUNT is a prop account, verified 2026-09-11 from help.tradeify247.co:
//   · $100,000 · 2-Step: phase 1 target +10%, phase 2 +5%, no time limit
//   · daily loss 3% of account size, measured from the 22:00 UTC closing-balance snapshot,
//     checked on LIVE EQUITY (open P&L counts) — a hard breach, account closed
//   · max drawdown 6% STATIC from the starting balance, live equity, never moves
//   · 0.04% commission per side, NO funding/overnight cost, weekends allowed
//   · leverage 5:1 BTC/ETH, 2:1 alts — irrelevant at prop sizing (risk/stop = 25× risk)
//   · funded: 80% split, first payout after 3 days of ≥ +0.5%
// Risk is a FIXED % of the $100k starting balance (the limits are fixed dollars, so the bet
// must be too — compounding up into a static floor is how prop accounts die).
//
// Intraday marks: a 4h bar's LOW is the worst equity mark for an open long. The breach
// checks use that, which is the conservative reading of "checked on live equity at any point".
import { exitParams, managedStop } from "../src/lib/margin-shadow";
import type { KrakenBar } from "../src/lib/kraken-margin";
import { readFileSync, existsSync } from "node:fs";

const OLD = "/tmp/claude-501/-Users-user-trading/9d589653-7ac2-433f-a03a-11e6aa69aeb5/scratchpad";
const CACHE = `${OLD}/bars.json`;
const SIGCACHE = `${OLD}/sigs-4h-v3-high.json`;   // HIGH conviction only — the rule that trades

// PLAN=std   $100k 2-Step: +10% then +5%, 3% daily, 6% static           ($580, 35% off Sep 2026)
// PLAN=promo $247k 3-Step promotional: +10% ×3, 3% daily, 10% static ($47, one per customer)
const PROMO = process.env.PLAN === "promo";
// PLAN=instant $100k Instant Funding: funded day 0, 6% max loss TRAILING per closed-trade high (floor capped at start)
const INSTANT = process.env.PLAN === "instant";
const ACCT = PROMO ? 247_000 : 100_000;
const DAILY = 0.03 * ACCT, MAXDD = (PROMO ? 0.10 : 0.06) * ACCT;
const TARGETS = PROMO ? [0.10 * ACCT, 0.10 * ACCT, 0.10 * ACCT] : INSTANT ? [] : [0.10 * ACCT, 0.05 * ACCT];
const FEE = Number(process.env.FEE ?? 0.0004);       // per side, notional (Tradeify 0.04%)
const SLIP = Number(process.env.SLIP ?? 0.002);      // stop fill vs stop price on their feed
const CHASE = 0.001;
const STOP = 0.04;
const SLOTS = Number(process.env.SLOTS ?? 1);
const RESET_UTC = 22 * 3600;
const STARTDAY = Number(process.env.STARTDAY ?? 0);   // begin the eval N days into the data window

interface Sig { coin: string; t: number; px: number; tier: string }
interface Open { coin: string; entry: number; stop: number; peak: number; oneR: number; notional: number; openedT: number }

type Phase = "p1" | "p2" | "p3" | "funded";
interface Result {
  seed: number; risk: number;
  breached: string | null; breachDay: number | null; breachPhase: Phase | null;
  passedP1Day: number | null; passedP2Day: number | null;
  fundedPnl: number; fundedDays: number; trades: number; wins: number;
  worstDay: number; worstDD: number; monthlyPnl: Record<string, number>;
}

function run(sigsIn: Sig[], bars: Record<string, { h4: KrakenBar[] }>, risk: number, seed: number): Result {
  const p = exitParams("swing-lev", 5, 1);
  const holdBars = Math.ceil(p.maxHoldH / 4);
  // same seeded tiebreak as the desk replay — the choice among same-bar breakouts is luck
  let rnd = seed * 2654435761 >>> 0;
  const nextR = () => ((rnd = (rnd * 1664525 + 1013904223) >>> 0) / 4294967296);
  const jitter = new Map<Sig, number>();
  for (const s of sigsIn) jitter.set(s, nextR());
  const cut = sigsIn[0].t + STARTDAY * 86400;
  const sigs = [...sigsIn].filter((x) => x.t >= cut).sort((a, b) => a.t - b.t || (jitter.get(a)! - jitter.get(b)!));

  const step = 4 * 3600;
  const t0 = sigs[0].t, tEnd = sigs[sigs.length - 1].t + holdBars * step;
  const riskUsd = ACCT * risk;

  let balance = ACCT;               // closed-trade balance
  let phase: Phase = INSTANT ? "funded" : "p1";
  let highClosed = ACCT;   // instant: the trailing reference
  let phaseStart = ACCT;            // balance at phase start (phase 2 and funded restart at $100k)
  let snapshot = ACCT;              // 22:00 UTC closing balance → daily floor
  let lastResetDay = Math.floor((t0 - RESET_UTC) / 86400);
  const open: Open[] = [];
  const r: Result = { seed, risk, breached: null, breachDay: null, breachPhase: null, passedP1Day: null, passedP2Day: null, fundedPnl: 0, fundedDays: 0, trades: 0, wins: 0, worstDay: 0, worstDD: 0, monthlyPnl: {} };
  let fundedSince = INSTANT ? t0 : 0;
  let si = 0;

  const closeAll = () => { open.length = 0; };
  const day = (t: number) => (t - t0) / 86400;

  for (let t = t0; t <= tEnd; t += step) {
    // 22:00 UTC reset: new daily snapshot from the closing balance
    const resetDay = Math.floor((t - RESET_UTC) / 86400);
    if (resetDay > lastResetDay) { lastResetDay = resetDay; snapshot = balance; }

    // 1. worst intraday mark for this bar — the breach checks run on live equity
    let worstMark = balance;
    for (const o of open) {
      const b = bars[o.coin].h4.find((x) => x.t === t); if (!b) continue;
      const lowPx = Math.max(b.l, o.stop * (1 - SLIP));      // a stop caps the loss at the fill
      worstMark += o.notional * (lowPx - o.entry) / o.entry - o.notional * FEE;
    }
    const floor = INSTANT ? Math.min(ACCT, highClosed - MAXDD) : ACCT - MAXDD;
    const dayLoss = snapshot - worstMark, dd = worstMark <= floor ? MAXDD : ACCT - worstMark;
    r.worstDay = Math.max(r.worstDay, dayLoss); r.worstDD = Math.max(r.worstDD, dd);
    // the funded floor: 2-Step funded keeps the static floor at start − 6%, no payout lock
    if (dayLoss >= DAILY || dd >= MAXDD) {
      r.breached = dayLoss >= DAILY ? "daily 3%" : "max 6%";
      r.breachDay = Math.round(day(t)); r.breachPhase = phase;
      closeAll();
      break;
    }

    // 2. resolve open trades exactly as the desk does
    for (let k = open.length - 1; k >= 0; k--) {
      const o = open[k];
      const b = bars[o.coin].h4.find((x) => x.t === t); if (!b) continue;
      const ageBars = Math.round((t - o.openedT) / step);
      let exit: number | null = null;
      if (b.l <= o.stop) exit = o.stop * (1 - SLIP);
      else if (ageBars >= holdBars) exit = b.c;
      else { o.peak = Math.max(o.peak, b.h); o.stop = managedStop(1, o.entry, o.peak, o.stop, o.oneR, p); }
      if (exit == null) continue;
      const pnl = o.notional * (exit - o.entry) / o.entry - o.notional * FEE * 2;
      balance += pnl; r.trades++; if (pnl > 0) r.wins++; highClosed = Math.max(highClosed, balance);
      if (process.env.TRADES) console.log(`  ${new Date(t * 1000).toISOString().slice(0, 16)} ${phase.padEnd(6)} ${o.coin.padEnd(6)} entry ${o.entry.toPrecision(5)} exit ${exit.toPrecision(5)} notional $${Math.round(o.notional)} pnl ${Math.round(pnl)} bal ${Math.round(balance)}`);
      if (phase === "funded") { r.fundedPnl += pnl; const k2 = new Date(t * 1000).toISOString().slice(0, 7); r.monthlyPnl[k2] = (r.monthlyPnl[k2] ?? 0) + pnl; }
      open.splice(k, 1);
    }

    // 3. phase transitions on closed balance (targets are balance targets)
    if (phase !== "funded") {
      const pi = Number(phase[1]) - 1;
      if (balance - phaseStart >= TARGETS[pi]) {
        if (pi === 0) r.passedP1Day = Math.round(day(t));
        if (pi === TARGETS.length - 1) { phase = "funded"; r.passedP2Day = Math.round(day(t)); fundedSince = t; }
        else phase = (`p${pi + 2}`) as Phase;
        balance = ACCT; phaseStart = ACCT; snapshot = ACCT; closeAll();
      }
    }
    if (phase === "funded") r.fundedDays = (t - fundedSince) / 86400;

    // 4. entries — fixed-dollar risk, one slot
    while (si < sigs.length && sigs[si].t === t) {
      const s = sigs[si++];
      if (open.length >= SLOTS) continue;
      if (open.some((o) => o.coin === s.coin)) continue;
      // never open a trade whose full stop-out would breach the day — the bot must know the rule
      const roomToday = worstMark - (snapshot - DAILY);   // equity left before today's floor
      // size DOWN to fit the room (a prop-aware bot would), refuse only when the fit is tiny
      const fit = (Math.min(roomToday, balance - (INSTANT ? Math.min(ACCT, highClosed - MAXDD) : ACCT - MAXDD)) / (1 + SLIP / STOP)) * 0.9;
      const use = Math.min(riskUsd, fit);
      if (use < riskUsd * 0.25) continue;
      const entry = s.px * (1 + CHASE);
      const notional = use / STOP;
      open.push({ coin: s.coin, entry, stop: entry * (1 - STOP), peak: entry, oneR: entry * STOP, notional, openedT: t });
    }
  }
  return r;
}

function main() {
  if (!existsSync(CACHE) || !existsSync(SIGCACHE)) throw new Error("bar/signal cache missing — run backtest-portfolio.ts TIER=high first");
  const bars = JSON.parse(readFileSync(CACHE, "utf8"));
  const sigs: Sig[] = (JSON.parse(readFileSync(SIGCACHE, "utf8")) as Sig[]).filter((s) => s.tier === "high").sort((a, b) => a.t - b.t);
  const days = (sigs[sigs.length - 1].t - sigs[0].t) / 86400;
  const f = (x: number) => (x < 0 ? "−" : "") + "$" + Math.round(Math.abs(x)).toLocaleString();
  console.log(`Tradeify 247 · ${PROMO ? "$247k 3-Step PROMO (10% static DD)" : INSTANT ? "$100k INSTANT (6% trailing, funded day 0)" : "$100k 2-Step (6% static DD)"} · swing-lev high conviction · ${sigs.length} signals over ${days.toFixed(0)} days (${new Date(sigs[0].t * 1000).toISOString().slice(0, 10)} → ${new Date(sigs[sigs.length - 1].t * 1000).toISOString().slice(0, 10)})`);
  console.log(`rules: daily −3% (from 22:00 UTC snapshot, live equity) · max −6% static · 0.04%/side · stop slip ${(SLIP * 100).toFixed(2)}% · ${SLOTS} slot\n`);

  const risks = process.env.RISK ? [Number(process.env.RISK)] : [0.005, 0.01, 0.015, 0.02, 0.025, 0.03];
  const seeds = process.env.SEED ? [Number(process.env.SEED)] : [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
  console.log("risk/trade  breached   passedP1   FUNDED    median P1 day  fundedP&L/mo(80%)  worst day  worst DD  trades  win%");
  for (const risk of risks) {
    const rs = seeds.map((s) => run(sigs, bars, risk, s));
    const breached = rs.filter((x) => x.breached).length;
    const p1 = rs.filter((x) => x.passedP1Day != null), p2 = rs.filter((x) => x.passedP2Day != null);
    const med = (a: number[]) => { const b = [...a].sort((x, y) => x - y); return b.length ? b[Math.floor(b.length / 2)] : NaN; };
    const funded = rs.filter((x) => x.fundedDays > 7);
    const fundedMo = funded.length ? med(funded.map((x) => x.fundedPnl / x.fundedDays * 30 * 0.8)) : NaN;
    const worstDay = Math.max(...rs.map((x) => x.worstDay)), worstDD = Math.max(...rs.map((x) => x.worstDD));
    const tr = rs.reduce((a, x) => a + x.trades, 0), w = rs.reduce((a, x) => a + x.wins, 0);
    console.log(
      `  ${(risk * 100).toFixed(1).padStart(4)}%     ${String(breached).padStart(2)}/${rs.length}      ${String(p1.length).padStart(2)}/${rs.length}      ${String(p2.length).padStart(2)}/${rs.length}     ` +
      `${(p1.length ? String(med(p1.map((x) => x.passedP1Day!))) : "—").padStart(6)}        ` +
      `${(Number.isFinite(fundedMo) ? f(fundedMo) : "—").padStart(9)}        ${f(worstDay).padStart(7)}   ${f(worstDD).padStart(7)}   ${String(Math.round(tr / rs.length)).padStart(3)}   ${((w / tr) * 100).toFixed(0)}%`,
    );
    if (process.env.VERBOSE) for (const x of rs) console.log(`      seed ${x.seed}: ${x.breached ? `BREACH ${x.breached} day ${x.breachDay} in ${x.breachPhase}` : "alive"}  P1 ${x.passedP1Day ?? "—"}  P2 ${x.passedP2Day ?? "—"}  funded ${f(x.fundedPnl)} over ${x.fundedDays.toFixed(0)}d  ${JSON.stringify(x.monthlyPnl)}`);
  }
  console.log("\nA breach is the whole account. 'fundedP&L/mo' is the trader's 80% share, median over seeds that reached funding for 7+ days — on THIS window only.");
}
main();
