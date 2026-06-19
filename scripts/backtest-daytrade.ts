/**
 * DAY-TRADE DIP BACKTEST — replays the Alpaca STOCK intraday buy-the-dip engine over
 * Databento equity history to find out whether it has REAL edge (read-only research).
 *
 * FIDELITY: the entry/exit logic is ported LINE-FOR-LINE from scanIntradayDips() in
 * src/lib/stocks-agent.ts (15-min bars, RSI(14)<38 + below-VWAP + near-session-low +
 * "stabilizing" + above daily-EMA50 trend filter; stop = sessionLow − 0.5·ATR; target =
 * min(VWAP, price + 2·ATR); flatten EOD). The ema/rsi/atr helpers are copied verbatim
 * from stocks-agent.ts so the math is identical.
 *
 * KNOWN APPROXIMATIONS (honest — this is a SUPERSET of live trades):
 *  - NO AI-confirmation overlay (live also needs Claude to agree at conviction A/A+; that
 *    only FILTERS, so a positive technical edge here is necessary, not sufficient).
 *  - Live re-scans every cron tick and acts on the FIRST qualifying bar; we replicate that
 *    (enter on the first bar each session that meets all conditions, one trade per name/day).
 *  - confidence>=65 gate IS applied (matches the paper-account override in runStocksAgent).
 *  - 1-bp slippage per side + no commission (Alpaca stock commissions are $0).
 *  - Exit resolved on 1-MINUTE bars after entry (accurate stop-vs-target fill order); EOD
 *    flatten at the last RTH minute (mirrors eod_flatten).
 *  - Daily EMA50 trend filter uses ONLY prior days (no lookahead).
 *
 * DATA (mirrors scripts/spread-fill-backfill.ts cost discipline):
 *   FREE metadata.get_cost preview sums the whole pull and ABORTS over --max-usd before
 *   fetching a byte. Default is DRY-RUN (preview only). --execute actually pulls. Cached to
 *   data/equity/<sym>_1m.csv and <sym>_1d.csv so re-runs never re-pull.
 *
 *   npx tsx scripts/backtest-daytrade.ts                       dry-run: preview cost, pull nothing
 *   npx tsx scripts/backtest-daytrade.ts --execute             pull (guarded) + run the backtest
 *   npx tsx scripts/backtest-daytrade.ts --execute --max-usd 10 --years 2
 */
import fs from "node:fs";

// ── config ──
const SYMBOLS = ["NVDA", "AAPL", "TSLA", "META", "AMZN", "GOOGL", "MSFT", "AMD", "AVGO", "NFLX"]; // stocks_focus_symbols
const ROOT = new URL("..", import.meta.url);
const argv = process.argv.slice(2);
const EXECUTE = argv.includes("--execute");
const MAX_USD = parseFloat(argv[argv.indexOf("--max-usd") + 1]) || 10;
const YEARS = parseInt(argv[argv.indexOf("--years") + 1]) || 2;
const SLIP_BPS = 1; // 1 basis point adverse per side

function apiKey(): string | null {
  if (process.env.DATABENTO_API_KEY) return process.env.DATABENTO_API_KEY;
  for (const f of [".env.local", ".env"]) {
    try { const m = fs.readFileSync(new URL(f, ROOT), "utf8").match(/^DATABENTO_API_KEY=(.+)$/m); if (m) return m[1].trim(); } catch {}
  }
  return null;
}
const dayStr = (d: Date) => d.toISOString().slice(0, 10);

// ── indicators — copied VERBATIM from src/lib/stocks-agent.ts ──
function ema(data: number[], period: number): number[] {
  const k = 2 / (period + 1);
  const result: number[] = [data[0]];
  for (let i = 1; i < data.length; i++) result.push(data[i] * k + result[i - 1] * (1 - k));
  return result;
}
function rsi(closes: number[], period: number = 14): number | null {
  if (closes.length < period + 1) return null;
  const changes: number[] = [];
  for (let i = closes.length - period; i < closes.length; i++) changes.push(closes[i] - closes[i - 1]);
  const gains = changes.filter((c) => c > 0);
  const losses = changes.filter((c) => c < 0).map((c) => Math.abs(c));
  const avgGain = gains.length > 0 ? gains.reduce((a, b) => a + b, 0) / period : 0;
  const avgLoss = losses.length > 0 ? losses.reduce((a, b) => a + b, 0) / period : 0;
  if (avgLoss === 0) return 100;
  return 100 - 100 / (1 + avgGain / avgLoss);
}
function atr(bars: { h: number; l: number; c: number }[], period: number = 14): number {
  if (bars.length < period + 1) return 0;
  const trs: number[] = [];
  for (let i = bars.length - period; i < bars.length; i++) {
    const tr = Math.max(bars[i].h - bars[i].l, Math.abs(bars[i].h - bars[i - 1].c), Math.abs(bars[i].l - bars[i - 1].c));
    trs.push(tr);
  }
  return trs.reduce((a, b) => a + b, 0) / trs.length;
}

// ── data pull (Databento XNAS.ITCH, raw_symbol, ohlcv-1m / ohlcv-1d) ──
async function previewCost(sym: string, schema: string, start: string, end: string, auth: string): Promise<number> {
  const body = new URLSearchParams({ dataset: "XNAS.ITCH", symbols: sym, stype_in: "raw_symbol", schema, start, end, mode: "historical-streaming" });
  try {
    const r = await fetch("https://hist.databento.com/v0/metadata.get_cost", { method: "POST", headers: { Authorization: auth, "Content-Type": "application/x-www-form-urlencoded" }, body });
    return r.ok ? parseFloat(await r.text()) : NaN;
  } catch { return NaN; }
}
async function fetchBars(sym: string, schema: string, start: string, end: string, auth: string): Promise<string> {
  const body = new URLSearchParams({ dataset: "XNAS.ITCH", symbols: sym, stype_in: "raw_symbol", schema, start, end, encoding: "csv", pretty_px: "true", pretty_ts: "true" });
  const r = await fetch("https://hist.databento.com/v0/timeseries.get_range", { method: "POST", headers: { Authorization: auth, "Content-Type": "application/x-www-form-urlencoded" }, body });
  if (!r.ok) throw new Error(`${sym} ${schema}: HTTP ${r.status} — ${(await r.text()).slice(0, 200)}`);
  return r.text();
}

// ── bar types + loaders ──
interface Bar { t: number; o: number; h: number; l: number; c: number; v: number; }
// CSV: ts_event(0 ISO),rtype,publisher_id,instrument_id,open(4),high(5),low(6),close(7),volume(8)
function parseCsv(text: string): Bar[] {
  const rows = text.trim().split("\n").slice(1);
  const out: Bar[] = [];
  for (const r of rows) {
    if (!r) continue;
    const c = r.split(",");
    const t = new Date(c[0]).getTime();
    const o = +c[4], h = +c[5], l = +c[6], cl = +c[7], v = +c[8];
    if (!isFinite(t) || !isFinite(cl) || cl <= 0) continue;
    out.push({ t, o, h, l, c: cl, v });
  }
  out.sort((a, b) => a.t - b.t);
  return out;
}
function load1m(sym: string): Bar[] { return parseCsv(fs.readFileSync(new URL(`data/equity/${sym}_1m.csv`, ROOT), "utf8")); }
function load1d(sym: string): Bar[] { return parseCsv(fs.readFileSync(new URL(`data/equity/${sym}_1d.csv`, ROOT), "utf8")); }

// ── RTH filter + ET calendar-day grouping ──
// XNAS.ITCH ohlcv-1m ts_event is UTC. RTH = 13:30–20:00 UTC (9:30am–4pm ET) on the standard
// schedule. DST shifts this by an hour, so derive the ET wall-clock from the timestamp and keep
// 09:30 <= ET < 16:00. Group by ET calendar date so a session = one trading day.
function etParts(t: number): { etDateStr: string; etMinutes: number } {
  const d = new Date(t);
  const etDateStr = d.toLocaleDateString("en-CA", { timeZone: "America/New_York" }); // YYYY-MM-DD
  const hm = d.toLocaleTimeString("en-US", { timeZone: "America/New_York", hour12: false, hour: "2-digit", minute: "2-digit" });
  const [hh, mm] = hm.split(":").map(Number);
  return { etDateStr, etMinutes: hh * 60 + mm };
}
const RTH_START = 9 * 60 + 30; // 09:30 ET
const RTH_END = 16 * 60;       // 16:00 ET

// Aggregate RTH 1-minute bars → 15-minute bars, grouped by ET session date.
// Returns: per-session 15m bars + the raw RTH 1m bars (for accurate intrabar exit fills).
interface Session { date: string; b15: Bar[]; m1: Bar[]; }
function buildSessions(m1all: Bar[]): Session[] {
  const byDate = new Map<string, Bar[]>();
  for (const b of m1all) {
    const { etDateStr, etMinutes } = etParts(b.t);
    if (etMinutes < RTH_START || etMinutes >= RTH_END) continue; // RTH only
    (byDate.get(etDateStr) ?? byDate.set(etDateStr, []).get(etDateStr)!).push(b);
  }
  const sessions: Session[] = [];
  for (const [date, m1] of [...byDate.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    m1.sort((a, b) => a.t - b.t);
    // 15m buckets aligned to wall-clock 15-min boundaries (00,15,30,45) — matches Alpaca 15Min bars.
    const buckets = new Map<number, Bar>();
    for (const b of m1) {
      const key = Math.floor(b.t / 900000) * 900000;
      const ex = buckets.get(key);
      if (!ex) buckets.set(key, { t: key, o: b.o, h: b.h, l: b.l, c: b.c, v: b.v });
      else { ex.h = Math.max(ex.h, b.h); ex.l = Math.min(ex.l, b.l); ex.c = b.c; ex.v += b.v; }
    }
    const b15 = [...buckets.values()].sort((a, b) => a.t - b.t);
    sessions.push({ date, b15, m1 });
  }
  return sessions;
}

// ── daily EMA50 trend filter (prior days only — NO lookahead) ──
// Returns a function: given an ET session date, is price-vs-EMA50 known and what is it?
function buildDailyEma50(daily: Bar[]): (date: string) => number | null {
  const dates = daily.map((b) => dayStr(new Date(b.t)));
  const closes = daily.map((b) => b.c);
  return (sessionDate: string) => {
    // index of the last daily bar STRICTLY BEFORE this session date (prior days only)
    let idx = -1;
    for (let i = 0; i < dates.length; i++) { if (dates[i] < sessionDate) idx = i; else break; }
    if (idx < 49) return null; // need >=50 prior daily closes (matches daily.length >= 50)
    const sub = closes.slice(0, idx + 1);
    const e = ema(sub, 50);
    return e[e.length - 1];
  };
}

// ── the ported strategy + per-session simulation ──
interface DTrade { sym: string; date: string; entryTime: number; entry: number; exit: number; stop: number; target: number; rMult: number; pnlPct: number; outcome: string; rsi: number; confidence: number; }

// Resolve exit walking the session's 1-minute bars forward from entry: stop / target / EOD flatten.
// Stop-first if a single minute spans both (conservative).
function resolveExit(m1: Bar[], fromTime: number, stop: number, target: number): { px: number; outcome: string; t: number } {
  let last: Bar | null = null;
  for (const b of m1) {
    if (b.t < fromTime) continue;
    last = b;
    const hitStop = b.l <= stop;
    const hitTarget = b.h >= target;
    if (hitStop && hitTarget) return { px: stop, outcome: "stop(ambig)", t: b.t };
    if (hitStop) return { px: stop, outcome: "stop", t: b.t };
    if (hitTarget) return { px: target, outcome: "target", t: b.t };
  }
  // EOD flatten at the last RTH minute close
  return { px: last ? last.c : stop, outcome: "eod", t: last ? last.t : fromTime };
}

// Replicate scanIntradayDips for ONE session, walking bar-by-bar. Live re-scans each tick and
// fires on the FIRST qualifying state, so we enter on the first 15m bar that meets all conditions.
function simulateSession(sym: string, s: Session, ema50: number | null): DTrade | null {
  const b15 = s.b15;
  for (let n = 6; n <= b15.length; n++) {              // intraday.length < 6 → skip (need >=6 bars)
    const intraday = b15.slice(0, n);                  // bars known up to and including the current bar (no lookahead)
    const closes = intraday.map((b) => b.c);
    const currentPrice = closes[closes.length - 1];
    const intradayRsi = rsi(closes, 14);
    const intradayAtr = atr(intraday.map((b) => ({ h: b.h, l: b.l, c: b.c })), 14);

    // Session VWAP (typical price weighted by volume) — exact loop from stocks-agent.
    let pv = 0, vol = 0;
    for (const b of intraday) { const typical = (b.h + b.l + b.c) / 3; pv += typical * b.v; vol += b.v; }
    const vwap = vol > 0 ? pv / vol : currentPrice;

    const sessionLow = Math.min(...intraday.map((b) => b.l));
    const sessionHigh = Math.max(...intraday.map((b) => b.h));
    const lastBar = intraday[intraday.length - 1];

    // Trend filter: price above daily EMA50 * 0.98 (if we lack >=50 prior daily bars, allow through).
    const trendOk = ema50 == null ? true : currentPrice > ema50 * 0.98;

    const belowVwap = currentPrice < vwap;
    const nearLow = intradayAtr > 0 && currentPrice <= sessionLow + intradayAtr * 0.6;
    const stabilizing = lastBar.c >= lastBar.o || currentPrice > sessionLow * 1.001;
    const oversold = intradayRsi !== null && intradayRsi < 38;

    if (!(oversold && belowVwap && nearLow && stabilizing && trendOk)) continue;
    if (intradayAtr <= 0) continue;

    const stop = sessionLow - intradayAtr * 0.5;
    const target = Math.min(vwap, currentPrice + intradayAtr * 2);
    const riskPerShare = currentPrice - stop;
    if (riskPerShare <= 0) continue;
    const rr = (target - currentPrice) / riskPerShare;
    if (rr < 1.2 || target <= currentPrice) continue;

    // confidence (exact formula) + the >=65 paper gate from runStocksAgent.
    const rsiDepth = Math.max(0, 38 - (intradayRsi as number));
    const vwapStretch = (vwap - currentPrice) / vwap;
    const confidence = Math.min(85, Math.round(55 + rsiDepth * 0.7 + Math.min(15, vwapStretch * 1000) + (lastBar.c > lastBar.o ? 5 : 0)));
    if (confidence < 65) continue;

    // ── FILL: enter at the close of the qualifying 15m bar (the bar the scan saw), 1bp adverse.
    // Exit resolved on the session's 1-minute bars AFTER the 15m bar closes (no lookahead).
    const entry = currentPrice * (1 + SLIP_BPS / 10000);
    const fromTime = lastBar.t + 900000; // minute after this 15m bar closes
    const ex = resolveExit(s.m1, fromTime, stop, target);
    const exitPx = ex.px * (1 - SLIP_BPS / 10000);
    const riskAfter = entry - stop;
    const pnlPct = (exitPx - entry) / entry;
    const rMult = riskAfter > 0 ? (exitPx - entry) / riskAfter : 0;
    return { sym, date: s.date, entryTime: lastBar.t, entry, exit: exitPx, stop, target, rMult, pnlPct, outcome: ex.outcome, rsi: intradayRsi as number, confidence };
  }
  return null;
}

function backtestSymbol(sym: string): DTrade[] {
  const m1all = load1m(sym);
  const daily = load1d(sym);
  const sessions = buildSessions(m1all);
  const ema50At = buildDailyEma50(daily);
  const out: DTrade[] = [];
  for (const s of sessions) {
    const t = simulateSession(sym, s, ema50At(s.date));
    if (t) out.push(t);
  }
  return out;
}

// ── stats ──
function stats(trades: DTrade[]) {
  const n = trades.length; if (!n) return null;
  const wins = trades.filter((t) => t.rMult > 0), losses = trades.filter((t) => t.rMult < 0);
  const grossW = wins.reduce((s, t) => s + t.rMult, 0), grossL = Math.abs(losses.reduce((s, t) => s + t.rMult, 0));
  const expR = trades.reduce((s, t) => s + t.rMult, 0) / n;
  // max drawdown on the cumulative-R equity curve (time-ordered)
  const ordered = [...trades].sort((a, b) => a.entryTime - b.entryTime);
  let cum = 0, peak = 0, dd = 0;
  for (const t of ordered) { cum += t.rMult; peak = Math.max(peak, cum); dd = Math.min(dd, cum - peak); }
  return { n, wr: wins.length / n, expR, pf: grossL ? grossW / grossL : (grossW > 0 ? Infinity : 0), totR: cum, dd, avgWinR: wins.length ? grossW / wins.length : 0, avgLossR: losses.length ? grossL / losses.length : 0 };
}
const fmtS = (s: ReturnType<typeof stats>) => s
  ? `n=${String(s.n).padStart(4)} | win ${(s.wr * 100).toFixed(0)}% | exp ${s.expR >= 0 ? "+" : ""}${s.expR.toFixed(3)}R | PF ${s.pf === Infinity ? "INF" : s.pf.toFixed(2)} | totR ${s.totR >= 0 ? "+" : ""}${s.totR.toFixed(1)} | maxDD ${s.dd.toFixed(1)}R`
  : "n=0";

async function main() {
  const W = 96;
  const key = apiKey();
  if (!key) { console.error("⛔ DATABENTO_API_KEY not found in env or .env.local."); process.exit(1); }
  const auth = "Basic " + Buffer.from(key + ":").toString("base64");

  // Window: end ~4 days ago (recent data is locked behind live sub), back YEARS.
  const end = new Date(Date.now() - 4 * 86_400_000);
  const startMin = new Date(end.getTime() - YEARS * 365 * 86_400_000);
  const startDaily = new Date(end.getTime() - (YEARS + 1) * 365 * 86_400_000); // +1yr daily so EMA50 is warm at the 1m window start
  const S = (d: Date) => d.toISOString().slice(0, 19);

  const dir = new URL("data/equity/", ROOT);
  fs.mkdirSync(dir, { recursive: true });

  console.log("\n" + "═".repeat(W));
  console.log("  DAY-TRADE DIP BACKTEST — Alpaca intraday buy-the-dip (scanIntradayDips) over Databento equities");
  console.log("═".repeat(W));
  console.log(`  Symbols: ${SYMBOLS.join(", ")}`);
  console.log(`  1m window: ${dayStr(startMin)} → ${dayStr(end)} (RTH only) | daily window: ${dayStr(startDaily)} → ${dayStr(end)}`);
  console.log(`  Mode: ${EXECUTE ? `EXECUTE (guard $${MAX_USD})` : "DRY-RUN (cost preview only — pulls nothing)"}`);
  console.log("─".repeat(W));

  // 1) Determine which pulls are needed (skip cached files), free cost-preview the rest.
  let est = 0, toPull: { sym: string; schema: string; start: string; end: string; file: URL }[] = [];
  for (const sym of SYMBOLS) {
    const f1m = new URL(`data/equity/${sym}_1m.csv`, ROOT);
    const f1d = new URL(`data/equity/${sym}_1d.csv`, ROOT);
    if (!fs.existsSync(f1m)) toPull.push({ sym, schema: "ohlcv-1m", start: S(startMin), end: S(end), file: f1m });
    if (!fs.existsSync(f1d)) toPull.push({ sym, schema: "ohlcv-1d", start: S(startDaily), end: S(end), file: f1d });
  }
  if (toPull.length === 0) {
    console.log("  All data cached in data/equity/ — no pull needed.");
  } else {
    console.log(`  Cost preview for ${toPull.length} uncached pulls...`);
    let unpriced = 0;
    for (const p of toPull) {
      const c = await previewCost(p.sym, p.schema, p.start, p.end, auth);
      if (isFinite(c)) est += c; else unpriced++;
      console.log(`    ${p.sym.padEnd(6)} ${p.schema.padEnd(9)} ${isFinite(c) ? "$" + c.toFixed(4) : "unpriced"}`);
    }
    console.log("─".repeat(W));
    console.log(`  Estimated total: $${est.toFixed(4)}${unpriced ? ` (${unpriced} unpriced)` : ""}  |  guard $${MAX_USD}`);
    if (est > MAX_USD) {
      console.log(`  ⛔ Estimate exceeds guard. Not pulling. Re-run with --max-usd ${Math.ceil(est) + 1} to allow.`);
      console.log("═".repeat(W) + "\n");
      return;
    }
    if (!EXECUTE) {
      console.log(`  ✅ Under guard. Re-run with --execute to pull and run the backtest.`);
      console.log("═".repeat(W) + "\n");
      return;
    }
    // 2) EXECUTE: pull + cache.
    console.log(`  Pulling ${toPull.length} files...`);
    for (const p of toPull) {
      try {
        const csv = await fetchBars(p.sym, p.schema, p.start, p.end, auth);
        fs.writeFileSync(p.file, csv);
        const rows = csv.trim().split("\n").length - 1;
        console.log(`    ${p.sym.padEnd(6)} ${p.schema.padEnd(9)} ${String(rows).padStart(7)} bars → data/equity/${p.sym}_${p.schema === "ohlcv-1m" ? "1m" : "1d"}.csv`);
      } catch (e) { console.log(`    ${p.sym} ${p.schema}: ERROR ${e instanceof Error ? e.message : e}`); }
    }
  }

  if (!EXECUTE && toPull.length === 0) {
    // cached + dry-run: still allow running the backtest on cached data (nothing pulled).
  } else if (!EXECUTE) {
    return; // already handled above
  }

  // 3) Run the backtest on all symbols.
  console.log("─".repeat(W));
  const all: DTrade[] = [];
  const perSym: Record<string, DTrade[]> = {};
  for (const sym of SYMBOLS) {
    try {
      const t = backtestSymbol(sym);
      perSym[sym] = t; all.push(...t);
    } catch (e) { console.log(`  ${sym}: ${e instanceof Error ? e.message : e}`); }
  }
  all.sort((a, b) => a.entryTime - b.entryTime);

  if (!all.length) { console.log("  No trades produced — check data/equity/ files."); console.log("═".repeat(W) + "\n"); return; }

  console.log("  OVERALL");
  console.log("  " + fmtS(stats(all)));
  const winsAll = stats(all)!;
  console.log(`  avg win ${winsAll.avgWinR >= 0 ? "+" : ""}${winsAll.avgWinR.toFixed(2)}R | avg loss -${winsAll.avgLossR.toFixed(2)}R`);

  console.log("\n  PER SYMBOL");
  for (const sym of SYMBOLS) {
    const s = stats(perSym[sym] || []);
    console.log(`    ${sym.padEnd(6)} ${s ? fmtS(s) : "n=0"}`);
  }

  console.log("\n  OUTCOME MIX");
  const outcomes = [...new Set(all.map((t) => t.outcome.replace("(ambig)", "")))];
  for (const oc of outcomes) {
    const sub = all.filter((t) => t.outcome.replace("(ambig)", "") === oc);
    console.log(`    ${oc.padEnd(8)} ${String(sub.length).padStart(4)} (${((sub.length / all.length) * 100).toFixed(0)}%) avgR ${(sub.reduce((s, t) => s + t.rMult, 0) / sub.length).toFixed(2)}`);
  }

  // 4) OUT-OF-SAMPLE: time-ordered 70/30 split + by-year. Edge is only real if it holds OOS.
  console.log("\n" + "─".repeat(W));
  console.log("  OUT-OF-SAMPLE — time-ordered split (older 70% IN-sample vs recent 30% OOS)");
  const splitIdx = Math.floor(all.length * 0.7);
  const inSample = all.slice(0, splitIdx), oos = all.slice(splitIdx);
  const splitDate = oos.length ? dayStr(new Date(oos[0].entryTime)) : "n/a";
  console.log(`    split at ${splitDate}`);
  console.log(`    IN  (70%)  ${fmtS(stats(inSample))}`);
  console.log(`    OOS (30%)  ${fmtS(stats(oos))}`);

  console.log("\n  BY YEAR (a real edge is positive in MOST years)");
  const yearOf = (t: DTrade) => new Date(t.entryTime).getUTCFullYear();
  const years = [...new Set(all.map(yearOf))].sort();
  for (const y of years) {
    const s = stats(all.filter((t) => yearOf(t) === y));
    console.log(`    ${y}  ${s ? fmtS(s) : "n=0"}`);
  }

  // 5) Verdict.
  const si = stats(inSample), so = stats(oos);
  console.log("\n" + "═".repeat(W));
  console.log("  VERDICT");
  let verdict: string;
  if (!so || so.n < 25) {
    verdict = `⏳ INCONCLUSIVE — only ${so?.n ?? 0} OOS trades. Sample too thin to call. Pull more history (--years).`;
  } else if (so.expR >= 0.10 && so.pf >= 1.2 && si && si.expR > 0) {
    verdict = `✅ EDGE HOLDS OOS — OOS exp ${so.expR.toFixed(3)}R, PF ${so.pf.toFixed(2)} on ${so.n} trades (and IN-sample positive). Worth a closer look (still no AI overlay / costs are real).`;
  } else if (so.expR > 0 && so.pf > 1.0) {
    verdict = `🟡 MARGINAL — OOS positive but weak (exp ${so.expR.toFixed(3)}R, PF ${so.pf.toFixed(2)}). Not a clear edge; likely a coin flip after costs/AI filtering. Do not size up.`;
  } else {
    verdict = `❌ NO EDGE — OOS loses (exp ${so.expR.toFixed(3)}R, PF ${so.pf.toFixed(2)} on ${so.n} trades). Intraday dip-buying these names does NOT have demonstrable edge out-of-sample.`;
  }
  console.log("  " + verdict);
  console.log("\n  Caveats: technical-only superset (live also needs AI conviction A/A+, which only filters);");
  console.log("  1bp/side slippage, $0 commission (Alpaca); exits on 1m intrabar + EOD flatten; EMA50 prior-days-only.");
  console.log("═".repeat(W) + "\n");
}
main().catch((e) => { console.error(e); process.exit(1); });
