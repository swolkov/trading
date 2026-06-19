/**
 * BACKTEST — crypto intraday DIP-BUY / mean-reversion edge test (READ-ONLY research).
 *
 * Question: does the live crypto bot's mechanical dip-buy setup have a real, out-of-sample edge?
 *
 * FIDELITY — the entry/exit math is copied VERBATIM from src/lib/crypto-research.ts:
 *   - rsi(), ema(), atr() are line-for-line identical.
 *   - We replicate the two MEAN-REVERSION / DIP setups the bot actually fires:
 *       SETUP 2 "mean_reversion" (regime-independent):  RSI<30 AND price <= 20-period-low*1.01
 *               stop = price - ATR*2 ; target = EMA21 ; require RR >= 1.5 ; LONG only.
 *       SETUP 4 "fear dip buy" (regime == CRYPTO_FEAR):  RSI<45
 *               stop = price - ATR*2 ; target = max(EMA21,EMA9) (must be > price) ; RR >= 1.5 ; LONG.
 *     (Setups 1/3/5/6 are momentum/trend/fade — NOT dip buys — so they are out of scope here.)
 *   - Bars: 1-HOUR (the bot calls getCryptoBars(symbol,"1Hour") and scans the last ~100 hourly bars).
 *   - Regime (for setup 4) is reconstructed exactly like detectCryptoRegime(): the external
 *     Fear&Greed daily value drives CRYPTO_FEAR (F&G<=20) / CRYPTO_EUPHORIA (>=80), with BTC daily
 *     EMA9/EMA21 trend for BULL/BEAR/CHOPPY. We pull the FULL F&G history (free, no auth).
 *
 * EXIT — same as the live manager (crypto-agent.ts §10):
 *   long closes when price <= stop (stop), price >= target (target), or held >= maxHoldHours (time).
 *   maxHoldHours = 12 (crypto_max_hold_hours default). Walk hourly bars forward; if a bar's range
 *   spans both stop and target, STOP fills first (conservative). No lookahead — indicators use only
 *   bars up to and including the entry bar.
 *
 * KNOWN APPROXIMATIONS (honest — backtest is a SUPERSET of live trades):
 *   - NO AI-confirmation overlay (the bot also requires Claude conviction A/A+ — it only FILTERS,
 *     so a positive edge here is necessary, not sufficient).
 *   - NO confidence-threshold gate (those scores route through the AI layer; mechanical signal only).
 *   - Hourly-bar exit resolution (not minute) — slightly coarser fill order than live.
 *   - One open position per symbol at a time; fees/slippage modeled as a flat round-trip haircut.
 *   - USDT pairs used as USD proxy (standard for crypto backtests).
 *
 * DATA — FREE, no auth: Binance public data mirror data-api.binance.vision (klines), F&G from
 *   alternative.me. Cached to data/crypto/<SYM>.csv and data/crypto/fng.csv so re-runs don't re-pull.
 *
 * Run: npx tsx scripts/backtest-crypto-daytrade.ts
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// ===================== exact math (verbatim from src/lib/crypto-research.ts) =====================
function ema(data: number[], period: number): number[] {
  const k = 2 / (period + 1);
  const result: number[] = [data[0]];
  for (let i = 1; i < data.length; i++) result.push(data[i] * k + result[i - 1] * (1 - k));
  return result;
}
function rsi(closes: number[], period = 14): number | null {
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
function atr(bars: { h: number; l: number; c: number }[], period = 14): number {
  if (bars.length < period + 1) return 0;
  const trs: number[] = [];
  for (let i = bars.length - period; i < bars.length; i++)
    trs.push(Math.max(bars[i].h - bars[i].l, Math.abs(bars[i].h - bars[i - 1].c), Math.abs(bars[i].l - bars[i - 1].c)));
  return trs.reduce((a, b) => a + b, 0) / trs.length;
}

// ===================== config =====================
interface Bar { t: number; o: number; h: number; l: number; c: number; v: number; }
const SYMBOLS = ["BTC", "ETH", "SOL", "AVAX", "DOGE", "LINK", "XRP"];
const MAX_HOLD_HOURS = 12;          // crypto_max_hold_hours default
const LOOKBACK = 100;               // bot scans last ~100 hourly bars
const FEE_RT = 0.0010;              // round-trip fee+slippage haircut on notional (~0.10%; Binance taker ~0.05%/side)
const DATA_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../data/crypto");
const BINANCE = "https://data-api.binance.vision/api/v3/klines";
const HISTORY_START = Date.UTC(2024, 0, 1); // ~1.5yr window (covers a bull + chop + the recent fear leg)

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ===================== data fetch (Binance vision, paginated) + cache =====================
async function fetchSymbol(sym: string): Promise<Bar[]> {
  const csv = path.join(DATA_DIR, `${sym}.csv`);
  if (fs.existsSync(csv)) {
    const rows = fs.readFileSync(csv, "utf8").trim().split("\n").slice(1);
    return rows.map((r) => { const c = r.split(","); return { t: +c[0], o: +c[1], h: +c[2], l: +c[3], c: +c[4], v: +c[5] }; });
  }
  const pair = `${sym}USDT`;
  const bars: Bar[] = [];
  let start = HISTORY_START;
  const now = Date.now();
  // paginate forward in 1000-bar pages (1h bars → 1000h per page)
  for (let guard = 0; guard < 60 && start < now; guard++) {
    const url = `${BINANCE}?symbol=${pair}&interval=1h&limit=1000&startTime=${start}`;
    const res = await fetch(url, { signal: AbortSignal.timeout(20000) });
    if (!res.ok) throw new Error(`${pair} HTTP ${res.status}: ${(await res.text()).slice(0, 120)}`);
    const page = (await res.json()) as unknown[][];
    if (!page.length) break;
    for (const k of page) bars.push({ t: +k[0], o: +k[1], h: +k[2], l: +k[3], c: +k[4], v: +k[5] });
    const last = +page[page.length - 1][0];
    if (page.length < 1000) break;
    start = last + 3_600_000; // next hour
    await sleep(250); // be polite
  }
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(csv, "t,o,h,l,c,v\n" + bars.map((b) => `${b.t},${b.o},${b.h},${b.l},${b.c},${b.v}`).join("\n"));
  return bars;
}

// Fear & Greed daily history → map of YYYY-MM-DD → value
async function fetchFng(): Promise<Map<string, number>> {
  const csv = path.join(DATA_DIR, "fng.csv");
  const m = new Map<string, number>();
  if (fs.existsSync(csv)) {
    for (const r of fs.readFileSync(csv, "utf8").trim().split("\n").slice(1)) { const [d, v] = r.split(","); m.set(d, +v); }
    return m;
  }
  const res = await fetch("https://api.alternative.me/fng/?limit=0&format=json", { signal: AbortSignal.timeout(20000) });
  const data = (await res.json()) as { data: { value: string; timestamp: string }[] };
  for (const row of data.data) {
    const d = new Date(+row.timestamp * 1000).toISOString().slice(0, 10);
    m.set(d, +row.value);
  }
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(csv, "date,value\n" + [...m].map(([d, v]) => `${d},${v}`).join("\n"));
  return m;
}

// ===================== regime reconstruction (mirrors detectCryptoRegime) =====================
// Built from BTC daily bars (EMA9/EMA21 trend) + that day's F&G value. Returns regime per ET-ish day.
type Regime = "CRYPTO_BULL" | "CRYPTO_BEAR" | "CRYPTO_CHOPPY" | "CRYPTO_EUPHORIA" | "CRYPTO_FEAR";
function buildRegimeByDay(btc1h: Bar[], fng: Map<string, number>): Map<string, Regime> {
  // aggregate BTC 1h → daily (UTC) closes
  const dayClose = new Map<string, Bar>();
  for (const b of btc1h) {
    const d = new Date(b.t).toISOString().slice(0, 10);
    const ex = dayClose.get(d);
    if (!ex) dayClose.set(d, { ...b });
    else { ex.h = Math.max(ex.h, b.h); ex.l = Math.min(ex.l, b.l); ex.c = b.c; ex.v += b.v; }
  }
  const days = [...dayClose.keys()].sort();
  const closes = days.map((d) => dayClose.get(d)!.c);
  const out = new Map<string, Regime>();
  for (let i = 0; i < days.length; i++) {
    const d = days[i];
    const upto = closes.slice(0, i + 1);
    let trend: "up" | "down" | "sideways" = "sideways";
    if (upto.length >= 21) {
      const e9 = ema(upto, 9), e21 = ema(upto, 21);
      const diff = (e9[e9.length - 1] - e21[e21.length - 1]) / e21[e21.length - 1];
      if (diff > 0.01) trend = "up"; else if (diff < -0.01) trend = "down";
    }
    const fg = fng.get(d) ?? 50; // bot defaults missing F&G to 50
    let regime: Regime;
    if (fg >= 80) regime = "CRYPTO_EUPHORIA";
    else if (fg <= 20) regime = "CRYPTO_FEAR";
    else if (trend === "up" && fg > 50) regime = "CRYPTO_BULL";
    else if (trend === "down" && fg < 40) regime = "CRYPTO_BEAR";
    else regime = "CRYPTO_CHOPPY";
    out.set(d, regime);
  }
  return out;
}

// ===================== dip-setup detection (ported line-for-line) =====================
interface Setup { type: "mean_reversion" | "fear_dip"; stop: number; target: number; rr: number; rsi: number; }
// `window` = the bot's scan window (last ~100 hourly bars, ending at the entry bar). No lookahead.
function detectDip(window: Bar[], regime: Regime): Setup | null {
  if (window.length < 30) return null; // bot requires >=30 bars
  const closes = window.map((b) => b.c);
  const barData = window.map((b) => ({ h: b.h, l: b.l, c: b.c }));
  const currentPrice = closes[closes.length - 1];
  const currentRsi = rsi(closes);
  const currentAtr = atr(barData);
  const e9 = ema(closes, 9), e21 = ema(closes, 21);
  const ema9 = e9[e9.length - 1], ema21 = e21[e21.length - 1];
  const low20 = Math.min(...closes.slice(-20));

  // SETUP 2 — mean reversion (oversold), regime-independent
  if (currentRsi !== null && currentRsi < 30 && currentPrice <= low20 * 1.01) {
    const stop = currentPrice - currentAtr * 2;
    const target = ema21;
    if (currentPrice - stop > 0) {
      const rr = Math.abs(target - currentPrice) / (currentPrice - stop);
      if (rr >= 1.5 && target > currentPrice) return { type: "mean_reversion", stop, target, rr, rsi: currentRsi };
    }
  }
  // SETUP 4 — Fear Dip Buy, only in CRYPTO_FEAR
  if (regime === "CRYPTO_FEAR" && currentRsi !== null && currentRsi < 45) {
    const stop = currentPrice - currentAtr * 2.0;
    const target = Math.max(ema21, ema9);
    if (target > currentPrice && currentPrice - stop > 0) {
      const rr = (target - currentPrice) / (currentPrice - stop);
      if (rr >= 1.5) return { type: "fear_dip", stop, target, rr, rsi: currentRsi };
    }
  }
  return null;
}

// ===================== backtest loop =====================
interface Trade { sym: string; type: string; entry: number; exit: number; r: number; pnlPct: number; outcome: string; entryTime: number; rsi: number; regime: Regime; }
function backtest(sym: string, bars: Bar[], regimeByDay: Map<string, Regime>): Trade[] {
  const trades: Trade[] = [];
  let blockedUntil = 0; // one position per symbol at a time
  for (let i = LOOKBACK; i < bars.length; i++) {
    if (bars[i].t < blockedUntil) continue;
    const window = bars.slice(i - LOOKBACK + 1, i + 1);
    const day = new Date(bars[i].t).toISOString().slice(0, 10);
    const regime = regimeByDay.get(day) ?? "CRYPTO_CHOPPY";
    const setup = detectDip(window, regime);
    if (!setup) continue;

    // entry at next hourly bar's open (signal forms on close of bar i) — no lookahead
    const entryIdx = i + 1;
    if (entryIdx >= bars.length) break;
    const entry = bars[entryIdx].o;
    // recompute stop/target relative to actual entry distance ratios from the signal bar
    const sigPrice = bars[i].c;
    const stop = entry - (sigPrice - setup.stop);
    const target = entry + (setup.target - sigPrice);
    if (entry - stop <= 0) continue;

    const riskDist = entry - stop;
    const maxTime = bars[entryIdx].t + MAX_HOLD_HOURS * 3_600_000;
    let exitPx = entry, outcome = "time", exitTime = maxTime;
    for (let j = entryIdx; j < bars.length && bars[j].t <= maxTime; j++) {
      const b = bars[j];
      const hitStop = b.l <= stop, hitTarget = b.h >= target;
      if (hitStop && hitTarget) { exitPx = stop; outcome = "stop(ambig)"; exitTime = b.t; break; } // stop first (conservative)
      if (hitStop) { exitPx = stop; outcome = "stop"; exitTime = b.t; break; }
      if (hitTarget) { exitPx = target; outcome = "target"; exitTime = b.t; break; }
      exitPx = b.c; exitTime = b.t; // running close → time exit if loop ends
    }
    const grossPct = (exitPx - entry) / entry;
    const pnlPct = grossPct - FEE_RT;                  // haircut for fees/slippage (round trip)
    const r = (exitPx - entry - entry * FEE_RT) / riskDist; // R-multiple net of fees
    trades.push({ sym, type: setup.type, entry, exit: exitPx, r, pnlPct, outcome, entryTime: bars[entryIdx].t, rsi: setup.rsi, regime });
    blockedUntil = exitTime;
  }
  return trades;
}

// ===================== metrics =====================
function stats(trades: Trade[]) {
  const n = trades.length; if (!n) return null;
  const wins = trades.filter((t) => t.r > 0), losses = trades.filter((t) => t.r < 0);
  const grossW = wins.reduce((s, t) => s + t.r, 0), grossL = Math.abs(losses.reduce((s, t) => s + t.r, 0));
  let cum = 0, peak = 0, dd = 0;
  for (const t of trades) { cum += t.r; peak = Math.max(peak, cum); dd = Math.min(dd, cum - peak); }
  return {
    n, wr: wins.length / n,
    expR: trades.reduce((s, t) => s + t.r, 0) / n,
    expPct: (trades.reduce((s, t) => s + t.pnlPct, 0) / n) * 100,
    pf: grossL ? grossW / grossL : (grossW > 0 ? Infinity : 0),
    netR: trades.reduce((s, t) => s + t.r, 0),
    ddR: dd,
  };
}
const fmt = (s: ReturnType<typeof stats>) =>
  s ? `n=${String(s.n).padStart(4)} | win ${(s.wr * 100).toFixed(0).padStart(3)}% | exp ${(s.expR >= 0 ? "+" : "") + s.expR.toFixed(3)}R (${(s.expPct >= 0 ? "+" : "") + s.expPct.toFixed(2)}%) | PF ${(s.pf === Infinity ? "INF" : s.pf.toFixed(2)).padStart(4)} | netR ${(s.netR >= 0 ? "+" : "") + s.netR.toFixed(1)} | maxDD ${s.ddR.toFixed(1)}R` : "n=0";
const fmtShort = (s: ReturnType<typeof stats>) =>
  s ? `n=${String(s.n).padStart(3)} PF ${(s.pf === Infinity ? "INF" : s.pf.toFixed(2)).padStart(4)} ${(s.expR >= 0 ? "+" : "") + s.expR.toFixed(3)}R ${(s.wr * 100).toFixed(0)}%w` : "n=0";
function line(label: string, t: Trade[]) { console.log(`  ${label.padEnd(22)} ${fmt(stats(t))}`); }

// ===================== main =====================
async function main() {
  console.log("\n" + "=".repeat(96));
  console.log("  CRYPTO DAY-TRADE DIP-BUY BACKTEST — mechanical mean-reversion/fear-dip (no AI overlay)");
  console.log("=".repeat(96));

  // ---- load data ----
  const data: Record<string, Bar[]> = {};
  for (const sym of SYMBOLS) {
    try {
      const bars = await fetchSymbol(sym);
      data[sym] = bars;
      const first = new Date(bars[0].t).toISOString().slice(0, 10);
      const last = new Date(bars[bars.length - 1].t).toISOString().slice(0, 10);
      console.log(`  ${sym.padEnd(5)} ${bars.length} 1h bars  (${first} → ${last})`);
    } catch (e) { console.log(`  ${sym}: FETCH FAILED — ${e instanceof Error ? e.message : e}`); }
  }
  const fng = await fetchFng();
  console.log(`  F&G  ${fng.size} daily values cached`);

  if (!data.BTC) { console.log("\nNo BTC data — cannot build regime. Aborting."); return; }
  const regimeByDay = buildRegimeByDay(data.BTC, fng);
  const fearDays = [...regimeByDay.values()].filter((r) => r === "CRYPTO_FEAR").length;
  console.log(`  Regime days reconstructed: ${regimeByDay.size} (${fearDays} CRYPTO_FEAR days)`);

  // ---- run backtest ----
  const all: Trade[] = [];
  const perSym: Record<string, Trade[]> = {};
  for (const sym of SYMBOLS) {
    if (!data[sym]) continue;
    const t = backtest(sym, data[sym], regimeByDay);
    perSym[sym] = t;
    all.push(...t);
  }

  // ---- per-symbol full-sample ----
  console.log("\n" + "-".repeat(96));
  console.log("FULL SAMPLE — per symbol (LONG dip buys only):");
  for (const sym of SYMBOLS) if (perSym[sym]) line(sym, perSym[sym]);
  console.log("-".repeat(96));
  line("ALL SYMBOLS", all);
  for (const ty of [...new Set(all.map((t) => t.type))]) line("  • " + ty, all.filter((t) => t.type === ty));

  // ---- OUT-OF-SAMPLE: time-ordered 70/30 split ----
  const sorted = [...all].sort((a, b) => a.entryTime - b.entryTime);
  const splitIdx = Math.floor(sorted.length * 0.7);
  const splitTime = sorted.length ? sorted[splitIdx]?.entryTime ?? Infinity : Infinity;
  const splitDate = isFinite(splitTime) ? new Date(splitTime).toISOString().slice(0, 10) : "n/a";
  console.log("\n" + "=".repeat(96));
  console.log(`OUT-OF-SAMPLE — time-ordered split (older 70% IN-SAMPLE vs newer 30% OOS; cut ${splitDate})`);
  console.log("  A real edge holds in the OOS block. Lucky in-sample only = no edge.");
  console.log("=".repeat(96));
  const isS = (t: Trade) => t.entryTime < splitTime, oosS = (t: Trade) => t.entryTime >= splitTime;
  const wf = (label: string, t: Trade[]) =>
    console.log(`  ${label.padEnd(20)} IN:  ${fmtShort(stats(t.filter(isS))).padEnd(34)} | OOS: ${fmtShort(stats(t.filter(oosS)))}`);
  wf("ALL", all);
  for (const ty of [...new Set(all.map((t) => t.type))]) wf("• " + ty, all.filter((t) => t.type === ty));
  console.log("  per symbol:");
  for (const sym of SYMBOLS) if (perSym[sym]?.length) wf("  " + sym, perSym[sym]);

  // ---- BY YEAR — robustness (real edge positive in MOST years) ----
  const yearOf = (t: Trade) => new Date(t.entryTime).getUTCFullYear();
  const years = [...new Set(all.map(yearOf))].sort();
  console.log("\n" + "=".repeat(96));
  console.log("BY YEAR — real edge is positive in MOST years (one good year = regime ghost):");
  console.log("=".repeat(96));
  const yr = (label: string, t: Trade[]) => {
    const parts = years.map((y) => { const s = stats(t.filter((x) => yearOf(x) === y)); return s ? `${y} PF${s.pf === Infinity ? "INF" : s.pf.toFixed(2)} ${s.expR >= 0 ? "+" : ""}${s.expR.toFixed(2)}R/${s.n}` : `${y} —`; });
    console.log(`  ${label.padEnd(20)} ${parts.join("   ")}`);
  };
  yr("ALL", all);
  for (const ty of [...new Set(all.map((t) => t.type))]) yr("• " + ty, all.filter((t) => t.type === ty));
  for (const sym of SYMBOLS) if (perSym[sym]?.length) yr(sym, perSym[sym]);

  // ---- VERDICT ----
  console.log("\n" + "=".repeat(96));
  console.log("VERDICT (per symbol — does intraday dip-buying have OOS edge?):");
  console.log("=".repeat(96));
  for (const sym of SYMBOLS) {
    const t = perSym[sym]; if (!t?.length) { console.log(`  ${sym.padEnd(5)} no trades`); continue; }
    const so = stats(t.filter(oosS)), si = stats(t.filter(isS));
    const real = !!(si && so && si.expR > 0 && so.expR >= 0.05 && so.pf >= 1.2 && so.n >= 15);
    const verdict = !so || so.n < 15 ? "INSUFFICIENT OOS SAMPLE"
      : real ? "EDGE HOLDS OOS"
      : so.expR < 0 ? "LOSES OOS"
      : "COIN FLIP / NO DURABLE EDGE";
    console.log(`  ${sym.padEnd(5)} ${(real ? "[EDGE] " : "[----] ")}${verdict.padEnd(26)} OOS ${fmtShort(so)}`);
  }
  const sAll = stats(all), sOos = stats(all.filter(oosS));
  console.log("-".repeat(96));
  console.log(`  OVERALL full-sample: ${fmt(sAll)}`);
  console.log(`  OVERALL OOS:         ${fmt(sOos)}`);
  const overallReal = !!(sOos && sOos.expR >= 0.03 && sOos.pf >= 1.15);
  console.log(`  >> OVERALL: ${overallReal ? "dip-buying shows OOS edge" : "NO durable OOS edge — dip-buying is a coin flip or loses"}`);

  // XRP confirmation vs prior finding
  const xrp = perSym.XRP;
  if (xrp?.length) {
    const sx = stats(xrp);
    console.log(`\n  XRP check (prior May-29 finding: mean-rev/momentum LOSES): full-sample ${fmtShort(sx)} → ${sx && sx.netR < 0 ? "CONFIRMS prior (XRP loses)" : sx && sx.expR < 0.03 ? "CONFIRMS prior (no edge)" : "diverges from prior"}`);
  }

  console.log("\nCaveats: mechanical signal only (no AI conviction gate, which further filters live);");
  console.log("  hourly-bar exit resolution; one position/symbol; ~0.10% round-trip fee/slippage; USDT≈USD.");
  console.log("  A SUPERSET of live trades. Negative/flat here => no reason to expect a live edge.");
  console.log("=".repeat(96) + "\n");
}

main().catch((e) => { console.error(e); process.exit(1); });
