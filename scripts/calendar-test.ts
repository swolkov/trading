/**
 * CALENDAR / SEASONALITY edge test — days, weeks, months — on 15yr daily data.
 * Tests documented effects: day-of-week, the TURN-OF-MONTH effect (last day + first 3 of month —
 * historically captures most of equities' return), and month-of-year seasonality.
 *   npx tsx scripts/calendar-test.ts
 */
import fs from "node:fs";

interface Ret { d: Date; r: number; }
function rets(sym: string): Ret[] {
  const rows = fs.readFileSync(new URL(`../data/daily/${sym}_1d.csv`, import.meta.url), "utf8").trim().split("\n").slice(1);
  const bars = rows.map(x => { const c = x.split(","); return { t: new Date(c[0]).getTime(), c: +c[7] }; })
    .filter(b => isFinite(b.c) && b.c > 0).sort((a, b) => a.t - b.t);
  const out: Ret[] = [];
  for (let i = 1; i < bars.length; i++) out.push({ d: new Date(bars[i].t), r: Math.log(bars[i].c / bars[i - 1].c) });
  return out;
}

const WD = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const bps = (x: number) => (x * 10000).toFixed(1);

function dayOfWeek(rs: Ret[]) {
  const m = new Map<number, number[]>();
  for (const x of rs) (m.get(x.d.getUTCDay()) ?? m.set(x.d.getUTCDay(), []).get(x.d.getUTCDay())!).push(x.r);
  return [1, 2, 3, 4, 5].map(wd => { const a = m.get(wd) ?? []; return `${WD[wd]} ${a.length ? (bps(a.reduce((s, v) => s + v, 0) / a.length)) : "-"}`; }).join("  ");
}

function turnOfMonth(rs: Ret[]) {
  // tag first 3 + last 1 trading day of each month as TOM
  const byMonth = new Map<string, Ret[]>();
  for (const x of rs) { const k = x.d.toISOString().slice(0, 7); (byMonth.get(k) ?? byMonth.set(k, []).get(k)!).push(x); }
  let tomS = 0, tomN = 0, restS = 0, restN = 0;
  for (const days of byMonth.values()) {
    days.sort((a, b) => a.d.getTime() - b.d.getTime());
    days.forEach((x, i) => { const isTOM = i < 3 || i === days.length - 1; if (isTOM) { tomS += x.r; tomN++; } else { restS += x.r; restN++; } });
  }
  const total = tomS + restS;
  return { tomAvg: tomS / tomN, restAvg: restS / restN, tomShare: total !== 0 ? tomS / total : 0, tomDaysPerYr: tomN / (rs.length / 252) };
}

function monthOfYear(rs: Ret[]) {
  const m = new Map<number, number>();
  for (const x of rs) m.set(x.d.getUTCMonth(), (m.get(x.d.getUTCMonth()) ?? 0) + x.r);
  return [...Array(12).keys()].map(mo => (m.get(mo) ?? 0) * 100);
}

function main() {
  console.log("\n" + "═".repeat(80));
  console.log("  CALENDAR / SEASONALITY — days, weeks, months (15yr daily)");
  console.log("═".repeat(80));
  const groups: [string, string[]][] = [["Equity indices", ["ES", "NQ", "YM", "RTY"]], ["Gold", ["GC"]], ["Bonds", ["ZB", "ZN"]]];

  console.log("\n── DAY-OF-WEEK (avg daily return, bps) ──");
  for (const [name, syms] of groups) {
    const all: Ret[] = []; for (const s of syms) { try { all.push(...rets(s)); } catch { } }
    if (all.length) console.log(`  ${name.padEnd(16)} ${dayOfWeek(all)}`);
  }

  console.log("\n── TURN-OF-MONTH (last day + first 3 of each month vs the rest) ──");
  for (const [name, syms] of groups) {
    const all: Ret[] = []; for (const s of syms) { try { all.push(...rets(s)); } catch { } }
    if (!all.length) continue;
    const t = turnOfMonth(all);
    console.log(`  ${name.padEnd(16)} TOM avg ${bps(t.tomAvg).padStart(6)} bps/day vs rest ${bps(t.restAvg).padStart(6)} bps/day | TOM (~${t.tomDaysPerYr.toFixed(0)} days/yr) captured ${(t.tomShare * 100).toFixed(0)}% of total return`);
  }

  console.log("\n── MONTH-OF-YEAR (cumulative return by calendar month, %, 15yr) ──");
  const mo = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  for (const [name, syms] of groups) {
    const all: Ret[] = []; for (const s of syms) { try { all.push(...rets(s)); } catch { } }
    if (!all.length) continue;
    const m = monthOfYear(all);
    console.log(`  ${name}:`);
    console.log(`    ${mo.map((x, i) => `${x}${m[i] >= 0 ? "+" : ""}${m[i].toFixed(0)}`).join("  ")}`);
  }
  console.log("\n" + "═".repeat(80) + "\n");
}
main();
