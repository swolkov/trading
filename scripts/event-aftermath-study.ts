/**
 * EVENT-AFTERMATH STUDY (2026-08-11) — what does gold/NQ actually do AFTER an 8:30 ET macro print?
 *
 * The blackout guard (8:15–8:45 on release days) answers "don't get gapped." This answers the next
 * question: is there exploitable STRUCTURE in the aftermath — continuation or fade of the initial
 * 8:30→8:45 impulse? NFP days are computable offline (first Friday); CPI dates are not, so NFP is
 * the clean sample and ordinary days are the control. Measured, not theorized:
 *   impulse = 8:30→8:45 move. Then track 8:45→9:30, →10:30, →11:30 in impulse direction.
 *   "follow" = aftermath continues the impulse sign; "fade" = it reverses.
 */
import fs from "node:fs";
const ROOT = new URL("..", import.meta.url);
const FILE = process.argv[2] === "NQ" ? "data/NQ_1m.csv" : "data/GC_1m.csv";
const LBL = process.argv[2] === "NQ" ? "NQ" : "GC";
const etFmt = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", hour12: false, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" });
const oc = new Map<number, number>();
function off(t: number) { const hr = Math.floor(t/3600000); const c = oc.get(hr); if (c !== undefined) return c;
  const p: any = {}; for (const x of etFmt.formatToParts(hr*3600000)) p[x.type]=x.value;
  let hh = parseInt(p.hour); if (hh===24) hh=0;
  const o = Date.UTC(+p.year,+p.month-1,+p.day,hh,+p.minute)-hr*3600000; oc.set(hr,o); return o; }
const lines = fs.readFileSync(new URL(FILE, ROOT), "utf8").split("\n");
// price at specific ET minute per day
const px = new Map<string, number>();  // "day|hhmm" -> close
const dayDow = new Map<string, number>(); const dayDom = new Map<string, number>();
for (let i = 1; i < lines.length; i++) { const r = lines[i]; if (!r) continue; const f = r.split(",");
  const t = Date.parse(f[0]); const c = +f[7]; if (!isFinite(t) || !(c > 0)) continue;
  const e = t + off(t); const d = new Date(e);
  const key = d.toISOString().slice(0, 10);
  const hm = d.getUTCHours() * 100 + d.getUTCMinutes();
  if ([829, 844, 929, 1029, 1129].includes(hm)) px.set(`${key}|${hm}`, c);
  if (!dayDow.has(key)) { dayDow.set(key, d.getUTCDay()); dayDom.set(key, d.getUTCDate()); }
}
interface Row { impulse: number; a930: number; a1030: number; a1130: number }
const nfp: Row[] = [], normal: Row[] = [];
for (const [key] of dayDow) {
  const g = (hm: number) => px.get(`${key}|${hm}`);
  const p829 = g(829), p844 = g(844), p930 = g(929), p1030 = g(1029), p1130 = g(1129);
  if (!p829 || !p844 || !p930 || !p1030 || !p1130) continue;
  const imp = p844 - p829; if (Math.abs(imp) < 1e-9) continue;
  const sgn = Math.sign(imp);
  const row: Row = { impulse: Math.abs(imp / p829 * 100),
    a930: sgn * (p930 - p844) / p844 * 100, a1030: sgn * (p1030 - p844) / p844 * 100, a1130: sgn * (p1130 - p844) / p844 * 100 };
  const isNFP = dayDow.get(key) === 5 && dayDom.get(key)! <= 7;
  (isNFP ? nfp : normal).push(row);
}
const stat = (a: Row[], f: (r: Row) => number) => { const v = a.map(f); const m = v.reduce((s,x)=>s+x,0)/v.length;
  const sd = Math.sqrt(v.reduce((s,x)=>s+(x-m)**2,0)/Math.max(1,v.length-1)); return { m, t: sd>0? m/(sd/Math.sqrt(v.length)):0, w: v.filter(x=>x>0).length/v.length }; };
const rep = (lbl: string, a: Row[]) => {
  if (a.length < 10) { console.log(`  ${lbl}: n=${a.length} — too few`); return; }
  console.log(`  ${lbl}  n=${a.length}  avg impulse ${ (a.reduce((s,r)=>s+r.impulse,0)/a.length).toFixed(2)}%`);
  for (const [name, f] of [["→9:30", (r:Row)=>r.a930], ["→10:30", (r:Row)=>r.a1030], ["→11:30", (r:Row)=>r.a1130]] as [string,(r:Row)=>number][]) {
    const s = stat(a, f);
    console.log(`     ${name.padEnd(7)} in impulse dir: ${s.m>=0?"+":""}${(s.m*100).toFixed(1)}bp  t=${s.t.toFixed(2)}  follow-rate ${(s.w*100).toFixed(0)}%  ${Math.abs(s.t)>2?(s.m>0?"⚡ FOLLOW signal":"⚡ FADE signal"):""}`);
  }
};
console.log(`\n${LBL} — aftermath of the 8:30→8:45 impulse (positive = continuation)`);
rep("NFP days (first Fridays)", nfp);
rep("ordinary days (control) ", normal);
