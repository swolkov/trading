#!/usr/bin/env node
// ============ REAL-TIME FUTURES TRADING ENGINE ============
// Persistent process — polls Yahoo Finance every 5s for prices,
// builds bars, detects setups on bar close, executes via Tradovate.
// Deploy on Railway.
//
// WHY YAHOO POLLING (not Tradovate WebSocket):
// Tradovate demo accounts don't provide market data via WebSocket.
// Yahoo Finance gives us ~5s delayed quotes for ES=F, NQ=F, YM=F, RTY=F.
// For demo testing with 5-min bars, this is more than adequate.
// When live account is funded, switch to Tradovate WebSocket for tick data.

// eslint-disable-next-line @typescript-eslint/no-require-imports
const YFEngine = require("yahoo-finance2").default || require("yahoo-finance2");
const yfEngine = new YFEngine({ suppressNotices: ["ripHistorical", "yahooSurvey"] });

import { prisma } from "../lib/db";
import { logTradeToJournal, logDecision, vaultRead } from "../lib/vault";

// ── Config ──────────────────────────────────────────────

const DEMO_API = "https://demo.tradovateapi.com/v1";
const ORDER_API = DEMO_API;
const POLL_INTERVAL_MS = 5000; // Poll Yahoo every 5 seconds
const BAR_INTERVAL_MS = 5 * 60 * 1000; // 5-minute bars

// MES ($5/pt), MNQ ($2/pt) — equity indices
// MGC ($10/pt) — micro gold, diversification + risk-off hedge
const SYMBOLS = ["MES", "MNQ", "MGC"];
const YAHOO_MAP: Record<string, string> = {
  MES: "ES=F", MNQ: "NQ=F", MGC: "GC=F",
};
const CONTRACT_MULTIPLIERS: Record<string, number> = {
  MES: 5, MNQ: 2, MGC: 10, MYM: 0.5, M2K: 5,
};
// Symbols that are metals (different session timing + strategy)
const METALS = new Set(["MGC"]);

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

// ── Yahoo Finance Circuit Breaker ───────────────────────

let yahooConsecutiveFailures = 0;
let yahooCircuitOpen = false;
let yahooCircuitResetAt = 0;
const YAHOO_MAX_FAILURES = 5;
const YAHOO_CIRCUIT_BASE_MS = 30_000;

// ── Contract Resolution ─────────────────────────────────

interface ContractInfo { id: number; name: string; tickSize: number; symbol: string; }
const contracts: Map<string, ContractInfo> = new Map();

async function resolveContracts() {
  for (const sym of SYMBOLS) {
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

async function pollPrices() {
  // Circuit breaker: skip polls while circuit is open
  if (yahooCircuitOpen) {
    if (Date.now() < yahooCircuitResetAt) return;
    yahooCircuitOpen = false;
    log(`[YAHOO] Circuit half-open — attempting recovery poll`);
  }

  try {
    const yahooSymbols = SYMBOLS.map(s => YAHOO_MAP[s]);
    const quotes = await yfEngine.quote(yahooSymbols);
    const arr = Array.isArray(quotes) ? quotes : [quotes];

    let received = 0;
    for (let i = 0; i < SYMBOLS.length; i++) {
      const q = arr[i];
      if (q?.regularMarketPrice) {
        onPrice(SYMBOLS[i], q.regularMarketPrice, q.regularMarketVolume || 0);
        received++;
      }
    }

    if (received > 0 && yahooConsecutiveFailures > 0) {
      log(`[YAHOO] Recovered after ${yahooConsecutiveFailures} failures — ${received} quotes received`);
      yahooConsecutiveFailures = 0;
    }
  } catch (err) {
    yahooConsecutiveFailures++;
    log(`[YAHOO] Poll failed (${yahooConsecutiveFailures}/${YAHOO_MAX_FAILURES}): ${err instanceof Error ? err.message : err}`);

    if (yahooConsecutiveFailures >= YAHOO_MAX_FAILURES) {
      const backoffMultiplier = Math.min(yahooConsecutiveFailures - YAHOO_MAX_FAILURES + 1, 10);
      const cooldownMs = YAHOO_CIRCUIT_BASE_MS * backoffMultiplier;
      yahooCircuitOpen = true;
      yahooCircuitResetAt = Date.now() + cooldownMs;
      log(`[YAHOO] Circuit OPEN — pausing polls for ${Math.round(cooldownMs / 1000)}s (backoff x${backoffMultiplier})`);
      notify(`Yahoo Finance down (${yahooConsecutiveFailures} failures) — market data paused ${Math.round(cooldownMs / 1000)}s`, "general");
    }
  }
}

// ── Session Management ──────────────────────────────────

function getSessionName(): string {
  const now = new Date();
  const utcH = now.getUTCHours() + now.getUTCMinutes() / 60;
  if (utcH >= 21 && utcH < 22) return "halt";
  if (now.getUTCDay() === 6 || (now.getUTCDay() === 0 && utcH < 22)) return "halt";
  if (utcH >= 13.5 && utcH < 14) return "open";
  if (utcH >= 14 && utcH < 16) return "morning";
  if (utcH >= 16 && utcH < 18) return "midday";
  if (utcH >= 18 && utcH < 19.75) return "afternoon";
  if (utcH >= 19.75 && utcH < 20) return "close";
  if (utcH >= 20 && utcH < 21) return "eth_evening";
  if (utcH >= 22 || utcH < 2) return "eth_evening";
  if (utcH >= 2 && utcH < 7) return "eth_asia";
  if (utcH >= 7 && utcH < 13) return "eth_europe";
  return "pre_market";
}

function getMinutesSinceRTHOpen(): number {
  const now = new Date();
  return Math.max(0, (now.getUTCHours() + now.getUTCMinutes() / 60 - 13.5) * 60);
}

function getSizeMultiplier(sym?: string): number {
  const s = getSessionName();

  // Gold has different prime hours: COMEX 8:20 AM - 1:30 PM ET = UTC 12:20 - 17:30
  // London overlap 8-12 ET is best for gold
  if (sym && METALS.has(sym)) {
    const now = new Date();
    const utcH = now.getUTCHours() + now.getUTCMinutes() / 60;
    if (utcH >= 12.33 && utcH < 14) return 1.0;   // COMEX open + London overlap = prime
    if (utcH >= 14 && utcH < 16) return 0.8;       // Mid-COMEX
    if (utcH >= 16 && utcH < 17.5) return 0.6;     // Late COMEX
    if (utcH >= 7 && utcH < 12.33) return 0.7;     // London pre-COMEX
    if (utcH >= 17.5 && utcH < 21) return 0.3;     // After COMEX
    return 0.2; // Overnight — thin
  }

  // Equities session sizing
  if (s === "morning") return 1.0;
  if (s === "afternoon") return 0.8;
  if (s === "midday") return 0;  // lunch doldrums, lowest volume, most losses
  if (s === "eth_europe") return 0.6;
  if (s === "eth_evening") return 0.4;
  if (s === "eth_asia") return 0.3;
  if (s === "close" || s === "halt" || s === "open") return 0;
  return 0.7;
}

function checkSessionReset() {
  const now = new Date();
  if (now.getUTCHours() === 13 && now.getUTCMinutes() >= 29 && now.getUTCMinutes() <= 31) {
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
    // Save start-of-day balance for calendar-day P&L calculation
    (async () => {
      try {
        await prisma.agentConfig.upsert({
          where: { key: "start_of_day_balance" },
          update: { value: String(tradovateEquity) },
          create: { key: "start_of_day_balance", value: String(tradovateEquity) },
        });
        log(`[RESET] Saved start-of-day balance: $${tradovateEquity.toFixed(2)}`);
      } catch {}
    })();
    // Clean slate: cancel any orphaned orders from yesterday
    cancelAllOrders().catch(err => log(`[RESET] Order cleanup failed: ${err}`));
  }

  // EOD forced close: flatten all positions AND cancel all orders at 3:50 PM ET (19:50 UTC)
  if (now.getUTCHours() === 19 && now.getUTCMinutes() >= 49 && now.getUTCMinutes() <= 51) {
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
}

const positions: Map<string, Position> = new Map();
let dailyTradeCount = 0;
let dailyPnl = 0;
const stoppedSymbols: Set<string> = new Set(); // symbols stopped out today — no re-entry
let consecutiveStops = 0; // tilt protection counter
let tiltPauseUntil = 0; // timestamp when tilt pause ends

// Vault lessons cache — refreshed hourly, read before each trade
let vaultLessonsCache: { lessons: string | null; antiPatterns: string | null } | null = null;
let vaultLessonsCacheTime = 0;

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

function checkPositions(sym: string, price: number) {
  const pos = positions.get(sym);
  if (!pos) return;

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
      } catch (err) {
        log(`${sym}: WARNING — failed to move broker stop to breakeven: ${err}`);
      }
    })();
  }

  // 3R: Scale out 33% — lock in meaningful profit, let the rest ride
  if (diff >= stopDist * 3 && !pos.scaledOut && pos.quantity >= 2) {
    const scaleQty = Math.max(1, Math.floor(pos.quantity / 3));
    log(`${sym}: Reached 3R ($${pnlDollars.toFixed(0)}) — scaling out ${scaleQty} of ${pos.quantity} contracts`);
    scaleOutPosition(sym, price, scaleQty);
  }

  // 2.5R+: Activate trailing stop with WIDE trail (2x ATR) — place on broker
  if (diff >= stopDist * 2.5) {
    const currentATRVal = atr(barBuilders.get(sym)?.bars5m || []);
    if (currentATRVal > 0) {
      const atrMult = METALS.has(sym) ? 1.5 : 1.0;
      const trail = pos.direction === "long" ? price - currentATRVal * atrMult * 2.0 : price + currentATRVal * atrMult * 2.0;
      if (!pos.trailStop || (pos.direction === "long" ? trail > pos.trailStop : trail < pos.trailStop)) {
        const isNew = !pos.trailStop;
        if (isNew) log(`${sym}: 2.5R+ ($${pnlDollars.toFixed(0)}) — trailing stop at $${trail.toFixed(2)} (2x ATR)`);
        pos.trailStop = trail;

        // Move broker stop to trail level
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
            if (isNew) log(`${sym}: Broker trailing stop placed at $${trail.toFixed(2)} (order #${s.orderId})`);
          } catch (err) {
            log(`${sym}: WARNING — failed to place broker trail stop: ${err}`);
          }
        })();
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

  // Emergency
  if (diff * mult * pos.quantity < -750) {
    log(`${sym}: EMERGENCY CLOSE $${(diff * mult * pos.quantity).toFixed(0)}`);
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

async function closePosition(sym: string, price: number, reason: string) {
  const pos = positions.get(sym);
  if (!pos) return;
  const mult = CONTRACT_MULTIPLIERS[sym] || 5;

  // Retry up to 3 times — critical for EOD close and emergency exits
  let closeOrderId: number | null = null;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      // Cancel bracket orders
      if (pos.stopOrderId) try { await apiFetch("/order/cancelorder", { method: "POST", body: JSON.stringify({ orderId: pos.stopOrderId }) }); } catch {}
      if (pos.targetOrderId) try { await apiFetch("/order/cancelorder", { method: "POST", body: JSON.stringify({ orderId: pos.targetOrderId }) }); } catch {}

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
  }

  try {
    // Get ACTUAL fill price from Tradovate instead of using bar price estimate
    let actualExitPrice = price;
    if (closeOrderId) {
      try {
        await new Promise(r => setTimeout(r, 1500)); // wait for fill
        const fills = await apiFetch("/fill/list") as { orderId: number; price: number; qty: number; timestamp: string }[];
        const myFills = fills.filter(f => f.orderId === closeOrderId);
        if (myFills.length > 0) {
          // Weighted average fill price if multiple fills
          const totalQty = myFills.reduce((s, f) => s + f.qty, 0);
          actualExitPrice = myFills.reduce((s, f) => s + f.price * f.qty, 0) / totalQty;
          if (Math.abs(actualExitPrice - price) > 0.01) {
            log(`${sym}: Actual fill $${actualExitPrice.toFixed(2)} (bar was $${price.toFixed(2)}, diff: ${(actualExitPrice - price).toFixed(2)})`);
          }
        }
      } catch { /* use bar price as fallback */ }
    }

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
    } catch { /* vault optional */ }

    positions.delete(sym);
    await savePositions();
  } catch (err) { log(`Close failed ${sym}: ${err}`); }
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

REJECT if: fighting 15m trend, no volume confirmation, price in no-man's land (not at a key level), R:R < 2:1${isMetal ? ", or USD strengthening while going long gold" : ", or macro signals strongly oppose direction (risk_off + long, risk_on + short)"}.
ACCEPT if: aligned with higher timeframe, at a key level, with volume, in the right session${isMetal ? ", and USD/macro confirms gold direction" : ", and macro confirms or is neutral"}.

Respond ONLY with JSON: {"agree":true/false,"confidence":75,"reasoning":"one sentence"}`;

    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: "claude-sonnet-4-6",
        max_tokens: 100,
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
    const parsed = JSON.parse(text.trim());
    return { agree: !!parsed.agree, confidence: parsed.confidence || 50, reasoning: parsed.reasoning || "" };
  } catch (err) {
    log(`[AI] Error: ${err instanceof Error ? err.message : err}`);
    // AI unavailable: still allow high-confidence equity trades, but block gold (less tested)
    return { agree: true, confidence: 0, reasoning: "AI unavailable" };
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
  if (sizeMult === 0 || positions.has(sym) || positions.size >= 2 || dailyTradeCount >= 8 || dailyPnl < -2000) return;
  // Tilt protection: pause after 2 consecutive stops
  if (Date.now() < tiltPauseUntil) return;
  // No re-entry on stopped-out symbols
  if (stoppedSymbols.has(sym)) return;

  // CORRELATION GATE: don't hold two equity index positions simultaneously
  // MES and MNQ are 90%+ correlated — holding both is doubling the same bet
  const EQUITY_INDICES = new Set(["MES", "MNQ", "MYM", "M2K"]);
  if (EQUITY_INDICES.has(sym)) {
    const holdingEquityIndex = [...positions.keys()].some(s => EQUITY_INDICES.has(s));
    if (holdingEquityIndex) {
      // Already holding an equity index — only allow MGC (uncorrelated) or same-symbol addition
      return;
    }
  }

  // VAULT LESSONS GATE: check anti-patterns before trading
  // Cache refreshes hourly in the background, check is synchronous
  if (vaultLessonsCache?.antiPatterns) {
    const ap = vaultLessonsCache.antiPatterns.toLowerCase();
    // Check time-of-day anti-patterns from synthesis agent
    if (ap.includes("first_30_min") && ap.includes("0% win rate") && session === "open") {
      log(`${sym}: VAULT BLOCK — anti-pattern: 0% win rate in first 30 min`);
      return;
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
        trend15Aligns: true, // RSI extremes override trend
        rsiExtreme: true,
        priceAboveVWAP: false,
        dayTypeMatch: true,
        sessionQuality,
      });

      log(`  → EXTREME RSI BOUNCE ${dir.toUpperCase()} | RSI:${currentRSI.toFixed(0)} | Confidence: ${score}% | ${reasons.join(", ")}`);

      if (score >= 65) {
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
  const GAP_THRESHOLDS: Record<string, number> = { MES: 10, MNQ: 50, MGC: 15 };
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

  // SETUP 2: Trend Continuation (pullback to EMA9)
  if ((dayType === "trend" || Math.abs(fastEMA - slowEMA) / price > 0.001) &&
      (session === "morning" || session === "afternoon" || session === "eth_europe" || session === "eth_evening")) {
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

      if (score >= 65) {
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

  log(`  EXECUTING: ${direction.toUpperCase()} ${sym} @ $${price.toFixed(2)} | Confidence: ${finalScore}%`);
  await executeTrade(sym, direction as "long" | "short", price, stopDist, targetDist, sizeMult, finalScore,
    `[${finalScore}% confidence] ${reasoning}. AI: ${ai.agree ? "confirms" : "disagrees"} — ${ai.reasoning}`);
}

// ── Trade Execution ─────────────────────────────────────

async function executeTrade(sym: string, direction: "long" | "short", price: number, stopDist: number, targetDist: number, sizeMult: number, confidenceScore: number, reasoning: string) {
  const contract = contracts.get(sym);
  if (!contract) return;

  const mult = CONTRACT_MULTIPLIERS[sym] || 5;
  const equity = tradovateEquity; // Live from Tradovate demo account
  // Sizing: A+ setups get more size to make $100-$1000 per trade
  // 90+ confidence = 1.5% risk, 80+ = 1%, <80 = 0.5%
  // Gold: half size for first week while we validate setups
  const metalPenalty = METALS.has(sym) ? 0.5 : 1.0;
  const riskPct = (confidenceScore >= 90 ? 0.015 : confidenceScore >= 80 ? 0.01 : 0.005) * metalPenalty;
  const maxRisk = equity * riskPct * sizeMult;
  const riskPer = stopDist * mult;
  const qty = Math.max(1, Math.min(2, Math.floor(maxRisk / riskPer))); // HARD CAP: 2 contracts max (was 20 — caused 16-contract emergency exits)
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
}

// ── Heartbeat (tells dashboard the engine is alive) ─────

async function writeHeartbeat() {
  try {
    const payload = JSON.stringify({
      timestamp: new Date().toISOString(),
      tickCount,
      positions: positions.size,
      dailyPnl: Math.round(dailyPnl),
      dailyTrades: dailyTradeCount,
      session: getSessionName(),
      yahooHealth: yahooCircuitOpen ? "circuit_open" : yahooConsecutiveFailures > 0 ? `degraded(${yahooConsecutiveFailures})` : "ok",
    });
    await prisma.agentConfig.upsert({
      where: { key: "futures_engine_heartbeat" },
      update: { value: payload },
      create: { key: "futures_engine_heartbeat", value: payload },
    });
    // Also persist position state (trailing stops, breakeven flags) every heartbeat
    if (positions.size > 0) await savePositions();
  } catch { /* best-effort */ }
}

// ── Position Sync ───────────────────────────────────────

async function syncPositions() {
  try {
    const tvPos = await apiFetch("/position/list") as { contractId: number; netPos: number; netPrice: number; timestamp: string }[];

    // Step 1: Remove engine positions that no longer exist on Tradovate
    for (const [sym, pos] of [...positions]) {
      if (!tvPos.find(p => p.contractId === pos.contractId && p.netPos !== 0)) {
        const mult = CONTRACT_MULTIPLIERS[sym] || 5;

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

async function preloadBars() {
  log("Pre-loading historical bars from Yahoo Finance...");

  for (const sym of SYMBOLS) {
    const yahooSym = YAHOO_MAP[sym];
    const b = barBuilders.get(sym);
    if (!b) continue;

    try {
      // Fetch last 2 days of 5-min bars
      const result = await yfEngine.chart(yahooSym, {
        period1: new Date(Date.now() - 2 * 24 * 60 * 60 * 1000),
        period2: new Date(),
        interval: "5m",
      });

      if (result?.quotes) {
        const bars: Bar[] = result.quotes
          .filter((q: Record<string, number | null>) => q.close != null && q.close > 0)
          .map((q: Record<string, number | Date | null>) => ({
            t: q.date ? Math.floor(new Date(String(q.date)).getTime() / 1000) : 0,
            o: Number(q.open) || 0,
            h: Number(q.high) || 0,
            l: Number(q.low) || 0,
            c: Number(q.close) || 0,
            v: Number(q.volume) || 0,
          }));

        // Load into bar builder (last 200 bars)
        b.bars5m = bars.slice(-200);
        b.lastPrice = bars.length > 0 ? bars[bars.length - 1].c : 0;

        // Calculate prev day levels from the data
        const today = new Date();
        const todayStr = today.toISOString().split("T")[0];
        const prevDayBars = bars.filter(bar => {
          const d = new Date(bar.t * 1000).toISOString().split("T")[0];
          return d < todayStr;
        });
        const todayBars = bars.filter(bar => {
          const d = new Date(bar.t * 1000).toISOString().split("T")[0];
          return d === todayStr;
        });

        if (prevDayBars.length > 0) {
          b.prevDayHigh = Math.max(...prevDayBars.map(x => x.h));
          b.prevDayLow = Math.min(...prevDayBars.map(x => x.l));
          b.prevDayClose = prevDayBars[prevDayBars.length - 1].c;
        }

        // Session bars = today's bars
        b.sessionBars = todayBars;
        b.barCount = todayBars.length;

        // Opening range (Initial Balance) from today's first 12 bars (60 min)
        if (todayBars.length >= 12) {
          const orBars = todayBars.slice(0, 12);
          b.openingRangeHigh = Math.max(...orBars.map(x => x.h));
          b.openingRangeLow = Math.min(...orBars.map(x => x.l));
        }

        log(`  ${sym}: Loaded ${bars.length} bars | Last: $${b.lastPrice.toFixed(2)} | PDH:$${b.prevDayHigh.toFixed(2)} PDL:$${b.prevDayLow.toFixed(2)} | Today: ${todayBars.length} bars`);
      }
    } catch (err) {
      log(`  ${sym}: Failed to pre-load: ${err}`);
    }
  }

  log("Pre-load complete — engine ready to trade immediately");
}

// ── VIX Check (adjust risk based on volatility) ──

let tradovateEquity = 50000; // Will be fetched from Tradovate on startup

async function updateTradovateEquity() {
  try {
    const cashBalances = await apiFetch(`/cashBalance/getCashBalanceSnapshot?accountId=${accountId}`) as Record<string, number>;
    if (cashBalances?.totalCashValue) {
      tradovateEquity = cashBalances.totalCashValue;
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
      yfEngine.quote("^VIX").catch(() => null),
      yfEngine.quote("^VIX3M").catch(() => null),
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
      log(`[EARNINGS] Mega-cap earnings this week: ${earningsWeekSymbols.join(", ")} — MNQ size ${(earningsWeekNQPenalty * 100).toFixed(0)}%`);
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
      symbols.map(s => yfEngine.quote(s).catch(() => null))
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
      sectors.map(s => yfEngine.quote(s.sym).catch(() => null))
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
      yahoo: yahooCircuitOpen ? "circuit_open" : yahooConsecutiveFailures > 0 ? `degraded(${yahooConsecutiveFailures})` : "ok",
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

async function authenticateWithRetry(maxRetries = 5): Promise<string> {
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      return await authenticate();
    } catch (err) {
      log(`[AUTH] Attempt ${attempt}/${maxRetries} failed: ${err}`);
      if (attempt === maxRetries) throw err;
      const delay = Math.min(5000 * Math.pow(2, attempt - 1), 60_000);
      log(`[AUTH] Retrying in ${Math.round(delay / 1000)}s...`);
      await new Promise(r => setTimeout(r, delay));
    }
  }
  throw new Error("Auth retry exhausted"); // unreachable, satisfies TS
}

// ── Reliability: Session bars cap ────────────────────────

const MAX_SESSION_BARS = 500; // ~41 hours of 5-min bars, more than a full session

// ── Main ────────────────────────────────────────────────

async function main() {
  log("╔══════════════════════════════════════════════╗");
  log("║  ESBUENO FUTURES — REAL-TIME TRADING ENGINE  ║");
  log("╚══════════════════════════════════════════════╝");
  log("Mode: DEMO | Data: Yahoo Finance (5s poll) | Orders: Tradovate");

  // Validate all required env vars BEFORE doing anything else
  validateEnvironment();

  // Start health server first — Railway can ping us even during init
  startHealthServer();

  await authenticateWithRetry();
  await resolveContracts();
  for (const sym of SYMBOLS) initBarBuilder(sym);

  // Restore positions from database (survive restarts)
  await loadPositions();

  // Pre-load historical bars so we can trade IMMEDIATELY
  await preloadBars();

  // Get account equity + VIX + macro intelligence
  await updateTradovateEquity();
  await updateVIX();
  log(`VIX: ${currentVIX.toFixed(1)}`);
  await updateEconomicCalendar();
  await updateCrossAssetSignals();
  await updateEarningsWeekFilter();
  await updateSectorRotation();

  // Start polling — all wrapped in safe intervals
  pollIntervalRef = safeInterval(pollPrices, POLL_INTERVAL_MS, "pollPrices");
  safeInterval(checkSessionReset, 60_000, "checkSessionReset");
  safeInterval(syncPositions, 30_000, "syncPositions");
  safeInterval(writeHeartbeat, 60_000, "writeHeartbeat");
  safeInterval(updateVIX, 300_000, "updateVIX");
  safeInterval(updateTradovateEquity, 600_000, "updateTradovateEquity"); // every 10min
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
    const yahooStatus = yahooCircuitOpen ? "CIRCUIT_OPEN" : yahooConsecutiveFailures > 0 ? `degraded(${yahooConsecutiveFailures})` : "ok";
    const tiltStatus = tiltPauseUntil === Infinity ? "SESSION_DONE" : Date.now() < tiltPauseUntil ? `PAUSED(${consecutiveStops} stops)` : "ok";
    const prices = SYMBOLS.map(s => {
      const b = barBuilders.get(s);
      return `${s}:$${b?.lastPrice?.toFixed(2) || "—"}/${b?.bars5m.length || 0}b`;
    }).join(" ");
    const macroStatus = macroBlockReason || "clear";
    log(`STATUS: ${session.toUpperCase()} | ${vix.label} | ${crossAssetSummary || "No macro"} | Macro:${macroStatus} | Ticks:${tickCount} | Pos:${positions.size} | P&L:$${dailyPnl.toFixed(0)} | ${dailyTradeCount}/6 | Yahoo:${yahooStatus} | Tilt:${tiltStatus} | ${prices}`);
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
