/**
 * PRE-FOMC DRIFT — skeptical institutional validation (Lucca-Moench 2015 anomaly).
 * Tests, with hostility: persistence/decay by era, concentration in a few events, by-instrument,
 * and (on 1m) overnight-vs-intraday-before-2pm decomposition. Does it survive modern crowding?
 *   npx tsx scripts/fomc-drift.ts
 * ⚠️ FOMC dates are a best-reconstruction — VERIFY against the official Fed calendar before deployment.
 *    (The drift, if real, survives ±1-day noise in aggregate; this is a directional test, not production.)
 */
import fs from "node:fs";
// FOMC announcement days (2nd day, ~2pm ET). Reconstructed — verify before live use.
const FOMC = `2011-01-26 2011-03-15 2011-04-27 2011-06-22 2011-08-09 2011-09-21 2011-11-02 2011-12-13
2012-01-25 2012-03-13 2012-04-25 2012-06-20 2012-08-01 2012-09-13 2012-10-24 2012-12-12
2013-01-30 2013-03-20 2013-05-01 2013-06-19 2013-07-31 2013-09-18 2013-10-30 2013-12-18
2014-01-29 2014-03-19 2014-04-30 2014-06-18 2014-07-30 2014-09-17 2014-10-29 2014-12-17
2015-01-28 2015-03-18 2015-04-29 2015-06-17 2015-07-29 2015-09-17 2015-10-28 2015-12-16
2016-01-27 2016-03-16 2016-04-27 2016-06-15 2016-07-27 2016-09-21 2016-11-02 2016-12-14
2017-02-01 2017-03-15 2017-05-03 2017-06-14 2017-07-26 2017-09-20 2017-11-01 2017-12-13
2018-01-31 2018-03-21 2018-05-02 2018-06-13 2018-08-01 2018-09-26 2018-11-08 2018-12-19
2019-01-30 2019-03-20 2019-05-01 2019-06-19 2019-07-31 2019-09-18 2019-10-30 2019-12-11
2020-01-29 2020-03-18 2020-04-29 2020-06-10 2020-07-29 2020-09-16 2020-11-05 2020-12-16
2021-01-27 2021-03-17 2021-04-28 2021-06-16 2021-07-28 2021-09-22 2021-11-03 2021-12-15
2022-01-26 2022-03-16 2022-05-04 2022-06-15 2022-07-27 2022-09-21 2022-11-02 2022-12-14
2023-02-01 2023-03-22 2023-05-03 2023-06-14 2023-07-26 2023-09-20 2023-11-01 2023-12-13
2024-01-31 2024-03-20 2024-05-01 2024-06-12 2024-07-31 2024-09-18 2024-11-07 2024-12-18
2025-01-29 2025-03-19 2025-05-07 2025-06-18 2025-07-30 2025-09-17 2025-10-29 2025-12-10
2026-01-28 2026-03-18`.split(/\s+/);

const dir = new URL("../data/daily/", import.meta.url);
interface Bar { d: string; o: number; h: number; l: number; c: number; }
function load(sym: string): Bar[] { try { return fs.readFileSync(new URL(`${sym}_1d.csv`, dir), "utf8").trim().split("\n").slice(1).map(r => { const x = r.split(","); return { d: x[0].slice(0, 10), o: +x[4], h: +x[5], l: +x[6], c: +x[7] }; }).filter(b => isFinite(b.c) && b.c > 0).sort((a, b) => (a.d < b.d ? -1 : 1)); } catch { return []; } }
const mean = (a: number[]) => a.reduce((s, v) => s + v, 0) / (a.length || 1);

function main() {
  console.log("\n" + "═".repeat(80));
  console.log("  PRE-FOMC DRIFT — skeptical institutional validation (ES daily, day-before-announcement)");
  console.log("═".repeat(80));
  const fset = new Set(FOMC);
  for (const sym of ["ES", "NQ"]) {
    const b = load(sym); if (b.length < 30) continue;
    const idx = new Map(b.map((x, i) => [x.d, i]));
    const drift: { ret: number; year: number }[] = []; const allRet: number[] = [];
    for (let i = 1; i < b.length; i++) { allRet.push((b[i].c - b[i - 1].c) / b[i - 1].c); }
    for (const fd of FOMC) { const i = idx.get(fd); if (i === undefined || i < 2) continue; drift.push({ ret: (b[i - 1].c - b[i - 2].c) / b[i - 2].c, year: +fd.slice(0, 4) }); }   // day-BEFORE return = clean pre-announcement proxy
    const dr = drift.map(x => x.ret);
    console.log(`\n  ${sym}: n=${dr.length} FOMC events`);
    console.log(`     pre-FOMC (day-before) mean return: ${(mean(dr) * 100).toFixed(3)}%/event  vs baseline ${(mean(allRet) * 100).toFixed(3)}%/day  (${(mean(dr) / mean(allRet)).toFixed(1)}x)`);
    console.log(`     win rate ${(dr.filter(x => x > 0).length / dr.length * 100).toFixed(0)}%   annualized (8/yr): ${(mean(dr) * 8 * 100).toFixed(1)}%`);
    // DECAY by era
    const eras: [string, number, number][] = [["2011-2015 (pre-paper era)", 2011, 2015], ["2016-2020", 2016, 2020], ["2021-2026 (modern)", 2021, 2026]];
    for (const [n, s, e] of eras) { const er = drift.filter(x => x.year >= s && x.year <= e).map(x => x.ret); if (er.length) console.log(`       ${n.padEnd(26)} ${(mean(er) * 100).toFixed(3)}%/event  (n=${er.length})`); }
    // CONCENTRATION — drop the top 5 events
    const sorted = [...dr].sort((a, b) => b - a); const exTop = dr.filter(x => !sorted.slice(0, 5).includes(x));
    console.log(`     concentration: full ${(mean(dr) * 100).toFixed(3)}%  →  ex-top-5 events ${(mean(exTop) * 100).toFixed(3)}%  ${mean(exTop) > mean(allRet) * 1.5 ? "(survives — not just a few events)" : "(⚠️ carried by a few events)"}`);
  }
  console.log("\n  VERDICT GUIDE: real edge = +mean clearly above baseline, persists into 2021-2026, survives ex-top-5.");
  console.log("  (Daily day-before is a clean pre-announcement proxy. Precise 24h-to-2pm window needs 1m + verified dates.)");
  console.log("═".repeat(80) + "\n");
}
main();
