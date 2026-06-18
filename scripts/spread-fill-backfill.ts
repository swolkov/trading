/**
 * SPREAD FILL BACKFILL — settles FILL CERTAINTY from history, now, instead of waiting months.
 *
 * The forward shadow ledger (spread-shadow.ts) captures REAL bid/ask fills the day a signal fires,
 * but real entries are ~2σ events: round-trips accrue over MONTHS. This harness answers the same
 * question immediately by replaying the EXACT validated strategy (runPair, identical to paper-forward)
 * over the last ~12 months and, for every completed round-trip, pulling the REAL Databento tbbo bid/ask
 * at the actual entry AND exit dates for both legs — then computing the marketable real-fill round-trip
 * vs the modeled (daily-close) round-trip the backtest assumes. This measures fill drag AT THE ACTUAL
 * z=2 ENTRY MOMENTS (where adverse selection lives), not in calm conditions like the median-spread proxy.
 *
 * COST SAFETY: tbbo L1 is included within 1yr on the $179 plan, but this NEVER pulls blind. It runs a
 * free metadata.get_cost pre-pass over every (symbol, day) it would fetch, sums the estimate, and ABORTS
 * if the total exceeds --max-usd (default $5). Real pulls happen only with --execute AND under the guard.
 *
 *   npx tsx scripts/spread-fill-backfill.ts                 dry-run: enumerate trades + preview $ cost, pull nothing
 *   npx tsx scripts/spread-fill-backfill.ts --execute       pull real tbbo (guarded) → reports/spread-fill-backfill.csv
 *   npx tsx scripts/spread-fill-backfill.ts --execute --max-usd 10 --months 12
 */
import fs from "node:fs";

const PAIRS: [string, string][] = [["CL", "RB"], ["CL", "HO"], ["ZC", "ZS"], ["ZW", "ZC"], ["ZS", "ZW"], ["6E", "6B"], ["6A", "6C"], ["GC", "HG"]];
const P = { lookback: 60, entryZ: 2, exitZ: 0, stopZ: 3.5, maxHold: 40 };
const ROOT = new URL("..", import.meta.url);
const LEDGER = new URL("reports/spread-fill-backfill.csv", ROOT).pathname;

const argv = process.argv.slice(2);
const EXECUTE = argv.includes("--execute");
const MAX_USD = parseFloat(argv[argv.indexOf("--max-usd") + 1]) || 5;
const MONTHS = parseInt(argv[argv.indexOf("--months") + 1]) || 12;  // free tbbo window is ~1yr

function apiKey(): string | null {
  if (process.env.DATABENTO_API_KEY) return process.env.DATABENTO_API_KEY;
  for (const f of [".env.local", ".env"]) { try { const m = fs.readFileSync(new URL(f, ROOT), "utf8").match(/^DATABENTO_API_KEY=(.+)$/m); if (m) return m[1].trim(); } catch {} }
  return null;
}
const day = (d: Date) => d.toISOString().slice(0, 10);
const nextDay = (ds: string) => day(new Date(new Date(ds + "T00:00:00Z").getTime() + 86_400_000));

// Daily closes by date — identical loader to paper-forward.ts (col 7 = close).
function loadDaily(sym: string): Map<string, number> {
  const m = new Map<string, number>();
  try { for (const r of fs.readFileSync(new URL(`data/daily/${sym}_1d.csv`, ROOT), "utf8").trim().split("\n").slice(1)) { const c = r.split(","); const p = +c[7]; if (isFinite(p) && p > 0) m.set(c[0].slice(0, 10), p); } } catch {}
  return m;
}
const cache = new Map<string, Map<string, number>>();
const L = (s: string) => cache.get(s) ?? cache.set(s, loadDaily(s)).get(s)!;

interface Tr { pair: string; a: string; b: string; entry: string; exit: string; dir: number; R: number; fs: number; reason: string; }

// EXACT replay from paper-forward.ts runPair — every completed round-trip with modeled gross R.
function runPair(a: string, b: string): Tr[] {
  const A = L(a), B = L(b); const dates = [...A.keys()].filter(d => B.has(d)).sort();
  if (dates.length < P.lookback + 50) return [];
  const ratio = dates.map(d => A.get(d)! / B.get(d)!);
  const out: Tr[] = []; let pos: { dir: number; entry: number; fs: number; i: number } | null = null;
  for (let i = P.lookback; i < ratio.length; i++) {
    const w = ratio.slice(i - P.lookback, i), m = w.reduce((s, v) => s + v, 0) / P.lookback;
    const sd = Math.sqrt(w.reduce((s, v) => s + (v - m) ** 2, 0) / P.lookback) || 1e-9, z = (ratio[i] - m) / sd;
    if (pos) {
      const revert = pos.dir === -1 ? z <= P.exitZ : z >= P.exitZ, stopped = Math.abs(z) >= P.stopZ, timeout = i - pos.i >= P.maxHold;
      if (revert || stopped || timeout) {
        const R = (pos.dir * (ratio[i] - pos.entry) / pos.entry) / (1.5 * pos.fs);
        out.push({ pair: `${a}/${b}`, a, b, entry: dates[pos.i], exit: dates[i], dir: pos.dir, R, fs: pos.fs, reason: stopped ? "stop" : timeout ? "timeout" : "revert" });
        pos = null;
      }
    }
    if (!pos) { if (z > P.entryZ) pos = { dir: -1, entry: ratio[i], fs: sd / m, i }; else if (z < -P.entryZ) pos = { dir: 1, entry: ratio[i], fs: sd / m, i }; }
  }
  return out;
}

// Free cost preview for one (symbol, single-day) tbbo pull.
async function previewCost(sym: string, date: string, auth: string): Promise<number> {
  const body = new URLSearchParams({ dataset: "GLBX.MDP3", symbols: `${sym}.v.0`, stype_in: "continuous", schema: "tbbo", start: date, end: nextDay(date), mode: "historical-streaming" });
  try {
    const r = await fetch("https://hist.databento.com/v0/metadata.get_cost", { method: "POST", headers: { Authorization: auth, "Content-Type": "application/x-www-form-urlencoded" }, body });
    return r.ok ? parseFloat(await r.text()) : NaN;
  } catch { return NaN; }
}

// Real last-of-day top-of-book bid/ask for (symbol, date). null if unavailable.
const quoteCache = new Map<string, { bid: number; ask: number } | null>();
async function dayQuote(sym: string, date: string, auth: string): Promise<{ bid: number; ask: number } | null> {
  const ck = `${sym}|${date}`;
  if (quoteCache.has(ck)) return quoteCache.get(ck)!;
  const body = new URLSearchParams({ dataset: "GLBX.MDP3", symbols: `${sym}.v.0`, stype_in: "continuous", schema: "tbbo", start: date, end: nextDay(date), encoding: "csv", pretty_px: "true", pretty_ts: "true" });
  let out: { bid: number; ask: number } | null = null;
  try {
    const r = await fetch("https://hist.databento.com/v0/timeseries.get_range", { method: "POST", headers: { Authorization: auth, "Content-Type": "application/x-www-form-urlencoded" }, body });
    if (r.ok) {
      const lines = (await r.text()).trim().split("\n");
      if (lines.length >= 2) {
        const h = lines[0].split(","), bi = h.indexOf("bid_px_00"), ai = h.indexOf("ask_px_00");
        for (let i = lines.length - 1; i >= 1; i--) { const c = lines[i].split(","); const bid = +c[bi], ask = +c[ai]; if (bid > 0 && ask > 0 && ask >= bid) { out = { bid, ask }; break; } }
      }
    }
  } catch {}
  quoteCache.set(ck, out);
  return out;
}

async function main() {
  const key = apiKey();
  const W = 100;
  if (!key) { console.error("⛔ DATABENTO_API_KEY not found — cannot capture real fills."); process.exit(1); }
  const auth = "Basic " + Buffer.from(key + ":").toString("base64");

  // 1) Enumerate every round-trip, keep those whose ENTRY is within the last MONTHS (free tbbo window).
  const all: Tr[] = []; for (const [a, b] of PAIRS) all.push(...runPair(a, b));
  if (!all.length) { console.error("No trades — is data/daily populated? Run scripts/dbn-fetch-daily.ts"); process.exit(1); }
  const lastData = all.reduce((mx, t) => (t.exit > mx ? t.exit : mx), "0000");
  const cut = new Date(lastData + "T00:00:00Z"); cut.setUTCMonth(cut.getUTCMonth() - MONTHS);
  const FROM = day(cut);
  const trades = all.filter(t => t.entry >= FROM).sort((x, y) => x.entry.localeCompare(y.entry));

  // Unique (symbol, date) tbbo lookups needed: both legs at both entry and exit.
  const needed = new Set<string>();
  for (const t of trades) for (const d of [t.entry, t.exit]) for (const s of [t.a, t.b]) needed.add(`${s}|${d}`);

  console.log("\n" + "═".repeat(W));
  console.log(`  SPREAD FILL BACKFILL — real tbbo fills vs modeled, at the ACTUAL entry/exit moments`);
  console.log("═".repeat(W));
  console.log(`  Window: ${FROM} → ${lastData} (${MONTHS}mo)   round-trips: ${trades.length}   unique (sym,day) pulls: ${needed.size}`);
  console.log(`  Mode: ${EXECUTE ? `EXECUTE (guard $${MAX_USD})` : "DRY-RUN (cost preview only — pulls nothing)"}`);
  console.log("─".repeat(W));

  // 2) Free cost pre-pass over every needed (sym, day). Sum; abort if over guard.
  let est = 0, priced = 0, unpriced = 0;
  for (const ck of needed) {
    const [s, d] = ck.split("|");
    const c = await previewCost(s, d, auth);
    if (isFinite(c)) { est += c; priced++; } else unpriced++;
  }
  console.log(`  Cost preview: $${est.toFixed(2)} across ${priced} priced pulls${unpriced ? ` (${unpriced} unpriced/unavailable)` : ""}.`);

  if (est > MAX_USD) {
    console.log(`  ⛔ Estimated $${est.toFixed(2)} exceeds guard $${MAX_USD}. Not pulling. Re-run with --max-usd ${Math.ceil(est)} to allow, or --months <fewer>.`);
    console.log("═".repeat(W) + "\n");
    return;
  }
  if (!EXECUTE) {
    console.log(`  ✅ Under guard. Re-run with --execute to pull real fills and bank the ledger.`);
    console.log("═".repeat(W) + "\n");
    return;
  }

  // 3) EXECUTE: pull real tbbo at each entry/exit, compute real-fill vs modeled round-trip R.
  const rows: string[] = [];
  let captured = 0, skipped = 0;
  const realRs: number[] = [], modeledRs: number[] = [];
  for (const t of trades) {
    const ea = await dayQuote(t.a, t.entry, auth), eb = await dayQuote(t.b, t.entry, auth);
    const xa = await dayQuote(t.a, t.exit, auth), xb = await dayQuote(t.b, t.exit, auth);
    if (!ea || !eb || !xa || !xb) { skipped++; continue; }
    // Marketable fills. Entry: long buys A/sells B → askA/bidB ; short sells A/buys B → bidA/askB.
    const realEntry = t.dir === 1 ? ea.ask / eb.bid : ea.bid / eb.ask;
    // Exit reverses: long sells A/buys B → bidA/askB ; short buys A/sells B → askA/bidB.
    const realExit = t.dir === 1 ? xa.bid / xb.ask : xa.ask / xb.bid;
    const realR = t.dir * (realExit - realEntry) / realEntry / (1.5 * t.fs);
    realRs.push(realR); modeledRs.push(t.R);
    rows.push([t.pair, t.dir === 1 ? "long" : "short", t.entry, t.exit, t.reason, t.R.toFixed(3), realR.toFixed(3), (t.R - realR).toFixed(3)].join(","));
    captured++;
  }

  fs.writeFileSync(LEDGER, "pair,dir,entry_date,exit_date,reason,modeled_R,real_R,slip_R\n" + rows.join("\n") + (rows.length ? "\n" : ""));
  const avg = (x: number[]) => x.length ? x.reduce((s, v) => s + v, 0) / x.length : 0;
  const mModeled = avg(modeledRs), mReal = avg(realRs), drag = mModeled - mReal;
  const retained = mModeled !== 0 ? (mReal / mModeled) * 100 : 0;
  console.log(`  Captured ${captured} real round-trips${skipped ? ` (${skipped} skipped — missing tbbo)` : ""}  →  ${LEDGER}`);
  console.log("─".repeat(W));
  console.log(`  Modeled avg ${mModeled >= 0 ? "+" : ""}${mModeled.toFixed(3)}R   vs   REAL-FILL avg ${mReal >= 0 ? "+" : ""}${mReal.toFixed(3)}R   |   fill drag ${drag.toFixed(3)}R/trade (${retained.toFixed(0)}% of edge retained)`);
  const verdict = captured < 20 ? `⏳ ${captured} round-trips — directional; pull more history (--months) for a firm verdict.`
    : mReal > 0 ? `✅ Edge SURVIVES real fills (${mReal.toFixed(3)}R/trade net of actual crossing at the entry moment).`
    : `❌ Real fills ERASE the edge — the modeled close-fill was optimistic. Do not fund.`;
  console.log(`  → ${verdict}`);
  console.log("═".repeat(W) + "\n");
}
main().catch((e) => { console.error(e); process.exit(1); });
