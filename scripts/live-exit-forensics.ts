/**
 * LIVE EXIT FORENSICS — replay every REAL live index fill against alternative exit rules.
 *
 * WHY THIS EXISTS: scripts/index-edge-validation.ts fires ~3x more often than production and wins
 * 38% where live wins 66%, so its optimal exit parameters are optimal FOR A POPULATION LIVE DOES
 * NOT TRADE. It already misled me once (see that file's header). This script has no entry model at
 * all — it takes the actual broker fills out of RoundTrip and only re-runs the EXIT, so the trade
 * population is exactly the one the account really took.
 *
 * Each trade is replayed from its real entry price/time over 1-minute bars, to a common 4-hour
 * horizon so a variant is never truncated by the exit the engine actually chose.
 */
import fs from "node:fs"; import { prisma } from "../src/lib/db";

const PV: Record<string, number> = { MNQ: 2, MES: 5, NQ: 20, ES: 50 };
const SRC: Record<string, string> = { MNQ: "NQ", MES: "ES", NQ: "NQ", ES: "ES" };
interface B { t: number; h: number; l: number; c: number }
const cache = new Map<string, B[]>();
function bars(sym: string): B[] {
  const k = SRC[sym]; if (cache.has(k)) return cache.get(k)!;
  const out: B[] = [];
  for (const line of fs.readFileSync(new URL(`../data/live-window/${k}_1m.csv`, import.meta.url), "utf8").split("\n").slice(1)) {
    if (!line) continue; const f = line.split(","); const t = Date.parse(f[0]); const c = +f[7];
    const h = +f[5], l = +f[6];
    if (isFinite(t) && isFinite(c) && c > 0 && isFinite(h) && isFinite(l) && h > 0 && l > 0) out.push({ t, h, l, c });
  }
  out.sort((a, b) => a.t - b.t); cache.set(k, out); return out;
}

interface Cfg { be: number; lock: number; trail: number; tgt: number; stale?: number }
/** Replay one trade's exit. Returns R captured. */
function replay(w: B[], entry: number, long: boolean, stopDist: number, c: Cfg): number {
  let stop = long ? entry - stopDist : entry + stopDist, peak = 0, armed = false;
  const t0 = w[0].t;
  const tgt = long ? entry + stopDist * c.tgt : entry - stopDist * c.tgt;
  for (const b of w) {
    // adverse first within the bar — the conservative assumption
    const adverse = long ? b.l : b.h;
    if (long ? adverse <= stop : adverse >= stop) return (stop - entry) / stopDist * (long ? 1 : -1);
    const fav = long ? b.h : b.l;
    if (long ? fav >= tgt : fav <= tgt) return c.tgt;
    // STALE EXIT, as the engine enforces it: a trade that has not reached 1R and never armed
    // breakeven is closed at market after `stale` minutes.
    if (c.stale && !armed && peak < 1.0 && (b.t - t0) >= c.stale * 60_000)
      return (long ? b.c - entry : entry - b.c) / stopDist;
    const excursion = (long ? fav - entry : entry - fav) / stopDist;
    if (excursion > peak) peak = excursion;
    if (!armed && peak >= c.be) { armed = true; stop = entry; }
    if (peak >= 1.0) { const lk = long ? entry + stopDist * c.lock * peak : entry - stopDist * c.lock * peak; stop = long ? Math.max(stop, lk) : Math.min(stop, lk); }
    if (peak >= 1.1) { const tr = long ? b.c - stopDist * c.trail : b.c + stopDist * c.trail; stop = long ? Math.max(stop, tr) : Math.min(stop, tr); }
  }
  const last = w[w.length - 1].c;
  return (long ? last - entry : entry - last) / stopDist;
}

(async () => {
  const MODE = process.env.MODE || "live";
  const rt = (await prisma.roundTrip.findMany({ where: MODE === "all" ? {} : { mode: MODE }, orderBy: { entryTime: "asc" } }))
    .filter(t => PV[t.symbol] && t.rMultiple != null && t.entryPrice && t.entryTime);
  const rows: { sym: string; long: boolean; entry: number; stopDist: number; w: B[]; actual: number; mfe: number; mae: number }[] = [];
  for (const t of rt) {
    const bs = bars(t.symbol), a = t.entryTime!.getTime();
    const HZ = parseFloat(process.env.HZ || '240');
    const w = bs.filter(x => x.t >= a && x.t <= a + HZ * 60_000);
    if (w.length < 5) continue;
    if (!isFinite(t.rMultiple!) || t.rMultiple === 0) continue;
    const long = t.direction === "long";
    const risk = Math.abs(t.pnl / t.rMultiple!);
    const stopDist = risk / (PV[t.symbol] * (t.contracts || 1));
    const hi = Math.max(...w.map(x => x.h)), lo = Math.min(...w.map(x => x.l));
    if (!isFinite(stopDist) || stopDist <= 0) continue;
    rows.push({ sym: t.symbol, long, entry: t.entryPrice!, stopDist, w, actual: t.rMultiple!,
      mfe: (long ? hi - t.entryPrice! : t.entryPrice! - lo) / stopDist,
      mae: (long ? t.entryPrice! - lo : hi - t.entryPrice!) / stopDist });
  }
  console.log(`\n  ${rows.length} REAL round-trips with bar coverage (mode=${MODE}, of ${rt.length})\n`);
  const sum = (a: number[]) => a.reduce((s, x) => s + x, 0);
  console.log(`  WHAT WAS AVAILABLE vs WHAT WE TOOK`);
  console.log(`    avg peak (MFE)      ${(sum(rows.map(r => r.mfe)) / rows.length).toFixed(2)}R`);
  console.log(`    avg actual captured ${(sum(rows.map(r => r.actual)) / rows.length).toFixed(2)}R`);
  console.log(`    capture ratio       ${(sum(rows.map(r => r.actual)) / sum(rows.map(r => r.mfe)) * 100).toFixed(0)}% of the peak`);
  const reached = (x: number) => rows.filter(r => r.mfe >= x).length;
  console.log(`    trades that reached  0.6R: ${reached(0.6)}/${rows.length}   1.0R: ${reached(1.0)}   1.5R: ${reached(1.5)}   2.33R: ${reached(2.33)}`);

  const base: Cfg = { be: 0.6, lock: 0.45, trail: 1.4 * 1.5 / 1.5, tgt: 2.33 };
  const variants: [string, Cfg][] = [
    ["NO stale exit (replay before)", base],
    ["LIVE NOW  stale 30m", { ...base, stale: 30 }],
    ["stale 45m", { ...base, stale: 45 }],
    ["stale 60m", { ...base, stale: 60 }],
    ["stale 90m", { ...base, stale: 90 }],
    ["stale 20m", { ...base, stale: 20 }],
    ["BE .8   be .8 lock .45", { ...base, be: 0.8 }],
    ["BE 1.0  be 1.0 lock .45", { ...base, be: 1.0 }],
    ["BE .8 + stale 90", { ...base, be: 0.8, stale: 90 }],
    ["lock .65      be .6 lock .65", { ...base, lock: 0.65 }],
    ["lock .80      be .6 lock .80", { ...base, lock: 0.80 }],
    ["BE .4         be .4 lock .45", { ...base, be: 0.4 }],
    ["BE .5         be .5 lock .45", { ...base, be: 0.5 }],
    ["BE .5+lock.65 be .5 lock .65", { ...base, be: 0.5, lock: 0.65 }],
    ["BE .4+lock.65 be .4 lock .65", { ...base, be: 0.4, lock: 0.65 }],
    ["target 1.5R   be .6 lock .45", { ...base, tgt: 1.5 }],
    ["target 1.5R+lock.65",          { ...base, tgt: 1.5, lock: 0.65 }],
  ];
  console.log(`\n  REPLAY ON THE REAL FILLS (avg R per trade, and total R over ${rows.length} trades)`);
  const scored = variants.map(([label, c]) => {
    const rs = rows.map(r => replay(r.w, r.entry, r.long, r.stopDist, c));
    const wins = rs.filter(x => x > 0.02).length;
    return { label, tot: sum(rs), avg: sum(rs) / rs.length, wr: wins / rs.length };
  }).sort((a, b) => b.tot - a.tot);
  for (const s of scored) {
    const flag = s.label.startsWith("LIVE NOW") ? "  ← current" : "";
    console.log(`    ${s.label.padEnd(30)} ${s.avg >= 0 ? "+" : ""}${s.avg.toFixed(3)}R/trade   total ${s.tot >= 0 ? "+" : ""}${s.tot.toFixed(1)}R   win ${(s.wr * 100).toFixed(0)}%${flag}`);
  }
  const cur = scored.find(s => s.label.startsWith("LIVE NOW"))!, best = scored[0];
  console.log(`\n  best = ${best.label.split(" ")[0]} at ${best.avg >= 0 ? "+" : ""}${best.avg.toFixed(3)}R vs current ${cur.avg.toFixed(3)}R  →  ${((best.avg - cur.avg) * 153).toFixed(0)} $/trade at $153 risk`);
  await prisma.$disconnect();
})();
