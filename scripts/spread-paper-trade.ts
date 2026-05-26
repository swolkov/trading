/**
 * SPREAD PAPER-TRADING ACCOUNT — a $50K paper account trading the VALIDATED spread edge, forward.
 *
 * Stateful: opens/closes the 7 robust spread positions on the daily z-score rules, fills at the close
 * with MEASURED costs, sized at a professional 1% ($500) risk per spread, and tracks a real equity curve.
 * SAFE — a pure simulation, isolated from the Railway engines (no order API, no real/paper broker calls).
 * This is the watchable, credible forward track record that raises the fund. The $1K live can't trade this
 * (capital); the $50K demo can. State persists → reports/spread-paper-account.json (advances each run).
 *
 *   npx tsx scripts/spread-paper-trade.ts          advance to the latest data, print the account
 *   npx tsx scripts/spread-paper-trade.ts --reset  start a fresh $50K account (seeds the last 18mo curve)
 */
import fs from "node:fs";

const CAPITAL0 = 50_000, RISK_DOLLARS = 500;          // $50K; 1% = $500 risk per spread (pro sizing)
const PAIRS: [string, string][] = [["CL", "RB"], ["CL", "HO"], ["ZC", "ZS"], ["ZW", "ZC"], ["ZS", "ZW"], ["6E", "6B"], ["6A", "6C"], ["GC", "HG"]];
const P = { lookback: 60, entryZ: 2, exitZ: 0, stopZ: 3.5, maxHold: 40 };
const COST_BPS: Record<string, number> = { "CL/RB": 4.19, "CL/HO": 5.63, "ZC/ZS": 7.42, "ZW/ZC": 9.14, "ZS/ZW": 5.88, "6E/6B": 1.18, "6A/6C": 1.39, "GC/HG": 1.69 };
const COMMISSION_BPS = 2.0, FORWARD_MONTHS = 18;

const dailyDir = new URL("../data/daily/", import.meta.url);
const STATE = new URL("../reports/spread-paper-account.json", import.meta.url);

function loadCloses(sym: string): Map<string, number> {
  const m = new Map<string, number>();
  try { for (const r of fs.readFileSync(new URL(`${sym}_1d.csv`, dailyDir), "utf8").trim().split("\n").slice(1)) { const c = r.split(","); const p = +c[7]; if (isFinite(p) && p > 0) m.set(c[0].slice(0, 10), p); } } catch { }
  return m;
}

interface Pos { dir: number; entryRatio: number; entryDate: string; fs: number; barsHeld: number; }
interface State { equity: number; peak: number; positions: Record<string, Pos>; ledger: { pair: string; entry: string; exit: string; R: number; pnl: number; reason: string }[]; lastDate: string | null; curve: { date: string; equity: number }[]; }

function main() {
  const reset = process.argv.includes("--reset");
  const legs = [...new Set(PAIRS.flat())];
  const closes: Record<string, Map<string, number>> = {};
  for (const s of legs) closes[s] = loadCloses(s);
  const allDates = [...new Set(legs.flatMap(s => [...closes[s].keys()]))].sort();
  if (allDates.length < P.lookback + 5) { console.log("Not enough daily data — run scripts/dbn-fetch-daily.ts"); return; }
  const lastAvail = allDates[allDates.length - 1];

  // per-pair ratio series (intersection of the two legs' dates) + fast index lookup
  const PD: Record<string, { ds: string[]; ratio: number[]; idxOf: Map<string, number> }> = {};
  for (const [a, b] of PAIRS) {
    const A = closes[a], B = closes[b]; const ds = allDates.filter(d => A.has(d) && B.has(d));
    PD[`${a}/${b}`] = { ds, ratio: ds.map(d => A.get(d)! / B.get(d)!), idxOf: new Map(ds.map((d, i) => [d, i])) };
  }

  let st: State;
  if (reset || !fs.existsSync(STATE)) {
    const cut = new Date(lastAvail + "T00:00:00Z"); cut.setUTCMonth(cut.getUTCMonth() - FORWARD_MONTHS);
    st = { equity: CAPITAL0, peak: CAPITAL0, positions: {}, ledger: [], lastDate: cut.toISOString().slice(0, 10), curve: [{ date: cut.toISOString().slice(0, 10), equity: CAPITAL0 }] };
  } else st = JSON.parse(fs.readFileSync(STATE, "utf8"));

  const newDates = allDates.filter(d => st.lastDate === null || d > st.lastDate);
  const actions: string[] = [];
  for (const date of newDates) {
    for (const [a, b] of PAIRS) {
      const key = `${a}/${b}`; const { ds, ratio, idxOf } = PD[key];
      const idx = idxOf.get(date); if (idx === undefined || idx < P.lookback) continue;   // this pair has no bar today / not enough history
      const w = ratio.slice(idx - P.lookback, idx);
      const m = w.reduce((s, v) => s + v, 0) / P.lookback;
      const sd = Math.sqrt(w.reduce((s, v) => s + (v - m) ** 2, 0) / P.lookback) || 1e-9;
      const r = ratio[idx], z = (r - m) / sd;
      const pos = st.positions[key];
      if (pos) {
        pos.barsHeld++;
        const revert = pos.dir === -1 ? z <= P.exitZ : z >= P.exitZ, stopped = Math.abs(z) >= P.stopZ, timeout = pos.barsHeld >= P.maxHold;
        if (revert || stopped || timeout) {
          const R = (pos.dir * (r - pos.entryRatio) / pos.entryRatio) / (1.5 * pos.fs);
          const costR = ((COST_BPS[key] + COMMISSION_BPS) / 1e4) / (1.5 * pos.fs);
          const pnl = (R - costR) * RISK_DOLLARS;
          st.equity += pnl; st.peak = Math.max(st.peak, st.equity);
          st.ledger.push({ pair: key, entry: pos.entryDate, exit: date, R: +R.toFixed(3), pnl: Math.round(pnl), reason: stopped ? "stop" : timeout ? "timeout" : "revert" });
          delete st.positions[key];
          actions.push(`${date}  CLOSE ${key.padEnd(7)} ${pos.dir > 0 ? "long " : "short"} → ${R >= 0 ? "+" : ""}${R.toFixed(2)}R  ${pnl >= 0 ? "+" : ""}$${Math.round(pnl)}`);
        }
      }
      if (!st.positions[key]) {
        if (z > P.entryZ) { st.positions[key] = { dir: -1, entryRatio: r, entryDate: date, fs: sd / m, barsHeld: 0 }; actions.push(`${date}  OPEN  ${key.padEnd(7)} short (z=${z.toFixed(1)})`); }
        else if (z < -P.entryZ) { st.positions[key] = { dir: 1, entryRatio: r, entryDate: date, fs: sd / m, barsHeld: 0 }; actions.push(`${date}  OPEN  ${key.padEnd(7)} long  (z=${z.toFixed(1)})`); }
      }
    }
    st.curve.push({ date, equity: Math.round(st.equity) });
  }
  st.lastDate = lastAvail;
  fs.mkdirSync(new URL("../reports/", import.meta.url), { recursive: true });
  fs.writeFileSync(STATE, JSON.stringify(st, null, 2));

  // ── report ──
  const ret = (st.equity / CAPITAL0 - 1) * 100;
  let peak = CAPITAL0, maxDD = 0; for (const c of st.curve) { peak = Math.max(peak, c.equity); maxDD = Math.min(maxDD, (c.equity - peak) / peak * 100); }
  const closed = st.ledger; const wins = closed.filter(t => t.pnl > 0);
  const open = Object.entries(st.positions);
  const start = st.curve[0]?.date, days = (new Date(lastAvail).getTime() - new Date(start).getTime()) / 86_400_000;
  const cagr = days > 0 ? ((st.equity / CAPITAL0) ** (365 / days) - 1) * 100 : 0;
  const W = 86; const bar = "═".repeat(W);
  console.log("\n" + bar);
  console.log(`  SPREAD PAPER ACCOUNT  (the $50K demo trading the validated edge)  →  reports/spread-paper-account.json`);
  console.log(bar);
  console.log(`  Equity:   $${st.equity.toLocaleString(undefined, { maximumFractionDigits: 0 })}   (start $${CAPITAL0.toLocaleString()})   return ${ret >= 0 ? "+" : ""}${ret.toFixed(1)}%   ≈ ${cagr >= 0 ? "+" : ""}${cagr.toFixed(0)}%/yr`);
  console.log(`  Period:   ${start} → ${lastAvail}   ·   max drawdown ${maxDD.toFixed(1)}%`);
  console.log(`  Trades:   ${closed.length} closed · win rate ${closed.length ? (wins.length / closed.length * 100).toFixed(0) : 0}% · ${open.length} open now`);
  if (open.length) { console.log("  Open positions:"); for (const [k, p] of open) console.log(`     ${k.padEnd(8)} ${p.dir > 0 ? "long " : "short"}  since ${p.entryDate}  (held ${p.barsHeld}d)`); }
  if (actions.length) { console.log(`\n  Latest activity (${Math.min(actions.length, 6)} of ${actions.length}):`); for (const a of actions.slice(-6)) console.log("     " + a); }
  // equity curve — monthly samples
  const monthly = new Map<string, number>(); for (const c of st.curve) monthly.set(c.date.slice(0, 7), c.equity);
  const ms = [...monthly.entries()]; const step = Math.max(1, Math.floor(ms.length / 12));
  console.log("\n  Equity curve (monthly):");
  for (let i = 0; i < ms.length; i += step) { const [mo, eq] = ms[i]; const len = Math.round((eq - CAPITAL0) / 1000); console.log(`     ${mo}  $${eq.toLocaleString().padStart(8)}  ${len >= 0 ? "+".repeat(Math.min(len, 50)) : "-".repeat(Math.min(-len, 50))}`); }
  console.log(bar + "\n");
}
main();
