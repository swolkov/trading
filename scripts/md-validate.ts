/**
 * PHASE 1 — MARKET-DATA VALIDATION: Databento vs Yahoo (1-minute bars, recent window).
 * Quantifies the quality gap the live engines currently eat via the Yahoo fallback:
 * bar counts, session/ETH coverage, OHLC agreement, volume, missing bars, timestamp alignment.
 * Offline + read-only — touches NO live engine. Answers: should Yahoo be removed?
 *   npx tsx scripts/md-validate.ts
 * (Tradovate-vs-Databento needs a live parallel capture → Phase 1b, after the sidecar exists.)
 */
import fs from "node:fs";

function apiKey(): string {
  if (process.env.DATABENTO_API_KEY) return process.env.DATABENTO_API_KEY;
  const m = fs.readFileSync(new URL("../.env.local", import.meta.url), "utf8").match(/^DATABENTO_API_KEY=(.+)$/m);
  if (!m) throw new Error("DATABENTO_API_KEY not found in .env.local");
  return m[1].trim();
}
const auth = "Basic " + Buffer.from(apiKey() + ":").toString("base64");

const SYMS: [string, string][] = [["ES", "ES=F"], ["NQ", "NQ=F"], ["GC", "GC=F"]];  // [databento, yahoo]
const END = new Date(Date.now() - 2 * 86_400_000);            // T-2 (historical settles with a lag)
const START = new Date(END.getTime() - 7 * 86_400_000);        // Yahoo caps 1m requests at 8 days
const day = (d: Date) => d.toISOString().slice(0, 10);
interface Bar { o: number; h: number; l: number; c: number; v: number; }

async function databento(sym: string): Promise<Map<string, Bar>> {
  const body = new URLSearchParams({ dataset: "GLBX.MDP3", symbols: `${sym}.v.0`, stype_in: "continuous", schema: "ohlcv-1m", start: day(START), end: day(END), encoding: "csv", pretty_px: "true", pretty_ts: "true" });
  const res = await fetch("https://hist.databento.com/v0/timeseries.get_range", { method: "POST", headers: { Authorization: auth, "Content-Type": "application/x-www-form-urlencoded" }, body });
  if (!res.ok) throw new Error(`HTTP ${res.status} — ${(await res.text()).slice(0, 140)}`);
  const m = new Map<string, Bar>();
  for (const r of (await res.text()).trim().split("\n").slice(1)) { const c = r.split(","); const min = c[0].slice(0, 16); const b = { o: +c[4], h: +c[5], l: +c[6], c: +c[7], v: +c[8] }; if (isFinite(b.c) && b.c > 0) m.set(min, b); }
  return m;
}
async function yahoo(sym: string): Promise<Map<string, Bar>> {
  // mirror the engine's yahoo-finance2 usage
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const YF = require("yahoo-finance2").default || require("yahoo-finance2");
  const yf = typeof YF === "function" ? new YF({ suppressNotices: ["ripHistorical", "yahooSurvey"] }) : YF;
  const ch = await yf.chart(sym, { period1: START, period2: END, interval: "1m" });
  const m = new Map<string, Bar>();
  for (const q of (ch?.quotes ?? [])) { if (!q?.date || q.close == null) continue; const min = new Date(q.date).toISOString().slice(0, 16); m.set(min, { o: q.open, h: q.high, l: q.low, c: q.close, v: q.volume ?? 0 }); }
  return m;
}
const hourHist = (keys: string[]) => { const h = new Array(24).fill(0); for (const k of keys) h[+k.slice(11, 13)]++; return h; };

async function main() {
  console.log("\n" + "═".repeat(86));
  console.log(`  PHASE 1 — MD VALIDATION: Databento vs Yahoo  (1m, ${day(START)} → ${day(END)})`);
  console.log("═".repeat(86));
  for (const [dbSym, yhSym] of SYMS) {
    let D: Map<string, Bar>, Y: Map<string, Bar>;
    try { D = await databento(dbSym); } catch (e) { console.log(`\n  ${dbSym}: Databento ERROR — ${e instanceof Error ? e.message : e}`); continue; }
    try { Y = await yahoo(yhSym); } catch (e) { console.log(`\n  ${dbSym}: Yahoo ERROR — ${e instanceof Error ? e.message : e}`); Y = new Map(); }

    const dKeys = [...D.keys()], yKeys = [...Y.keys()];
    const overlap = dKeys.filter(k => Y.has(k));
    const onlyD = dKeys.filter(k => !Y.has(k)).length, onlyY = yKeys.filter(k => !D.has(k)).length;
    // OHLC agreement on overlapping minutes
    let sumAbs = 0, maxAbs = 0; for (const k of overlap) { const d = D.get(k)!, y = Y.get(k)!; const diff = Math.abs(d.c - y.c) / d.c; sumAbs += diff; maxAbs = Math.max(maxAbs, diff); }
    const meanPct = overlap.length ? (sumAbs / overlap.length) * 100 : 0;
    const dVol = dKeys.filter(k => D.get(k)!.v > 0).length, yVol = yKeys.filter(k => Y.get(k)!.v > 0).length;
    const dH = hourHist(dKeys), yH = hourHist(yKeys);
    const dHours = dH.filter(x => x > 0).length, yHours = yH.filter(x => x > 0).length;

    console.log(`\n  ${dbSym} (vs ${yhSym})`);
    console.log(`     bars:        Databento ${dKeys.length}   Yahoo ${yKeys.length}   overlap ${overlap.length}`);
    console.log(`     coverage:    Databento ${dHours}/24 UTC hours   Yahoo ${yHours}/24   → ${dHours - yHours > 4 ? "🟡 Yahoo missing ETH/overnight" : "similar"}`);
    console.log(`     exclusive:   only-Databento ${onlyD} min   only-Yahoo ${onlyY} min`);
    console.log(`     OHLC close:  mean |Δ| ${meanPct.toFixed(3)}%   max |Δ| ${(maxAbs * 100).toFixed(2)}%  ${meanPct < 0.05 ? "✅ agree" : meanPct < 0.2 ? "🟡 minor drift" : "❌ disagree"}`);
    console.log(`     volume:      Databento ${dVol}/${dKeys.length} bars have vol   Yahoo ${yVol}/${yKeys.length}  ${yVol < yKeys.length * 0.5 ? "🟡 Yahoo vol sparse/zero" : ""}`);
  }
  console.log("\n  READ: Databento should show fuller session coverage (ETH/overnight), real volume, and clean");
  console.log("        timestamps; large only-Yahoo gaps or sparse volume justify removing Yahoo once the live feed is in.");
  console.log("        Next: Phase 1b — log Tradovate vs Databento quotes in parallel during a live session.");
  console.log("═".repeat(86) + "\n");
}
main().catch(e => { console.error(e); process.exit(1); });
