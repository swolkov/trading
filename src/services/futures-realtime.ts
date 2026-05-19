#!/usr/bin/env node
// ============ REAL-TIME FUTURES TRADING ENGINE ============
// Persistent process — polls Tradovate md/getChart every 5s for prices,
// builds bars, detects setups on bar close, executes via Tradovate.
// Deploy on Railway.
//
// DATA SOURCE: Tradovate md/getChart REST (same broker = most reliable).
// Falls back to Yahoo Finance if Tradovate MD is unavailable.

import { prisma } from "../lib/db";
import { logTradeToJournal, logDecision, logObservation, vaultRead, vaultWrite } from "../lib/vault";
import { getETHour, getETDayOfWeek, getETDateString, isWeekend as isWeekendET, isHalt as isHaltET } from "../lib/session-time";
import { getTradingMode } from "../lib/trading-mode";

// ── Config ──────────────────────────────────────────────

const DEMO_API = "https://demo.tradovateapi.com/v1";
const LIVE_API = "https://live.tradovateapi.com/v1";
const ORDER_API = DEMO_API; // Demo engine — ALWAYS on, 24/7 learning
let isLiveMode = false;     // When true, ALSO executes on live during RTH windows
const POLL_INTERVAL_MS = 5000; // Poll Yahoo every 5 seconds
const BAR_INTERVAL_MS = 5 * 60 * 1000; // 5-minute bars

// Subscribe to both full-size and micro — trade whichever fits account equity
// Full-size: ES ($50/pt), NQ ($20/pt), GC ($100/pt) — need $25k+
// Micro: MES ($5/pt), MNQ ($2/pt) — MGC removed ($10/pt too risky for $1K)
const FULL_SIZE_SYMBOLS = ["ES", "NQ", "GC"];
const MICRO_SYMBOLS = ["MES", "MNQ"]; // MGC removed: $10/pt too risky for $1K live mirror
// Map full-size to micro equivalents
const MICRO_EQUIVALENT: Record<string, string> = { ES: "MES", NQ: "MNQ", GC: "MGC" };
const FULL_EQUIVALENT: Record<string, string> = { MES: "ES", MNQ: "NQ", MGC: "GC" };
// $25k threshold: below this, trade micros. Above, trade full-size.
const FULL_SIZE_EQUITY_THRESHOLD = 25_000;

// Active trading symbols — recalculated when equity updates
let SYMBOLS = MICRO_SYMBOLS; // default to micros, upgraded on startup after equity fetch

function updateTradingSymbols() {
  const prev = SYMBOLS;
  // Demo always trades micros (full-size MD not subscribed on demo).
  // Live only upgrades to full-size when equity exceeds $25K.
  SYMBOLS = isLiveMode && tradovateEquity >= FULL_SIZE_EQUITY_THRESHOLD ? FULL_SIZE_SYMBOLS : MICRO_SYMBOLS;
  if (prev !== SYMBOLS) {
    log(`[SIZING] Equity $${tradovateEquity.toFixed(0)} → trading ${SYMBOLS.join(", ")} (${SYMBOLS === FULL_SIZE_SYMBOLS ? "full-size" : "micros"})`);
  }
}

// Yahoo fallback symbol mapping (used only if Tradovate MD fails)
const YAHOO_MAP: Record<string, string> = {
  ES: "ES=F", NQ: "NQ=F", GC: "GC=F",
  MES: "ES=F", MNQ: "NQ=F", MGC: "GC=F",
};
// Lazy-load Yahoo only when needed (fallback path)
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let _yfEngine: { quote: (symbols: string[] | string) => Promise<any>; chart: (symbol: string, opts: Record<string, unknown>) => Promise<any> } | null = null;
function getYfEngine() {
  if (!_yfEngine) {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const YFEngine = require("yahoo-finance2").default || require("yahoo-finance2");
    _yfEngine = new YFEngine({ suppressNotices: ["ripHistorical", "yahooSurvey"] }) as typeof _yfEngine;
  }
  return _yfEngine!;
}
const CONTRACT_MULTIPLIERS: Record<string, number> = {
  // Full-size
  ES: 50, NQ: 20, GC: 100, YM: 5, RTY: 50,
  // Micros
  MES: 5, MNQ: 2, MGC: 10, MYM: 0.5, M2K: 5,
};
// Symbols that are metals (different session timing + strategy)
const METALS = new Set(["MGC", "GC"]);

// ── Trading Mode + Live Mirror ────────────────────────────
// Demo engine ALWAYS runs 24/7. When isLiveMode=true, trades are ALSO
// mirrored to the live account during RTH windows.

let liveAccessToken = "";
let liveTokenExpires = 0;
let liveAccountId = 0;
let liveAccountName = "";
let liveEquity = 0;

async function authenticateLive(): Promise<string> {
  if (liveAccessToken && Date.now() < liveTokenExpires) return liveAccessToken;

  const res = await fetch(`${LIVE_API}/auth/accesstokenrequest`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      name: process.env.TRADOVATE_USERNAME || "",
      password: process.env.TRADOVATE_PASSWORD || "",
      appId: process.env.TRADOVATE_APP_ID || "",
      appVersion: process.env.TRADOVATE_APP_VERSION || "1.0",
      deviceId: "esbueno-live-agent",
      cid: parseInt(process.env.TRADOVATE_CID || "0"),
      sec: process.env.TRADOVATE_SEC || "",
    }),
  });

  if (!res.ok) throw new Error(`Live auth failed (${res.status}): ${await res.text().catch(() => "")}`);

  const data = await res.json();
  liveAccessToken = data.accessToken;
  liveTokenExpires = Date.now() + 23 * 60 * 60 * 1000;

  const accounts = await liveApiFetch("/account/list") as { id: number; name: string; active: boolean }[];
  const active = accounts.find((a) => a.active) || accounts[0];
  if (active) { liveAccountId = active.id; liveAccountName = active.name; }

  // Fetch live equity
  try {
    const bal = await liveApiFetch(`/cashBalance/getCashBalanceSnapshot?accountId=${liveAccountId}`) as { totalCashValue?: number };
    if (bal?.totalCashValue) liveEquity = bal.totalCashValue;
  } catch { /* use last known */ }

  log(`[LIVE] Authenticated — ${liveAccountName} (#${liveAccountId}) — equity $${liveEquity.toFixed(0)}`);
  return liveAccessToken;
}

async function liveApiFetch(path: string, options?: RequestInit): Promise<unknown> {
  const token = await authenticateLive();
  const res = await fetch(`${LIVE_API}${path}`, {
    ...options,
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}`, ...options?.headers },
    signal: AbortSignal.timeout(15000),
  });
  if (res.status === 401) {
    liveAccessToken = "";
    liveTokenExpires = 0;
    const newToken = await authenticateLive();
    const retry = await fetch(`${LIVE_API}${path}`, {
      ...options,
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${newToken}`, ...options?.headers },
      signal: AbortSignal.timeout(15000),
    });
    if (!retry.ok) throw new Error(`Live API ${retry.status}: ${await retry.text().catch(() => "")}`);
    return retry.json();
  }
  if (!res.ok) throw new Error(`Live API ${res.status}: ${await res.text().catch(() => "")}`);
  return res.json();
}

function isLiveRTHWindow(): boolean {
  if (!isLiveMode) return false;
  const s = getSessionName();
  if (s === "morning") return getMinutesSinceRTHOpen() >= 15; // After first 15 min
  if (s === "afternoon") return true;
  if (s === "close") return true;
  return false; // Block: midday, ETH, open, halt
}

async function loadTradingMode() {
  try {
    const mode = await getTradingMode("futures");
    const newIsLive = mode === "live";

    if (newIsLive === isLiveMode) return; // No change

    log(`\n${"!".repeat(60)}`);
    log(`LIVE MODE: ${newIsLive ? "ENABLED — trades will mirror to live during RTH" : "DISABLED — demo only"}`);
    log(`${"!".repeat(60)}\n`);
    notify(`LIVE MODE ${newIsLive ? "ENABLED" : "DISABLED"} — demo continues 24/7`, "general");

    isLiveMode = newIsLive;

    if (newIsLive) {
      // Authenticate against live account (demo stays untouched)
      try {
        await authenticateLive();
      } catch (err) {
        log(`[LIVE] Auth FAILED: ${err} — disabling live mode`);
        isLiveMode = false;
        notify(`LIVE AUTH FAILED — live disabled: ${err}`, "general");
      }
    }
  } catch (err) {
    log(`[MODE] Failed to check trading mode: ${err}`);
  }
}

// ── Tradovate Auth (for order execution only) ───────────

let accessToken = "";
let tokenExpires = 0;
let accountId = 0;
let accountName = "";

async function authenticate(): Promise<string> {
  if (accessToken && Date.now() < tokenExpires) return accessToken;

  const res = await fetch(`${ORDER_API}/auth/accesstokenrequest`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      name: process.env.TRADOVATE_USERNAME || "",
      password: process.env.TRADOVATE_PASSWORD || "",
      appId: process.env.TRADOVATE_APP_ID || "",
      appVersion: process.env.TRADOVATE_APP_VERSION || "1.0",
      deviceId: "esbueno-realtime-agent",
      cid: parseInt(process.env.TRADOVATE_CID || "0"),
      sec: process.env.TRADOVATE_SEC || "",
    }),
  });

  if (!res.ok) throw new Error(`Auth failed (${res.status}): ${await res.text().catch(() => "")}`);

  const data = await res.json();
  accessToken = data.accessToken;
  tokenExpires = Date.now() + 23 * 60 * 60 * 1000;

  const accounts = await apiFetch("/account/list") as { id: number; name: string; active: boolean }[];
  const active = accounts.find((a) => a.active) || accounts[0];
  if (active) { accountId = active.id; accountName = active.name; }

  log(`Authenticated — ${accountName} (#${accountId}) — DEMO`);
  return accessToken;
}

async function apiFetch(path: string, options?: RequestInit): Promise<unknown> {
  const token = await authenticate();
  const makeRequest = (t: string) => fetch(`${ORDER_API}${path}`, {
    ...options,
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${t}`, ...options?.headers },
    signal: AbortSignal.timeout(15000),
  });

  const res = await makeRequest(token);

  // Rate limit handling — wait and retry
  if (res.status === 429) {
    const retryAfter = parseInt(res.headers.get("Retry-After") || "5", 10);
    log(`[API] Rate limited on ${path} — waiting ${retryAfter}s`);
    await new Promise(r => setTimeout(r, retryAfter * 1000));
    const retry = await makeRequest(token);
    if (!retry.ok) throw new Error(`API ${retry.status} after rate limit wait: ${await retry.text().catch(() => "")}`);
    return retry.json();
  }

  if (res.status === 401) {
    // Token expired — force re-auth and retry once
    accessToken = "";
    tokenExpires = 0;
    const newToken = await authenticate();
    const retry = await makeRequest(newToken);
    if (!retry.ok) throw new Error(`API ${retry.status}: ${await retry.text().catch(() => "")}`);
    return retry.json();
  }
  if (!res.ok) throw new Error(`API ${res.status}: ${await res.text().catch(() => "")}`);
  return res.json();
}

function log(msg: string) {
  const ts = new Date().toISOString().replace("T", " ").slice(0, 19);
  console.log(`[${ts}] ${msg}`);
}

// Cancel all working orders on Tradovate (cleanup orphaned brackets)
async function cancelAllOrders() {
  try {
    const orders = await apiFetch("/order/list") as { id: number; ordStatus: string }[];
    const working = orders.filter(o => o.ordStatus === "Working" || o.ordStatus === "Accepted");
    if (working.length === 0) return;
    log(`[CLEANUP] Cancelling ${working.length} orphaned working orders`);
    for (const order of working) {
      try {
        await apiFetch("/order/cancelorder", { method: "POST", body: JSON.stringify({ orderId: order.id }) });
      } catch {}
    }
    log(`[CLEANUP] Done — all orders cancelled`);
  } catch (err) {
    log(`[CLEANUP] Failed to cancel orders: ${err}`);
  }
}

// Best-effort notification for critical events (trades, closes, errors)
async function notify(msg: string, channel: "futures" | "general" = "futures") {
  try {
    const keys = { futures: "webhook_futures", general: "webhook_general" } as const;
    let config = await prisma.agentConfig.findUnique({ where: { key: keys[channel] } });
    if (!config?.value) {
      config = await prisma.agentConfig.findUnique({ where: { key: "notification_webhook" } });
    }
    if (!config?.value) return;
    await fetch(config.value, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: `[FUTURES] ${msg}` }),
      signal: AbortSignal.timeout(5000),
    });
  } catch {}
}

// ── Startup Validation ──────────────────────────────────

function validateEnvironment() {
  const required = [
    ["TRADOVATE_USERNAME", process.env.TRADOVATE_USERNAME],
    ["TRADOVATE_PASSWORD", process.env.TRADOVATE_PASSWORD],
    ["TRADOVATE_APP_ID", process.env.TRADOVATE_APP_ID],
    ["TRADOVATE_CID", process.env.TRADOVATE_CID],
    ["TRADOVATE_SEC", process.env.TRADOVATE_SEC],
    ["DATABASE_URL", process.env.DATABASE_URL],
  ] as const;

  const missing = required.filter(([, v]) => !v).map(([k]) => k);
  if (missing.length > 0) {
    const msg = `Missing required env vars: ${missing.join(", ")}`;
    log(`[FATAL] ${msg}`);
    throw new Error(msg);
  }

  if (!process.env.ANTHROPIC_API_KEY) {
    log("[WARN] ANTHROPIC_API_KEY not set — AI confirmation disabled, all setups will auto-approve");
  }

  log("[ENV] All required environment variables present");
}

// ── Market Data Circuit Breaker ──────────────────────────

let mdConsecutiveFailures = 0;
let mdCircuitOpen = false;
let mdDebugCount = 0; // Log first 3 MD failures to diagnose
let mdCircuitResetAt = 0;
const MD_MAX_FAILURES = 5;
const MD_CIRCUIT_BASE_MS = 30_000;
// Tradovate MD base URLs (try dedicated MD server, fall back to main API)
const DEMO_MD_URL = "https://md-demo.tradovateapi.com/v1";
const LIVE_MD_URL = "https://md.tradovateapi.com/v1";
function getMdUrl(): string {
  // Default to demo; override when live mode is detected
  return ORDER_API.includes("live") ? LIVE_MD_URL : DEMO_MD_URL;
}

// ── Contract Resolution ─────────────────────────────────

interface ContractInfo { id: number; name: string; tickSize: number; symbol: string; }
const contracts: Map<string, ContractInfo> = new Map();

async function resolveContracts() {
  // Resolve both full-size and micro contracts so we can switch dynamically
  for (const sym of [...FULL_SIZE_SYMBOLS, ...MICRO_SYMBOLS]) {
    try {
      const results = await apiFetch(`/contract/suggest?t=${sym}&l=5`) as { id: number; name: string; tickSize: number; providerTickSize: number }[];
      if (results.length > 0) {
        contracts.set(sym, { id: results[0].id, name: results[0].name, tickSize: results[0].providerTickSize || results[0].tickSize, symbol: sym });
        log(`Resolved ${sym} → ${results[0].name} (ID: ${results[0].id})`);
      }
    } catch (err) { log(`Failed to resolve ${sym}: ${err}`); }
  }
}

// ── Technical Indicators ────────────────────────────────

interface Bar { t: number; o: number; h: number; l: number; c: number; v: number; }

function ema(data: number[], period: number): number[] {
  if (!data.length) return [];
  const k = 2 / (period + 1);
  const r = [data[0]];
  for (let i = 1; i < data.length; i++) r.push(data[i] * k + r[i - 1] * (1 - k));
  return r;
}

function rsi(closes: number[], period = 14): number | null {
  if (closes.length < period + 1) return null;
  const changes: number[] = [];
  for (let i = closes.length - period; i < closes.length; i++) changes.push(closes[i] - closes[i - 1]);
  const avgGain = changes.filter(c => c > 0).reduce((a, b) => a + b, 0) / period;
  const avgLoss = changes.filter(c => c < 0).reduce((a, b) => a + Math.abs(b), 0) / period;
  return avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
}

function atr(bars: Bar[], period = 14): number {
  if (bars.length < period + 1) return 0;
  const trs: number[] = [];
  for (let i = bars.length - period; i < bars.length; i++)
    trs.push(Math.max(bars[i].h - bars[i].l, Math.abs(bars[i].h - bars[i - 1].c), Math.abs(bars[i].l - bars[i - 1].c)));
  return trs.reduce((a, b) => a + b, 0) / trs.length;
}

function calcVwap(bars: Bar[]): { vwap: number; upper: number; lower: number } {
  let cumPV = 0, cumV = 0, cumPV2 = 0;
  for (const b of bars) {
    const tp = (b.h + b.l + b.c) / 3;
    cumPV += tp * b.v; cumPV2 += tp * tp * b.v; cumV += b.v;
  }
  const v = cumV > 0 ? cumPV / cumV : 0;
  const sd = Math.sqrt(Math.max(0, cumV > 0 ? (cumPV2 / cumV) - v * v : 0));
  return { vwap: v, upper: v + sd, lower: v - sd };
}

// ── Bar Building & Price Polling ────────────────────────

const barBuilders: Map<string, {
  currentBar: Bar | null;
  bars5m: Bar[];
  sessionBars: Bar[];
  lastPrice: number;
  lastVolume: number;
  prevDayHigh: number;
  prevDayLow: number;
  prevDayClose: number;
  openingRangeHigh: number;
  openingRangeLow: number;
  barCount: number;
}> = new Map();

function initBarBuilder(sym: string) {
  barBuilders.set(sym, {
    currentBar: null, bars5m: [], sessionBars: [], lastPrice: 0, lastVolume: 0,
    prevDayHigh: 0, prevDayLow: 0, prevDayClose: 0,
    openingRangeHigh: 0, openingRangeLow: 0, barCount: 0,
  });
}

let tickCount = 0;

// Date-based flags to ensure exactly one session reset and one EOD close per day
let lastResetDate = "";
let lastEODDate = "";

function onPrice(sym: string, price: number, volume: number) {
  const b = barBuilders.get(sym);
  if (!b || price <= 0) return;

  tickCount++;
  b.lastPrice = price;
  b.lastVolume = volume;

  const periodStart = Math.floor(Date.now() / BAR_INTERVAL_MS) * (BAR_INTERVAL_MS / 1000);

  if (!b.currentBar || b.currentBar.t !== periodStart) {
    // New bar period
    if (b.currentBar) {
      const completed = { ...b.currentBar };
      b.bars5m.push(completed);
      b.sessionBars.push(completed);
      if (b.bars5m.length > 200) b.bars5m.shift();
      if (b.sessionBars.length > MAX_SESSION_BARS) b.sessionBars.shift();
      b.barCount++;

      if (b.barCount <= 12) {  // Initial Balance is first 60 min (institutional standard)
        b.openingRangeHigh = Math.max(b.openingRangeHigh, completed.h);
        b.openingRangeLow = b.openingRangeLow === 0 ? completed.l : Math.min(b.openingRangeLow, completed.l);
      }

      // ── BAR CLOSE → SETUP DETECTION ──
      onBarClose(sym, completed);
    }
    b.currentBar = { t: periodStart, o: price, h: price, l: price, c: price, v: 0 };
  } else {
    b.currentBar.h = Math.max(b.currentBar.h, price);
    b.currentBar.l = Math.min(b.currentBar.l, price);
    b.currentBar.c = price;
    b.currentBar.v += volume;
  }

  // Tick-by-tick position management
  checkPositions(sym, price);
}

async function fetchTradovateQuote(sym: string): Promise<{ price: number; volume: number } | null> {
  const contract = contracts.get(sym);
  if (!contract) return null;

  const chartDesc = encodeURIComponent(JSON.stringify({
    underlyingType: "MinuteBar", elementSize: 1, elementSizeUnit: "UnderlyingUnits",
  }));
  const timeRange = encodeURIComponent(JSON.stringify({ asMuchAsElements: 1 }));
  const mdUrl = getMdUrl();
  const token = await authenticate();

  // Try dedicated MD server first
  try {
    const res = await fetch(
      `${mdUrl}/md/getChart?contractId=${contract.id}&chartDescription=${chartDesc}&timeRange=${timeRange}`,
      { headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(8000) },
    );
    if (res.ok) {
      const data = await res.json() as { charts?: { bars: { close: number; upVolume: number; downVolume: number }[] }[] };
      const bars = data?.charts?.[0]?.bars;
      if (bars && bars.length > 0) {
        const bar = bars[bars.length - 1];
        return { price: bar.close, volume: (bar.upVolume || 0) + (bar.downVolume || 0) };
      }
    } else if (mdDebugCount < 3) {
      mdDebugCount++;
      log(`[MD-DEBUG] ${sym} MD server ${res.status}: ${await res.text().catch(() => "no body")}`);
    }
  } catch (err) {
    if (mdDebugCount < 3) {
      mdDebugCount++;
      log(`[MD-DEBUG] ${sym} MD server error: ${err instanceof Error ? err.message : err}`);
    }
  }

  // Fallback: main API server
  try {
    const data = await apiFetch(
      `/md/getChart?contractId=${contract.id}&chartDescription=${chartDesc}&timeRange=${timeRange}`
    ) as { charts?: { bars: { close: number; upVolume: number; downVolume: number }[] }[] };
    const bars = data?.charts?.[0]?.bars;
    if (bars && bars.length > 0) {
      const bar = bars[bars.length - 1];
      return { price: bar.close, volume: (bar.upVolume || 0) + (bar.downVolume || 0) };
    }
  } catch { /* fall through */ }

  return null;
}

async function fetchYahooQuotes(): Promise<Map<string, { price: number; volume: number }>> {
  const result = new Map<string, { price: number; volume: number }>();
  try {
    const yahooSymbols = SYMBOLS.map(s => YAHOO_MAP[s]);
    const quotes = await getYfEngine().quote(yahooSymbols);
    const arr = Array.isArray(quotes) ? quotes : [quotes];
    for (const sym of SYMBOLS) {
      const yahooSym = YAHOO_MAP[sym];
      const q = (arr as Record<string, unknown>[]).find(item => item?.symbol === yahooSym);
      if (q?.regularMarketPrice) {
        result.set(sym, { price: q.regularMarketPrice as number, volume: (q.regularMarketVolume || 0) as number });
      }
    }
  } catch (err) {
    log(`[YAHOO-FALLBACK] Failed: ${err instanceof Error ? err.message : err}`);
  }
  return result;
}

async function pollPrices() {
  // Circuit breaker: skip polls while circuit is open
  if (mdCircuitOpen) {
    if (Date.now() < mdCircuitResetAt) return;
    mdCircuitOpen = false;
    log(`[MD] Circuit half-open — attempting recovery poll`);
  }

  try {
    // Primary: Tradovate md/getChart (parallel per symbol)
    const tradovateResults = await Promise.allSettled(
      SYMBOLS.map(async (sym) => {
        const quote = await fetchTradovateQuote(sym);
        return quote ? { sym, ...quote } : null;
      })
    );

    let received = 0;
    const needYahoo: string[] = [];

    for (const r of tradovateResults) {
      if (r.status === "fulfilled" && r.value) {
        onPrice(r.value.sym, r.value.price, r.value.volume);
        received++;
      } else {
        const sym = SYMBOLS[tradovateResults.indexOf(r)];
        needYahoo.push(sym);
      }
    }

    // Fallback: Yahoo for any symbols Tradovate couldn't serve
    if (needYahoo.length > 0) {
      const yahooQuotes = await fetchYahooQuotes();
      for (const sym of needYahoo) {
        const yq = yahooQuotes.get(sym);
        if (yq) {
          onPrice(sym, yq.price, yq.volume);
          received++;
        }
      }
      if (yahooQuotes.size > 0) {
        log(`[MD] Tradovate missed ${needYahoo.join(",")}, Yahoo fallback served ${yahooQuotes.size}`);
      }
    }

    // Track failures
    if (received === 0) {
      mdConsecutiveFailures++;
      log(`[MD] Zero quotes received (${mdConsecutiveFailures}/${MD_MAX_FAILURES})`);
    } else if (mdConsecutiveFailures > 0) {
      log(`[MD] Recovered after ${mdConsecutiveFailures} failures — ${received} quotes received`);
      mdConsecutiveFailures = 0;
    }
  } catch (err) {
    mdConsecutiveFailures++;
    log(`[MD] Poll failed (${mdConsecutiveFailures}/${MD_MAX_FAILURES}): ${err instanceof Error ? err.message : err}`);

    if (mdConsecutiveFailures >= MD_MAX_FAILURES) {
      const backoffMultiplier = Math.min(mdConsecutiveFailures - MD_MAX_FAILURES + 1, 10);
      const cooldownMs = MD_CIRCUIT_BASE_MS * backoffMultiplier;
      mdCircuitOpen = true;
      mdCircuitResetAt = Date.now() + cooldownMs;
      log(`[MD] Circuit OPEN — pausing polls for ${Math.round(cooldownMs / 1000)}s (backoff x${backoffMultiplier})`);
      notify(`Market data down (${mdConsecutiveFailures} failures) — polls paused ${Math.round(cooldownMs / 1000)}s`, "general");
    }
  }
}

// ── Session Management ──────────────────────────────────

function getSessionName(): string {
  // DST-aware session detection via shared helper
  if (isWeekendET() || isHaltET()) return "halt";
  const etH = getETHour();
  if (etH >= 9.5 && etH < 16) {
    const minSinceOpen = (etH - 9.5) * 60;
    if (minSinceOpen < 15) return "open";
    if (etH < 12) return "morning";
    if (etH < 14) return "midday";
    if (etH < 15.75) return "afternoon";
    return "close";
  }
  if (etH >= 16 && etH < 17) return "eth_evening";
  if (etH >= 18 && etH < 22) return "eth_evening";
  if (etH >= 22 || etH < 3) return "eth_asia";
  if (etH >= 3 && etH < 9) return "eth_europe";
  return "pre_market";
}

function getMinutesSinceRTHOpen(): number {
  return Math.max(0, (getETHour() - 9.5) * 60);
}

function getSizeMultiplier(sym?: string): number {
  const s = getSessionName();

  // Demo engine trades 24/7 — live mirroring handled separately by isLiveRTHWindow()
  if (s === "halt") return 0; // market closed (5-6 PM daily break)

  if (sym && METALS.has(sym)) {
    const etH = getETHour();
    if (etH >= 8.33 && etH < 13.5) return 1.0;  // COMEX prime
    return 0.5; // Off-COMEX — still trade, smaller size for learning
  }

  // Equities
  if (s === "morning" || s === "afternoon") return 1.0;  // RTH prime
  if (s === "midday") return 0.5;  // Lunch — test if midday works
  if (s === "open" || s === "close") return 0.5;  // Open/close — learning
  return 0.3; // ETH — minimal size, maximum learning
}

function checkSessionReset() {
  const now = new Date();
  const todayET = getETDateString();
  const etH = getETHour();

  // Session reset at 9:29 AM ET — once per day (DST-aware, date-flag ensures no misses)
  if (lastResetDate !== todayET && etH >= 9.483) { // 9:29 AM ET
    lastResetDate = todayET;
    for (const [sym, b] of barBuilders) {
      if (b.sessionBars.length > 0) {
        b.prevDayHigh = Math.max(...b.sessionBars.map(x => x.h));
        b.prevDayLow = Math.min(...b.sessionBars.map(x => x.l));
        b.prevDayClose = b.sessionBars[b.sessionBars.length - 1].c;
      }
      b.sessionBars = []; b.openingRangeHigh = 0; b.openingRangeLow = 0; b.barCount = 0;
      log(`Session reset ${sym} — PDH:${b.prevDayHigh.toFixed(2)} PDL:${b.prevDayLow.toFixed(2)}`);
    }
    dailyTradeCount = 0; dailyPnl = 0; stoppedSymbols.clear(); consecutiveStops = 0; tiltPauseUntil = 0;
    startOfDayBalance = tradovateEquity; // Capture SOD equity for daily loss limit
    // Save start-of-day balance for calendar-day P&L calculation
    (async () => {
      try {
        const today = now.toISOString().slice(0, 10); // YYYY-MM-DD
        // Save today's start-of-day balance (keyed by date for history)
        await prisma.agentConfig.upsert({
          where: { key: "start_of_day_balance" },
          update: { value: String(tradovateEquity) },
          create: { key: "start_of_day_balance", value: String(tradovateEquity) },
        });
        await prisma.agentConfig.upsert({
          where: { key: `daily_balance_${today}` },
          update: { value: String(tradovateEquity) },
          create: { key: `daily_balance_${today}`, value: String(tradovateEquity) },
        });
        // Also save yesterday's end-of-day balance (session reset = end of previous day)
        const yesterday = new Date(now.getTime() - 86400000).toISOString().slice(0, 10);
        await prisma.agentConfig.upsert({
          where: { key: `eod_balance_${yesterday}` },
          update: { value: String(tradovateEquity) },
          create: { key: `eod_balance_${yesterday}`, value: String(tradovateEquity) },
        });
        log(`[RESET] Saved start-of-day balance: $${tradovateEquity.toFixed(2)} (${today}), EOD yesterday (${yesterday})`);
        // Also save live SOD if live mode is active
        if (isLiveMode) {
          try {
            await authenticateLive();
            await prisma.agentConfig.upsert({
              where: { key: "live_start_of_day_balance" },
              update: { value: String(liveEquity) },
              create: { key: "live_start_of_day_balance", value: String(liveEquity) },
            });
            await prisma.agentConfig.upsert({
              where: { key: `live_daily_balance_${today}` },
              update: { value: String(liveEquity) },
              create: { key: `live_daily_balance_${today}`, value: String(liveEquity) },
            });
            log(`[RESET] Live SOD: $${liveEquity.toFixed(2)}`);
          } catch {}
        }

        // Write to Obsidian vault — persistent brain for agents
        try {
          const balancesDoc = await vaultRead("Performance/daily-balances.md");
          if (balancesDoc) {
            // Update today's SOD and yesterday's EOD in the vault
            const sodEntry = `\n${today}:\n  sod: ${Math.round(tradovateEquity)}\n  eod: null\n  day_pnl: null\n  notes: "Auto-tracked by engine"`;
            // Only append if today isn't already in the doc
            if (!balancesDoc.includes(today + ":")) {
              const updatedDoc = balancesDoc.replace(
                "```\n\n## Cumulative",
                sodEntry + "\n```\n\n## Cumulative"
              );
              if (updatedDoc !== balancesDoc) {
                await vaultWrite("Performance/daily-balances.md", updatedDoc, "futures-realtime");
              }
            }
          }
        } catch { /* vault write optional */ }
      } catch {}
    })();
    // Clean slate: cancel any orphaned orders from yesterday
    cancelAllOrders().catch(err => log(`[RESET] Order cleanup failed: ${err}`));
  }

  // EOD forced close: flatten all positions AND cancel all orders at 3:50 PM ET (DST-aware)
  if (lastEODDate !== todayET && etH >= 15.833) { // 3:50 PM ET
    lastEODDate = todayET;
    if (positions.size > 0) {
      log(`[EOD] 3:50 PM ET — closing all ${positions.size} positions before market close`);
      for (const [sym] of [...positions]) {
        const b = barBuilders.get(sym);
        const price = b?.lastPrice || 0;
        if (price > 0) {
          closePosition(sym, price, "eod_close").catch(err => log(`[EOD] Failed to close ${sym}: ${err}`));
        }
      }
    }
    // Cancel ALL working orders to prevent orphaned fills overnight
    cancelAllOrders().catch(err => log(`[EOD] Failed to cancel orders: ${err}`));
    // Also cancel all live working orders
    if (isLiveMode) {
      (async () => {
        try {
          const orders = await liveApiFetch("/order/list") as { id: number; ordStatus: string }[];
          const working = orders.filter(o => o.ordStatus === "Working" || o.ordStatus === "Accepted");
          for (const o of working) try { await liveApiFetch("/order/cancelorder", { method: "POST", body: JSON.stringify({ orderId: o.id }) }); } catch {}
          if (working.length > 0) log(`[EOD LIVE] Cancelled ${working.length} live orders`);
        } catch (err) { log(`[EOD LIVE] Order cleanup failed: ${err}`); }
      })();
    }
    // Save end-of-day balance snapshot for historical daily P&L
    (async () => {
      try {
        await new Promise(r => setTimeout(r, 3000)); // wait for close fills to settle
        await updateTradovateEquity();
        const today = now.toISOString().slice(0, 10);
        await prisma.agentConfig.upsert({
          where: { key: `eod_balance_${today}` },
          update: { value: String(tradovateEquity) },
          create: { key: `eod_balance_${today}`, value: String(tradovateEquity) },
        });
        log(`[EOD] Saved end-of-day balance: $${tradovateEquity.toFixed(2)} (${today})`);

        // Write EOD to vault + reconciliation check
        try {
          const sodKey = await prisma.agentConfig.findUnique({ where: { key: `daily_balance_${today}` } });
          const sodBalance = sodKey ? parseFloat(sodKey.value) : null;
          const eodBalance = tradovateEquity;
          const balanceDelta = sodBalance != null ? eodBalance - sodBalance : null;

          // Reconciliation: compare engine dailyPnl vs actual balance delta
          if (balanceDelta != null) {
            const discrepancy = Math.abs(dailyPnl - balanceDelta);
            if (discrepancy > 50) {
              log(`[RECONCILE] WARNING: Engine dailyPnl=$${dailyPnl.toFixed(0)} but balance delta=$${balanceDelta.toFixed(0)} (discrepancy: $${discrepancy.toFixed(0)})`);
              notify(`RECONCILE WARNING: Engine tracked $${dailyPnl.toFixed(0)} but Tradovate balance moved $${balanceDelta.toFixed(0)} today. Discrepancy: $${discrepancy.toFixed(0)}`, "general");
            }
          }

          // Update vault daily-balances.md with EOD
          const balancesDoc = await vaultRead("Performance/daily-balances.md");
          if (balancesDoc && sodBalance != null) {
            const dayPnl = Math.round(eodBalance - sodBalance);
            const updatedDoc = balancesDoc
              .replace(new RegExp(`(${today}:[\\s\\S]*?eod:)\\s*null`), `$1 ${Math.round(eodBalance)}`)
              .replace(new RegExp(`(${today}:[\\s\\S]*?day_pnl:)\\s*null`), `$1 ${dayPnl >= 0 ? "+" : ""}${dayPnl}`);
            if (updatedDoc !== balancesDoc) {
              await vaultWrite("Performance/daily-balances.md", updatedDoc, "futures-realtime");
              log(`[EOD] Updated vault: ${today} SOD=$${sodBalance.toFixed(0)} EOD=$${Math.round(eodBalance)} P&L=${dayPnl >= 0 ? "+" : ""}$${dayPnl}`);
            }
          }
        } catch { /* vault/reconciliation optional */ }
      } catch {}
    })();
  }
}

// ── Position Tracking ───────────────────────────────────

interface Position {
  symbol: string; contractId: number; direction: "long" | "short";
  quantity: number; entryPrice: number; stopLoss: number; target: number;
  trailStop: number | null; reachedBreakeven: boolean;
  stopOrderId: number | null; targetOrderId: number | null;
  entryTime: number;
  scaledOut: boolean;
  originalQty: number;
  consecutiveStops: number;
  pyramided: boolean;
}

const positions: Map<string, Position> = new Map();
// Per-symbol lock to prevent concurrent async stop modifications
const stopMoveLocks = new Map<string, boolean>();

// ── Live Position Tracking (mirrors demo management to live account) ──
interface LivePosition {
  symbol: string; contractId: number; direction: "long" | "short";
  quantity: number; entryPrice: number; stopLoss: number; target: number;
  trailStop: number | null; reachedBreakeven: boolean;
  stopOrderId: number | null; targetOrderId: number | null;
  entryTime: number; scaledOut: boolean; originalQty: number; pyramided: boolean;
}
const livePositions: Map<string, LivePosition> = new Map();
const liveStopMoveLocks = new Map<string, boolean>();
let dailyTradeCount = 0;
let dailyPnl = 0;
const stoppedSymbols: Set<string> = new Set(); // symbols stopped out today — no re-entry
let consecutiveStops = 0; // tilt protection counter
let tiltPauseUntil = 0; // timestamp when tilt pause ends

// Vault lessons cache — refreshed hourly, read before each trade
let vaultLessonsCache: { lessons: string | null; antiPatterns: string | null } | null = null;
let vaultLessonsCacheTime = 0;

// ── Runtime Risk Config (loaded from DB — Agent Hub is the UI) ──────────
// These are the LIVE values from AgentConfig table. Engine uses them at runtime.
// Agent Hub page writes to these keys. Vault risk-management.md is documentation only.
interface RiskConfig {
  maxContractsPerTrade: number;
  maxTotalContracts: number;
  maxTradesPerDay: number;
  riskPerTradePct: number;
  dailyLossLimitPct: number;
  maxDrawdownPct: number;
  maxConcurrentPositions: number;
  atrStopMultiplier: number;
  atrTargetMultiplier: number;
  simulatedEquity: number;       // Size trades as if this is account equity (0 = use actual)
}

// Demo defaults — simulate $1K sizing so learning matches live conditions
const DEMO_DEFAULTS: RiskConfig = {
  maxContractsPerTrade: 3,       // Match live — learn with same sizing
  maxTotalContracts: 4,          // Match live
  maxTradesPerDay: 10,           // More than live — gather learning data faster
  riskPerTradePct: 8,            // Match live — 8% of simulated $1K = $80
  dailyLossLimitPct: 25,         // Looser than live — don't stop learning early
  maxDrawdownPct: 25,
  maxConcurrentPositions: 4,     // Match live
  atrStopMultiplier: 1.5,
  atrTargetMultiplier: 4.0,
  simulatedEquity: 1_000,        // Size as $1K even though demo account has $50K
};

// Live defaults from Rules/risk-management.md ($1K account)
const LIVE_DEFAULTS: RiskConfig = {
  maxContractsPerTrade: 3,
  maxTotalContracts: 4,
  maxTradesPerDay: 6,
  riskPerTradePct: 8,            // 8% of account per trade ($80 on $1K)
  dailyLossLimitPct: 15,         // 15% daily loss → full stop ($150 on $1K)
  maxDrawdownPct: 25,            // 25% drawdown → kill switch
  maxConcurrentPositions: 4,
  atrStopMultiplier: 1.5,
  atrTargetMultiplier: 4.0,
  simulatedEquity: 0,            // Use actual live equity
};

let riskConfig: RiskConfig = DEMO_DEFAULTS;

async function loadRiskConfig() {
  const defaults = isLiveMode ? LIVE_DEFAULTS : DEMO_DEFAULTS;
  try {
    const keys = [
      "futures_max_contracts", "futures_max_total_contracts", "futures_max_trades_per_day",
      "futures_risk_per_trade_pct", "futures_daily_loss_limit_pct", "futures_max_drawdown_pct",
      "futures_atr_stop_multiplier", "futures_atr_target_multiplier", "max_positions",
      "futures_simulated_equity",
    ];
    const configs = await prisma.agentConfig.findMany({ where: { key: { in: keys } } });
    const cfg: Record<string, string> = {};
    for (const c of configs) cfg[c.key] = c.value;

    riskConfig = {
      maxContractsPerTrade: parseInt(cfg.futures_max_contracts) || defaults.maxContractsPerTrade,
      maxTotalContracts: parseInt(cfg.futures_max_total_contracts) || defaults.maxTotalContracts,
      maxTradesPerDay: parseInt(cfg.futures_max_trades_per_day) || defaults.maxTradesPerDay,
      riskPerTradePct: parseFloat(cfg.futures_risk_per_trade_pct) || defaults.riskPerTradePct,
      dailyLossLimitPct: parseFloat(cfg.futures_daily_loss_limit_pct) || defaults.dailyLossLimitPct,
      maxDrawdownPct: parseFloat(cfg.futures_max_drawdown_pct) || defaults.maxDrawdownPct,
      maxConcurrentPositions: parseInt(cfg.max_positions) || defaults.maxConcurrentPositions,
      atrStopMultiplier: parseFloat(cfg.futures_atr_stop_multiplier) || defaults.atrStopMultiplier,
      atrTargetMultiplier: parseFloat(cfg.futures_atr_target_multiplier) || defaults.atrTargetMultiplier,
      simulatedEquity: parseFloat(cfg.futures_simulated_equity) || defaults.simulatedEquity,
    };
    log(`[CONFIG] Loaded risk config from DB: ${JSON.stringify(riskConfig)}`);
  } catch (err) {
    riskConfig = defaults;
    log(`[CONFIG] Failed to load from DB, using defaults: ${err}`);
  }
}

// ── Position Persistence (survive restarts) ──────────────

async function savePositions() {
  try {
    const data = Object.fromEntries(
      [...positions].map(([k, v]) => [k, { ...v }])
    );
    await prisma.agentConfig.upsert({
      where: { key: "futures_positions" },
      update: { value: JSON.stringify(data) },
      create: { key: "futures_positions", value: JSON.stringify(data) },
    });
  } catch (err) { log(`[PERSIST] Failed to save positions: ${err}`); }
}

async function saveLivePositions() {
  if (livePositions.size === 0) return;
  try {
    const data = Object.fromEntries([...livePositions].map(([k, v]) => [k, { ...v }]));
    await prisma.agentConfig.upsert({
      where: { key: "live_futures_positions" },
      update: { value: JSON.stringify(data) },
      create: { key: "live_futures_positions", value: JSON.stringify(data) },
    });
  } catch (err) { log(`[LIVE PERSIST] Failed to save: ${err}`); }
}

async function loadLivePositions() {
  if (!isLiveMode) return;
  try {
    const saved = await prisma.agentConfig.findUnique({ where: { key: "live_futures_positions" } });
    if (saved?.value) {
      const data = JSON.parse(saved.value) as Record<string, LivePosition>;
      for (const [sym, pos] of Object.entries(data)) livePositions.set(sym, pos);
      if (livePositions.size > 0) {
        log(`[LIVE PERSIST] Restored ${livePositions.size} live positions`);
        await syncLivePositions();
      }
    }
  } catch (err) { log(`[LIVE PERSIST] Failed to load: ${err}`); }
}

async function syncLivePositions() {
  if (!isLiveMode) return;
  try {
    const tvPos = await liveApiFetch("/position/list") as { contractId: number; netPos: number; netPrice: number }[];

    // Remove closed live positions
    for (const [sym, pos] of [...livePositions]) {
      if (!tvPos.find(p => p.contractId === pos.contractId && p.netPos !== 0)) {
        log(`[LIVE SYNC] ${sym} closed on live broker — removing`);
        livePositions.delete(sym);
      }
    }

    // Adopt untracked live positions (copy flags from demo if available)
    for (const tp of tvPos) {
      if (tp.netPos === 0) continue;
      let sym: string | null = null;
      for (const [s, c] of contracts) { if (c.id === tp.contractId) { sym = s; break; } }
      if (!sym || livePositions.has(sym)) continue;

      const demoPos = positions.get(sym);
      if (demoPos) {
        livePositions.set(sym, {
          symbol: sym, contractId: tp.contractId,
          direction: tp.netPos > 0 ? "long" : "short",
          quantity: Math.abs(tp.netPos), entryPrice: demoPos.entryPrice,
          stopLoss: demoPos.stopLoss, target: demoPos.target,
          trailStop: demoPos.trailStop, reachedBreakeven: demoPos.reachedBreakeven,
          stopOrderId: null, targetOrderId: null, entryTime: Date.now(),
          scaledOut: demoPos.scaledOut, originalQty: Math.abs(tp.netPos), pyramided: demoPos.pyramided,
        });
        log(`[LIVE SYNC] Adopted ${sym} from live broker, synced from demo`);
      }
    }

    // Correct qty/direction drift
    for (const [sym, pos] of livePositions) {
      const tv = tvPos.find(p => p.contractId === pos.contractId && p.netPos !== 0);
      if (!tv) continue;
      const tvQty = Math.abs(tv.netPos);
      const tvDir: "long" | "short" = tv.netPos > 0 ? "long" : "short";
      if (tvDir !== pos.direction || tvQty !== pos.quantity) {
        log(`[LIVE SYNC] ${sym} drift: engine=${pos.direction} ${pos.quantity}x, live=${tvDir} ${tvQty}x — correcting`);
        pos.direction = tvDir;
        pos.quantity = tvQty;
      }
    }

    await saveLivePositions();
  } catch (err) { log(`[LIVE SYNC] Failed: ${err}`); }
}

async function loadPositions() {
  try {
    // Try loading from database first
    const saved = await prisma.agentConfig.findUnique({
      where: { key: "futures_positions" },
    });

    if (saved?.value) {
      const data = JSON.parse(saved.value) as Record<string, Position>;
      let restored = 0;
      for (const [sym, pos] of Object.entries(data)) {
        positions.set(sym, pos);
        restored++;
      }
      if (restored > 0) {
        log(`[PERSIST] Restored ${restored} positions from database`);
        await syncPositions();
        log(`[PERSIST] After sync: ${positions.size} positions confirmed`);
      }
    }

    // Always check Tradovate for positions we don't have tracked
    log(`[PERSIST] Scanning Tradovate for untracked positions...`);
    const tvPos = await apiFetch("/position/list") as { contractId: number; netPos: number; netPrice: number; timestamp: string }[];
    const openPos = tvPos.filter(p => p.netPos !== 0);

    for (const tp of openPos) {
      // Find which symbol this contractId belongs to
      let sym: string | null = null;
      for (const [s, contract] of contracts) {
        if (contract.id === tp.contractId) { sym = s; break; }
      }
      if (!sym) continue;
      if (positions.has(sym)) continue; // Already tracked

      const direction: "long" | "short" = tp.netPos > 0 ? "long" : "short";
      const qty = Math.abs(tp.netPos);

      // Try to find entry details from our trade log
      const entryLog = await prisma.autoTradeLog.findFirst({
        where: {
          symbol: `FUT:${sym}`,
          action: direction === "long" ? "futures_long" : "futures_short",
        },
        orderBy: { createdAt: "desc" },
      });

      // Parse stop/target from entry log reason
      let stopLoss = 0;
      let target = 0;
      if (entryLog?.reason) {
        const stopMatch = entryLog.reason.match(/Stop:\s*\$?([\d,.]+)/);
        const targetMatch = entryLog.reason.match(/Target:\s*\$?([\d,.]+)/);
        if (stopMatch) stopLoss = parseFloat(stopMatch[1].replace(",", ""));
        if (targetMatch) target = parseFloat(targetMatch[1].replace(",", ""));
      }

      // If no stop/target from logs, estimate from ATR
      if (!stopLoss || !target) {
        const b = barBuilders.get(sym);
        const currentATR = b ? atr(b.bars5m) : 5;
        stopLoss = direction === "long" ? tp.netPrice - currentATR * 1.5 : tp.netPrice + currentATR * 1.5;
        target = direction === "long" ? tp.netPrice + currentATR * 4 : tp.netPrice - currentATR * 4;
      }

      // SANITY: Stop must be on correct side of entry (slippage can push fill past calculated stop)
      const actualEntry = entryLog?.price || tp.netPrice;
      if (direction === "long" && stopLoss >= actualEntry) {
        const b = barBuilders.get(sym);
        const currentATR = b ? atr(b.bars5m) : 5;
        const corrected = actualEntry - currentATR * 1.5;
        log(`[PERSIST] WARNING: Stop $${stopLoss.toFixed(2)} was ABOVE entry $${actualEntry.toFixed(2)} for LONG — corrected to $${corrected.toFixed(2)}`);
        stopLoss = corrected;
      }
      if (direction === "short" && stopLoss <= actualEntry) {
        const b = barBuilders.get(sym);
        const currentATR = b ? atr(b.bars5m) : 5;
        const corrected = actualEntry + currentATR * 1.5;
        log(`[PERSIST] WARNING: Stop $${stopLoss.toFixed(2)} was BELOW entry $${actualEntry.toFixed(2)} for SHORT — corrected to $${corrected.toFixed(2)}`);
        stopLoss = corrected;
      }

      // Use entry log price instead of Tradovate netPrice (which is averaged and can be wrong after partial fills)
      const entryPrice = entryLog?.price || tp.netPrice;
      if (entryLog?.price && Math.abs(entryLog.price - tp.netPrice) > 0.5) {
        log(`[PERSIST] Entry price: using DB log $${entryLog.price.toFixed(2)} (Tradovate netPrice $${tp.netPrice.toFixed(2)} differs — likely averaged)`);
      }

      positions.set(sym, {
        symbol: sym,
        contractId: tp.contractId,
        direction,
        quantity: qty,
        entryPrice,
        stopLoss,
        target,
        trailStop: null,
        reachedBreakeven: false,
        stopOrderId: null,
        targetOrderId: null,
        entryTime: new Date(tp.timestamp).getTime(),
        scaledOut: false, originalQty: qty, consecutiveStops: 0,
        pyramided: false,
      });

      log(`[PERSIST] Bootstrapped ${sym}: ${direction} ${qty}x @ $${entryPrice.toFixed(2)} | Stop: $${stopLoss.toFixed(2)} | Target: $${target.toFixed(2)}`);
    }

    if (positions.size > 0) {
      await savePositions();
      log(`[PERSIST] Bootstrapped ${positions.size} positions from Tradovate`);
    }
  } catch (err) {
    log(`[PERSIST] Failed to load positions: ${err}`);
  }
}

// ── Live Mirror: route management actions to live account ──
type LiveAction = "breakeven" | "trail" | "pyramid" | "scale_out" | "close";

async function mirrorToLive(action: LiveAction, sym: string, params: {
  stopPrice?: number; qty?: number; addQty?: number; reason?: string;
}) {
  if (!isLiveMode) return;
  const livePos = livePositions.get(sym);
  if (!livePos) return;

  try {
    const liveAccounts = await liveApiFetch("/account/list") as { id: number; name: string }[];
    const liveAcct = liveAccounts.find(a => a.id === liveAccountId) || liveAccounts[0];
    const closeSide = livePos.direction === "long" ? "Sell" : "Buy";

    switch (action) {
      case "breakeven": {
        if (livePos.stopOrderId) try { await liveApiFetch("/order/cancelorder", { method: "POST", body: JSON.stringify({ orderId: livePos.stopOrderId }) }); } catch {}
        const s = await liveApiFetch("/order/placeorder", { method: "POST", body: JSON.stringify({
          accountSpec: liveAcct.name, accountId: liveAccountId, action: closeSide, symbol: livePos.contractId,
          orderQty: livePos.quantity, orderType: "Stop", stopPrice: livePos.entryPrice, timeInForce: "GTC", isAutomated: true,
        })}) as { orderId: number };
        livePos.stopOrderId = s.orderId;
        livePos.stopLoss = livePos.entryPrice;
        livePos.reachedBreakeven = true;
        log(`[LIVE MIRROR] ${sym}: Breakeven stop at $${livePos.entryPrice.toFixed(2)}`);
        break;
      }
      case "trail": {
        if (!params.stopPrice || liveStopMoveLocks.get(sym)) break;
        liveStopMoveLocks.set(sym, true);
        try {
          if (livePos.stopOrderId) try { await liveApiFetch("/order/cancelorder", { method: "POST", body: JSON.stringify({ orderId: livePos.stopOrderId }) }); } catch {}
          const s = await liveApiFetch("/order/placeorder", { method: "POST", body: JSON.stringify({
            accountSpec: liveAcct.name, accountId: liveAccountId, action: closeSide, symbol: livePos.contractId,
            orderQty: livePos.quantity, orderType: "Stop", stopPrice: params.stopPrice, timeInForce: "GTC", isAutomated: true,
          })}) as { orderId: number };
          livePos.stopOrderId = s.orderId;
          livePos.trailStop = params.stopPrice;
          log(`[LIVE MIRROR] ${sym}: Trail stop at $${params.stopPrice.toFixed(2)}`);
        } finally { liveStopMoveLocks.set(sym, false); }
        break;
      }
      case "pyramid": {
        if (!params.addQty) break;
        const side = livePos.direction === "long" ? "Buy" : "Sell";
        await liveApiFetch("/order/placeorder", { method: "POST", body: JSON.stringify({
          accountSpec: liveAcct.name, accountId: liveAccountId, action: side, symbol: livePos.contractId,
          orderQty: params.addQty, orderType: "Market", timeInForce: "Day", isAutomated: true,
        })});
        livePos.quantity += params.addQty;
        livePos.pyramided = true;
        if (livePos.stopOrderId) try { await liveApiFetch("/order/cancelorder", { method: "POST", body: JSON.stringify({ orderId: livePos.stopOrderId }) }); } catch {}
        const s = await liveApiFetch("/order/placeorder", { method: "POST", body: JSON.stringify({
          accountSpec: liveAcct.name, accountId: liveAccountId, action: closeSide, symbol: livePos.contractId,
          orderQty: livePos.quantity, orderType: "Stop", stopPrice: livePos.entryPrice, timeInForce: "GTC", isAutomated: true,
        })}) as { orderId: number };
        livePos.stopOrderId = s.orderId;
        log(`[LIVE MIRROR] ${sym}: Pyramid +${params.addQty}x, now ${livePos.quantity}x`);
        notify(`LIVE PYRAMID ${sym}: +${params.addQty}x, now ${livePos.quantity}x`, "general");
        break;
      }
      case "scale_out": {
        if (!params.qty) break;
        if (livePos.targetOrderId) try { await liveApiFetch("/order/cancelorder", { method: "POST", body: JSON.stringify({ orderId: livePos.targetOrderId }) }); } catch {}
        await liveApiFetch("/order/placeorder", { method: "POST", body: JSON.stringify({
          accountSpec: liveAcct.name, accountId: liveAccountId, action: closeSide, symbol: livePos.contractId,
          orderQty: params.qty, orderType: "Market", timeInForce: "Day", isAutomated: true,
        })});
        livePos.quantity -= params.qty;
        livePos.scaledOut = true;
        livePos.targetOrderId = null;
        if (livePos.stopOrderId) try { await liveApiFetch("/order/cancelorder", { method: "POST", body: JSON.stringify({ orderId: livePos.stopOrderId }) }); } catch {}
        const so = await liveApiFetch("/order/placeorder", { method: "POST", body: JSON.stringify({
          accountSpec: liveAcct.name, accountId: liveAccountId, action: closeSide, symbol: livePos.contractId,
          orderQty: livePos.quantity, orderType: "Stop", stopPrice: livePos.stopLoss, timeInForce: "GTC", isAutomated: true,
        })}) as { orderId: number };
        livePos.stopOrderId = so.orderId;
        log(`[LIVE MIRROR] ${sym}: Scaled out ${params.qty}x, ${livePos.quantity}x remaining`);
        notify(`LIVE SCALE ${sym}: ${params.qty}x closed, ${livePos.quantity}x left`, "general");
        break;
      }
      case "close": {
        if (livePos.stopOrderId) try { await liveApiFetch("/order/cancelorder", { method: "POST", body: JSON.stringify({ orderId: livePos.stopOrderId }) }); } catch {}
        if (livePos.targetOrderId) try { await liveApiFetch("/order/cancelorder", { method: "POST", body: JSON.stringify({ orderId: livePos.targetOrderId }) }); } catch {}
        // Check if still open before placing close order
        try {
          const tvPos = await liveApiFetch("/position/list") as { contractId: number; netPos: number }[];
          if (!tvPos.find(p => p.contractId === livePos.contractId && p.netPos !== 0)) {
            log(`[LIVE MIRROR] ${sym}: Already closed on broker`);
            livePositions.delete(sym);
            await saveLivePositions();
            break;
          }
        } catch {}
        await liveApiFetch("/order/placeorder", { method: "POST", body: JSON.stringify({
          accountSpec: liveAcct.name, accountId: liveAccountId, action: closeSide, symbol: livePos.contractId,
          orderQty: livePos.quantity, orderType: "Market", timeInForce: "Day", isAutomated: true,
        })});
        log(`[LIVE MIRROR] ${sym}: CLOSED — ${params.reason}`);
        notify(`LIVE CLOSED ${sym}: ${params.reason}`, "general");
        try {
          await prisma.autoTradeLog.create({ data: {
            symbol: `FUT:${sym}`, action: `live_${params.reason || "close"}`,
            qty: livePos.quantity, price: 0, pnl: 0,
            reason: `[LIVE ${sym}] ${params.reason}: Closed ${livePos.quantity}x. Entry: $${livePos.entryPrice.toFixed(2)}`,
            orderId: null,
          }});
        } catch {}
        livePositions.delete(sym);
        break;
      }
    }
    await saveLivePositions();
  } catch (err) {
    log(`[LIVE MIRROR] ${action} FAILED for ${sym}: ${err}`);
    notify(`LIVE MIRROR ${action} FAILED ${sym}: ${err}`, "general");
  }
}

function checkPositions(sym: string, price: number) {
  const pos = positions.get(sym);
  if (!pos) return;

  // AGGREGATE DRAWDOWN CHECK: close ALL positions if total drawdown exceeds 15% of equity
  const MAX_DRAWDOWN_PCT = 0.15;
  const aggregateUnrealized = [...positions.entries()].reduce((sum, [s, p]) => {
    const m = CONTRACT_MULTIPLIERS[s] || 5;
    const lastPrice = s === sym ? price : (barBuilders.get(s)?.currentBar?.c || p.entryPrice);
    const d = p.direction === "long" ? lastPrice - p.entryPrice : p.entryPrice - lastPrice;
    return sum + d * m * p.quantity;
  }, 0);
  const totalDrawdown = aggregateUnrealized + dailyPnl;
  if (tradovateEquity > 0 && totalDrawdown < -(tradovateEquity * MAX_DRAWDOWN_PCT)) {
    log(`🚨 AGGREGATE DRAWDOWN KILL: Combined P&L $${totalDrawdown.toFixed(0)} exceeds ${(MAX_DRAWDOWN_PCT * 100)}% of equity $${tradovateEquity.toFixed(0)} — CLOSING ALL`);
    notify(`🚨 AGGREGATE DRAWDOWN KILL: $${totalDrawdown.toFixed(0)} loss. Closing all positions.`, "general");
    for (const [s, p] of positions) {
      closePosition(s, barBuilders.get(s)?.currentBar?.c || p.entryPrice, "emergency");
    }
    return;
  }

  const mult = CONTRACT_MULTIPLIERS[sym] || 5;
  const diff = pos.direction === "long" ? price - pos.entryPrice : pos.entryPrice - price;
  const stopDist = Math.abs(pos.entryPrice - pos.stopLoss);
  const pnlDollars = diff * mult * pos.quantity;

  // 1R: Move stop to breakeven ON THE BROKER — protect capital, NO scale out yet
  if (diff >= stopDist && !pos.reachedBreakeven) {
    pos.reachedBreakeven = true;
    const breakevenPrice = pos.entryPrice;
    log(`${sym}: Reached 1R ($${pnlDollars.toFixed(0)}) — moving broker stop to breakeven $${breakevenPrice.toFixed(2)}`);

    // CRITICAL: Cancel old stop and place new one at breakeven on the broker
    // This protects against fast moves between bar closes
    if (!stopMoveLocks.get(sym)) {
      stopMoveLocks.set(sym, true);
      (async () => {
        try {
          // Cancel existing broker stop
          if (pos.stopOrderId) {
            await apiFetch("/order/cancelorder", { method: "POST", body: JSON.stringify({ orderId: pos.stopOrderId }) });
          }
          // Place new stop at breakeven
          const accounts = await apiFetch("/account/list") as { id: number; name: string }[];
          const acct = accounts.find(a => a.id === accountId) || accounts[0];
          const closeSide = pos.direction === "long" ? "Sell" : "Buy";
          const s = await apiFetch("/order/placeorder", { method: "POST", body: JSON.stringify({
            accountSpec: acct.name, accountId, action: closeSide, symbol: pos.contractId,
            orderQty: pos.quantity, orderType: "Stop", stopPrice: breakevenPrice, timeInForce: "GTC", isAutomated: true,
          })}) as { orderId: number };
          pos.stopOrderId = s.orderId;
          pos.stopLoss = breakevenPrice;
          log(`${sym}: Broker stop moved to breakeven $${breakevenPrice.toFixed(2)} (order #${s.orderId})`);
          mirrorToLive("breakeven", sym, {}).catch(() => {});
        } catch (err) {
          log(`${sym}: WARNING — failed to move broker stop to breakeven: ${err}`);
        } finally {
          stopMoveLocks.set(sym, false);
        }
      })();
    }
  }

  // 1R+: PYRAMID — add to winners (original position now risk-free at breakeven)
  // Only pyramid if: breakeven reached, haven't already pyramided, equity allows it
  if (pos.reachedBreakeven && diff >= stopDist * 1.2 && diff < stopDist * 2 && !pos.pyramided) {
    const addQty = Math.max(1, Math.floor(pos.quantity * 0.5)); // Add 50% of original size
    const maxTotalContracts = Math.max(2, Math.floor(tradovateEquity / 500)); // Scale with account
    if (pos.quantity + addQty <= maxTotalContracts) {
      log(`${sym}: PYRAMID +${addQty}x @ $${price.toFixed(2)} (1.2R, original at breakeven). Total: ${pos.quantity + addQty}x`);
      // Place add order — stop for NEW contracts at breakeven (same as original)
      (async () => {
        try {
          const accounts = await apiFetch("/account/list") as { id: number; name: string }[];
          const acct = accounts.find(a => a.id === accountId) || accounts[0];
          const side = pos.direction === "long" ? "Buy" : "Sell";
          await apiFetch("/order/placeorder", { method: "POST", body: JSON.stringify({
            accountSpec: acct.name, accountId, action: side, symbol: pos.contractId,
            orderQty: addQty, orderType: "Market", timeInForce: "Day", isAutomated: true,
          })});
          pos.quantity += addQty;
          pos.pyramided = true;
          // Update broker stop to cover full new quantity at breakeven
          if (pos.stopOrderId) try { await apiFetch("/order/cancelorder", { method: "POST", body: JSON.stringify({ orderId: pos.stopOrderId }) }); } catch {}
          const closeSide = pos.direction === "long" ? "Sell" : "Buy";
          const s = await apiFetch("/order/placeorder", { method: "POST", body: JSON.stringify({
            accountSpec: acct.name, accountId, action: closeSide, symbol: pos.contractId,
            orderQty: pos.quantity, orderType: "Stop", stopPrice: pos.entryPrice, timeInForce: "GTC", isAutomated: true,
          })}) as { orderId: number };
          pos.stopOrderId = s.orderId;
          log(`${sym}: Pyramid filled — now ${pos.quantity}x. Stop updated for full qty at breakeven $${pos.entryPrice.toFixed(2)}`);
          notify(`PYRAMID ${sym}: +${addQty}x added at $${price.toFixed(2)}. Now ${pos.quantity}x total, stop at breakeven.`);
          mirrorToLive("pyramid", sym, { addQty }).catch(() => {});
          await savePositions();
        } catch (err) { log(`${sym}: Pyramid order failed: ${err}`); }
      })();
    }
  }

  // 2R+: Scale out 50% of full (pyramided) position — lock profit
  if (diff >= stopDist * 2 && !pos.scaledOut && pos.quantity >= 2) {
    const scaleQty = Math.max(1, Math.floor(pos.quantity / 2));
    log(`${sym}: Reached 2R ($${pnlDollars.toFixed(0)}) — scaling out ${scaleQty} of ${pos.quantity} contracts`);
    scaleOutPosition(sym, price, scaleQty);
  }

  // 1.5R+: Activate trailing stop with 1.5x ATR trail — capture profit tighter
  if (diff >= stopDist * 1.5) {
    const currentATRVal = atr(barBuilders.get(sym)?.bars5m || []);
    if (currentATRVal > 0) {
      const atrMult = METALS.has(sym) ? 1.5 : 1.0;
      const trail = pos.direction === "long" ? price - currentATRVal * atrMult * 1.5 : price + currentATRVal * atrMult * 1.5;
      if (!pos.trailStop || (pos.direction === "long" ? trail > pos.trailStop : trail < pos.trailStop)) {
        const isNew = !pos.trailStop;
        if (isNew) log(`${sym}: 1.5R+ ($${pnlDollars.toFixed(0)}) — trailing stop at $${trail.toFixed(2)} (1.5x ATR)`);
        pos.trailStop = trail;

        // Move broker stop to trail level (locked to prevent concurrent modifications)
        if (!stopMoveLocks.get(sym)) {
          stopMoveLocks.set(sym, true);
          (async () => {
            try {
              if (pos.stopOrderId) {
                await apiFetch("/order/cancelorder", { method: "POST", body: JSON.stringify({ orderId: pos.stopOrderId }) });
              }
              const accounts = await apiFetch("/account/list") as { id: number; name: string }[];
              const acct = accounts.find(a => a.id === accountId) || accounts[0];
              const closeSide = pos.direction === "long" ? "Sell" : "Buy";
              const s = await apiFetch("/order/placeorder", { method: "POST", body: JSON.stringify({
                accountSpec: acct.name, accountId, action: closeSide, symbol: pos.contractId,
                orderQty: pos.quantity, orderType: "Stop", stopPrice: trail, timeInForce: "GTC", isAutomated: true,
              })}) as { orderId: number };
              pos.stopOrderId = s.orderId;
              if (isNew) log(`${sym}: Broker trail stop at $${trail.toFixed(2)} (1.5x ATR, order #${s.orderId})`);
              mirrorToLive("trail", sym, { stopPrice: trail }).catch(() => {});
            } catch (err) {
              log(`${sym}: WARNING — failed to place broker trail stop: ${err}`);
            } finally {
              stopMoveLocks.set(sym, false);
            }
          })();
        }
      }
    }
  }

  // Trail hit
  if (pos.trailStop) {
    if ((pos.direction === "long" && price <= pos.trailStop) || (pos.direction === "short" && price >= pos.trailStop)) {
      log(`${sym}: TRAIL STOP at $${price.toFixed(2)} (trail:$${pos.trailStop.toFixed(2)}). P&L: $${(diff * mult * pos.quantity).toFixed(0)}`);
      closePosition(sym, price, "trail_stop"); return;
    }
  }

  // Breakeven stop — if we hit 1R and then price comes back to entry
  if (pos.reachedBreakeven && diff <= 0) {
    log(`${sym}: BREAKEVEN STOP. P&L: $${(diff * mult * pos.quantity).toFixed(0)}`);
    closePosition(sym, price, "breakeven"); return;
  }

  // HARD STOP: Fallback when broker stop order fails or was never placed
  // Only fires if we haven't already moved to trail/breakeven (those manage their own exits)
  if (!pos.trailStop && !pos.reachedBreakeven && pos.stopLoss > 0) {
    const pastStop = pos.direction === "long" ? price <= pos.stopLoss : price >= pos.stopLoss;
    if (pastStop) {
      log(`${sym}: HARD STOP — price $${price.toFixed(2)} past stop $${pos.stopLoss.toFixed(2)}. Broker stop may have failed. P&L: $${pnlDollars.toFixed(0)}`);
      closePosition(sym, price, "stop_loss"); return;
    }
  }

  // Per-position emergency: cap single-position loss at 10% of equity or $750, whichever is lower
  const perPositionLimit = Math.min(750, tradovateEquity * 0.10);
  if (pnlDollars < -perPositionLimit) {
    log(`${sym}: EMERGENCY CLOSE $${pnlDollars.toFixed(0)} exceeds per-position limit $${perPositionLimit.toFixed(0)}`);
    closePosition(sym, price, "emergency"); return;
  }
}

async function scaleOutPosition(sym: string, price: number, scaleQty: number) {
  const pos = positions.get(sym);
  if (!pos || pos.scaledOut) return;

  const mult = CONTRACT_MULTIPLIERS[sym] || 5;
  const diff = pos.direction === "long" ? price - pos.entryPrice : pos.entryPrice - price;
  const pnl = diff * mult * scaleQty;

  try {
    const accounts = await apiFetch("/account/list") as { id: number; name: string }[];
    const acct = accounts.find(a => a.id === accountId) || accounts[0];

    // Cancel the old target bracket (it's for full qty)
    if (pos.targetOrderId) try { await apiFetch("/order/cancelorder", { method: "POST", body: JSON.stringify({ orderId: pos.targetOrderId }) }); } catch {}

    // Market close half
    const scaleOrder = await apiFetch("/order/placeorder", {
      method: "POST",
      body: JSON.stringify({
        accountSpec: acct.name, accountId, action: pos.direction === "long" ? "Sell" : "Buy",
        symbol: pos.contractId, orderQty: scaleQty, orderType: "Market", timeInForce: "Day", isAutomated: true,
      }),
    }) as { orderId: number };

    // Get actual fill price from Tradovate
    try {
      await new Promise(r => setTimeout(r, 1500));
      const fills = await apiFetch("/fill/list") as { orderId: number; price: number; qty: number }[];
      const myFills = fills.filter(f => f.orderId === scaleOrder.orderId);
      if (myFills.length > 0) {
        const totalQty = myFills.reduce((s, f) => s + f.qty, 0);
        const actualPrice = myFills.reduce((s, f) => s + f.price * f.qty, 0) / totalQty;
        if (Math.abs(actualPrice - price) > 0.01) {
          log(`${sym}: Scale-out actual fill $${actualPrice.toFixed(2)} (bar was $${price.toFixed(2)})`);
          price = actualPrice;
        }
      }
    } catch { /* use bar price */ }

    // Recalculate P&L with actual fill price
    const actualDiff = pos.direction === "long" ? price - pos.entryPrice : pos.entryPrice - price;
    const actualPnl = actualDiff * mult * scaleQty;

    pos.quantity -= scaleQty;
    pos.scaledOut = true;
    dailyPnl += actualPnl;
    log(`${sym}: SCALE OUT ${scaleQty}x @ $${price.toFixed(2)} — locked in $${actualPnl.toFixed(0)}. ${pos.quantity}x remaining.`);
    notify(`SCALE OUT ${sym}: +$${actualPnl.toFixed(0)} locked (${scaleQty}x @ $${price.toFixed(2)}). ${pos.quantity}x trailing.`);
    mirrorToLive("scale_out", sym, { qty: scaleQty }).catch(() => {});

    // Log to database
    try {
      await prisma.autoTradeLog.create({ data: {
        symbol: `FUT:${sym}`,
        action: "futures_scale_out",
        qty: scaleQty,
        price,
        pnl: actualPnl,
        reason: `[FUTURES ${sym}] Scale out 50% at 1R: ${scaleQty}x @ $${price.toFixed(2)}. Entry: $${pos.entryPrice.toFixed(2)}. P&L: $${actualPnl.toFixed(0)}. Remaining: ${pos.quantity}x`,
        orderId: null,
      }});
    } catch {}

    // Update the stop bracket for remaining qty
    if (pos.stopOrderId) try { await apiFetch("/order/cancelorder", { method: "POST", body: JSON.stringify({ orderId: pos.stopOrderId }) }); } catch {}
    try {
      const closeSide = pos.direction === "long" ? "Sell" : "Buy";
      const accounts2 = await apiFetch("/account/list") as { id: number; name: string }[];
      const acct2 = accounts2.find(a => a.id === accountId) || accounts2[0];
      const s = await apiFetch("/order/placeorder", { method: "POST", body: JSON.stringify({
        accountSpec: acct2.name, accountId, action: closeSide, symbol: pos.contractId,
        orderQty: pos.quantity, orderType: "Stop", stopPrice: pos.stopLoss, timeInForce: "GTC", isAutomated: true,
      })}) as { orderId: number };
      pos.stopOrderId = s.orderId;
    } catch {}
    pos.targetOrderId = null; // target removed, trail handles exit

    // Log scale-out to Obsidian vault (learning loop)
    try {
      await logTradeToJournal({
        tradeId: `${new Date().toISOString().slice(0, 10)}-FRT-${sym}-SCALE`,
        timestamp: new Date().toISOString(),
        instrument: `FUT:${sym}`,
        direction: pos.direction === "long" ? "LONG" : "SHORT",
        strategy: "futures-scalping",
        setupType: "scale_out",
        contracts: scaleQty,
        entryPrice: pos.entryPrice,
        stopPrice: pos.stopLoss,
        targetPrice: pos.target,
        exitPrice: price,
        pnlDollars: actualPnl,
        rMultiple: pos.stopLoss ? (price - pos.entryPrice) / Math.abs(pos.entryPrice - pos.stopLoss) * (pos.direction === "long" ? 1 : -1) : undefined,
        conviction: 3,
        exitReason: "scale_out",
      }, "futures-realtime");
      await logDecision("futures-realtime", "EXIT", `FUT:${sym}`, `Scale out ${scaleQty}x @ $${price.toFixed(2)}: P&L $${actualPnl.toFixed(0)}. ${pos.quantity}x remaining.`, actualPnl > 0 ? 4 : 2);
    } catch { /* vault optional */ }

    await savePositions();
  } catch (err) { log(`Scale out failed ${sym}: ${err}`); }
}

// Lock to prevent concurrent close attempts on the same symbol
const closingLocks = new Map<string, boolean>();

async function closePosition(sym: string, price: number, reason: string) {
  // Prevent double-close: if another close is already in progress, skip
  if (closingLocks.get(sym)) {
    log(`${sym}: Close already in progress (${reason}) — skipping duplicate`);
    return;
  }
  const pos = positions.get(sym);
  if (!pos) return;
  closingLocks.set(sym, true);
  const mult = CONTRACT_MULTIPLIERS[sym] || 5;

  // CHECK: Is the position still open on Tradovate? Bracket stop/target may have already filled.
  let positionAlreadyClosed = false;
  try {
    const tvPos = await apiFetch("/position/list") as { contractId: number; netPos: number }[];
    const tvMatch = tvPos.find(p => p.contractId === pos.contractId && p.netPos !== 0);
    if (!tvMatch) {
      positionAlreadyClosed = true;
      log(`${sym}: Position already closed on Tradovate (bracket filled). Using actual fill for P&L.`);
    }
  } catch { /* if check fails, proceed with close attempt */ }

  let closeOrderId: number | null = null;

  // Helper: cancel ALL working orders for this contract (catches orphans after restarts)
  const cancelAllOrdersForContract = async () => {
    try {
      if (pos.stopOrderId) try { await apiFetch("/order/cancelorder", { method: "POST", body: JSON.stringify({ orderId: pos.stopOrderId }) }); } catch {}
      if (pos.targetOrderId) try { await apiFetch("/order/cancelorder", { method: "POST", body: JSON.stringify({ orderId: pos.targetOrderId }) }); } catch {}
      // Also scan for ANY working orders on this contract (catches orphans with unknown IDs)
      const allOrders = await apiFetch("/order/list") as { id: number; contractId: number; ordStatus: string }[];
      const orphans = allOrders.filter(o => o.contractId === pos.contractId && (o.ordStatus === "Working" || o.ordStatus === "Accepted"));
      for (const o of orphans) {
        try { await apiFetch("/order/cancelorder", { method: "POST", body: JSON.stringify({ orderId: o.id }) }); } catch {}
      }
      if (orphans.length > 0) log(`${sym}: Cancelled ${orphans.length} orphaned orders for contract`);
    } catch {}
  };

  if (positionAlreadyClosed) {
    // Bracket already closed the position — cancel any remaining bracket orders
    await cancelAllOrdersForContract();
  } else {
    // Position still open — close it manually with retry
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        // Cancel ALL bracket/working orders for this contract
        await cancelAllOrdersForContract();

        const accounts = await apiFetch("/account/list") as { id: number; name: string }[];
        const acct = accounts.find(a => a.id === accountId) || accounts[0];
        const orderResult = await apiFetch("/order/placeorder", {
          method: "POST",
          body: JSON.stringify({
            accountSpec: acct.name, accountId, action: pos.direction === "long" ? "Sell" : "Buy",
            symbol: pos.contractId, orderQty: pos.quantity, orderType: "Market", timeInForce: "Day", isAutomated: true,
          }),
        }) as { orderId: number };
        closeOrderId = orderResult.orderId;
        // Success — break out of retry loop
        break;
    } catch (err) {
      log(`[CLOSE] Attempt ${attempt}/3 failed for ${sym}: ${err}`);
      if (attempt === 3) {
        log(`[CLOSE] CRITICAL: Could not close ${sym} after 3 attempts!`);
        // Persist failed close to database — survives restarts, visible on dashboard
        try {
          await prisma.autoTradeLog.create({ data: {
            symbol: `FUT:${sym}`,
            action: "futures_close_failed",
            qty: pos.quantity,
            price,
            pnl: 0,
            reason: `CRITICAL: Failed to close ${sym} ${pos.direction} ${pos.quantity}x after 3 attempts. Entry: $${pos.entryPrice.toFixed(2)}. Current: $${price.toFixed(2)}. Manual intervention required.`,
            orderId: null,
          }});
        } catch {}
        // Notify once per symbol to prevent Slack spam
        if (!stoppedSymbols.has(`close_failed_${sym}`)) {
          stoppedSymbols.add(`close_failed_${sym}`);
          notify(`CRITICAL: Failed to close ${sym} ${pos.direction} ${pos.quantity}x after 3 retries! Manual intervention needed.`, "general");
        }
        return; // Don't remove from tracking — retry next tick
      }
      await new Promise(r => setTimeout(r, 2000 * attempt));
      continue;
    }
  } // end retry loop
  } // end else (position still open)

  try {
    // Get ACTUAL fill price from Tradovate — works for both bracket fills and engine-initiated closes
    let actualExitPrice = price;
    try {
      if (closeOrderId) {
        await new Promise(r => setTimeout(r, 1500)); // wait for fill
      }
      // Query ALL recent fills for this contract to find the actual exit price
      const fills = await apiFetch("/fill/list") as { orderId: number; contractId: number; action: string; price: number; qty: number; timestamp: string }[];
      const closeSide = pos.direction === "long" ? "Sell" : "Buy";
      // Match by: our close order ID, OR recent fills on this contract in the close direction
      const myFills = closeOrderId
        ? fills.filter(f => f.orderId === closeOrderId)
        : fills
            .filter(f => f.contractId === pos.contractId && f.action === closeSide)
            .filter(f => Date.now() - new Date(f.timestamp).getTime() < 120_000) // within 2 min
            .sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime())
            .slice(0, pos.quantity); // match qty
      if (myFills.length > 0) {
        const totalQty = myFills.reduce((s, f) => s + f.qty, 0);
        actualExitPrice = myFills.reduce((s, f) => s + f.price * f.qty, 0) / totalQty;
        if (Math.abs(actualExitPrice - price) > 0.01) {
          log(`${sym}: Actual fill $${actualExitPrice.toFixed(2)} (engine price was $${price.toFixed(2)}, diff: ${(actualExitPrice - price).toFixed(2)})`);
        }
      } else {
        log(`${sym}: No fills found — using engine price $${price.toFixed(2)} for P&L`);
      }
    } catch { /* use bar price as fallback */ }

    // Calculate P&L from actual fill price
    const diff = pos.direction === "long" ? actualExitPrice - pos.entryPrice : pos.entryPrice - actualExitPrice;
    const pnl = diff * mult * pos.quantity;
    price = actualExitPrice; // update for logging

    dailyPnl += pnl;
    if (reason === "stop_loss" || reason === "emergency") {
      stoppedSymbols.add(sym);
      consecutiveStops++;

      // Escalating tilt protection: progressive pause durations
      // 2 stops → 30min, 3 → 60min, 4 → 2hr, 5+ → rest of session
      const pauseSchedule = [0, 0, 30, 60, 120]; // minutes per consecutive stop count
      const pauseMin = consecutiveStops >= 5 ? Infinity : (pauseSchedule[consecutiveStops] || 0);

      if (pauseMin > 0) {
        tiltPauseUntil = pauseMin === Infinity ? Infinity : Date.now() + pauseMin * 60_000;
        const label = pauseMin === Infinity ? "rest of session" : `${pauseMin} min`;
        log(`[TILT] Level ${consecutiveStops - 1}: ${consecutiveStops} consecutive stops — pausing ${label}`);
        notify(`TILT L${consecutiveStops - 1}: ${consecutiveStops} stops → pausing ${label}. Daily P&L: $${dailyPnl.toFixed(0)}`, "general");
      }
    } else {
      consecutiveStops = 0; // reset on profitable exit
    }
    log(`CLOSED ${sym}: ${reason} | P&L: $${pnl.toFixed(0)} | Daily: $${dailyPnl.toFixed(0)}`);
    notify(`CLOSED ${sym}: ${reason} | ${pnl >= 0 ? "+" : ""}$${pnl.toFixed(0)} | Daily: ${dailyPnl >= 0 ? "+" : ""}$${dailyPnl.toFixed(0)}`);

    // Store in pattern memory — builds the database that predicts future outcomes
    try {
      const { storePattern } = await import("../lib/pattern-memory");
      const stopDist = Math.abs(pos.entryPrice - pos.stopLoss);
      await storePattern({
        regime: "choppy" as "bull" | "bear" | "choppy",
        session: getSessionName(),
        instrument: sym,
        setupType: reason,
        direction: pos.direction,
        rsi: 50, // TODO: capture at entry time
        vixLevel: currentVIX,
        vixTrend: currentVIX > 20 ? "rising" as const : "falling" as const,
        atr: stopDist / pos.entryPrice * 1000,
        priceVsVwap: 0, // TODO: capture at entry time
        trend15m: "flat" as const, // TODO: capture at entry time
        trendDaily: "flat" as const,
        riskReward: stopDist > 0 ? Math.abs(pos.target - pos.entryPrice) / stopDist : 2,
        dollarTrend: "flat" as const,
        bondTrend: "flat" as const,
        outcome: pnl > 0 ? "win" : "loss",
        pnlR: stopDist > 0 ? diff / stopDist : 0,
      });
    } catch { /* pattern storage is optional */ }

    // Log close to database
    try {
      await prisma.autoTradeLog.create({ data: {
        symbol: `FUT:${sym}`,
        action: `futures_${reason}`,
        qty: pos.quantity,
        price,
        pnl,
        reason: `[FUTURES ${sym}] ${reason}: Closed ${pos.quantity}x @ $${price.toFixed(2)}. Entry: $${pos.entryPrice.toFixed(2)}. P&L: $${pnl.toFixed(0)}. Daily: $${dailyPnl.toFixed(0)}`,
        orderId: null,
      }});
    } catch {}

    // Log exit to Obsidian vault
    try {
      await logTradeToJournal({
        tradeId: `${new Date().toISOString().slice(0, 10)}-FRT-${sym}`,
        timestamp: new Date().toISOString(),
        instrument: `FUT:${sym}`,
        direction: pos.direction === "long" ? "LONG" : "SHORT",
        strategy: "futures-scalping",
        setupType: "realtime",
        contracts: pos.quantity,
        entryPrice: pos.entryPrice,
        stopPrice: pos.stopLoss,
        targetPrice: pos.target,
        exitPrice: price,
        pnlDollars: pnl,
        rMultiple: pos.stopLoss ? (price - pos.entryPrice) / Math.abs(pos.entryPrice - pos.stopLoss) * (pos.direction === "long" ? 1 : -1) : undefined,
        conviction: 3,
        exitReason: reason,
        followedPlan: true,
      }, "futures-realtime");
      await logDecision("futures-realtime", "EXIT", `FUT:${sym}`, `${reason}: P&L $${pnl.toFixed(0)}`, pnl > 0 ? 4 : 2);
      // Log observations for notable trades (big wins, big losses, emergencies)
      const rMult = pos.stopLoss ? Math.abs((price - pos.entryPrice) / (pos.entryPrice - pos.stopLoss)) * (pnl > 0 ? 1 : -1) : null;
      if (rMult != null && rMult >= 2) {
        await logObservation("futures-realtime", `BIG WIN: ${sym} ${pos.direction} +$${pnl.toFixed(0)} (${rMult.toFixed(1)}R) — ${reason}`);
      } else if (pnl < -200) {
        await logObservation("futures-realtime", `BIG LOSS: ${sym} ${pos.direction} -$${Math.abs(pnl).toFixed(0)} — ${reason}`);
      } else if (reason.includes("emergency") || reason.includes("kill")) {
        await logObservation("futures-realtime", `EMERGENCY: ${sym} ${pos.direction} $${pnl.toFixed(0)} — ${reason}`);
      }
    } catch { /* vault optional */ }

    positions.delete(sym);
    mirrorToLive("close", sym, { reason }).catch(() => {});
    await savePositions();

    // Save balance snapshot after every close — ensures accurate daily P&L even with overnight trades or engine restarts
    try {
      await updateTradovateEquity();
      const today = new Date().toISOString().slice(0, 10);
      await prisma.agentConfig.upsert({
        where: { key: `eod_balance_${today}` },
        update: { value: String(tradovateEquity) },
        create: { key: `eod_balance_${today}`, value: String(tradovateEquity) },
      });
    } catch {}
  } catch (err) { log(`Close failed ${sym}: ${err}`); }
  finally { closingLocks.delete(sym); }
}

// ── Multi-Timeframe (build 15-min bars from 5-min) ──────

function get15mTrend(bars5m: Bar[]): { trend: "up" | "down" | "flat"; strength: number } {
  // Aggregate 5-min bars into 15-min bars
  const bars15m: Bar[] = [];
  for (let i = 0; i + 2 < bars5m.length; i += 3) {
    bars15m.push({
      t: bars5m[i].t,
      o: bars5m[i].o,
      h: Math.max(bars5m[i].h, bars5m[i + 1].h, bars5m[i + 2].h),
      l: Math.min(bars5m[i].l, bars5m[i + 1].l, bars5m[i + 2].l),
      c: bars5m[i + 2].c,
      v: bars5m[i].v + bars5m[i + 1].v + bars5m[i + 2].v,
    });
  }
  if (bars15m.length < 21) return { trend: "flat", strength: 0 };

  const closes = bars15m.map(b => b.c);
  const fast = ema(closes, 9);
  const slow = ema(closes, 21);
  const f = fast[fast.length - 1];
  const s = slow[slow.length - 1];
  const spread = Math.abs(f - s) / s;

  if (f > s) return { trend: "up", strength: spread };
  if (f < s) return { trend: "down", strength: spread };
  return { trend: "flat", strength: 0 };
}

// ── AI Confirmation (asks Claude before each trade) ─────

async function getAIConfirmation(setup: {
  sym: string; direction: string; reasoning: string;
  price: number; rsi: number; atr: number; vwap: number;
  dayType: string; session: string; trend15: string;
  prevDayHigh: number; prevDayLow: number;
}): Promise<{ agree: boolean; confidence: number; reasoning: string }> {
  try {
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) return { agree: true, confidence: 0, reasoning: "AI unavailable" };

    const macroCtx = crossAssetSummary || "No macro data";
    const eventCtx = macroBlockReason || "No macro events nearby";

    const isMetal = METALS.has(setup.sym);
    const metalContext = isMetal ? `
GOLD-SPECIFIC RULES:
- Gold is INVERSE to USD. Dollar down = gold up. Dollar up = gold down.
- Gold rallies on RISK-OFF (VIX spike, fear). Goes flat/down on RISK-ON.
- LONG gold when: USD weakening, VIX rising, bonds rallying, geopolitical tension
- SHORT gold when: USD strengthening, VIX falling, risk appetite strong
- Gold trends for HOURS — let winners run, wide stops needed
- COMEX open (8:20 AM ET) is the most important session for gold` : "";

    const prompt = `You are an elite futures day trader. You only take A+ setups with clear edge.

${setup.sym} @ $${setup.price.toFixed(2)} | ${setup.direction.toUpperCase()} | ${isMetal ? "MICRO GOLD" : "EQUITY INDEX"}
Setup: ${setup.reasoning}
RSI(14): ${setup.rsi.toFixed(0)} | ATR: ${setup.atr.toFixed(2)} | VWAP: $${setup.vwap.toFixed(2)}
15m trend: ${setup.trend15} | Day type: ${setup.dayType} | Session: ${setup.session}
Key levels: PDH $${setup.prevDayHigh.toFixed(2)} | PDL $${setup.prevDayLow.toFixed(2)}
VIX: ${currentVIX.toFixed(1)} | Term structure: ${vixTermStructure} ${vixTermStructure === "backwardation" ? "(FEAR — market stressed)" : "(normal)"}
${macroCtx}
${sectorContext || "No sector data"}
Earnings week: ${earningsWeekSymbols.length > 0 ? earningsWeekSymbols.join(", ") + " reporting — elevated vol" : "no mega-cap earnings"}
Macro events: ${eventCtx}
${metalContext}
${vaultLessonsCache?.lessons ? `\nLESSONS FROM PAST TRADES (apply these):\n${vaultLessonsCache.lessons.match(/\*\*LESSON\*\*:\s*(.+)/g)?.slice(0, 5).map(l => "- " + l.replace("**LESSON**: ", "")).join("\n") || "none"}\n` : ""}
${vaultLessonsCache?.antiPatterns ? `ANTI-PATTERNS (avoid these proven losers):\n${vaultLessonsCache.antiPatterns.match(/\*\*PATTERN\*\*:\s*(.+)/g)?.slice(0, 5).map(l => "- " + l.replace("**PATTERN**: ", "")).join("\n") || "none"}\n` : ""}
REJECT if: fighting 15m trend, no volume confirmation, price in no-man's land (not at a key level), R:R < 2:1${isMetal ? ", or USD strengthening while going long gold" : ", or macro signals strongly oppose direction (risk_off + long, risk_on + short)"}, or matches any ANTI-PATTERN above.
ACCEPT if: aligned with higher timeframe, at a key level, with volume, in the right session${isMetal ? ", and USD/macro confirms gold direction" : ", and macro confirms or is neutral"}, and aligns with LESSONS above.

Respond ONLY with JSON: {"agree":true/false,"confidence":75,"reasoning":"one sentence"}`;

    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: "claude-opus-4-6",
        max_tokens: 8000,
        thinking: { type: "enabled", budget_tokens: 5000 },
        messages: [{ role: "user", content: prompt }],
      }),
      signal: AbortSignal.timeout(30000),
    });

    if (!res.ok) {
      const errBody = await res.text().catch(() => "");
      log(`[AI] Call failed (${res.status}): ${errBody.slice(0, 200)}`);
      return { agree: true, confidence: 0, reasoning: `AI ${res.status}` };
    }

    const data = await res.json() as { content: { type: string; text: string }[] };
    const text = data.content?.find(b => b.type === "text")?.text || "";
    // Handle Claude sometimes wrapping JSON in markdown code blocks
    let jsonText = text.trim();
    const jsonMatch = jsonText.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/);
    if (jsonMatch) jsonText = jsonMatch[1].trim();
    const parsed = JSON.parse(jsonText);
    return { agree: !!parsed.agree, confidence: parsed.confidence || 50, reasoning: parsed.reasoning || "" };
  } catch (err) {
    const msg = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
    log(`[AI] ERROR — ${msg}`);
    // AI unavailable: still allow trades but with reduced confidence (no AI boost)
    return { agree: true, confidence: 0, reasoning: `AI error: ${msg.slice(0, 80)}` };
  }
}

// ── Confidence Scoring ──────────────────────────────────

function scoreSetup(factors: {
  baseConfidence: number;
  volTrend: string;
  volRatio: number;
  trend15Aligns: boolean;
  rsiExtreme: boolean;
  priceAboveVWAP: boolean;
  dayTypeMatch: boolean;
  sessionQuality: string;
}): { score: number; reasons: string[] } {
  let score = factors.baseConfidence;
  const reasons: string[] = [];

  // Volume confirmation
  if (factors.volTrend === "surge" && factors.volRatio > 2) { score += 8; reasons.push("volume surge +8"); }
  else if (factors.volTrend === "declining") { score += 5; reasons.push("declining vol (healthy pullback) +5"); }
  else if (factors.volTrend === "dry") { score -= 5; reasons.push("dry volume -5"); }

  // 15-min trend alignment
  if (factors.trend15Aligns) { score += 10; reasons.push("15m trend confirms +10"); }
  else { score -= 10; reasons.push("15m trend opposes -10"); }

  // RSI extreme (good for mean reversion, careful for breakout)
  if (factors.rsiExtreme) { score += 3; reasons.push("RSI at extreme +3"); }

  // VWAP position
  if (factors.priceAboveVWAP) { score += 3; reasons.push("price above VWAP +3"); }

  // Session quality
  if (factors.sessionQuality === "prime") { score += 5; reasons.push("prime session +5"); }
  else if (factors.sessionQuality === "avoid") { score -= 10; reasons.push("poor session -10"); }

  return { score: Math.max(0, Math.min(100, score)), reasons };
}

// ── Setup Detection (on 5-min bar close) ────────────────

function onBarClose(sym: string, bar: Bar) {
  const b = barBuilders.get(sym);
  if (!b || b.bars5m.length < 25) return;

  const session = getSessionName();
  const sizeMult = getSizeMultiplier(sym);

  // CORRELATION GATE: don't hold two equity index positions simultaneously
  // ES and NQ are 90%+ correlated — holding both is doubling the same bet
  const EQUITY_INDICES = new Set(["ES", "NQ", "YM", "RTY", "MES", "MNQ", "MYM", "M2K"]);
  if (EQUITY_INDICES.has(sym)) {
    const holdingEquityIndex = [...positions.keys()].some(s => EQUITY_INDICES.has(s));
    if (holdingEquityIndex) {
      // Already holding an equity index — only allow GC/MGC (uncorrelated) or same-symbol addition
      return;
    }
  }

  // VAULT LESSONS GATE: check anti-patterns before trading
  // Cache refreshes hourly in the background, check is synchronous
  if (vaultLessonsCache?.antiPatterns) {
    const ap = vaultLessonsCache.antiPatterns.toLowerCase();

    // Map synthesis agent time buckets to engine session names
    const sessionAntiPatterns: { pattern: string; sessions: string[]; label: string }[] = [
      { pattern: "first_30_min", sessions: ["open"], label: "first 30 min" },
      { pattern: "mid_morning", sessions: ["morning"], label: "mid-morning" },
      { pattern: "midday", sessions: ["midday"], label: "midday/lunch" },
      { pattern: "afternoon", sessions: ["afternoon"], label: "afternoon" },
      { pattern: "last_30_min", sessions: ["close"], label: "last 30 min" },
    ];

    for (const rule of sessionAntiPatterns) {
      if (!ap.includes(rule.pattern)) continue;
      if (!rule.sessions.includes(session)) continue;

      // Extract the win rate from the anti-pattern text (e.g. "29% win rate" or "0% win rate")
      const wrMatch = ap.match(new RegExp(`${rule.pattern}[^\\n]*?(\\d+)%\\s*win\\s*rate`));
      const winRate = wrMatch ? parseInt(wrMatch[1]) : null;

      // Block if win rate < 30%, reduce size if < 40%
      if (winRate !== null && winRate < 30) {
        log(`${sym}: VAULT BLOCK — anti-pattern: ${rule.label} has ${winRate}% win rate`);
        return;
      }
    }

    // Check instrument-specific anti-patterns (e.g. "MGC has only 15% win rate")
    const instMatch = ap.match(new RegExp(`${sym.toLowerCase()}[^\\n]*?(\\d+)%\\s*win\\s*rate`));
    if (instMatch) {
      const instWR = parseInt(instMatch[1]);
      if (instWR < 25) {
        log(`${sym}: VAULT BLOCK — anti-pattern: ${sym} has ${instWR}% win rate over many trades`);
        return;
      }
    }
  }

  // MACRO EVENT GATE: reduce/block trading around CPI, FOMC, jobs reports
  const macro = getMacroMultiplier();
  if (macro.multiplier === 0) {
    log(`  ✗ MACRO BLOCK: ${macro.reason} — no new trades`);
    return;
  }

  const bars = b.bars5m;
  const closes = bars.map(x => x.c);
  const price = bar.c;
  const rawATR = atr(bars);
  if (rawATR <= 0) return;
  // Gold needs wider stops — swings more than equity indices on 5-min bars
  const atrScale = METALS.has(sym) ? 1.5 : 1.0;
  const currentATR = rawATR * atrScale;

  const currentRSI = rsi(closes) || 50;
  const fast = ema(closes, 9);
  const slow = ema(closes, 21);
  const fastEMA = fast[fast.length - 1];
  const slowEMA = slow[slow.length - 1];
  const vwapData = b.sessionBars.length >= 3 ? calcVwap(b.sessionBars) : calcVwap(bars.slice(-78));

  // Volume analysis
  const last20 = bars.slice(-20);
  const avgVol = last20.reduce((s, x) => s + x.v, 0) / 20;
  const volRatio = avgVol > 0 ? bar.v / avgVol : 1;
  const volTrend = volRatio > 2 ? "surge" : volRatio < 0.6 ? "dry" : volRatio < 0.8 ? "declining" : "normal";

  // Multi-timeframe: 15-min trend
  const tf15 = get15mTrend(bars);

  // Day type
  const orSize = b.openingRangeHigh - b.openingRangeLow;
  const outsideRange = (b.prevDayHigh > 0 && price > b.prevDayHigh) || (b.prevDayLow > 0 && price < b.prevDayLow);
  const dayType = outsideRange || orSize > currentATR * 0.5 ? "trend" : "range";

  // VIX
  const vix = getVIXMultiplier();
  const adjustedATR = currentATR * vix.stopMult;
  let effectiveSizeMult = sizeMult * vix.sizeMult * macro.multiplier;
  // Earnings week: reduce equity indices when mega-caps reporting (gold unaffected)
  if (!METALS.has(sym) && earningsWeekNQPenalty < 1.0) {
    effectiveSizeMult *= earningsWeekNQPenalty;
  }
  const dayOfWeek = new Date().getUTCDay();
  if (dayOfWeek === 1 || dayOfWeek === 5) effectiveSizeMult *= 0.5; // half size Mon/Fri
  const sessionQuality = sizeMult >= 1 ? "prime" : sizeMult >= 0.5 ? "good" : "avoid";

  log(`${sym}: $${price.toFixed(2)} | ATR:${currentATR.toFixed(2)} | RSI:${currentRSI.toFixed(0)} | 15m:${tf15.trend} | ${dayType} | ${session} | ${vix.label}`);

  // ── EVALUATE ALL SETUPS WITH CONFIDENCE SCORING ──

  // Track near-misses for logging
  let bestNearMiss = "";

  // SETUP 0: Extreme RSI Bounce (any day type, any tradeable session)
  // When RSI is deeply oversold (<25) or overbought (>75), a bounce/reversal is likely
  // even on trend days. These are high-probability mean reversion trades.
  if (currentRSI < 25 || currentRSI > 75) {
    const isOversold = currentRSI < 25;
    const dir = isOversold ? "long" : "short";
    const targetDist = currentATR * 3.5; // target 3.5 ATR bounce — bigger moves
    const stopDistRSI = adjustedATR * 1.5;

    // Need declining volume (exhaustion, not capitulation)
    if (volTrend !== "surge") {
      const { score, reasons } = scoreSetup({
        baseConfidence: 70,
        volTrend, volRatio,
        trend15Aligns: isOversold ? tf15.trend !== "down" : tf15.trend !== "up", // don't fade strong 15m trends
        rsiExtreme: true,
        priceAboveVWAP: false,
        dayTypeMatch: true,
        sessionQuality,
      });

      log(`  → EXTREME RSI BOUNCE ${dir.toUpperCase()} | RSI:${currentRSI.toFixed(0)} | Confidence: ${score}% | ${reasons.join(", ")}`);

      if (score >= 75) {
        evaluateAndTrade(sym, dir, price, stopDistRSI, targetDist, effectiveSizeMult, score,
          `Extreme RSI ${isOversold ? "oversold" : "overbought"} bounce: RSI ${currentRSI.toFixed(0)}, ATR target ${targetDist.toFixed(2)}, conf ${score}%`,
          currentRSI, currentATR, vwapData.vwap, dayType, session, tf15.trend, b.prevDayHigh, b.prevDayLow);
        return;
      }
    } else {
      bestNearMiss = `RSI extreme (${currentRSI.toFixed(0)}) but volume surging — capitulation, not exhaustion`;
    }
  }

  // SETUP: GAP FILL (highest statistical edge — 78% fill rate on small gaps)
  const GAP_THRESHOLDS: Record<string, number> = { ES: 10, NQ: 50, GC: 15, MES: 10, MNQ: 50, MGC: 15 };
  if (b.barCount >= 1 && b.barCount <= 6 && b.prevDayClose > 0 && (session === "open" || session === "morning")) {
    const gap = b.sessionBars.length > 0 ? b.sessionBars[0].o - b.prevDayClose : 0;
    const absGap = Math.abs(gap);
    const maxGap = GAP_THRESHOLDS[sym] || 10;

    if (absGap > 1 && absGap < maxGap) {
      const dir = gap > 0 ? "short" : "long"; // fade the gap
      const gapTarget = Math.abs(price - b.prevDayClose) * 0.8; // target 80% gap fill
      const gapStop = absGap * 1.5;

      if (gapTarget > currentATR * 0.3) {
        const { score, reasons } = scoreSetup({
          baseConfidence: 75,
          volTrend, volRatio,
          trend15Aligns: true, // gap fills override trend
          rsiExtreme: false,
          priceAboveVWAP: false,
          dayTypeMatch: true,
          sessionQuality,
        });

        log(`  → GAP FILL ${dir.toUpperCase()} | Gap: ${gap.toFixed(2)} pts | Target: PDC $${b.prevDayClose.toFixed(2)} | Confidence: ${score}% | ${reasons.join(", ")}`);

        if (score >= 75) {
          evaluateAndTrade(sym, dir, price, gapStop, gapTarget, effectiveSizeMult, score,
            `Gap fill ${dir}: gap ${gap.toFixed(1)} pts, targeting PDC $${b.prevDayClose.toFixed(2)}, 78% fill rate, conf ${score}%`,
            currentRSI, currentATR, vwapData.vwap, dayType, session, tf15.trend, b.prevDayHigh, b.prevDayLow);
        }
        return;
      }
    }
  }

  // SETUP 1: Opening Range (IB) Breakout (trend days, morning/COMEX open, after IB complete)
  const isMorningSession = session === "morning" || (METALS.has(sym) && sizeMult >= 0.7);
  if (dayType === "trend" && isMorningSession && b.barCount >= 12 && b.openingRangeHigh > 0 && orSize > currentATR * 0.3) {
    const isLong = price > b.openingRangeHigh && volRatio > 1.5;
    const isShort = price < b.openingRangeLow && volRatio > 1.5;

    if (isLong || isShort) {
      const dir = isLong ? "long" : "short";
      const { score, reasons } = scoreSetup({
        baseConfidence: 65,
        volTrend, volRatio,
        trend15Aligns: isLong ? tf15.trend === "up" : tf15.trend === "down",
        rsiExtreme: false,
        priceAboveVWAP: isLong ? price > vwapData.vwap : price < vwapData.vwap,
        dayTypeMatch: true,
        sessionQuality,
      });

      log(`  → OR BREAKOUT ${dir.toUpperCase()} | Confidence: ${score}% | ${reasons.join(", ")}`);

      if (score >= 75) {
        evaluateAndTrade(sym, dir, price, Math.max(orSize * 0.5, adjustedATR), orSize * 2.5, effectiveSizeMult, score,
          `OR breakout ${dir} $${price.toFixed(2)} ${isLong ? ">" : "<"} OR ${isLong ? "high" : "low"} $${(isLong ? b.openingRangeHigh : b.openingRangeLow).toFixed(2)}, vol ${volRatio.toFixed(1)}x, conf ${score}%`,
          currentRSI, currentATR, vwapData.vwap, dayType, session, tf15.trend, b.prevDayHigh, b.prevDayLow);
      }
      return;
    }
  }

  // SETUP: FAILED IB BREAKOUT (fade the failure — high edge reversal)
  if (b.barCount >= 13 && b.openingRangeHigh > 0 && (session === "morning" || session === "midday" || session === "afternoon")) {
    // Check if we recently tested above IB high or below IB low (within last 6 bars)
    const recentBars = bars.slice(-6);
    const testedHigh = recentBars.some(x => x.h > b.openingRangeHigh);
    const testedLow = recentBars.some(x => x.l < b.openingRangeLow);
    const backInRange = price < b.openingRangeHigh && price > b.openingRangeLow;

    if (backInRange && (testedHigh || testedLow) && volTrend !== "surge") {
      const dir = testedHigh ? "short" : "long"; // fade the failed break
      const ibMid = (b.openingRangeHigh + b.openingRangeLow) / 2;
      const failTarget = Math.abs(price - ibMid);
      const failStop = testedHigh ? Math.abs(b.openingRangeHigh - price) + currentATR * 0.5 : Math.abs(price - b.openingRangeLow) + currentATR * 0.5;

      if (failTarget / failStop >= 2.0) {
        const { score, reasons } = scoreSetup({
          baseConfidence: 73,
          volTrend, volRatio,
          trend15Aligns: dir === "short" ? tf15.trend === "down" : tf15.trend === "up",
          rsiExtreme: testedHigh ? currentRSI > 65 : currentRSI < 35,
          priceAboveVWAP: dir === "short" ? price > vwapData.vwap : price < vwapData.vwap,
          dayTypeMatch: true,
          sessionQuality,
        });

        log(`  → FAILED IB BREAKOUT ${dir.toUpperCase()} | Tested ${testedHigh ? "high" : "low"}, back in range | Target: IB mid $${ibMid.toFixed(2)} | Confidence: ${score}% | ${reasons.join(", ")}`);

        if (score >= 75) {
          evaluateAndTrade(sym, dir, price, failStop, failTarget, effectiveSizeMult, score,
            `Failed IB breakout ${dir}: price tested ${testedHigh ? "IB high" : "IB low"} and returned, fading to mid $${ibMid.toFixed(2)}, conf ${score}%`,
            currentRSI, currentATR, vwapData.vwap, dayType, session, tf15.trend, b.prevDayHigh, b.prevDayLow);
        }
        return;
      }
    }
  }

  // SETUP 2: Trend Continuation (pullback to EMA9) — RTH only
  if ((dayType === "trend" || Math.abs(fastEMA - slowEMA) / price > 0.001) &&
      (session === "morning" || session === "afternoon")) {
    const nearEMA = Math.abs(price - fastEMA) / price < 0.003;
    const isLong = nearEMA && fastEMA > slowEMA && price > slowEMA && currentRSI > 35 && currentRSI < 65 && volTrend !== "surge";
    const isShort = nearEMA && fastEMA < slowEMA && price < slowEMA && currentRSI > 35 && currentRSI < 65 && volTrend !== "surge";

    if (isLong || isShort) {
      const dir = isLong ? "long" : "short";
      const { score, reasons } = scoreSetup({
        baseConfidence: 72,
        volTrend, volRatio,
        trend15Aligns: isLong ? tf15.trend === "up" : tf15.trend === "down",
        rsiExtreme: false,
        priceAboveVWAP: isLong ? price > vwapData.vwap : price < vwapData.vwap,
        dayTypeMatch: dayType === "trend",
        sessionQuality,
      });

      log(`  → TREND CONTINUATION ${dir.toUpperCase()} | EMA9:$${fastEMA.toFixed(2)} | Confidence: ${score}% | ${reasons.join(", ")}`);

      if (score >= 75) {
        evaluateAndTrade(sym, dir, price, adjustedATR * 1.5, adjustedATR * 4.0, effectiveSizeMult, score,
          `Trend pullback ${dir} near EMA9 $${fastEMA.toFixed(2)}, RSI ${currentRSI.toFixed(0)}, 15m ${tf15.trend}, conf ${score}%`,
          currentRSI, currentATR, vwapData.vwap, dayType, session, tf15.trend, b.prevDayHigh, b.prevDayLow);
      }
      return;
    }
  }

  // SETUP 3: VWAP Mean Reversion — DISABLED (backtest: 49 trades, 24% win rate, -99 pts)

  // Log near-miss or why no setup triggered
  if (bestNearMiss) {
    log(`  ✗ Near miss: ${bestNearMiss}`);
  } else {
    // Quick summary of why nothing triggered
    const reasons: string[] = [];
    if (currentRSI > 25 && currentRSI < 75) reasons.push(`RSI ${currentRSI.toFixed(0)} not extreme`);
    if (session !== "morning") reasons.push("not morning (no OR breakout)");
    if (Math.abs(price - fastEMA) / price >= 0.003) reasons.push(`price ${((Math.abs(price - fastEMA) / price) * 100).toFixed(2)}% from EMA9 (need <0.3%)`);
    if (dayType !== "range") reasons.push(`${dayType} day (VWAP reversion needs range)`);
    if (reasons.length > 0) log(`  ✗ No setup: ${reasons.join(" | ")}`);
  }
}

// ── AI Evaluation + Execute ─────────────────────────────

async function evaluateAndTrade(
  sym: string, direction: string, price: number,
  stopDist: number, targetDist: number, sizeMult: number, technicalScore: number,
  reasoning: string, rsiVal: number, atrVal: number, vwapVal: number,
  dayType: string, session: string, trend15: string,
  prevDayHigh: number, prevDayLow: number,
) {
  // Get AI confirmation
  const ai = await getAIConfirmation({
    sym, direction, reasoning, price,
    rsi: rsiVal, atr: atrVal, vwap: vwapVal,
    dayType, session, trend15, prevDayHigh, prevDayLow,
  });

  // Adjust confidence based on AI
  let finalScore = technicalScore;
  if (ai.confidence > 0) {
    if (ai.agree) {
      finalScore += Math.min(10, Math.round(ai.confidence / 10));
      log(`  AI CONFIRMS (${ai.confidence}%): ${ai.reasoning} → final ${finalScore}%`);
    } else {
      log(`  AI REJECTS (${ai.confidence}%): ${ai.reasoning} — trade blocked`);
      return;
    }
  } else {
    log(`  AI: ${ai.reasoning}`);
  }

  // Final gate: need 65%+ after AI adjustment
  if (finalScore < 65) {
    log(`  SKIPPED: Final confidence ${finalScore}% below 65% threshold`);
    return;
  }

  // Execution gates — limits from DB config (Agent Hub manages these)
  const canExec = sizeMult > 0 && !positions.has(sym) && positions.size < riskConfig.maxConcurrentPositions
    && dailyTradeCount < riskConfig.maxTradesPerDay && dailyPnl >= -(startOfDayBalance || tradovateEquity) * (riskConfig.dailyLossLimitPct / 100)
    && Date.now() >= tiltPauseUntil && !stoppedSymbols.has(sym);

  if (canExec) {
    // SHADOW LOG: Record what confluence/pattern would have said (doesn't affect execution)
    // This data trains the next-generation decision system
    try {
      const { predictOutcome } = await import("../lib/pattern-memory");
      const patternPrediction = await predictOutcome({
        regime: "choppy" as "bull" | "bear" | "choppy",
        session, instrument: sym, setupType: reasoning.split("]")[0]?.replace("[", "") || "unknown",
        direction: direction as "long" | "short",
        rsi: rsiVal, vixLevel: currentVIX, vixTrend: currentVIX > 20 ? "rising" : "falling",
        atr: atrVal / price * 1000, priceVsVwap: vwapVal > 0 ? (price - vwapVal) / vwapVal * 100 : 0,
        trend15m: trend15 as "up" | "down" | "flat",
        trendDaily: dayType.includes("trend") ? (direction === "long" ? "up" : "down") : "flat",
        riskReward: targetDist / stopDist,
        dollarTrend: "flat", bondTrend: "flat", // TODO: wire cross-asset
      });
      log(`  [SHADOW] Pattern memory: ${patternPrediction.matchCount} matches, ${(patternPrediction.winRate * 100).toFixed(0)}% historical WR, score ${patternPrediction.score}`);
    } catch { /* shadow logging is optional */ }

    log(`  EXECUTING: ${direction.toUpperCase()} ${sym} @ $${price.toFixed(2)} | Confidence: ${finalScore}%`);
    await executeTrade(sym, direction as "long" | "short", price, stopDist, targetDist, sizeMult, finalScore,
      `[${finalScore}% confidence] ${reasoning}. AI: ${ai.agree ? "confirms" : "disagrees"} — ${ai.reasoning}`);
  } else {
    // Hit daily limit or tilt — done for the day. Demo handles learning independently.
    log(`  BLOCKED: ${direction.toUpperCase()} ${sym} (${dailyTradeCount >= 10 ? "daily limit" : "tilt/position limit"}). Done.`);
  }
}

// ── Trade Execution ─────────────────────────────────────

async function executeTrade(sym: string, direction: "long" | "short", price: number, stopDist: number, targetDist: number, sizeMult: number, confidenceScore: number, reasoning: string) {
  const contract = contracts.get(sym);
  if (!contract) return;

  // Demo always executes (24/7 learning). Live mirrors during RTH if enabled.

  const mult = CONTRACT_MULTIPLIERS[sym] || 5;
  // Use simulated equity for sizing (demo simulates $1K). Fall back to actual if not set.
  const equity = riskConfig.simulatedEquity > 0 ? riskConfig.simulatedEquity : tradovateEquity;
  const riskPct = riskConfig.riskPerTradePct / 100;
  const maxRisk = equity * riskPct * sizeMult;
  const riskPer = stopDist * mult;
  let qty = Math.max(1, Math.min(riskConfig.maxContractsPerTrade, Math.floor(maxRisk / riskPer)));
  // Hard ceiling: never risk more than 15% of equity on a single entry
  const totalRisk = riskPer * qty;
  if (totalRisk > equity * 0.15) {
    qty = Math.max(1, Math.floor((equity * 0.15) / riskPer));
    log(`${sym}: HARD CAP — risk $${totalRisk.toFixed(0)} exceeds 15% equity, capped to ${qty} contracts`);
  }
  const rr = targetDist / stopDist;
  if (rr < 2.0) { log(`${sym}: R:R ${rr.toFixed(1)} too low (need 2.0+)`); return; }

  const stopPrice = direction === "long" ? price - stopDist : price + stopDist;
  const targetPrice = direction === "long" ? price + targetDist : price - targetDist;
  const side = direction === "long" ? "Buy" : "Sell";
  const closeSide = direction === "long" ? "Sell" : "Buy";

  log(`\n${"=".repeat(50)}`);
  log(`TRADE: ${side} ${qty}x ${sym} @ $${price.toFixed(2)}`);
  log(`  Stop: $${stopPrice.toFixed(2)} | Target: $${targetPrice.toFixed(2)} | R:R: ${rr.toFixed(1)} | Risk: $${(riskPer * qty).toFixed(0)}`);
  log(`  ${reasoning}`);
  log(`${"=".repeat(50)}\n`);

  try {
    const accounts = await apiFetch("/account/list") as { id: number; name: string }[];
    const acct = accounts.find(a => a.id === accountId) || accounts[0];

    const entry = await apiFetch("/order/placeorder", { method: "POST", body: JSON.stringify({
      accountSpec: acct.name, accountId, action: side, symbol: contract.id,
      orderQty: qty, orderType: "Market", timeInForce: "Day", isAutomated: true,
    })}) as { orderId: number };

    await new Promise(r => setTimeout(r, 1500));

    let stopOrderId: number | null = null;
    try {
      const s = await apiFetch("/order/placeorder", { method: "POST", body: JSON.stringify({
        accountSpec: acct.name, accountId, action: closeSide, symbol: contract.id,
        orderQty: qty, orderType: "Stop", stopPrice, timeInForce: "GTC", isAutomated: true,
      })}) as { orderId: number };
      stopOrderId = s.orderId;
    } catch {}

    let targetOrderId: number | null = null;
    try {
      const t = await apiFetch("/order/placeorder", { method: "POST", body: JSON.stringify({
        accountSpec: acct.name, accountId, action: closeSide, symbol: contract.id,
        orderQty: qty, orderType: "Limit", price: targetPrice, timeInForce: "GTC", isAutomated: true,
      })}) as { orderId: number };
      targetOrderId = t.orderId;
    } catch {}

    positions.set(sym, {
      symbol: sym, contractId: contract.id, direction, quantity: qty,
      entryPrice: price, stopLoss: stopPrice, target: targetPrice,
      trailStop: null, reachedBreakeven: false,
      stopOrderId, targetOrderId, entryTime: Date.now(),
      scaledOut: false, originalQty: qty, consecutiveStops: 0,
      pyramided: false,
    });
    dailyTradeCount++;
    log(`Order #${entry.orderId} filled | Stop #${stopOrderId} | Target #${targetOrderId}`);
    notify(`${side} ${qty}x ${sym} @ $${price.toFixed(2)} | Stop: $${stopPrice.toFixed(2)} | Target: $${targetPrice.toFixed(2)} | R:R ${rr.toFixed(1)}`);
    await savePositions();

    // Log to database so Vercel dashboard shows it
    try {
      await prisma.autoTradeLog.create({ data: {
        symbol: `FUT:${sym}`,
        action: `futures_${direction}`,
        qty,
        price,
        reason: `[FUTURES ${sym}] ${reasoning}. Stop: $${stopPrice.toFixed(2)}, Target: $${targetPrice.toFixed(2)}. R:R ${rr.toFixed(1)}. Risk: $${(riskPer * qty).toFixed(0)}. Size: ${sizeMult.toFixed(1)}x`,
        aiScore: confidenceScore,
        aiSignal: direction,
        orderId: String(entry.orderId),
      }});
    } catch {}
  } catch (err) { log(`TRADE FAILED: ${err}`); }

  // ── LIVE MIRROR: Also execute on live account if enabled + RTH window ──
  // Check daily loss limit on live account before mirroring
  if (isLiveRTHWindow()) {
    // Query today's live P&L from DB to enforce daily loss limit
    let liveDailyPnl = 0;
    try {
      const todayET = getETDateString();
      const isDST = new Date().toLocaleString("en-US", { timeZone: "America/New_York", timeZoneName: "short" }).includes("EDT");
      const todayStart = new Date(`${todayET}T00:00:00${isDST ? "-04:00" : "-05:00"}`);
      const liveTrades = await prisma.autoTradeLog.findMany({
        where: { action: { startsWith: "live_" }, pnl: { not: null }, createdAt: { gte: todayStart } },
      });
      liveDailyPnl = liveTrades.reduce((s, t) => s + (t.pnl || 0), 0);
    } catch {}
    const liveDailyLimit = liveEquity * (LIVE_DEFAULTS.dailyLossLimitPct / 100); // 15% of $1K = $150
    if (liveDailyPnl < -liveDailyLimit) {
      log(`[LIVE MIRROR] BLOCKED — live daily P&L $${liveDailyPnl.toFixed(0)} exceeds limit -$${liveDailyLimit.toFixed(0)}`);
    } else {
    try {
      const liveContract = contract;
      const liveMult = CONTRACT_MULTIPLIERS[sym] || 5;
      const liveRiskPct = LIVE_DEFAULTS.riskPerTradePct / 100;
      const liveMaxRisk = liveEquity * liveRiskPct;
      const liveRiskPer = stopDist * liveMult;
      let liveQty = Math.max(1, Math.min(LIVE_DEFAULTS.maxContractsPerTrade, Math.floor(liveMaxRisk / liveRiskPer)));
      // Hard cap: never risk more than 15% of live equity
      if (liveRiskPer * liveQty > liveEquity * 0.15) {
        liveQty = Math.max(1, Math.floor((liveEquity * 0.15) / liveRiskPer));
      }

      const liveAccounts = await liveApiFetch("/account/list") as { id: number; name: string }[];
      const liveAcct = liveAccounts.find(a => a.id === liveAccountId) || liveAccounts[0];

      log(`[LIVE MIRROR] ${side} ${liveQty}x ${sym} @ ~$${price.toFixed(2)} | Risk: $${(liveRiskPer * liveQty).toFixed(0)} | Equity: $${liveEquity.toFixed(0)}`);

      const liveEntry = await liveApiFetch("/order/placeorder", { method: "POST", body: JSON.stringify({
        accountSpec: liveAcct.name, accountId: liveAccountId, action: side, symbol: liveContract.id,
        orderQty: liveQty, orderType: "Market", timeInForce: "Day", isAutomated: true,
      })}) as { orderId: number };

      await new Promise(r => setTimeout(r, 1500));

      // Place stop on live — capture order ID for management
      let liveStopOrderId: number | null = null;
      try {
        const ls = await liveApiFetch("/order/placeorder", { method: "POST", body: JSON.stringify({
          accountSpec: liveAcct.name, accountId: liveAccountId, action: closeSide, symbol: liveContract.id,
          orderQty: liveQty, orderType: "Stop", stopPrice, timeInForce: "GTC", isAutomated: true,
        })}) as { orderId: number };
        liveStopOrderId = ls.orderId;
      } catch (stopErr) {
        log(`[LIVE] Stop order FAILED: ${stopErr}`);
        notify(`LIVE STOP FAILED for ${sym} — position UNPROTECTED!`, "general");
      }

      // Place target on live — capture order ID
      let liveTargetOrderId: number | null = null;
      try {
        const lt = await liveApiFetch("/order/placeorder", { method: "POST", body: JSON.stringify({
          accountSpec: liveAcct.name, accountId: liveAccountId, action: closeSide, symbol: liveContract.id,
          orderQty: liveQty, orderType: "Limit", price: targetPrice, timeInForce: "GTC", isAutomated: true,
        })}) as { orderId: number };
        liveTargetOrderId = lt.orderId;
      } catch {}

      // Track live position for management mirroring
      livePositions.set(sym, {
        symbol: sym, contractId: contract.id, direction, quantity: liveQty,
        entryPrice: price, stopLoss: stopPrice, target: targetPrice,
        trailStop: null, reachedBreakeven: false,
        stopOrderId: liveStopOrderId, targetOrderId: liveTargetOrderId,
        entryTime: Date.now(), scaledOut: false, originalQty: liveQty, pyramided: false,
      });
      await saveLivePositions();

      log(`[LIVE MIRROR] ${sym}: ${direction} ${liveQty}x tracked | stop #${liveStopOrderId} | target #${liveTargetOrderId}`);
      notify(`LIVE: ${side} ${liveQty}x ${sym} @ $${price.toFixed(2)} | Stop: $${stopPrice.toFixed(2)} | Target: $${targetPrice.toFixed(2)}`, "general");

      // Log live trade to DB
      try {
        await prisma.autoTradeLog.create({ data: {
          symbol: `FUT:${sym}`,
          action: `live_${direction}`,
          qty: liveQty,
          price,
          reason: `[LIVE ${sym}] Mirrored from demo. ${reasoning}. Stop: $${stopPrice.toFixed(2)}, Target: $${targetPrice.toFixed(2)}. R:R ${rr.toFixed(1)}. Risk: $${(liveRiskPer * liveQty).toFixed(0)}`,
          aiScore: confidenceScore,
          aiSignal: direction,
          orderId: String(liveEntry.orderId),
        }});
      } catch {}
    } catch (err) {
      log(`[LIVE MIRROR] FAILED: ${err}`);
      notify(`LIVE TRADE FAILED for ${sym}: ${err}`, "general");
    }
    } // end else (not past daily loss limit)
  } else if (isLiveMode) {
    // Live mode active but outside RTH or daily loss hit — log paper trade for learning
    const paperReason = getSessionName() === "halt" ? "market halted"
      : !isLiveRTHWindow() ? `outside RTH (${getSessionName()})`
      : "daily loss limit hit";
    try {
      await prisma.autoTradeLog.create({ data: {
        symbol: `FUT:${sym}`, action: `paper_live_${direction}`,
        qty: 1, price,
        reason: `[PAPER LIVE] Would have ${direction} ${sym} @ $${price.toFixed(2)}. Blocked: ${paperReason}. Stop: $${stopPrice.toFixed(2)}, Target: $${targetPrice.toFixed(2)}. R:R ${rr.toFixed(1)}`,
        aiScore: confidenceScore, aiSignal: direction,
      }});
      log(`[PAPER LIVE] ${direction} ${sym} @ $${price.toFixed(2)} — blocked (${paperReason})`);
    } catch {}
  }
}

// ── Heartbeat (tells dashboard the engine is alive) ─────

async function writeHeartbeat() {
  try {
    const payload = JSON.stringify({
      timestamp: new Date().toISOString(),
      tickCount,
      positions: positions.size,
      livePositions: livePositions.size,
      dailyPnl: Math.round(dailyPnl),
      dailyTrades: dailyTradeCount,
      session: getSessionName(),
      mdHealth: mdCircuitOpen ? "circuit_open" : mdConsecutiveFailures > 0 ? `degraded(${mdConsecutiveFailures})` : "ok",
    });
    await prisma.agentConfig.upsert({
      where: { key: "futures_engine_heartbeat" },
      update: { value: payload },
      create: { key: "futures_engine_heartbeat", value: payload },
    });
    // Also persist position state (trailing stops, breakeven flags) every heartbeat
    if (positions.size > 0) await savePositions();
    if (livePositions.size > 0) await saveLivePositions();
  } catch { /* best-effort */ }
}

// ── Position Sync ───────────────────────────────────────

async function syncPositions() {
  try {
    const tvPos = await apiFetch("/position/list") as { contractId: number; netPos: number; netPrice: number; timestamp: string }[];

    // Step 1: Remove engine positions that no longer exist on Tradovate
    for (const [sym, pos] of [...positions]) {
      if (!tvPos.find(p => p.contractId === pos.contractId && p.netPos !== 0)) {
        // Skip if closePosition is already handling this symbol
        if (closingLocks.get(sym)) {
          log(`SYNC: ${sym} — close already in progress, skipping`);
          continue;
        }
        const mult = CONTRACT_MULTIPLIERS[sym] || 5;

        // Cancel any orphaned working orders for this contract
        try {
          const allOrders = await apiFetch("/order/list") as { id: number; contractId: number; ordStatus: string }[];
          const orphans = allOrders.filter(o => o.contractId === pos.contractId && (o.ordStatus === "Working" || o.ordStatus === "Accepted"));
          for (const o of orphans) { try { await apiFetch("/order/cancelorder", { method: "POST", body: JSON.stringify({ orderId: o.id }) }); } catch {} }
          if (orphans.length > 0) log(`SYNC: Cancelled ${orphans.length} orphaned orders for ${sym}`);
        } catch {}

        // Check if this close was already logged (manual close from UI, or bracket order fill)
        // to avoid double-logging P&L
        let alreadyLogged = false;
        try {
          const recentClose = await prisma.autoTradeLog.findFirst({
            where: {
              symbol: `FUT:${sym}`,
              action: { in: ["futures_manual_close", "futures_take_profit", "futures_stop_loss", "futures_trail_stop", "futures_breakeven", "futures_emergency", "futures_bracket_close"] },
              createdAt: { gte: new Date(Date.now() - 120_000) }, // within last 2 minutes
            },
            orderBy: { createdAt: "desc" },
          });
          if (recentClose) {
            alreadyLogged = true;
            const loggedPnl = recentClose.pnl || 0;
            dailyPnl += loggedPnl;
            log(`SYNC: ${sym} closed externally — already logged as ${recentClose.action} (P&L: $${loggedPnl.toFixed(0)}). Skipping duplicate log.`);
          }
        } catch {}

        if (!alreadyLogged) {
          // Position closed but not logged — get actual exit from Tradovate fills
          let closePrice = 0;
          let closeType = "bracket_close";

          // Query recent fills to find the actual exit price
          try {
            const fills = await apiFetch("/fill/list") as { contractId: number; action: string; price: number; qty: number; timestamp: string }[];
            const closeSide = pos.direction === "long" ? "Sell" : "Buy";
            const recentFills = fills
              .filter(f => f.contractId === pos.contractId && f.action === closeSide)
              .sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());

            if (recentFills.length > 0) {
              closePrice = recentFills[0].price;
              // Determine close type from price proximity
              const stopDist = Math.abs(closePrice - pos.stopLoss);
              const targetDist = Math.abs(closePrice - pos.target);
              closeType = stopDist < targetDist ? "stop_loss" : "take_profit";
              log(`SYNC: Found actual fill for ${sym}: ${closeSide} @ $${closePrice.toFixed(2)}`);
            }
          } catch {}

          // Fallback if no fill found
          if (closePrice === 0) {
            const b = barBuilders.get(sym);
            closePrice = b?.lastPrice || pos.entryPrice;
            const stopDist = Math.abs(closePrice - pos.stopLoss);
            const targetDist = Math.abs(closePrice - pos.target);
            closeType = stopDist < targetDist ? "stop_loss" : "take_profit";
            log(`SYNC: No fill found for ${sym}, using last price $${closePrice.toFixed(2)}`);
          }

          const diff = pos.direction === "long" ? closePrice - pos.entryPrice : pos.entryPrice - closePrice;
          const pnl = diff * mult * pos.quantity;
          dailyPnl += pnl;

          log(`SYNC: ${sym} ${closeType} at exchange | Close: $${closePrice.toFixed(2)} | P&L: $${pnl.toFixed(0)} | Daily: $${dailyPnl.toFixed(0)}`);

          try {
            await prisma.autoTradeLog.create({ data: {
              symbol: `FUT:${sym}`,
              action: `futures_${closeType}`,
              qty: pos.quantity,
              price: closePrice,
              pnl,
              reason: `[FUTURES ${sym}] ${closeType}: Closed ${pos.quantity}x @ $${closePrice.toFixed(2)}. Entry: $${pos.entryPrice.toFixed(2)}. P&L: $${pnl.toFixed(0)}. Daily: $${dailyPnl.toFixed(0)}`,
              orderId: null,
            }});
          } catch {}

          // Log synced close to Obsidian vault (learning loop)
          try {
            await logTradeToJournal({
              tradeId: `${new Date().toISOString().slice(0, 10)}-FRT-${sym}`,
              timestamp: new Date().toISOString(),
              instrument: `FUT:${sym}`,
              direction: pos.direction === "long" ? "LONG" : "SHORT",
              strategy: "futures-scalping",
              setupType: "realtime",
              contracts: pos.quantity,
              entryPrice: pos.entryPrice,
              stopPrice: pos.stopLoss,
              targetPrice: pos.target,
              exitPrice: closePrice,
              pnlDollars: pnl,
              rMultiple: pos.stopLoss ? (closePrice - pos.entryPrice) / Math.abs(pos.entryPrice - pos.stopLoss) * (pos.direction === "long" ? 1 : -1) : undefined,
              conviction: 3,
              exitReason: closeType,
            }, "futures-realtime");
            await logDecision("futures-realtime", "EXIT", `FUT:${sym}`, `${closeType}: P&L $${pnl.toFixed(0)}`, pnl > 0 ? 4 : 2);
          } catch { /* vault optional */ }
        }

        positions.delete(sym);
        await savePositions();
      }
    }

    // Step 2: Adopt Tradovate positions the engine doesn't know about
    for (const tp of tvPos) {
      if (tp.netPos === 0) continue;

      let sym: string | null = null;
      for (const [s, contract] of contracts) {
        if (contract.id === tp.contractId) { sym = s; break; }
      }
      if (!sym || positions.has(sym)) continue;

      // Orphaned position on Tradovate — adopt it with correct entry price from DB
      const direction: "long" | "short" = tp.netPos > 0 ? "long" : "short";
      const qty = Math.abs(tp.netPos);
      const b = barBuilders.get(sym);
      const currentATR = b ? atr(b.bars5m) : 5;

      // Get real entry price + stop/target from trade log
      let entryPrice = tp.netPrice;
      let stopLoss = 0;
      let target = 0;
      try {
        const entryLog = await prisma.autoTradeLog.findFirst({
          where: {
            symbol: `FUT:${sym}`,
            action: direction === "long" ? "futures_long" : "futures_short",
          },
          orderBy: { createdAt: "desc" },
        });
        if (entryLog?.price) {
          entryPrice = entryLog.price;
          log(`[SYNC] Using DB entry price $${entryPrice.toFixed(2)} instead of Tradovate netPrice $${tp.netPrice.toFixed(2)}`);
        }
        if (entryLog?.reason) {
          const stopMatch = entryLog.reason.match(/Stop:\s*\$?([\d,.]+)/);
          const targetMatch = entryLog.reason.match(/Target:\s*\$?([\d,.]+)/);
          if (stopMatch) stopLoss = parseFloat(stopMatch[1].replace(",", ""));
          if (targetMatch) target = parseFloat(targetMatch[1].replace(",", ""));
        }
      } catch {}

      if (!stopLoss) stopLoss = direction === "long" ? entryPrice - currentATR * 1.5 : entryPrice + currentATR * 1.5;
      if (!target) target = direction === "long" ? entryPrice + currentATR * 4 : entryPrice - currentATR * 4;

      // SANITY: Stop must be on correct side of entry
      if (direction === "long" && stopLoss >= entryPrice) {
        const corrected = entryPrice - currentATR * 1.5;
        log(`[SYNC] WARNING: Stop $${stopLoss.toFixed(2)} above entry $${entryPrice.toFixed(2)} for LONG — corrected to $${corrected.toFixed(2)}`);
        stopLoss = corrected;
      }
      if (direction === "short" && stopLoss <= entryPrice) {
        const corrected = entryPrice + currentATR * 1.5;
        log(`[SYNC] WARNING: Stop $${stopLoss.toFixed(2)} below entry $${entryPrice.toFixed(2)} for SHORT — corrected to $${corrected.toFixed(2)}`);
        stopLoss = corrected;
      }

      positions.set(sym, {
        symbol: sym,
        contractId: tp.contractId,
        direction,
        quantity: qty,
        entryPrice,
        stopLoss,
        target,
        trailStop: null,
        reachedBreakeven: false,
        scaledOut: false,
        originalQty: qty,
        consecutiveStops: 0,
        stopOrderId: null,
        targetOrderId: null,
        entryTime: Date.now(),
        pyramided: false,
      });

      log(`[SYNC] Adopted orphaned position: ${sym} ${direction} ${qty}x @ $${entryPrice.toFixed(2)} | Stop: $${stopLoss.toFixed(2)} | Target: $${target.toFixed(2)}`);
      notify(`ADOPTED orphaned ${sym} ${direction} ${qty}x @ $${entryPrice.toFixed(2)} — managing now`);
    }

    // Step 3: Update direction/qty if Tradovate net differs from engine's view
    for (const [sym, pos] of [...positions]) {
      const tvMatch = tvPos.find(p => p.contractId === pos.contractId && p.netPos !== 0);
      if (!tvMatch) continue;

      const tvDirection: "long" | "short" = tvMatch.netPos > 0 ? "long" : "short";
      const tvQty = Math.abs(tvMatch.netPos);

      if (tvDirection !== pos.direction || tvQty !== pos.quantity) {
        log(`[SYNC] Position mismatch ${sym}: engine=${pos.direction} ${pos.quantity}x @ $${pos.entryPrice.toFixed(2)}, Tradovate=${tvDirection} ${tvQty}x @ $${tvMatch.netPrice.toFixed(2)} — updating qty/direction only, keeping original entry`);
        pos.direction = tvDirection;
        pos.quantity = tvQty;
        // DO NOT overwrite entryPrice — Tradovate netPrice is the average of all fills
        // which corrupts P&L calculations after partial fills or scale-outs
      }
    }

    await savePositions();
  } catch (err) { log(`[SYNC] Position sync failed: ${err}`); }
}

// ── Pre-load Historical Bars (so we can trade immediately) ──

async function preloadBarsForSymbol(sym: string): Promise<void> {
  const b = barBuilders.get(sym);
  if (!b) return;
  const contract = contracts.get(sym);

  let bars: Bar[] = [];

  // Primary: Tradovate md/getChart (2 days of 5-min bars ≈ 156 bars)
  if (contract) {
    try {
      const chartDesc = encodeURIComponent(JSON.stringify({
        underlyingType: "MinuteBar", elementSize: 5, elementSizeUnit: "UnderlyingUnits",
      }));
      const timeRange = encodeURIComponent(JSON.stringify({ asMuchAsElements: 200 }));
      const token = await authenticate();
      const mdUrl = getMdUrl();

      let data: { charts?: { bars: { timestamp: string; open: number; high: number; low: number; close: number; upVolume: number; downVolume: number }[] }[] } | null = null;

      // Try dedicated MD server
      try {
        const res = await fetch(
          `${mdUrl}/md/getChart?contractId=${contract.id}&chartDescription=${chartDesc}&timeRange=${timeRange}`,
          { headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(15000) },
        );
        if (res.ok) data = await res.json();
      } catch { /* try main API */ }

      // Fallback: main API
      if (!data?.charts) {
        try {
          data = await apiFetch(
            `/md/getChart?contractId=${contract.id}&chartDescription=${chartDesc}&timeRange=${timeRange}`
          ) as typeof data;
        } catch { /* fall through to Yahoo */ }
      }

      if (data?.charts?.[0]?.bars) {
        bars = data.charts[0].bars
          .filter(b => b.close > 0)
          .map(b => ({
            t: Math.floor(new Date(b.timestamp).getTime() / 1000),
            o: b.open, h: b.high, l: b.low, c: b.close,
            v: (b.upVolume || 0) + (b.downVolume || 0),
          }));
      }
    } catch (err) {
      log(`  ${sym}: Tradovate preload failed: ${err instanceof Error ? err.message : err}`);
    }
  }

  // Fallback: Yahoo Finance
  if (bars.length === 0) {
    try {
      const yahooSym = YAHOO_MAP[sym];
      if (yahooSym) {
        const result = await getYfEngine().chart(yahooSym, {
          period1: new Date(Date.now() - 2 * 24 * 60 * 60 * 1000),
          period2: new Date(),
          interval: "5m",
        });
        if (result?.quotes) {
          bars = result.quotes
            .filter((q: Record<string, number | null>) => q.close != null && q.close > 0)
            .map((q: Record<string, number | Date | null>) => ({
              t: q.date ? Math.floor(new Date(String(q.date)).getTime() / 1000) : 0,
              o: Number(q.open) || 0, h: Number(q.high) || 0, l: Number(q.low) || 0,
              c: Number(q.close) || 0, v: Number(q.volume) || 0,
            }));
          if (bars.length > 0) log(`  ${sym}: Tradovate unavailable, loaded ${bars.length} bars from Yahoo`);
        }
      }
    } catch (err) {
      log(`  ${sym}: Yahoo fallback also failed: ${err instanceof Error ? err.message : err}`);
    }
  }

  if (bars.length === 0) {
    log(`  ${sym}: No historical data available — will build bars from live polls`);
    return;
  }

  // Load into bar builder
  b.bars5m = bars.slice(-200);
  b.lastPrice = bars[bars.length - 1].c;

  const today = new Date();
  const todayStr = today.toISOString().split("T")[0];
  const prevDayBars = bars.filter(bar => new Date(bar.t * 1000).toISOString().split("T")[0] < todayStr);
  const todayBars = bars.filter(bar => new Date(bar.t * 1000).toISOString().split("T")[0] === todayStr);

  if (prevDayBars.length > 0) {
    b.prevDayHigh = Math.max(...prevDayBars.map(x => x.h));
    b.prevDayLow = Math.min(...prevDayBars.map(x => x.l));
    b.prevDayClose = prevDayBars[prevDayBars.length - 1].c;
  }

  b.sessionBars = todayBars;
  b.barCount = todayBars.length;

  if (todayBars.length >= 12) {
    const orBars = todayBars.slice(0, 12);
    b.openingRangeHigh = Math.max(...orBars.map(x => x.h));
    b.openingRangeLow = Math.min(...orBars.map(x => x.l));
  }

  log(`  ${sym}: Loaded ${bars.length} bars | Last: $${b.lastPrice.toFixed(2)} | PDH:$${b.prevDayHigh.toFixed(2)} PDL:$${b.prevDayLow.toFixed(2)} | Today: ${todayBars.length} bars`);
}

async function preloadBars() {
  log("Pre-loading historical bars (Tradovate primary, Yahoo fallback)...");

  // Preload for ALL symbols (both full-size and micro)
  for (const sym of [...FULL_SIZE_SYMBOLS, ...MICRO_SYMBOLS]) {
    await preloadBarsForSymbol(sym);
  }

  log("Pre-load complete — engine ready to trade immediately");
}

// ── VIX Check (adjust risk based on volatility) ──

let tradovateEquity = 50000; // Will be fetched from Tradovate on startup
let startOfDayBalance = 0; // Set at session reset, used for daily loss limit

async function updateTradovateEquity() {
  try {
    const cashBalances = await apiFetch(`/cashBalance/getCashBalanceSnapshot?accountId=${accountId}`) as Record<string, number>;
    if (cashBalances?.totalCashValue) {
      tradovateEquity = cashBalances.totalCashValue;
      updateTradingSymbols();
      log(`[EQUITY] Tradovate account equity: $${tradovateEquity.toLocaleString()}`);
    }
  } catch {
    // Try alternate endpoint
    try {
      const balances = await apiFetch(`/account/item?id=${accountId}`) as Record<string, unknown>;
      // Demo accounts may not expose balance — keep last known value
      log(`[EQUITY] Using cached equity: $${tradovateEquity.toLocaleString()}`);
    } catch {}
  }
}

let currentVIX = 20;
let vix3m = 20;
let vixTermStructure: "contango" | "backwardation" | "flat" = "contango";

async function updateVIX() {
  try {
    const [vixQ, vix3mQ] = await Promise.all([
      getYfEngine().quote("^VIX").catch(() => null),
      getYfEngine().quote("^VIX3M").catch(() => null),
    ]);
    if (vixQ?.regularMarketPrice) currentVIX = vixQ.regularMarketPrice;
    if (vix3mQ?.regularMarketPrice) vix3m = vix3mQ.regularMarketPrice;

    // Term structure: VIX < VIX3M = contango (normal), VIX > VIX3M = backwardation (fear)
    const ratio = currentVIX / (vix3m || currentVIX);
    if (ratio > 1.05) vixTermStructure = "backwardation";
    else if (ratio < 0.95) vixTermStructure = "contango";
    else vixTermStructure = "flat";
  } catch {}
}

function getVIXMultiplier(): { stopMult: number; sizeMult: number; label: string } {
  // Backwardation = market stress, extra caution
  const backwardationPenalty = vixTermStructure === "backwardation" ? 0.7 : 1.0;

  if (currentVIX > 30) return { stopMult: 2.0, sizeMult: 0.5 * backwardationPenalty, label: `VIX ${currentVIX.toFixed(1)} EXTREME (${vixTermStructure}) — half size, wide stops` };
  if (currentVIX > 25) return { stopMult: 1.5, sizeMult: 0.7 * backwardationPenalty, label: `VIX ${currentVIX.toFixed(1)} HIGH (${vixTermStructure}) — reduced size` };
  if (currentVIX < 14) return { stopMult: 0.8, sizeMult: 1.0, label: `VIX ${currentVIX.toFixed(1)} LOW (${vixTermStructure}) — tight stops` };
  return { stopMult: 1.0, sizeMult: 1.0 * backwardationPenalty, label: `VIX ${currentVIX.toFixed(1)} normal (${vixTermStructure})` };
}

// ── Economic Calendar Gate (MACRO AWARENESS) ─────────────
// Fetches upcoming high-impact events and reduces/blocks trading around them.
// CPI, FOMC, jobs reports can move ES 50+ points in seconds.

interface MacroEvent {
  event: string;
  time: string; // ISO or HH:MM
  impact: string;
  sizeMultiplier: number; // 0.0 = no trades, 0.5 = half size
}

let upcomingMacroEvents: MacroEvent[] = [];
let macroSizeMultiplier = 1.0;
let macroBlockReason = "";

async function updateEconomicCalendar() {
  try {
    const FINNHUB_KEY = process.env.FINNHUB_API_KEY;
    if (!FINNHUB_KEY) return;

    const today = new Date();
    const from = today.toISOString().split("T")[0];
    const to = new Date(today.getTime() + 3 * 24 * 60 * 60 * 1000).toISOString().split("T")[0];

    const res = await fetch(`https://finnhub.io/api/v1/calendar/economic?from=${from}&to=${to}&token=${FINNHUB_KEY}`, {
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) return;

    const data = await res.json();
    const events = (data.economicCalendar || [])
      .filter((e: Record<string, string>) => e.country === "US" && (e.impact === "high" || e.impact === "medium"));

    upcomingMacroEvents = events.map((e: Record<string, string>) => {
      const name = (e.event || "").toLowerCase();
      let sizeMult = 1.0;

      // High-impact events — massive moves
      if (name.includes("fomc") || name.includes("federal funds rate")) sizeMult = 0.0; // NO TRADES
      if (name.includes("cpi") || name.includes("consumer price")) sizeMult = 0.0;
      if (name.includes("nonfarm") || name.includes("non-farm") || name.includes("payroll")) sizeMult = 0.0;
      if (name.includes("ppi") || name.includes("producer price")) sizeMult = 0.3;
      if (name.includes("gdp")) sizeMult = 0.3;
      if (name.includes("unemployment") || name.includes("jobless")) sizeMult = 0.5;
      if (name.includes("retail sales")) sizeMult = 0.5;
      if (name.includes("ism") || name.includes("pmi")) sizeMult = 0.5;
      if (name.includes("consumer confidence") || name.includes("sentiment")) sizeMult = 0.7;

      return { event: e.event || "", time: e.time || "", impact: e.impact || "medium", sizeMultiplier: sizeMult };
    }).filter((e: MacroEvent) => e.sizeMultiplier < 1.0);

    log(`[MACRO] Loaded ${upcomingMacroEvents.length} market-moving events (next 3 days)`);
    for (const ev of upcomingMacroEvents.slice(0, 5)) {
      log(`  → ${ev.event} | Impact: ${ev.impact} | Size: ${(ev.sizeMultiplier * 100).toFixed(0)}%`);
    }
  } catch (err) {
    log(`[MACRO] Calendar fetch failed: ${err}`);
  }
}

function getMacroMultiplier(): { multiplier: number; reason: string } {
  const now = new Date();
  const todayStr = now.toISOString().split("T")[0];
  const nowMinutes = now.getUTCHours() * 60 + now.getUTCMinutes();

  let worstMult = 1.0;
  let worstReason = "";

  for (const ev of upcomingMacroEvents) {
    // Parse event time — format varies but usually "HH:MM" or ISO
    let eventMinutes = -1;
    const timeMatch = ev.time.match(/(\d{1,2}):(\d{2})/);
    if (timeMatch) {
      eventMinutes = parseInt(timeMatch[1]) * 60 + parseInt(timeMatch[2]);
    }

    // If event is today, check if we're within the danger window
    if (ev.time.startsWith(todayStr) || eventMinutes >= 0) {
      const minutesBefore = eventMinutes - nowMinutes;

      // 30 minutes BEFORE event: apply full reduction
      // 15 minutes AFTER event: still reduced (whipsaw period)
      if (minutesBefore > -15 && minutesBefore < 30) {
        if (ev.sizeMultiplier < worstMult) {
          worstMult = ev.sizeMultiplier;
          worstReason = `${ev.event} in ${minutesBefore > 0 ? minutesBefore + "m" : Math.abs(minutesBefore) + "m ago"} — size ${(ev.sizeMultiplier * 100).toFixed(0)}%`;
        }
      }
      // 60 minutes before high-impact: reduced
      else if (minutesBefore > 0 && minutesBefore < 60 && ev.sizeMultiplier <= 0.3) {
        const scaledMult = Math.min(0.5, ev.sizeMultiplier + 0.3);
        if (scaledMult < worstMult) {
          worstMult = scaledMult;
          worstReason = `${ev.event} in ${minutesBefore}m — pre-event caution ${(scaledMult * 100).toFixed(0)}%`;
        }
      }
    }
  }

  macroSizeMultiplier = worstMult;
  macroBlockReason = worstReason;
  return { multiplier: worstMult, reason: worstReason };
}

// ── Mega-Cap Earnings Week Filter ─────────────────────────
// When AAPL, MSFT, NVDA, AMZN, GOOG, META, TSLA report earnings,
// NQ/MNQ volatility spikes dramatically. Reduce size.

const MEGA_CAPS = ["AAPL", "MSFT", "NVDA", "AMZN", "GOOGL", "META", "TSLA"];
let earningsWeekSymbols: string[] = [];
let earningsWeekNQPenalty = 1.0;

async function updateEarningsWeekFilter() {
  try {
    const FINNHUB_KEY = process.env.FINNHUB_API_KEY;
    if (!FINNHUB_KEY) return;

    const today = new Date();
    const from = today.toISOString().split("T")[0];
    const to = new Date(today.getTime() + 7 * 24 * 60 * 60 * 1000).toISOString().split("T")[0];

    const res = await fetch(`https://finnhub.io/api/v1/calendar/earnings?from=${from}&to=${to}&token=${FINNHUB_KEY}`, {
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) return;

    const data = await res.json();
    const calendar = data.earningsCalendar || [];
    earningsWeekSymbols = calendar
      .filter((e: Record<string, string>) => MEGA_CAPS.includes(e.symbol))
      .map((e: Record<string, string>) => e.symbol);

    if (earningsWeekSymbols.length >= 3) {
      earningsWeekNQPenalty = 0.5; // 3+ mega-caps reporting = half size NQ
    } else if (earningsWeekSymbols.length >= 1) {
      earningsWeekNQPenalty = 0.7; // 1-2 mega-caps = reduced
    } else {
      earningsWeekNQPenalty = 1.0;
    }

    if (earningsWeekSymbols.length > 0) {
      log(`[EARNINGS] Mega-cap earnings this week: ${earningsWeekSymbols.join(", ")} — NQ size ${(earningsWeekNQPenalty * 100).toFixed(0)}%`);
    }
  } catch (err) {
    log(`[EARNINGS] Filter fetch failed: ${err}`);
  }
}

// ── Cross-Asset Macro Signals ─────────────────────────────

let crossAssetSummary = "";

async function updateCrossAssetSignals() {
  try {
    const symbols = ["^VIX", "UUP", "TLT", "USO", "GLD"];
    const quotes = await Promise.all(
      symbols.map(s => getYfEngine().quote(s).catch(() => null))
    );

    const data: Record<string, { price: number; change: number }> = {};
    for (let i = 0; i < symbols.length; i++) {
      const q = quotes[i];
      if (q?.regularMarketPrice) {
        data[symbols[i]] = {
          price: q.regularMarketPrice,
          change: q.regularMarketChangePercent || 0,
        };
      }
    }

    const vix = data["^VIX"];
    const dollar = data["UUP"];
    const bonds = data["TLT"];
    const oil = data["USO"];
    const gold = data["GLD"];

    const signals: string[] = [];
    if (vix) signals.push(`VIX:${vix.price.toFixed(1)}(${vix.change > 0 ? "+" : ""}${vix.change.toFixed(1)}%)`);
    if (dollar) signals.push(`Dollar:${dollar.change > 0 ? "+" : ""}${dollar.change.toFixed(1)}%`);
    if (bonds) signals.push(`TLT:${bonds.change > 0 ? "+" : ""}${bonds.change.toFixed(1)}%`);
    if (oil) signals.push(`Oil:${oil.change > 0 ? "+" : ""}${oil.change.toFixed(1)}%`);
    if (gold) signals.push(`Gold:${gold.change > 0 ? "+" : ""}${gold.change.toFixed(1)}%`);

    // Determine macro stance
    let riskSignal = "mixed";
    const riskOnCount = [
      vix && vix.change < -3,
      bonds && bonds.change > 0,
      gold && gold.change < 0,
    ].filter(Boolean).length;
    const riskOffCount = [
      vix && vix.change > 3,
      bonds && bonds.change < 0,
      gold && gold.change > 1,
    ].filter(Boolean).length;

    if (riskOnCount >= 2) riskSignal = "risk_on";
    if (riskOffCount >= 2) riskSignal = "risk_off";

    crossAssetSummary = `Macro: ${riskSignal.toUpperCase()} | ${signals.join(" | ")}`;
    log(`[MACRO] ${crossAssetSummary}`);
  } catch (err) {
    log(`[MACRO] Cross-asset fetch failed: ${err}`);
  }
}

// ── Sector Rotation Intelligence (Cross-Pollination) ──────
// Detects which sectors lead/lag. Tech leading = favor MNQ. Financials leading = favor MES.
// Defensive sectors leading (XLU, XLP) = risk-off, reduce all.

let sectorBias: "tech_leads" | "broad_rally" | "defensive" | "mixed" = "mixed";
let sectorContext = "";

async function updateSectorRotation() {
  try {
    const sectors = [
      { sym: "XLK", name: "Tech" },
      { sym: "XLF", name: "Financials" },
      { sym: "XLE", name: "Energy" },
      { sym: "XLV", name: "Healthcare" },
      { sym: "XLI", name: "Industrials" },
      { sym: "XLY", name: "Discretionary" },
      { sym: "XLP", name: "Staples" },
      { sym: "XLU", name: "Utilities" },
    ];

    const quotes = await Promise.all(
      sectors.map(s => getYfEngine().quote(s.sym).catch(() => null))
    );

    const results: { name: string; change: number }[] = [];
    for (let i = 0; i < sectors.length; i++) {
      const q = quotes[i];
      if (q?.regularMarketChangePercent != null) {
        results.push({ name: sectors[i].name, change: q.regularMarketChangePercent });
      }
    }

    if (results.length < 4) return;

    results.sort((a, b) => b.change - a.change);
    const leaders = results.slice(0, 3).map(r => r.name);
    const laggards = results.slice(-3).map(r => r.name);

    // Determine bias
    if (leaders.includes("Tech") && leaders.includes("Discretionary")) {
      sectorBias = "tech_leads";
    } else if (leaders.includes("Utilities") || leaders.includes("Staples")) {
      sectorBias = "defensive";
    } else if (results.filter(r => r.change > 0).length >= 6) {
      sectorBias = "broad_rally";
    } else {
      sectorBias = "mixed";
    }

    sectorContext = `Sectors: ${sectorBias.toUpperCase()} | Leaders: ${leaders.join(",")} | Laggards: ${laggards.join(",")}`;
    log(`[SECTORS] ${sectorContext}`);
  } catch (err) {
    log(`[SECTORS] Update failed: ${err}`);
  }
}

// ── Reliability: Safe interval wrapper ───────────────────

function safeInterval(fn: () => void | Promise<void>, ms: number, label: string): NodeJS.Timeout {
  return setInterval(async () => {
    try {
      await fn();
    } catch (err) {
      log(`[SAFE-INTERVAL] ${label} threw: ${err}`);
    }
  }, ms);
}

// ── Reliability: Watchdog ────────────────────────────────

let lastTickCount = 0;
let lastTickCheckTime = Date.now();
let pollIntervalRef: NodeJS.Timeout | null = null;

function startWatchdog() {
  safeInterval(() => {
    const now = Date.now();
    const elapsed = now - lastTickCheckTime;

    if (tickCount === lastTickCount && elapsed > 60_000) {
      log(`[WATCHDOG] Poll loop stalled — no new ticks in ${Math.round(elapsed / 1000)}s. Restarting poll interval...`);
      if (pollIntervalRef) clearInterval(pollIntervalRef);
      pollIntervalRef = safeInterval(pollPrices, POLL_INTERVAL_MS, "pollPrices");
      // Force an immediate poll
      pollPrices().catch(err => log(`[WATCHDOG] Recovery poll failed: ${err}`));
    }

    if (tickCount !== lastTickCount) {
      lastTickCount = tickCount;
      lastTickCheckTime = now;
    }
  }, 15_000, "watchdog");
}

// ── Reliability: Health check HTTP server ────────────────

function startHealthServer() {
  // Dynamic import to avoid issues if http is somehow unavailable
  const http = require("http");
  const port = parseInt(process.env.PORT || "3001", 10);
  const startTime = Date.now();

  const server = http.createServer((_req: unknown, res: { writeHead: (code: number, headers: Record<string, string>) => void; end: (body: string) => void }) => {
    const now = Date.now();
    const uptimeSeconds = Math.round((now - startTime) / 1000);
    const lastTickAge = tickCount > 0 ? Math.round((now - lastTickCheckTime) / 1000) : -1;
    const healthy = tickCount > 0 && (now - lastTickCheckTime) < 120_000;

    const status = {
      status: healthy ? "healthy" : "degraded",
      uptime: uptimeSeconds,
      tickCount,
      lastTickAgeSec: lastTickAge,
      positions: positions.size,
      dailyPnl: Math.round(dailyPnl),
      dailyTrades: dailyTradeCount,
      session: getSessionName(),
      md: mdCircuitOpen ? "circuit_open" : mdConsecutiveFailures > 0 ? `degraded(${mdConsecutiveFailures})` : "ok",
      tilt: tiltPauseUntil === Infinity ? "session_done" : Date.now() < tiltPauseUntil ? `paused(${consecutiveStops})` : "ok",
      consecutiveStops,
      symbols: SYMBOLS.map(s => {
        const b = barBuilders.get(s);
        return { symbol: s, price: b?.lastPrice || 0, bars: b?.bars5m.length || 0 };
      }),
    };

    res.writeHead(healthy ? 200 : 503, { "Content-Type": "application/json" });
    res.end(JSON.stringify(status));
  });

  server.listen(port, () => {
    log(`Health server listening on port ${port}`);
  });

  server.on("error", (err: Error) => {
    log(`[HEALTH] Server error (non-fatal): ${err.message}`);
  });
}

// ── Reliability: Auth with retries ───────────────────────

async function authenticateWithRetry(): Promise<string> {
  let attempt = 0;
  while (true) {
    attempt++;
    try {
      return await authenticate();
    } catch (err) {
      const errStr = String(err);
      const isRateLimit = errStr.includes("429");
      if (isRateLimit) {
        // Rate limited: wait 5 min and retry FOREVER — never crash, never let Railway restart
        log(`[AUTH] Rate limited (attempt ${attempt}) — waiting 5 min before retry...`);
        await new Promise(r => setTimeout(r, 300_000));
      } else {
        // Other auth error: exponential backoff, give up after 10 attempts
        log(`[AUTH] Attempt ${attempt} failed: ${err}`);
        if (attempt >= 10) throw err;
        const delay = Math.min(5000 * Math.pow(2, attempt - 1), 60_000);
        log(`[AUTH] Retrying in ${Math.round(delay / 1000)}s...`);
        await new Promise(r => setTimeout(r, delay));
      }
    }
  }
}

// ── Reliability: Session bars cap ────────────────────────

const MAX_SESSION_BARS = 500; // ~41 hours of 5-min bars, more than a full session

// ── Main ────────────────────────────────────────────────

async function main() {
  log("╔══════════════════════════════════════════════╗");
  log("║  ESBUENO FUTURES — REAL-TIME TRADING ENGINE  ║");
  log("╚══════════════════════════════════════════════╝");
  log("Mode: DEMO 24/7 + LIVE mirror (RTH) | Data: Tradovate MD + Yahoo fallback | Orders: Tradovate");

  // Validate all required env vars BEFORE doing anything else
  validateEnvironment();

  // Start health server first — Railway can ping us even during init
  startHealthServer();

  await authenticateWithRetry();
  await loadRiskConfig(); // Load risk rules from DB (Agent Hub is the UI)
  await loadTradingMode(); // Check if live mode is enabled (may switch API endpoint)
  await resolveContracts();
  // Init bar builders for ALL symbols (both full-size and micro) so we can switch dynamically
  for (const sym of [...FULL_SIZE_SYMBOLS, ...MICRO_SYMBOLS]) initBarBuilder(sym);

  // Restore positions from database (survive restarts)
  await loadPositions();
  await loadLivePositions();

  // Pre-load historical bars so we can trade IMMEDIATELY
  await preloadBars();

  // Get account equity + VIX + macro intelligence — this also sets SYMBOLS based on equity
  await updateTradovateEquity();
  // Save balance snapshot on startup — ensures we always have today's reference point
  try {
    const today = new Date().toISOString().slice(0, 10);
    // If no SOD snapshot for today, save one now (catches deploys/restarts after 9:29 AM)
    const existing = await prisma.agentConfig.findUnique({ where: { key: `daily_balance_${today}` } });
    if (!existing) {
      await prisma.agentConfig.upsert({
        where: { key: `daily_balance_${today}` },
        update: { value: String(tradovateEquity) },
        create: { key: `daily_balance_${today}`, value: String(tradovateEquity) },
      });
      // Also update the global start_of_day_balance (may be stale from yesterday after a deploy)
      await prisma.agentConfig.upsert({
        where: { key: "start_of_day_balance" },
        update: { value: String(tradovateEquity) },
        create: { key: "start_of_day_balance", value: String(tradovateEquity) },
      });
      log(`[STARTUP] Saved SOD balance snapshot: $${tradovateEquity.toFixed(2)} (${today})`);
    } else {
      // SOD snapshot exists for today — make sure start_of_day_balance matches it (not stale from prior day)
      const sodGlobal = await prisma.agentConfig.findUnique({ where: { key: "start_of_day_balance" } });
      if (!sodGlobal || sodGlobal.value !== existing.value) {
        await prisma.agentConfig.upsert({
          where: { key: "start_of_day_balance" },
          update: { value: existing.value },
          create: { key: "start_of_day_balance", value: existing.value },
        });
        log(`[STARTUP] Synced start_of_day_balance to today's snapshot: $${existing.value}`);
      }
    }
  } catch {}
  await updateVIX();
  log(`VIX: ${currentVIX.toFixed(1)}`);
  await updateEconomicCalendar();
  await updateCrossAssetSignals();
  await updateEarningsWeekFilter();
  await updateSectorRotation();

  // Demo engine runs 24/7. When live mode enabled in DB, trades are ALSO mirrored
  // to the live account during RTH windows. Mode checked every 5 min.

  // Start polling — all wrapped in safe intervals
  pollIntervalRef = safeInterval(pollPrices, POLL_INTERVAL_MS, "pollPrices");
  safeInterval(checkSessionReset, 60_000, "checkSessionReset");
  safeInterval(syncPositions, 30_000, "syncPositions");
  safeInterval(syncLivePositions, 30_000, "syncLivePositions");
  safeInterval(writeHeartbeat, 60_000, "writeHeartbeat");
  safeInterval(updateVIX, 300_000, "updateVIX");
  safeInterval(updateTradovateEquity, 600_000, "updateTradovateEquity"); // every 10min
  safeInterval(loadRiskConfig, 300_000, "loadRiskConfig"); // refresh risk rules from DB every 5min
  safeInterval(loadTradingMode, 300_000, "loadTradingMode"); // check demo/live mode every 5min
  safeInterval(updateEconomicCalendar, 3600_000, "updateEconomicCalendar"); // hourly
  safeInterval(updateCrossAssetSignals, 300_000, "updateCrossAssetSignals"); // every 5min
  safeInterval(updateEarningsWeekFilter, 3600_000, "updateEarningsWeekFilter"); // hourly
  safeInterval(updateSectorRotation, 600_000, "updateSectorRotation"); // every 10min

  // Load vault lessons (anti-patterns, active lessons) on startup + refreshed hourly
  try {
    const [lessons, antiPatterns] = await Promise.all([
      vaultRead("Lessons/active-lessons.md"),
      vaultRead("Rules/anti-patterns.md"),
    ]);
    vaultLessonsCache = { lessons, antiPatterns };
    vaultLessonsCacheTime = Date.now();
    if (lessons || antiPatterns) log("[VAULT] Loaded lessons + anti-patterns from brain");
  } catch { /* vault read optional */ }
  safeInterval(async () => {
    try {
      const [lessons, antiPatterns] = await Promise.all([
        vaultRead("Lessons/active-lessons.md"),
        vaultRead("Rules/anti-patterns.md"),
      ]);
      vaultLessonsCache = { lessons, antiPatterns };
      vaultLessonsCacheTime = Date.now();
      if (lessons || antiPatterns) log("[VAULT] Loaded lessons + anti-patterns from brain");
    } catch { /* vault read optional */ }
  }, 3600_000, "loadVaultLessons");

  // Watchdog: monitors tickCount and restarts poll if stalled
  startWatchdog();

  // Status log every 2 minutes
  safeInterval(() => {
    const session = getSessionName();
    const vix = getVIXMultiplier();
    const mdStatus = mdCircuitOpen ? "CIRCUIT_OPEN" : mdConsecutiveFailures > 0 ? `degraded(${mdConsecutiveFailures})` : "ok";
    const tiltStatus = tiltPauseUntil === Infinity ? "SESSION_DONE" : Date.now() < tiltPauseUntil ? `PAUSED(${consecutiveStops} stops)` : "ok";
    const prices = SYMBOLS.map(s => {
      const b = barBuilders.get(s);
      return `${s}:$${b?.lastPrice?.toFixed(2) || "—"}/${b?.bars5m.length || 0}b`;
    }).join(" ");
    const macroStatus = macroBlockReason || "clear";
    log(`STATUS: ${session.toUpperCase()} | ${vix.label} | ${crossAssetSummary || "No macro"} | Macro:${macroStatus} | Ticks:${tickCount} | Pos:${positions.size}/${riskConfig.maxConcurrentPositions} | P&L:$${dailyPnl.toFixed(0)} | ${dailyTradeCount}/${riskConfig.maxTradesPerDay} | MD:${mdStatus} | Tilt:${tiltStatus} | ${prices}`);
  }, 120_000, "statusLog");

  log("Engine ready — scanning for setups on every 5-min bar close...");

  // First poll immediately
  await pollPrices();
}

// ── Global error handlers (MUST NOT exit) ────────────────

process.on("uncaughtException", (err) => {
  try {
    log(`[FATAL] Uncaught exception (process kept alive): ${err?.message || err}`);
    console.error(err);
  } catch {
    console.error("uncaughtException:", err);
  }
});

process.on("unhandledRejection", (reason) => {
  try {
    log(`[FATAL] Unhandled rejection (process kept alive): ${reason}`);
  } catch {
    console.error("unhandledRejection:", reason);
  }
});

// ── Startup with auto-restart ────────────────────────────

const MAX_RESTART_DELAY = 120_000;

(async function startWithRetry() {
  let restartCount = 0;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    try {
      await main();
      break; // main() sets up intervals and returns — success
    } catch (err) {
      restartCount++;
      const delay = Math.min(5000 * Math.pow(2, restartCount - 1), MAX_RESTART_DELAY);
      log(`[STARTUP] main() failed (attempt ${restartCount}): ${err}`);
      log(`[STARTUP] Retrying in ${Math.round(delay / 1000)}s...`);
      await new Promise(r => setTimeout(r, delay));
    }
  }
})();
