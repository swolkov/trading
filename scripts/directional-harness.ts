/**
 * DIRECTIONAL MICRO-FUTURES HARNESS — same falsification discipline as the spread lab.
 * Tests INTRADAY directional setups (RTH only, hard bracket stops, net of cost) on ES/NQ/GC 1-min.
 * Tests the categories NOT already falsified earlier: VWAP reclaim, liquidation-reversal, high-vol
 * mean-reversion. Reports per-trade R, by-year consistency, win%, MAE/MFE — honest rejection expected.
 * LIMIT: 1-min (not tick) = optimistic intrabar stops; 3yr (not 15yr) for ES/NQ/GC.
 *   npx tsx scripts/directional-harness.ts
 */
import fs from "node:fs";
function nthSun(y: number, mo: number, n: number, h: number) { const f = new Date(Date.UTC(y, mo, 1)); return Date.UTC(y, mo, ((7 - f.getUTCDay()) % 7 + 1) + (n - 1) * 7, h); }
function et(ms: number) { const y = new Date(ms).getUTCFullYear(); const edt = ms >= nthSun(y, 2, 2, 7) && ms < nthSun(y, 10, 1, 6); const d = new Date(ms + (edt ? -4 : -5) * 3600_000); return { min: d.getUTCHours() * 60 + d.getUTCMinutes(), day: d.toISOString().slice(0, 10) }; }

interface Bar { m: number; o: number; h: number; l: number; c: number; v: number; }
function sessions(sym: string): Map<string, Bar[]> {
  const rows = fs.readFileSync(new URL(`../data/${sym}_1m.csv`, import.meta.url), "utf8").trim().split("\n").slice(1);
  const byDay = new Map<string, Bar[]>();
  for (const r of rows) { const x = r.split(","); const c = +x[7]; if (!isFinite(c)) continue; const p = et(new Date(x[0]).getTime()); if (p.min < 570 || p.min > 960) continue; (byDay.get(p.day) ?? byDay.set(p.day, []).get(p.day)!).push({ m: p.min, o: +x[4], h: +x[5], l: +x[6], c, v: +x[8] || 1 }); }
  for (const a of byDay.values()) a.sort((x, y) => x.m - y.m);
  return byDay;
}
const TICK: Record<string, number> = { ES: 0.25, NQ: 0.25, GC: 0.10 };
interface Tr { R: number; year: number; mae: number; mfe: number; }

// generic intraday runner: a setup returns {dir, stopDist} at bar i (or null); exit = +2R / -1R / session end
function run(sym: string, setup: (bars: Bar[], i: number, vwap: number, atr: number) => { dir: number; stop: number } | null): Tr[] {
  const days = sessions(sym); const out: Tr[] = []; const tick = TICK[sym];
  for (const [day, bars] of days) {
    if (bars.length < 60) continue; const year = +day.slice(0, 4);
    let cumPV = 0, cumV = 0; let pos: { dir: number; entry: number; stop: number; risk: number; mae: number; mfe: number } | null = null;
    for (let i = 0; i < bars.length; i++) {
      const b = bars[i]; cumPV += ((b.h + b.l + b.c) / 3) * b.v; cumV += b.v; const vwap = cumPV / cumV;
      const atr = i >= 14 ? bars.slice(i - 14, i).reduce((s, x, k, arr) => s + (k ? Math.max(x.h - x.l, Math.abs(x.h - arr[k - 1].c)) : x.h - x.l), 0) / 14 : (b.h - b.l);
      if (pos) {
        const long = pos.dir === 1; const adv = long ? b.h - pos.entry : pos.entry - b.h; // favorable
        pos.mfe = Math.max(pos.mfe, (long ? b.h - pos.entry : pos.entry - b.l) / pos.risk);
        pos.mae = Math.min(pos.mae, (long ? b.l - pos.entry : pos.entry - b.h) / pos.risk);
        const hitStop = long ? b.l <= pos.stop : b.h >= pos.stop;
        const target = long ? pos.entry + 2 * pos.risk : pos.entry - 2 * pos.risk;
        const hitTgt = long ? b.h >= target : b.l <= target;
        const sessionEnd = i === bars.length - 1;
        let exit: number | null = null;
        if (hitStop) exit = pos.stop; else if (hitTgt) exit = target; else if (sessionEnd) exit = b.c;
        if (exit !== null) { const px = long ? exit - tick : exit + tick; const comm = tick; const R = ((long ? px - pos.entry : pos.entry - px) - comm) / pos.risk; out.push({ R, year, mae: pos.mae, mfe: pos.mfe }); pos = null; }
      }
      if (!pos && atr > 0 && i >= 15 && i < bars.length - 5) {
        const sig = setup(bars, i, vwap, atr); if (sig && sig.stop > 0) { const entry = sig.dir === 1 ? b.c + tick : b.c - tick; pos = { dir: sig.dir, entry, stop: entry - sig.dir * sig.stop, risk: sig.stop, mae: 0, mfe: 0 }; }
      }
    }
  }
  return out;
}

// ---- the untested setup categories ----
const SETUPS: Record<string, (b: Bar[], i: number, vwap: number, atr: number) => { dir: number; stop: number } | null> = {
  "VWAP reclaim": (b, i, vwap, atr) => { const prev = b[i - 1].c, cur = b[i].c; if (prev < vwap && cur > vwap) return { dir: 1, stop: atr }; if (prev > vwap && cur < vwap) return { dir: -1, stop: atr }; return null; },
  "Liquidation reversal": (b, i, _v, atr) => { const move = b[i].c - b[i - 10].c; if (move < -3 * atr) return { dir: 1, stop: 1.5 * atr }; if (move > 3 * atr) return { dir: -1, stop: 1.5 * atr }; return null; },
  "High-vol mean-rev": (b, i, vwap, atr) => { const d = (b[i].c - vwap) / atr; if (d > 2.5) return { dir: -1, stop: atr }; if (d < -2.5) return { dir: 1, stop: atr }; return null; },
};

function main() {
  const mean = (a: number[]) => a.reduce((s, v) => s + v, 0) / (a.length || 1);
  console.log("\n" + "═".repeat(82));
  console.log("  DIRECTIONAL MICRO HARNESS — RTH intraday, hard stops, net of cost (ES/NQ/GC 1m, 3yr)");
  console.log("═".repeat(82));
  for (const [name, fn] of Object.entries(SETUPS)) {
    let all: Tr[] = []; for (const s of ["ES", "NQ", "GC"]) all = all.concat(run(s, fn));
    if (all.length < 50) { console.log(`\n  ${name}: only ${all.length} trades — insufficient`); continue; }
    const R = all.map(t => t.R), years = [...new Set(all.map(t => t.year))].sort();
    const posY = years.filter(y => mean(all.filter(t => t.year === y).map(t => t.R)) > 0).length;
    const wr = R.filter(r => r > 0).length / R.length;
    console.log(`\n  ${name}:  n=${all.length} (~${(all.length / years.length).toFixed(0)}/yr)  win ${(wr * 100).toFixed(0)}%  avg ${mean(R) >= 0 ? "+" : ""}${mean(R).toFixed(3)}R  +in ${posY}/${years.length}yr`);
    console.log(`     by year: ${years.map(y => `${String(y).slice(2)} ${(mean(all.filter(t => t.year === y).map(t => t.R)) >= 0 ? "+" : "")}${mean(all.filter(t => t.year === y).map(t => t.R)).toFixed(2)}`).join("  ")}`);
    console.log(`     MAE(avg) ${mean(all.map(t => t.mae)).toFixed(2)}R  MFE(avg) ${mean(all.map(t => t.mfe)).toFixed(2)}R   VERDICT: ${mean(R) > 0.05 && posY >= years.length * 0.75 ? "🟡 worth deeper test" : "❌ no edge — reject"}`);
  }
  console.log("\n" + "═".repeat(82) + "\n");
}
main();
