/**
 * STRUCTURAL EVENT STUDY — opening-drive / trend-day continuation (3yr 1-min, ES/NQ/GC). No fitting.
 * Hypothesis: a strong, directional FIRST HOUR (9:30–10:30 ET) → the day trends → rest-of-day
 * (10:30→16:00) continues in that direction. This is DAILY frequency (the freq the mission needs).
 * Forced participant: institutions executing a directional program through the session + momentum flow.
 * Measures rest-of-day move (in first-hour-range units) conditional on a strong open, by year.
 *   npx tsx scripts/study-opening-drive.ts
 */
import fs from "node:fs";

function nthSundayUTC(y: number, mo: number, n: number, h: number): number {
  const f = new Date(Date.UTC(y, mo, 1)); return Date.UTC(y, mo, ((7 - f.getUTCDay()) % 7 + 1) + (n - 1) * 7, h);
}
function et(ms: number) {
  const y = new Date(ms).getUTCFullYear();
  const edt = ms >= nthSundayUTC(y, 2, 2, 7) && ms < nthSundayUTC(y, 10, 1, 6);
  const d = new Date(ms + (edt ? -4 : -5) * 3600_000);
  return { min: d.getUTCHours() * 60 + d.getUTCMinutes(), day: d.toISOString().slice(0, 10) };
}

interface Ev { year: number; restR: number; }
function study(base: string): Ev[] {
  const rows = fs.readFileSync(new URL(`../data/${base}_1m.csv`, import.meta.url), "utf8").trim().split("\n").slice(1);
  const byDay = new Map<string, { m: number; h: number; l: number; c: number }[]>();
  for (const r of rows) { const x = r.split(","); const c = +x[7]; if (!isFinite(c)) continue; const p = et(new Date(x[0]).getTime()); (byDay.get(p.day) ?? byDay.set(p.day, []).get(p.day)!).push({ m: p.min, h: +x[5], l: +x[6], c }); }
  const evs: Ev[] = [];
  for (const [day, bars] of byDay) {
    const rth = bars.filter(b => b.m >= 570 && b.m <= 960).sort((a, b) => a.m - b.m);   // 9:30–16:00
    const fh = rth.filter(b => b.m <= 630);                                              // first hour 9:30–10:30
    if (fh.length < 20 || rth.length < 60) continue;
    const p0930 = fh[0].c, p1030 = fh[fh.length - 1].c, p1600 = rth[rth.length - 1].c;
    const fhHi = Math.max(...fh.map(b => b.h)), fhLo = Math.min(...fh.map(b => b.l)), fhRange = fhHi - fhLo;
    if (fhRange <= 0) continue;
    const fhRet = p1030 - p0930, dir = Math.sign(fhRet);
    const closePos = (p1030 - fhLo) / fhRange;                                           // where 10:30 sits in first-hour range
    // "strong directional open": moved >= 60% of the first-hour range AND closed near the extreme in that dir
    const strong = Math.abs(fhRet) >= 0.6 * fhRange && (dir > 0 ? closePos > 0.7 : closePos < 0.3);
    if (!strong) continue;
    const rest = (p1600 - p1030) * dir;                                                  // rest-of-day, in move direction
    evs.push({ year: +day.slice(0, 4), restR: rest / fhRange });                         // normalized by first-hour range
  }
  return evs;
}

function report(label: string, ev: Ev[]) {
  if (!ev.length) { console.log(`  ${label}: no events`); return; }
  const mean = (a: number[]) => a.reduce((s, v) => s + v, 0) / (a.length || 1);
  const R = ev.map(e => e.restR), wins = R.filter(r => r > 0).length;
  const years = [...new Set(ev.map(e => e.year))].sort();
  const posY = years.filter(y => mean(ev.filter(e => e.year === y).map(e => e.restR)) > 0).length;
  console.log(`\n  ${label}: n=${ev.length} (~${(ev.length / years.length).toFixed(0)}/yr)  avg rest-of-day ${mean(R) >= 0 ? "+" : ""}${mean(R).toFixed(3)}  win ${(wins / ev.length * 100).toFixed(0)}%  +in ${posY}/${years.length} yrs`);
  console.log(`    by year: ${years.map(y => `${String(y).slice(2)}:${(mean(ev.filter(e => e.year === y).map(e => e.restR)) >= 0 ? "+" : "")}${mean(ev.filter(e => e.year === y).map(e => e.restR)).toFixed(2)}`).join(" ")}`);
  console.log(`    VERDICT: ${mean(R) > 0.10 && posY >= years.length * 0.65 ? "✅ survives — and it's DAILY frequency" : "❌ no clear edge"}`);
}

function main() {
  console.log("\n" + "═".repeat(78));
  console.log("  OPENING-DRIVE — strong first hour → rest-of-day continuation (3yr 1-min). DAILY freq.");
  console.log("═".repeat(78));
  const all: Ev[] = [];
  for (const s of ["ES", "NQ", "GC"]) { const e = study(s); all.push(...e); report(s, e); }
  report("★ POOLED", all);
  console.log("\n" + "═".repeat(78) + "\n");
}
main();
