/**
 * SPREAD LIVE SHADOW — settles the ONE open risk on the validated spread edge: FILL CERTAINTY.
 *
 * The backtest proves the edge survives 8–16× the MEASURED bid/ask crossing cost (paper-forward.ts),
 * but it cannot prove you actually get FILLED on both legs at the modeled price during a fast z=2
 * dislocation. Only forward, real-quote capture settles that. This harness:
 *   1. Replays the validated strategy (same params as paper-forward) to current open positions + today's signals.
 *   2. When a signal fires, fetches the REAL live bid/ask (Databento tbbo) for both legs and records the
 *      marketable fill (buy=ask, sell=bid) vs the modeled fill (daily close the backtest assumes).
 *   3. On close, banks a real-fill-vs-modeled round-trip to reports/spread-shadow-ledger.csv.
 * Pre-existing positions (open before tracking began) are seeded UNTRACKED so the ledger holds only
 * true live round-trips. Run daily (cron) — the real-fill record accrues forward.
 *
 *   node_modules/.bin/tsx scripts/spread-shadow.ts
 */
import fs from "node:fs";

const PAIRS: [string, string][] = [["CL", "RB"], ["CL", "HO"], ["ZC", "ZS"], ["ZW", "ZC"], ["ZS", "ZW"], ["6E", "6B"], ["GC", "HG"]]; // 6A/6C dropped (failed forward)
const P = { lookback: 60, entryZ: 2, exitZ: 0, stopZ: 3.5, maxHold: 40 };
const ROOT = new URL("..", import.meta.url);
const LEDGER = new URL("reports/spread-shadow-ledger.csv", ROOT).pathname;
const STATE = new URL("reports/spread-shadow-state.json", ROOT).pathname;

function apiKey(): string | null {
  if (process.env.DATABENTO_API_KEY) return process.env.DATABENTO_API_KEY;
  for (const f of [".env.local", ".env"]) { try { const m = fs.readFileSync(new URL(f, ROOT), "utf8").match(/^DATABENTO_API_KEY=(.+)$/m); if (m) return m[1].trim(); } catch {} }
  return null;
}
// Daily closes by date (YYYY-MM-DD → close).
function loadDaily(sym: string): Map<string, number> {
  const m = new Map<string, number>();
  try { for (const r of fs.readFileSync(new URL(`data/daily/${sym}_1d.csv`, ROOT), "utf8").trim().split("\n").slice(1)) { const c = r.split(","); const p = +c[7]; if (isFinite(p) && p > 0) m.set(c[0].slice(0, 10), p); } } catch {}
  return m;
}
const day = (d: Date) => d.toISOString().slice(0, 10);
// Latest live bid/ask for a leg (last valid tbbo row over the last few days). null if unavailable.
async function liveQuote(sym: string, key: string): Promise<{ bid: number; ask: number } | null> {
  const auth = "Basic " + Buffer.from(key + ":").toString("base64");
  const start = new Date(Date.now() - 3 * 86400000), end = new Date(Date.now() + 86400000);
  const body = new URLSearchParams({ dataset: "GLBX.MDP3", symbols: `${sym}.v.0`, stype_in: "continuous", schema: "tbbo", start: day(start), end: day(end), encoding: "csv", pretty_px: "true", pretty_ts: "true" });
  try {
    const r = await fetch("https://hist.databento.com/v0/timeseries.get_range", { method: "POST", headers: { Authorization: auth, "Content-Type": "application/x-www-form-urlencoded" }, body });
    if (!r.ok) return null;
    const lines = (await r.text()).trim().split("\n"); if (lines.length < 2) return null;
    const h = lines[0].split(","), bi = h.indexOf("bid_px_00"), ai = h.indexOf("ask_px_00");
    for (let i = lines.length - 1; i >= 1; i--) { const c = lines[i].split(","); const bid = +c[bi], ask = +c[ai]; if (bid > 0 && ask > 0 && ask >= bid) return { bid, ask }; }
  } catch {}
  return null;
}

interface OpenPos { dir: 1 | -1; entryDate: string; modeledEntry: number; fs: number; realEntry: number | null; tracked: boolean; legQuotes?: any; }

// Deterministic replay → current open position per pair (with entry details), using the SAME logic as paper-forward.
function currentOpens(): Record<string, OpenPos> {
  const out: Record<string, OpenPos> = {};
  for (const [a, b] of PAIRS) {
    const A = loadDaily(a), B = loadDaily(b);
    const dates = [...A.keys()].filter((d) => B.has(d)).sort();
    if (dates.length < P.lookback + 5) continue;
    const ratio = dates.map((d) => A.get(d)! / B.get(d)!);
    let pos: { dir: 1 | -1; entryDate: string; entry: number; fs: number; i: number } | null = null;
    for (let i = P.lookback; i < ratio.length; i++) {
      const w = ratio.slice(i - P.lookback, i), m = w.reduce((s, v) => s + v, 0) / P.lookback;
      const sd = Math.sqrt(w.reduce((s, v) => s + (v - m) ** 2, 0) / P.lookback) || 1e-9, z = (ratio[i] - m) / sd;
      if (pos) { const revert = pos.dir === -1 ? z <= P.exitZ : z >= P.exitZ; if (revert || Math.abs(z) >= P.stopZ || i - pos.i >= P.maxHold) pos = null; }
      if (!pos) { if (z > P.entryZ) pos = { dir: -1, entryDate: dates[i], entry: ratio[i], fs: sd / m, i }; else if (z < -P.entryZ) pos = { dir: 1, entryDate: dates[i], entry: ratio[i], fs: sd / m, i }; }
    }
    if (pos) out[`${a}/${b}`] = { dir: pos.dir, entryDate: pos.entryDate, modeledEntry: pos.entry, fs: pos.fs, realEntry: null, tracked: false };
  }
  return out;
}

async function main() {
  const key = apiKey();
  const lastData = day(new Date(Math.max(...PAIRS.flatMap(([a]) => [...loadDaily(a).keys()]).map((d) => new Date(d).getTime()))));
  const opens = currentOpens();
  const state: Record<string, OpenPos> = fs.existsSync(STATE) ? JSON.parse(fs.readFileSync(STATE, "utf8")) : {};
  const ledgerRows: string[] = [];
  let newOpens = 0, closes = 0, seeded = 0;

  // CLOSES: in state but no longer open (or reopened with a different entry date).
  for (const k of Object.keys(state)) {
    const st = state[k]; const cur = opens[k];
    const stillSame = cur && cur.entryDate === st.entryDate;
    if (stillSame) continue;
    if (st.tracked && st.realEntry != null) {
      const [a, b] = k.split("/");
      const qa = key ? await liveQuote(a, k) : null, qb = key ? await liveQuote(b, k) : null;
      // real exit fill: long pos closes by SELL a / BUY b → bidA/askB ; short closes by BUY a / SELL b → askA/bidB
      let realExit: number | null = null;
      if (qa && qb) realExit = st.dir === 1 ? qa.bid / qb.ask : qa.ask / qb.bid;
      const modeledExit = (loadDaily(a).get(lastData) ?? 0) / (loadDaily(b).get(lastData) ?? 1);
      const realR = realExit != null ? st.dir * (realExit - st.realEntry) / st.realEntry / (1.5 * st.fs) : null;
      const modeledR = st.dir * (modeledExit - st.modeledEntry) / st.modeledEntry / (1.5 * st.fs);
      ledgerRows.push([new Date().toISOString().slice(0, 10), k, st.dir === 1 ? "long" : "short", st.entryDate, lastData, modeledR.toFixed(3), realR != null ? realR.toFixed(3) : "NA", realR != null ? (modeledR - realR).toFixed(3) : "NA"].join(","));
      closes++;
    }
    delete state[k];
  }

  // OPENS: currently open, not already in state.
  for (const k of Object.keys(opens)) {
    if (state[k]) continue;
    const o = opens[k], [a, b] = k.split("/");
    if (o.entryDate === lastData) {
      // opened today → capture the live fill
      const qa = key ? await liveQuote(a, k) : null, qb = key ? await liveQuote(b, k) : null;
      o.realEntry = qa && qb ? (o.dir === 1 ? qa.ask / qb.bid : qa.bid / qb.ask) : null; // long: buy a/sell b
      o.tracked = o.realEntry != null;
      o.legQuotes = { a: qa, b: qb };
      if (o.tracked) newOpens++;
      state[k] = o;
    } else {
      // pre-existing (opened before tracking) → seed untracked, never enters the real-fill ledger
      o.tracked = false; state[k] = o; seeded++;
    }
  }

  fs.writeFileSync(STATE, JSON.stringify(state, null, 2));
  if (!fs.existsSync(LEDGER)) fs.writeFileSync(LEDGER, "run_date,pair,dir,entry_date,exit_date,modeled_R,real_R,slip_R\n");
  if (ledgerRows.length) fs.appendFileSync(LEDGER, ledgerRows.join("\n") + "\n");

  const W = 96;
  console.log("\n" + "═".repeat(W));
  console.log("  SPREAD LIVE SHADOW — real-fill vs modeled (settles FILL CERTAINTY)   data through " + lastData);
  console.log("═".repeat(W));
  console.log(`  Quote source: ${key ? "Databento tbbo (live)" : "⚠️ NO API KEY — modeled-only, fills not captured"}`);
  console.log(`  This run: ${newOpens} new tracked open(s), ${closes} closed round-trip(s), ${seeded} pre-existing seeded (untracked).`);
  console.log(`  Currently open (tracked/total): ${Object.values(state).filter((s) => s.tracked).length}/${Object.keys(state).length}`);
  for (const [k, s] of Object.entries(state)) console.log(`     ${k.padEnd(8)} ${s.dir === 1 ? "long " : "short"} since ${s.entryDate}  modeledEntry ${s.modeledEntry.toFixed(4)}  realEntry ${s.realEntry != null ? s.realEntry.toFixed(4) : "—(untracked)"}`);
  // Ledger summary
  if (fs.existsSync(LEDGER)) {
    const rows = fs.readFileSync(LEDGER, "utf8").trim().split("\n").slice(1).filter((r) => r.split(",")[6] !== "NA");
    if (rows.length) {
      const real = rows.map((r) => +r.split(",")[6]), modeled = rows.map((r) => +r.split(",")[5]);
      const avg = (x: number[]) => x.reduce((s, v) => s + v, 0) / x.length;
      console.log("─".repeat(W));
      console.log(`  LEDGER: ${rows.length} live round-trip(s)  |  modeled avg ${avg(modeled).toFixed(3)}R  vs  REAL-FILL avg ${avg(real).toFixed(3)}R  |  fill drag ${(avg(modeled) - avg(real)).toFixed(3)}R/trade`);
      console.log(`  → ${rows.length < 20 ? "Need ≥20-30 live round-trips before the fill-certainty verdict is trustworthy. Keep the daily cron running." : avg(real) > 0 ? "✅ Edge survives REAL fills." : "❌ Real fills erase the edge — investigate."}`);
    } else {
      console.log("─".repeat(W));
      console.log("  LEDGER: 0 live round-trips yet. Real-fill data accrues as new positions open & close under tracking.");
    }
  }
  console.log("═".repeat(W) + "\n");
}
main().catch((e) => { console.error(e); process.exit(1); });
