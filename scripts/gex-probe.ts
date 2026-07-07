// GEX PROOF-OF-CONCEPT: compute dealer Gamma Exposure from REAL SPY options open interest (Databento OPRA)
// on a handful of dates spanning calm and crash regimes, then check what happened NEXT (forward realized
// vol + drawdown from real SPY prices). Question: did NEGATIVE/low dealer gamma flag the danger in advance?
// Cost ≈ $0.39/date (definition + statistics). Run: `npx tsx scripts/gex-probe.ts`
import { getHistoricalBars } from "../src/lib/yahoo";
import { computeGex, type OptionOI } from "../src/lib/options/gex";

const KEY = process.env.DATABENTO_API_KEY || "";
const AUTH = "Basic " + Buffer.from(KEY + ":").toString("base64");
const HIST = "https://hist.databento.com/v0/timeseries.get_range";

// Dates spanning regimes. Danger = just BEFORE a known vol event; Calm = mid bull run. (OPRA data ≥ 2013.)
const DATES: { date: string; note: string }[] = [
  { date: "2018-12-03", note: "before Dec-2018 −16% crash" },
  { date: "2019-04-01", note: "calm bull" },
  { date: "2020-02-18", note: "the top before COVID −34%" },
  { date: "2021-11-01", note: "calm, near the 2021 top" },
  { date: "2022-01-03", note: "before 2022 bear (−25%)" },
  { date: "2022-08-16", note: "before Aug–Oct 2022 leg down" },
  { date: "2023-07-03", note: "calm 2023 recovery" },
  { date: "2024-06-03", note: "calm bull" },
  { date: "2024-11-01", note: "calm bull" },
  { date: "2025-02-18", note: "recent" },
];

async function dbnFetch(schema: string, date: string): Promise<string[]> {
  const end = new Date(new Date(date).getTime() + 86_400_000).toISOString().slice(0, 10);
  const body = new URLSearchParams({
    dataset: "OPRA.PILLAR", symbols: "SPY.OPT", stype_in: "parent",
    schema, start: date, end, encoding: "csv", pretty_px: "true",
  });
  const res = await fetch(HIST, { method: "POST", headers: { Authorization: AUTH, "Content-Type": "application/x-www-form-urlencoded" }, body });
  if (!res.ok) throw new Error(`${schema} ${date}: ${res.status} ${await res.text()}`);
  return (await res.text()).split("\n").filter(Boolean);
}

// Parse OSI raw_symbol "SPY   241220P00595000" → {expiryMs, type, strike}
function parseOsi(raw: string): { expiryMs: number; type: "call" | "put"; strike: number } | null {
  const m = raw.trim().match(/^[A-Z]+\s*(\d{6})([CP])(\d{8})$/);
  if (!m) return null;
  const yy = 2000 + +m[1].slice(0, 2), mm = +m[1].slice(2, 4), dd = +m[1].slice(4, 6);
  return { expiryMs: Date.UTC(yy, mm - 1, dd, 20, 0, 0), type: m[2] === "C" ? "call" : "put", strike: +m[3] / 1000 };
}

function col(header: string[], name: string): number { return header.indexOf(name); }

async function buildChain(date: string): Promise<Map<number, { strike: number; type: "call" | "put"; expiryMs: number }>> {
  const lines = await dbnFetch("definition", date);
  const h = lines[0].split(",");
  const iId = col(h, "instrument_id"), iSym = col(h, "raw_symbol");
  const map = new Map<number, { strike: number; type: "call" | "put"; expiryMs: number }>();
  for (let i = 1; i < lines.length; i++) {
    const c = lines[i].split(",");
    const id = +c[iId]; const p = parseOsi(c[iSym] || "");
    if (p && !map.has(id)) map.set(id, p);
  }
  return map;
}

async function openInterest(date: string): Promise<Map<number, number>> {
  const lines = await dbnFetch("statistics", date);
  const h = lines[0].split(",");
  const iId = col(h, "instrument_id"), iStat = col(h, "stat_type"), iQty = col(h, "quantity");
  const oi = new Map<number, number>();
  for (let i = 1; i < lines.length; i++) {
    const c = lines[i].split(",");
    if (c[iStat] !== "9") continue; // stat_type 9 = OPEN_INTEREST; value in quantity
    const id = +c[iId], q = +c[iQty];
    if (q > 0) oi.set(id, Math.max(oi.get(id) || 0, q));
  }
  return oi;
}

function fwdVolAndDD(bars: { t: string; c: number }[], date: string): { rvol: number; maxDD: number } {
  const idx = bars.findIndex((b) => b.t.slice(0, 10) >= date);
  if (idx < 0) return { rvol: NaN, maxDD: NaN };
  const seg = bars.slice(idx, idx + 30);
  const rets: number[] = [];
  for (let i = 1; i < seg.length; i++) rets.push(Math.log(seg[i].c / seg[i - 1].c));
  const mean = rets.reduce((a, b) => a + b, 0) / (rets.length || 1);
  const sd = Math.sqrt(rets.reduce((a, b) => a + (b - mean) ** 2, 0) / (rets.length || 1));
  const rvol = sd * Math.sqrt(252) * 100;
  let peak = seg[0]?.c || 0, dd = 0;
  for (const b of seg) { peak = Math.max(peak, b.c); dd = Math.min(dd, (b.c - peak) / peak); }
  return { rvol, maxDD: dd * 100 };
}

async function main() {
  console.log("\n" + "═".repeat(104));
  console.log("  DEALER GAMMA (GEX) vs WHAT HAPPENED NEXT — real SPY open interest (Databento OPRA)");
  console.log("═".repeat(104));
  const spy = await getHistoricalBars("SPY", 3200);
  const vix = await getHistoricalBars("^VIX", 3200);
  const vixOn = (d: string) => { const b = vix.filter((x) => x.t.slice(0, 10) <= d).pop(); return b?.c ?? 20; };
  const spyOn = (d: string) => { const b = spy.filter((x) => x.t.slice(0, 10) <= d).pop(); return b?.c ?? 0; };

  console.log("  date        note                              spot   GEX regime   norm-GEX   flip     →fwd 30d vol   fwd maxDD");
  console.log("  " + "─".repeat(100));
  const rows: { neg: boolean; rvol: number; dd: number }[] = [];
  for (const { date, note } of DATES) {
    try {
      const [chain, oi] = await Promise.all([buildChain(date), openInterest(date)]);
      const spot = spyOn(date), iv = vixOn(date) / 100, now = new Date(date).getTime();
      const opts: OptionOI[] = [];
      for (const [id, meta] of chain) {
        const q = oi.get(id); if (!q) continue;
        const T = (meta.expiryMs - now) / (365 * 86_400_000);
        if (T <= 0 || T > 0.5) continue; // near-term gamma dominates dealer hedging
        opts.push({ ...meta, openInterest: q });
      }
      const gex = computeGex(opts, spot, now, iv);
      const { rvol, maxDD } = fwdVolAndDD(spy, date);
      rows.push({ neg: gex.regime === "negative", rvol, dd: maxDD });
      const flip = gex.flipSpot ? `$${gex.flipSpot.toFixed(0)}` : "—";
      console.log(`  ${date}  ${note.padEnd(32)} $${spot.toFixed(0).padStart(4)}  ${gex.regime === "negative" ? "🔴NEGATIVE" : "🟢positive"}  ${gex.gexPerPointNorm.toFixed(3).padStart(7)}  ${flip.padStart(6)}   ${rvol.toFixed(0).padStart(6)}%      ${maxDD.toFixed(0).padStart(4)}%`);
    } catch (e) {
      console.log(`  ${date}  ${note.padEnd(32)} ERROR: ${(e as Error).message.slice(0, 60)}`);
    }
  }

  const neg = rows.filter((r) => r.neg), pos = rows.filter((r) => !r.neg);
  const avg = (a: number[]) => a.length ? a.reduce((x, y) => x + y, 0) / a.length : NaN;
  console.log("  " + "─".repeat(100));
  console.log(`  NEGATIVE-gamma days (n=${neg.length}): avg forward 30d vol ${avg(neg.map((r) => r.rvol)).toFixed(0)}%, avg forward maxDD ${avg(neg.map((r) => r.dd)).toFixed(0)}%`);
  console.log(`  POSITIVE-gamma days (n=${pos.length}): avg forward 30d vol ${avg(pos.map((r) => r.rvol)).toFixed(0)}%, avg forward maxDD ${avg(pos.map((r) => r.dd)).toFixed(0)}%`);
  console.log("═".repeat(104));
  console.log("  IF negative-gamma days show clearly higher forward vol / deeper drawdowns → GEX is a real crash-regime filter.\n");
}

main().catch((e) => { console.error(e); process.exit(1); });
