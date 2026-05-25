/**
 * SESSION / TIME-OF-DAY edge test — WHEN do futures returns actually happen?
 * Decomposes each day into three sessions (ET) using 3yr of 1-minute data:
 *   • Asia/overnight : prior 16:00 close → 03:00 ET
 *   • London/Europe  : 03:00 → 09:30 ET (US cash open)
 *   • US RTH         : 09:30 → 16:00 ET (US cash session)
 * Tests the documented "overnight edge" (in equity index futures, most of the return is overnight,
 * intraday is ~flat) and where gold's move concentrates.    npx tsx scripts/session-test.ts
 */
import fs from "node:fs";

// US Eastern DST: 2nd Sunday of March 07:00 UTC → 1st Sunday of November 06:00 UTC = EDT(-4), else EST(-5)
function nthSundayUTC(year: number, monthIdx: number, n: number, hourUTC: number): number {
  const first = new Date(Date.UTC(year, monthIdx, 1));
  const firstSunday = (7 - first.getUTCDay()) % 7 + 1;
  return Date.UTC(year, monthIdx, firstSunday + (n - 1) * 7, hourUTC);
}
function etParts(utcMs: number): { etMin: number; dayKey: string } {
  const y = new Date(utcMs).getUTCFullYear();
  const isEDT = utcMs >= nthSundayUTC(y, 2, 2, 7) && utcMs < nthSundayUTC(y, 10, 1, 6);
  const et = new Date(utcMs + (isEDT ? -4 : -5) * 3600_000);
  return { etMin: et.getUTCHours() * 60 + et.getUTCMinutes(), dayKey: et.toISOString().slice(0, 10) };
}

interface Px { etMin: number; c: number; }
function nearest(arr: Px[], target: number, tol = 25): number | null {
  let best: number | null = null, bd = 1e9;
  for (const p of arr) { const d = Math.abs(p.etMin - target); if (d < bd && d <= tol) { bd = d; best = p.c; } }
  return best;
}

function analyze(sym: string) {
  const rows = fs.readFileSync(new URL(`../data/${sym}_1m.csv`, import.meta.url), "utf8").trim().split("\n").slice(1);
  const byDay = new Map<string, Px[]>();
  for (const r of rows) {
    const c = r.split(","); const close = +c[7]; if (!isFinite(close)) continue;
    const { etMin, dayKey } = etParts(new Date(c[0]).getTime());
    (byDay.get(dayKey) ?? byDay.set(dayKey, []).get(dayKey)!).push({ etMin, c: close });
  }
  const days = [...byDay.keys()].sort();
  // per-day reference prices
  const ref = new Map<string, { p0300: number | null; p0930: number | null; p1600: number | null }>();
  for (const d of days) { const a = byDay.get(d)!; ref.set(d, { p0300: nearest(a, 180), p0930: nearest(a, 570), p1600: nearest(a, 960) }); }

  // accumulate log returns per session, by year
  const seg = { asia: new Map<number, number>(), london: new Map<number, number>(), us: new Map<number, number>() };
  const cnt = { asia: [0, 0], london: [0, 0], us: [0, 0] }; // [positive, total]
  const add = (m: Map<number, number>, y: number, v: number) => m.set(y, (m.get(y) ?? 0) + v);
  for (let i = 1; i < days.length; i++) {
    const y = +days[i].slice(0, 4);
    const prev = ref.get(days[i - 1])!, cur = ref.get(days[i])!;
    if (prev.p1600 && cur.p0300) { const r = Math.log(cur.p0300 / prev.p1600); add(seg.asia, y, r); cnt.asia[1]++; if (r > 0) cnt.asia[0]++; }
    if (cur.p0300 && cur.p0930) { const r = Math.log(cur.p0930 / cur.p0300); add(seg.london, y, r); cnt.london[1]++; if (r > 0) cnt.london[0]++; }
    if (cur.p0930 && cur.p1600) { const r = Math.log(cur.p1600 / cur.p0930); add(seg.us, y, r); cnt.us[1]++; if (r > 0) cnt.us[0]++; }
  }
  const total = (m: Map<number, number>) => [...m.values()].reduce((a, b) => a + b, 0);
  const pct = (x: number) => (x * 100).toFixed(1) + "%";
  console.log(`\n${sym}:`);
  for (const [name, m, c] of [["Asia/overnight (16:00→03:00)", seg.asia, cnt.asia], ["London/Europe (03:00→09:30)", seg.london, cnt.london], ["US RTH (09:30→16:00)", seg.us, cnt.us]] as [string, Map<number, number>, number[]][]) {
    const years = [...m.keys()].sort();
    const yp = years.map(y => `${String(y).slice(2)}:${(m.get(y)! * 100) >= 0 ? "+" : ""}${(m.get(y)! * 100).toFixed(0)}`).join(" ");
    console.log(`  ${name.padEnd(30)} total ${pct(total(m)).padStart(8)}  winDays ${((c[0] / c[1]) * 100).toFixed(0)}%   [${yp}]`);
  }
}

function main() {
  console.log("\n" + "═".repeat(78));
  console.log("  SESSION EDGE — where do futures returns happen? (cumulative log-return, 3yr)");
  console.log("  Documented: equity index 'overnight edge' — most return is overnight, intraday ~flat");
  console.log("═".repeat(78));
  for (const sym of ["ES", "NQ", "GC"]) { try { analyze(sym); } catch (e) { console.log(`${sym}: ${e instanceof Error ? e.message : e}`); } }
  console.log("\n" + "═".repeat(78) + "\n");
}
main();
