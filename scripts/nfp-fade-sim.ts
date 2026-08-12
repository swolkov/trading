/** NFP FADE — TRADE-MECHANICS SIM (2026-08-12). The aftermath study showed the 8:30→8:45 NFP impulse
 *  reverses (GC t=−2.38 @9:30, NQ t=−2.74 @10:30) with a dead 715-day control. This tests it as an
 *  actual TRADE: enter 8:45 close AGAINST the impulse, stop 1 tick beyond the 8:30–8:45 extreme,
 *  exit on stop or timed close. Micro economics, measured slippage, $2.02 commission. NFP only. */
import fs from "node:fs";
const ROOT = new URL("..", import.meta.url);
const CFG = process.argv[2] === "NQ"
  ? { file: "data/NQ_1m.csv", pt: 2, tick: 0.25, slip: 1.38, exitHM: 1029, lbl: "NQ→MNQ exit 10:30" }
  : { file: "data/GC_1m.csv", pt: 10, tick: 0.1, slip: 0.5, exitHM: 929, lbl: "GC→MGC exit 9:30" };
const etFmt = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", hour12: false, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" });
const oc = new Map<number, number>();
function off(t: number) { const hr = Math.floor(t/3600000); const c = oc.get(hr); if (c !== undefined) return c;
  const p: any = {}; for (const x of etFmt.formatToParts(hr*3600000)) p[x.type]=x.value;
  let hh = parseInt(p.hour); if (hh===24) hh=0;
  const o = Date.UTC(+p.year,+p.month-1,+p.day,hh,+p.minute)-hr*3600000; oc.set(hr,o); return o; }
const lines = fs.readFileSync(new URL(CFG.file, ROOT), "utf8").split("\n");
interface M { hm: number; h: number; l: number; c: number }
const days = new Map<string, M[]>(); const meta = new Map<string, {dow:number;dom:number}>();
for (let i = 1; i < lines.length; i++) { const r = lines[i]; if (!r) continue; const f = r.split(",");
  const t = Date.parse(f[0]); const c = +f[7]; if (!isFinite(t)||!(c>0)) continue;
  const e = t + off(t); const d = new Date(e); const key = d.toISOString().slice(0,10);
  const hm = d.getUTCHours()*100 + d.getUTCMinutes();
  if (hm < 829 || hm > 1035) continue;
  (days.get(key) ?? days.set(key, []).get(key)!).push({ hm, h:+f[5], l:+f[6], c });
  if (!meta.has(key)) meta.set(key, { dow: d.getUTCDay(), dom: d.getUTCDate() });
}
const trades: number[] = [];
for (const [key, bars] of days) {
  const m = meta.get(key)!; if (!(m.dow === 5 && m.dom <= 7)) continue;   // NFP only
  bars.sort((a,b)=>a.hm-b.hm);
  const at = (hm:number)=>bars.find(b=>b.hm===hm);
  const b829 = at(829), b844 = at(844); if (!b829 || !b844) continue;
  const imp = b844.c - b829.c; if (Math.abs(imp) < 1e-9) continue;
  const short = imp > 0;                                   // fade: short an up-impulse
  const win = bars.filter(b=>b.hm>=830 && b.hm<=844);
  const ext = short ? Math.max(...win.map(b=>b.h)) : Math.min(...win.map(b=>b.l));
  const entry = short ? b844.c - CFG.slip : b844.c + CFG.slip;
  const stop = short ? ext + CFG.tick : ext - CFG.tick;
  let pnlPts: number | null = null;
  for (const b of bars) {
    if (b.hm <= 844) continue;
    if (b.hm > CFG.exitHM) break;
    if (short ? b.h >= stop : b.l <= stop) { pnlPts = short ? entry - stop - CFG.tick : stop - entry - CFG.tick; break; }
    if (b.hm === CFG.exitHM) pnlPts = short ? entry - b.c : b.c - entry;
  }
  if (pnlPts == null) { const last = bars[bars.length-1]; pnlPts = short ? entry - last.c : last.c - entry; }
  trades.push(pnlPts * CFG.pt - 2.02);
}
const pf = (a:number[]) => { const g=a.filter(x=>x>0).reduce((s,x)=>s+x,0), l=Math.abs(a.filter(x=>x<=0).reduce((s,x)=>s+x,0)); return l>0?g/l:Infinity; };
const h = Math.floor(trades.length/2);
const net = trades.reduce((s,x)=>s+x,0), w = trades.filter(x=>x>0).length;
console.log(`${CFG.lbl}  NFP fades n=${trades.length}  win ${Math.round(w/trades.length*100)}%  PF ${pf(trades).toFixed(2)}  net $${net.toFixed(0)}  avg $${(net/trades.length).toFixed(0)}/trade  | halves ${pf(trades.slice(0,h)).toFixed(2)} / ${pf(trades.slice(h)).toFixed(2)}`);
