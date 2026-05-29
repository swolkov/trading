#!/usr/bin/env node
// ============ REAL-TIME FUTURES TRADING ENGINE ============
// Persistent process — streams real-time prices via Tradovate WebSocket,
// falls back to Yahoo Finance polling if WebSocket unavailable.
// Builds bars, detects setups on bar close, executes via Tradovate.
// Deploy on Railway — two instances: ENGINE_MODE=demo and ENGINE_MODE=live.

import { prisma } from "../lib/db";
import { logTradeToJournal, logDecision, logObservation, vaultRead, vaultWrite, updateJARVIS, appendLiveFeed } from "../lib/vault";
import { getETHour, getETDayOfWeek, getETDateString, isWeekend as isWeekendET, isHalt as isHaltET } from "../lib/session-time";
import { TradovateWebSocket, type QuoteUpdate } from "./tradovate-ws";


// ── Config ──────────────────────────────────────────────

const DEMO_API = "https://demo.tradovateapi.com/v1";
const LIVE_API = "https://live.tradovateapi.com/v1";

// ENGINE_MODE: "demo" or "live" — set per Railway service via env var
// Demo engine: 24/7 learning, full-size, DEMO_API, 5s polling
// Live engine: RTH prime only, micros, LIVE_API
const ENGINE_MODE = (process.env.ENGINE_MODE || "demo") as "demo" | "live";
const IS_DEMO = ENGINE_MODE === "demo";
const IS_LIVE = ENGINE_MODE === "live";
const ORDER_API = IS_LIVE ? LIVE_API : DEMO_API;
const POLL_INTERVAL_MS = 5000; // Yahoo fallback polls every 5s (Yahoo updates every ~15s)

// WebSocket state — when connected, polling pauses
let wsConnected = false;
let tradovateWS: TradovateWebSocket | null = null;
const BAR_INTERVAL_MS = 5 * 60 * 1000; // 5-minute bars

// Mode-keyed DB keys (both engines share DB, don't collide)
const HEARTBEAT_KEY = `futures_engine_heartbeat_${ENGINE_MODE}`;
const POSITIONS_KEY = `futures_positions_${ENGINE_MODE}`;
const TRADE_ACTION_PREFIX = IS_LIVE ? "live" : "futures";
const MODE_TAG = IS_LIVE ? "LIVE" : "DEMO";
const AGENT_NAME = `futures-realtime-${ENGINE_MODE}`;

// DEMO ($50K): Trade full-size ES, NQ, GC for maximum learning
// LIVE ($1K): Micros only MES, MNQ, MYM until equity scales
const FULL_SIZE_SYMBOLS = ["ES", "NQ", "GC"];
const MICRO_SYMBOLS = ["MES", "MNQ", "MYM"];  // MYM = Micro Dow, $0.50/pt, ~$150 margin — fits $1K
// Map full-size to micro equivalents (for market data fallback — micros have same price)
const MICRO_EQUIVALENT: Record<string, string> = { ES: "MES", NQ: "MNQ", GC: "MGC", YM: "MYM" };
const FULL_EQUIVALENT: Record<string, string> = { MES: "ES", MNQ: "NQ", MGC: "GC", MYM: "YM" };
// $25k threshold for live: below this, trade micros. Above, trade full-size.
const FULL_SIZE_EQUITY_THRESHOLD = 25_000;

// Active trading symbols — recalculated when equity updates
let SYMBOLS = FULL_SIZE_SYMBOLS; // default to full-size (demo), downgraded to micros for small live accounts
// PHASE 0 (live): optional symbol whitelist from DB config (live_futures_symbols), e.g. "MES" for day-1.
let symbolWhitelist: string[] | null = null;
// PHASE 0 (live): pyramiding OFF by default on live (1-contract rule); demo may still pyramid for learning.
const ALLOW_PYRAMID = process.env.ALLOW_PYRAMID ? process.env.ALLOW_PYRAMID === "true" : IS_DEMO;

function updateTradingSymbols() {
  const prev = SYMBOLS.join(",");
  // DEMO: Always trade full-size (ES, NQ, GC) — $50K demo account, max learning
  // LIVE: Micros until equity >= $25K, then full-size
  let next = IS_LIVE
    ? (tradovateEquity >= FULL_SIZE_EQUITY_THRESHOLD ? FULL_SIZE_SYMBOLS : MICRO_SYMBOLS)
    : FULL_SIZE_SYMBOLS;
  // PHASE 0: restrict to the whitelist if set (e.g. ["MES"] for live day-1)
  if (symbolWhitelist && symbolWhitelist.length > 0) next = next.filter(s => symbolWhitelist!.includes(s));
  SYMBOLS = next;
  if (prev !== SYMBOLS.join(",")) {
    log(`[SIZING] Equity $${tradovateEquity.toFixed(0)} → trading ${SYMBOLS.join(", ") || "(none)"}${symbolWhitelist ? ` [whitelist: ${symbolWhitelist.join(",")}]` : ""}`);
  }
}

// Yahoo fallback symbol mapping (used only if Tradovate MD fails)
const YAHOO_MAP: Record<string, string> = {
  ES: "ES=F", NQ: "NQ=F", GC: "GC=F", YM: "YM=F",
  MES: "ES=F", MNQ: "NQ=F", MGC: "GC=F", MYM: "YM=F",
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
  // Micros — MYM at $0.50/pt is the lowest-risk micro, ideal for $1K live
  MES: 5, MNQ: 2, MGC: 10, MYM: 0.5, M2K: 5,
};
// Symbols that are metals (different session timing + strategy)
const METALS = new Set(["MGC", "GC"]);

// ── JARVIS Dashboard Update (throttled) ──────────────────
let lastJARVISUpdate = 0;
const JARVIS_THROTTLE_MS = 30_000; // 30s min between updates
async function throttledJARVIS(trigger: string) {
  if (Date.now() - lastJARVISUpdate < JARVIS_THROTTLE_MS) return;
  lastJARVISUpdate = Date.now();
  try { await updateJARVIS(trigger); } catch { /* jarvis optional */ }
}

// Live feed logging (throttled for scans, immediate for trades)
let lastFeedScan = 0;
async function feedLog(type: "scan" | "setup" | "trade" | "exit" | "skip" | "cooldown" | "alert", msg: string) {
  // Scans: max once per 5 min. Everything else: immediate.
  if (type === "scan") {
    if (Date.now() - lastFeedScan < 300_000) return;
    lastFeedScan = Date.now();
  }
  try { await appendLiveFeed(AGENT_NAME, type, msg); } catch { /* feed optional */ }
}

// ── Tradovate Auth (for order execution) ────────────────

let accessToken = "";
let tokenExpires = 0;
let accountId = 0;
let accountName = "";

async function authenticate(): Promise<string> {
  if (accessToken && Date.now() < tokenExpires) return accessToken;

  // Check for shared or bootstrap token in DB (avoids hitting rate-limited auth endpoint)
  if (!accessToken) {
    try {
      // Try shared token first (saved by a previous engine run)
      const shareKey = IS_LIVE ? "tradovate_live_shared_token" : "tradovate_demo_shared_token";
      const shared = await prisma.agentConfig.findUnique({ where: { key: shareKey } });
      if (shared?.value) {
        const { token, expires, accountId: savedAcctId, accountName: savedAcctName } = JSON.parse(shared.value);
        const expMs = new Date(expires).getTime();
        if (token && expMs > Date.now() + 300_000) { // At least 5 min remaining
          log("[AUTH] Using shared token from DB (no auth call needed)");
          accessToken = token;
          tokenExpires = expMs;
          if (savedAcctId) { accountId = savedAcctId; accountName = savedAcctName; }
          return accessToken;
        }
      }
      // Try bootstrap token (manually injected)
      const bootstrapKey = IS_LIVE ? "tradovate_live_bootstrap_token" : "tradovate_bootstrap_token";
      const bootstrap = await prisma.agentConfig.findUnique({ where: { key: bootstrapKey } });
      if (bootstrap?.value) {
        const { token, expires } = JSON.parse(bootstrap.value);
        const expMs = new Date(expires).getTime();
        if (token && expMs > Date.now()) {
          log("[AUTH] Using bootstrap token from DB");
          accessToken = token;
          tokenExpires = expMs;
          await prisma.agentConfig.delete({ where: { key: bootstrapKey } }).catch(() => {});
          const accounts = await apiFetch("/account/list") as { id: number; name: string; active: boolean }[];
          const active = accounts.find((a) => a.active) || accounts[0];
          if (active) { accountId = active.id; accountName = active.name; }
          log(`Authenticated — ${accountName} (#${accountId}) — ${MODE_TAG} (bootstrap)`);
          return accessToken;
        }
      }
    } catch { /* token reuse optional */ }
  }

  const res = await fetch(`${ORDER_API}/auth/accesstokenrequest`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      name: process.env.TRADOVATE_USERNAME || "",
      password: process.env.TRADOVATE_PASSWORD || "",
      appId: process.env.TRADOVATE_APP_ID || "",
      appVersion: process.env.TRADOVATE_APP_VERSION || "1.0",
      deviceId: IS_LIVE ? "esbueno-live-engine" : "esbueno-demo-engine",
      cid: parseInt(process.env.TRADOVATE_CID || "0"),
      sec: process.env.TRADOVATE_SEC || "",
    }),
  });

  if (res.status === 429) {
    // Rate limited — don't hammer, wait for bootstrap token injection from local machine
    log("[AUTH] Rate limited (429) — entering DB-only poll mode. Inject bootstrap token to resume.");
    // Poll DB every 30s for a bootstrap token instead of retrying auth
    for (let i = 0; i < 240; i++) { // Up to 2 hours
      await new Promise(r => setTimeout(r, 30_000));
      try {
        const bootstrapKey = IS_LIVE ? "tradovate_live_bootstrap_token" : "tradovate_bootstrap_token";
        const bootstrap = await prisma.agentConfig.findUnique({ where: { key: bootstrapKey } });
        if (bootstrap?.value) {
          const { token, expires } = JSON.parse(bootstrap.value);
          if (token && new Date(expires).getTime() > Date.now()) {
            log("[AUTH] Found bootstrap token in DB — resuming");
            accessToken = token;
            tokenExpires = new Date(expires).getTime();
            await prisma.agentConfig.delete({ where: { key: bootstrapKey } }).catch(() => {});
            try {
              const accounts = await apiFetch("/account/list") as { id: number; name: string; active: boolean }[];
              const active = accounts.find((a) => a.active) || accounts[0];
              if (active) { accountId = active.id; accountName = active.name; }
            } catch {}
            log(`Authenticated — ${accountName} (#${accountId}) — ${MODE_TAG} (bootstrap after 429)`);
            return accessToken;
          }
        }
        // Also check shared token (another engine may have refreshed it)
        const shareKey = IS_LIVE ? "tradovate_live_shared_token" : "tradovate_demo_shared_token";
        const shared = await prisma.agentConfig.findUnique({ where: { key: shareKey } });
        if (shared?.value) {
          const { token, expires, accountId: aid, accountName: aname } = JSON.parse(shared.value);
          if (token && new Date(expires).getTime() > Date.now() + 300_000) {
            log("[AUTH] Found fresh shared token in DB — resuming");
            accessToken = token;
            tokenExpires = new Date(expires).getTime();
            if (aid) { accountId = aid; accountName = aname; }
            return accessToken;
          }
        }
      } catch {}
      if (i % 4 === 0) log(`[AUTH] Still waiting for bootstrap token... (${i * 30}s elapsed)`);
    }
    throw new Error("Auth failed: rate limited for 2 hours, no bootstrap token found");
  }

  if (!res.ok) throw new Error(`Auth failed (${res.status}): ${await res.text().catch(() => "")}`);

  const data = await res.json();
  accessToken = data.accessToken;
  tokenExpires = Date.now() + 23 * 60 * 60 * 1000;

  const accounts = await apiFetch("/account/list") as { id: number; name: string; active: boolean }[];
  const active = accounts.find((a) => a.active) || accounts[0];
  if (active) { accountId = active.id; accountName = active.name; }

  // Share token via DB so other services (crons, Vercel) can reuse it instead of re-authenticating
  // This prevents the Tradovate auth rate limit that burned us today
  try {
    const shareKey = IS_LIVE ? "tradovate_live_shared_token" : "tradovate_demo_shared_token";
    await prisma.agentConfig.upsert({
      where: { key: shareKey },
      update: { value: JSON.stringify({ token: accessToken, expires: new Date(tokenExpires).toISOString(), accountId, accountName }) },
      create: { key: shareKey, value: JSON.stringify({ token: accessToken, expires: new Date(tokenExpires).toISOString(), accountId, accountName }) },
    });
  } catch { /* sharing is best-effort */ }

  log(`Authenticated — ${accountName} (#${accountId}) — ${MODE_TAG}`);
  return accessToken;
}

// Proactive token refresh — check every 10min, refresh from DB 1h before expiry
async function proactiveTokenRefresh() {
  if (!accessToken || !tokenExpires) return;
  const timeLeft = tokenExpires - Date.now();
  const hoursLeft = timeLeft / 3_600_000;

  // More than 2 hours left — no action needed
  if (hoursLeft > 2) return;

  // Between 1-2 hours left — check DB for a fresh token from the cron
  if (hoursLeft > 0) {
    try {
      const shareKey = IS_LIVE ? "tradovate_live_shared_token" : "tradovate_demo_shared_token";
      const shared = await prisma.agentConfig.findUnique({ where: { key: shareKey } });
      if (shared?.value) {
        const { token, expires, accountId: aid, accountName: aname } = JSON.parse(shared.value);
        const expMs = new Date(expires).getTime();
        // Only use if it's newer than our current token (at least 2h more life)
        if (token && expMs > tokenExpires + 3_600_000) {
          log(`[AUTH] Proactive refresh: found fresher token in DB (${((expMs - Date.now()) / 3_600_000).toFixed(1)}h remaining)`);
          accessToken = token;
          tokenExpires = expMs;
          if (aid) { accountId = aid; accountName = aname; }
          return;
        }
      }
      // Also check bootstrap token
      const bootstrapKey = IS_LIVE ? "tradovate_live_bootstrap_token" : "tradovate_bootstrap_token";
      const bootstrap = await prisma.agentConfig.findUnique({ where: { key: bootstrapKey } });
      if (bootstrap?.value) {
        const { token, expires } = JSON.parse(bootstrap.value);
        if (token && new Date(expires).getTime() > Date.now() + 3_600_000) {
          log("[AUTH] Proactive refresh: using bootstrap token");
          accessToken = token;
          tokenExpires = new Date(expires).getTime();
          await prisma.agentConfig.delete({ where: { key: bootstrapKey } }).catch(() => {});
          return;
        }
      }
    } catch {}
    log(`[AUTH] Token expires in ${hoursLeft.toFixed(1)}h — no fresh token in DB yet. Cron should refresh soon.`);
  }
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
      body: JSON.stringify({ text: `[FUTURES-${MODE_TAG}] ${msg}` }),
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
// Tradovate MD base URLs
const DEMO_MD_URL = "https://md-demo.tradovateapi.com/v1";
const LIVE_MD_URL = "https://md.tradovateapi.com/v1";
function getMdUrl(): string {
  // Each engine uses its own MD server (contract IDs match the auth environment)
  return IS_LIVE ? LIVE_MD_URL : DEMO_MD_URL;
}

// ── Demo Auth + Contracts for MD fallback (live engine only) ──
// Live MD may fail — fall back to demo MD with demo contract IDs (same prices)
let demoMdToken = "";
let demoMdTokenExpires = 0;
const demoContracts: Map<string, ContractInfo> = new Map(); // demo contract IDs for MD fallback

async function authenticateDemoMd(): Promise<string> {
  if (IS_DEMO) return authenticate(); // demo engine: main token IS demo

  if (demoMdToken && Date.now() < demoMdTokenExpires) return demoMdToken;

  try {
    const res = await fetch(`${DEMO_API}/auth/accesstokenrequest`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: process.env.TRADOVATE_USERNAME || "",
        password: process.env.TRADOVATE_PASSWORD || "",
        appId: process.env.TRADOVATE_APP_ID || "",
        appVersion: process.env.TRADOVATE_APP_VERSION || "1.0",
        deviceId: "esbueno-live-md",
        cid: parseInt(process.env.TRADOVATE_CID || "0"),
        sec: process.env.TRADOVATE_SEC || "",
      }),
    });
    if (!res.ok) {
      log(`[MD AUTH] Demo auth for MD failed (${res.status})`);
      return "";
    }
    const data = await res.json();
    demoMdToken = data.accessToken;
    demoMdTokenExpires = Date.now() + 23 * 60 * 60 * 1000;
    log(`[MD AUTH] Authenticated demo token for market data fallback`);
    return demoMdToken;
  } catch (err) {
    log(`[MD AUTH] Failed: ${err}`);
    return "";
  }
}

async function resolveDemoContracts(): Promise<void> {
  if (IS_DEMO) return; // demo engine doesn't need separate demo contracts
  const token = await authenticateDemoMd();
  if (!token) return;
  for (const sym of [...FULL_SIZE_SYMBOLS, ...MICRO_SYMBOLS, "YM"]) {
    try {
      const res = await fetch(`${DEMO_API}/contract/suggest?t=${sym}&l=5`, {
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(10000),
      });
      if (!res.ok) continue;
      const results = await res.json() as { id: number; name: string; tickSize: number; providerTickSize: number }[];
      if (results.length > 0) {
        demoContracts.set(sym, { id: results[0].id, name: results[0].name, tickSize: results[0].providerTickSize || results[0].tickSize, symbol: sym });
        log(`[MD] Demo contract ${sym} → ${results[0].name} (ID: ${results[0].id})`);
      }
    } catch { /* non-critical */ }
  }
}

// ── Contract Resolution ─────────────────────────────────

interface ContractInfo { id: number; name: string; tickSize: number; symbol: string; }
const contracts: Map<string, ContractInfo> = new Map();

async function resolveContracts() {
  // Resolve both full-size and micro contracts so we can switch dynamically
  for (const sym of [...FULL_SIZE_SYMBOLS, ...MICRO_SYMBOLS, "YM"]) {
    try {
      const results = await apiFetch(`/contract/suggest?t=${sym}&l=5`) as { id: number; name: string; tickSize: number; providerTickSize: number }[];
      if (results.length > 0) {
        contracts.set(sym, { id: results[0].id, name: results[0].name, tickSize: results[0].providerTickSize || results[0].tickSize, symbol: sym });
        log(`Resolved ${sym} → ${results[0].name} (ID: ${results[0].id})`);
      }
    } catch (err) { log(`Failed to resolve ${sym}: ${err}`); }
  }
  // Live engine: also resolve demo contracts for MD fallback
  await resolveDemoContracts();
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

// `reliable` = price came from a real-time exchange feed (Databento/Tradovate).
// Yahoo fallback quotes lag 15-60s and flap overnight — they must NOT drive the
// software emergency close (the broker bracket stop is the real, on-exchange protection).
function onPrice(sym: string, price: number, volume: number, reliable = true) {
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
  checkPositions(sym, price, reliable);
}

async function fetchTradovateQuote(sym: string): Promise<{ price: number; volume: number } | null> {
  const contract = contracts.get(sym);
  if (!contract) return null;

  const chartDesc = encodeURIComponent(JSON.stringify({
    underlyingType: "MinuteBar", elementSize: 1, elementSizeUnit: "UnderlyingUnits",
  }));
  const timeRange = encodeURIComponent(JSON.stringify({ asMuchAsElements: 1 }));

  // Helper to parse MD response
  const parseMdResponse = (data: { charts?: { bars: { close: number; upVolume: number; downVolume: number }[] }[] }): { price: number; volume: number } | null => {
    const bars = data?.charts?.[0]?.bars;
    if (bars && bars.length > 0) {
      const bar = bars[bars.length - 1];
      return { price: bar.close, volume: (bar.upVolume || 0) + (bar.downVolume || 0) };
    }
    return null;
  };

  // PRIMARY: Mode's own MD server + token + contract IDs
  const mdUrl = getMdUrl();
  const token = await authenticate();
  try {
    const res = await fetch(
      `${mdUrl}/md/getChart?contractId=${contract.id}&chartDescription=${chartDesc}&timeRange=${timeRange}`,
      { headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(8000) },
    );
    if (res.ok) {
      const result = parseMdResponse(await res.json());
      if (result) return result;
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

  // FALLBACK 1: Mode's main API /md/getChart
  try {
    const data = await apiFetch(
      `/md/getChart?contractId=${contract.id}&chartDescription=${chartDesc}&timeRange=${timeRange}`
    ) as { charts?: { bars: { close: number; upVolume: number; downVolume: number }[] }[] };
    const result = parseMdResponse(data);
    if (result) return result;
  } catch { /* fall through */ }

  // FALLBACK 2 (live only): Demo MD server with demo contract IDs (same prices, free)
  if (IS_LIVE) {
    const demoToken = await authenticateDemoMd();
    const demoContract = demoContracts.get(sym) || demoContracts.get(FULL_EQUIVALENT[sym] || "");
    if (demoToken && demoContract) {
      try {
        const res = await fetch(
          `${DEMO_MD_URL}/md/getChart?contractId=${demoContract.id}&chartDescription=${chartDesc}&timeRange=${timeRange}`,
          { headers: { "Content-Type": "application/json", Authorization: `Bearer ${demoToken}` }, signal: AbortSignal.timeout(8000) },
        );
        if (res.ok) {
          const result = parseMdResponse(await res.json());
          if (result) return result;
        }
      } catch { /* fall through to Yahoo */ }
    }
  }

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

// Phase 4: read the Databento sidecar's real-time L1 from live_quotes. OFF by default (set
// DATABENTO_MD_ENABLED=true per engine to activate). FAIL-SAFE: any error/staleness → empty → existing MD chain.
let dbnMdLogged = 0;
let databentoMdEnabled = false;   // flipped via DB config (no engine restart needed)
let aiVetoEnabled = true;         // AI grader can BLOCK a setup. Live: ALWAYS on (real-money safety). Demo: off if futures_ai_grader="false" (the AI-on/off experiment).
const lastCumVol = new Map<string, number>();   // per-poll traded-volume delta from the sidecar's cumulative count
async function fetchDatabentoQuotes(): Promise<Map<string, { mid: number; vol: number }>> {
  if (!databentoMdEnabled) return new Map();
  try {
    const rows = await prisma.$queryRawUnsafe<{ symbol: string; mid: number; vol: number; ts: bigint | number }[]>(
      "SELECT symbol, mid, vol, ts FROM live_quotes",
    );
    const out = new Map<string, { mid: number; vol: number }>();
    const now = Date.now();
    for (const r of rows) {
      const ts = Number(r.ts), mid = Number(r.mid), cum = Number(r.vol) || 0;
      if (mid > 0 && now - ts < 30_000) {
        const last = lastCumVol.get(r.symbol) ?? cum;
        const delta = cum >= last ? cum - last : cum;   // reset-safe (sidecar restart drops the cumulative count)
        lastCumVol.set(r.symbol, cum);
        out.set(r.symbol, { mid, vol: Math.max(1, delta) });   // FRESH (<30s) quote + REAL traded volume since last poll
      }
    }
    if (out.size !== dbnMdLogged) { log(`[MD] Databento primary: ${out.size} fresh symbols from live_quotes`); dbnMdLogged = out.size; }
    return out;
  } catch {
    return new Map();   // fail-safe: never let an MD-source error halt the engine
  }
}

async function pollPrices() {
  // Skip polling when WebSocket is streaming real-time data
  if (wsConnected) return;

  // Circuit breaker: skip polls while circuit is open
  if (mdCircuitOpen) {
    if (Date.now() < mdCircuitResetAt) return;
    mdCircuitOpen = false;
    log(`[MD] Circuit half-open — attempting recovery poll`);
  }

  try {
    let received = 0;
    // PRIMARY (Phase 4): real-time L1 from the Databento sidecar's live_quotes. Fresh quotes used directly;
    // anything missing/stale falls through to the existing Tradovate→Yahoo chain UNCHANGED (fail-safe).
    const served = new Set<string>();
    const dbn = await fetchDatabentoQuotes();
    for (const sym of SYMBOLS) {
      const q = dbn.get(sym) ?? dbn.get(FULL_EQUIVALENT[sym] || "") ?? dbn.get(MICRO_EQUIVALENT[sym] || "");
      if (q && q.mid > 0) { onPrice(sym, q.mid, q.vol); received++; served.add(sym); }
    }
    const querySymbols = SYMBOLS.filter(s => !served.has(s));

    // Tradovate md/getChart (parallel) — only for symbols Databento didn't serve
    const tradovateResults = await Promise.allSettled(
      querySymbols.map(async (sym) => {
        const quote = await fetchTradovateQuote(sym);
        return quote ? { sym, ...quote } : null;
      })
    );

    const needYahoo: string[] = [];

    for (const r of tradovateResults) {
      if (r.status === "fulfilled" && r.value) {
        onPrice(r.value.sym, r.value.price, r.value.volume);
        received++;
      } else {
        const sym = querySymbols[tradovateResults.indexOf(r)];
        needYahoo.push(sym);
      }
    }

    // Fallback 1: Try micro equivalent via Tradovate (same price, demo has micro data subs)
    const stillNeedYahoo: string[] = [];
    if (needYahoo.length > 0) {
      for (const sym of needYahoo) {
        const microSym = MICRO_EQUIVALENT[sym];
        if (microSym) {
          try {
            const microQuote = await fetchTradovateQuote(microSym);
            if (microQuote) {
              onPrice(sym, microQuote.price, microQuote.volume); // Map micro price to full-size symbol
              received++;
              continue;
            }
          } catch { /* fall through to Yahoo */ }
        }
        stillNeedYahoo.push(sym);
      }
    }

    // Fallback 2: Yahoo for anything still missing
    if (stillNeedYahoo.length > 0) {
      const yahooQuotes = await fetchYahooQuotes();
      for (const sym of stillNeedYahoo) {
        const yq = yahooQuotes.get(sym);
        if (yq) {
          onPrice(sym, yq.price, yq.volume, false); // Yahoo fallback → unreliable: bars OK, but won't trip the emergency cut-out
          received++;
        }
      }
      if (yahooQuotes.size > 0) {
        log(`[MD] Tradovate missed ${stillNeedYahoo.join(",")}, Yahoo fallback served ${yahooQuotes.size}`);
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

  if (s === "halt") return 0; // market closed (5-6 PM daily break)

  // LIVE ENGINE: RTH-only (reverted from 24/7 on 2026-05-27 — overnight initial margin for 1 MES (~$2,657,
  // confirmed real from Tradovate's cashBalance API) EXCEEDS the $1K account → margin deficit / liquidation
  // risk. Day-trade margin (~$50) only applies during RTH, so the $1K can only safely hold positions intraday.
  if (IS_LIVE) {
    if (s === "morning" || s === "afternoon") return 1.0;   // RTH prime — full size
    if (s === "midday") return 0.5;                         // lunch — half size
    return 0;                                               // BLOCK open, close, and all ETH — overnight margin > $1K
  }

  // DEMO ENGINE: trades 24/7 for maximum learning
  if (sym && METALS.has(sym)) {
    const etH = getETHour();
    if (etH >= 8.33 && etH < 13.5) return 1.0;  // COMEX prime
    return 0.5; // Off-COMEX — still trade, smaller size for learning
  }

  // Equities
  if (s === "morning" || s === "afternoon") return 1.0;  // RTH prime
  if (s === "open" || s === "close") return 1.0;  // Open/close — full size (high-edge times)
  if (s === "midday") return 0.75; // Lunch
  return 0.5; // ETH (Asia + Europe overnight) — active 24/7 research, meaningful size
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
        // Save today's start-of-day balance — mode-keyed so demo/live don't collide
        const sodKey = IS_LIVE ? "live_start_of_day_balance" : "start_of_day_balance";
        const dailyBalKey = IS_LIVE ? `live_daily_balance_${today}` : `daily_balance_${today}`;
        await prisma.agentConfig.upsert({
          where: { key: sodKey },
          update: { value: String(tradovateEquity) },
          create: { key: sodKey, value: String(tradovateEquity) },
        });
        await prisma.agentConfig.upsert({
          where: { key: dailyBalKey },
          update: { value: String(tradovateEquity) },
          create: { key: dailyBalKey, value: String(tradovateEquity) },
        });
        // Also save yesterday's end-of-day balance (session reset = end of previous day)
        const yesterday = new Date(now.getTime() - 86400000).toISOString().slice(0, 10);
        const eodKey = IS_LIVE ? `live_eod_balance_${yesterday}` : `eod_balance_${yesterday}`;
        await prisma.agentConfig.upsert({
          where: { key: eodKey },
          update: { value: String(tradovateEquity) },
          create: { key: eodKey, value: String(tradovateEquity) },
        });
        log(`[RESET] Saved ${MODE_TAG} start-of-day balance: $${tradovateEquity.toFixed(2)} (${today}), EOD yesterday (${yesterday})`);

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
                await vaultWrite("Performance/daily-balances.md", updatedDoc, AGENT_NAME);
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
    // Save end-of-day balance snapshot for historical daily P&L
    (async () => {
      try {
        await new Promise(r => setTimeout(r, 3000)); // wait for close fills to settle
        await updateTradovateEquity();
        const today = now.toISOString().slice(0, 10);
        const eodBalKey = IS_LIVE ? `live_eod_balance_${today}` : `eod_balance_${today}`;
        await prisma.agentConfig.upsert({
          where: { key: eodBalKey },
          update: { value: String(tradovateEquity) },
          create: { key: eodBalKey, value: String(tradovateEquity) },
        });
        log(`[EOD] Saved ${MODE_TAG} end-of-day balance: $${tradovateEquity.toFixed(2)} (${today})`);

        // Write EOD to vault + reconciliation check
        try {
          const dailyBalKeyForReconcile = IS_LIVE ? `live_daily_balance_${today}` : `daily_balance_${today}`;
          const sodKey = await prisma.agentConfig.findUnique({ where: { key: dailyBalKeyForReconcile } });
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
              await vaultWrite("Performance/daily-balances.md", updatedDoc, AGENT_NAME);
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
  // Setup context captured at entry — used for pattern memory learning
  entryRsi: number;
  entryVwap: number;
  entryTrend15m: string;
  entryDayType: string;
  entrySession: string;
  // Emergency confirmation — require 2 consecutive ticks past limit before closing
  // Prevents stale Yahoo prices from triggering phantom emergency closes
  emergencyWarningTick: number;
}

const positions: Map<string, Position> = new Map();
// Per-symbol lock to prevent concurrent async stop modifications
const stopMoveLocks = new Map<string, boolean>();

let dailyTradeCount = 0;
let dailyPnl = 0;
const stoppedSymbols: Set<string> = new Set(); // symbols stopped out today — no re-entry
let consecutiveStops = 0; // tilt protection counter
let tiltPauseUntil = 0; // timestamp when tilt pause ends

// Vault lessons cache — refreshed hourly, read before each trade
let vaultLessonsCache: { lessons: string | null; antiPatterns: string | null } | null = null;
let vaultLessonsCacheTime = 0;

// Regime cache — refreshed hourly from vault Brain/market-regime.md
let cachedRegime: "bull" | "bear" | "choppy" = "choppy";
let regimeCacheTime = 0;
async function getCurrentRegime(): Promise<"bull" | "bear" | "choppy"> {
  if (Date.now() - regimeCacheTime < 3600_000 && regimeCacheTime > 0) return cachedRegime;
  try {
    const doc = await vaultRead("Brain/market-regime.md");
    if (doc) {
      const m = doc.match(/\*\*Current\*\*:\s*`?(\w+)`?/);
      if (m) {
        const r = m[1].toUpperCase();
        cachedRegime = r.includes("BULL") || r.includes("TREND") ? "bull"
          : r.includes("BEAR") ? "bear" : "choppy";
      }
    }
    regimeCacheTime = Date.now();
  } catch { /* use cached */ }
  return cachedRegime;
}

// Re-entry cooldown — after stop-out, block same symbol+direction for 3 bars (15 min)
const reEntryCooldowns = new Map<string, number>(); // "SYM:long" → timestamp when cooldown expires

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

// Demo defaults — use actual $50K equity, trade aggressively for max learning
// PROFESSIONAL RISK RULES (2026-05-25). Evidence: 3yr/12k-trade backtest shows >1% risk/trade
// DESTROYS thin edges via sequence risk (gold edge: +4% over 3yr at 1%, but NEGATIVE at 2-3%).
// 1% is the ceiling pros use. Even for a strong edge, more risk = bigger drawdowns + ruin risk.
// Demo runs the SAME professional sizing so its track record is realistic + fundable (not a casino).
const DEMO_DEFAULTS: RiskConfig = {
  maxContractsPerTrade: 10,      // ceiling; real size is set by 1% risk ÷ stop distance
  maxTotalContracts: 8,
  maxTradesPerDay: 20,           // high volume so the brain learns from many trades
  riskPerTradePct: 1,            // 1% of $50K = $500/trade — professional, realistic track record
  dailyLossLimitPct: 3,          // ~3 full losers → stop for the day
  maxDrawdownPct: 15,            // 15% drawdown → kill switch (edge may be broken)
  maxConcurrentPositions: 3,     // limit correlated heat (ES/NQ/GC move together)
  atrStopMultiplier: 1.5,
  atrTargetMultiplier: 4.0,
  simulatedEquity: 0,            // Use actual $50K demo equity (not simulated)
};

// Live defaults — $1K REAL money. At 1% ($10) NO micro fits (smallest stop ~$55+) → live correctly
// STOPS trading: $1K is too small to trade futures at professional risk. That halt IS the right
// outcome (live has no proven edge). Trade live only once funded to ~$10k+. Tunable via live_futures_* keys.
const LIVE_DEFAULTS: RiskConfig = {
  maxContractsPerTrade: 3,
  maxTotalContracts: 4,
  maxTradesPerDay: 6,
  riskPerTradePct: 1,            // 1% (~$10 on $1K) — pro standard; no micro fits → live pauses (correct)
  dailyLossLimitPct: 3,          // 3% daily loss → full stop
  maxDrawdownPct: 15,            // 15% drawdown → kill switch
  maxConcurrentPositions: 2,     // tight on a small real account
  atrStopMultiplier: 1.5,
  atrTargetMultiplier: 4.0,
  simulatedEquity: 0,            // Use actual live equity
};

let riskConfig: RiskConfig = IS_LIVE ? LIVE_DEFAULTS : DEMO_DEFAULTS;

async function loadRiskConfig() {
  const defaults = IS_LIVE ? LIVE_DEFAULTS : DEMO_DEFAULTS;
  // Live reads from live_futures_* keys, demo reads from futures_* keys
  const kp = IS_LIVE ? "live_futures" : "futures";
  try {
    const keys = [
      `${kp}_max_contracts`, `${kp}_max_total_contracts`, `${kp}_max_trades_per_day`,
      `${kp}_risk_per_trade_pct`, `${kp}_daily_loss_limit_pct`, `${kp}_max_drawdown_pct`,
      `${kp}_atr_stop_multiplier`, `${kp}_atr_target_multiplier`, `${kp}_max_positions`, "max_positions",
      `${kp}_simulated_equity`, `${kp}_symbols`, `${kp}_databento_md`, `${kp}_ai_grader`,
    ];
    const configs = await prisma.agentConfig.findMany({ where: { key: { in: keys } } });
    const cfg: Record<string, string> = {};
    for (const c of configs) cfg[c.key] = c.value;

    const dbTradesPerDay = parseInt(cfg[`${kp}_max_trades_per_day`]) || defaults.maxTradesPerDay;
    const dbDailyLossPct = parseFloat(cfg[`${kp}_daily_loss_limit_pct`]) || defaults.dailyLossLimitPct;

    riskConfig = {
      maxContractsPerTrade: parseInt(cfg[`${kp}_max_contracts`]) || defaults.maxContractsPerTrade,
      maxTotalContracts: parseInt(cfg[`${kp}_max_total_contracts`]) || defaults.maxTotalContracts,
      // Demo mode: never tighter than demo defaults — learn faster, don't stop early
      maxTradesPerDay: IS_DEMO ? Math.max(dbTradesPerDay, DEMO_DEFAULTS.maxTradesPerDay) : dbTradesPerDay,
      riskPerTradePct: parseFloat(cfg[`${kp}_risk_per_trade_pct`]) || defaults.riskPerTradePct,
      dailyLossLimitPct: IS_DEMO ? Math.max(dbDailyLossPct, DEMO_DEFAULTS.dailyLossLimitPct) : dbDailyLossPct,
      maxDrawdownPct: parseFloat(cfg[`${kp}_max_drawdown_pct`]) || defaults.maxDrawdownPct,
      // Live is ISOLATED to its mode-keyed limit (no leak from the shared max_positions / stocks setting);
      // demo keeps the legacy shared key for backward-compat.
      maxConcurrentPositions: parseInt(cfg[`${kp}_max_positions`]) || (IS_DEMO ? parseInt(cfg.max_positions) : 0) || defaults.maxConcurrentPositions,
      atrStopMultiplier: parseFloat(cfg[`${kp}_atr_stop_multiplier`]) || defaults.atrStopMultiplier,
      atrTargetMultiplier: parseFloat(cfg[`${kp}_atr_target_multiplier`]) || defaults.atrTargetMultiplier,
      simulatedEquity: parseFloat(cfg[`${kp}_simulated_equity`]) || defaults.simulatedEquity,
    };
    // PHASE 0: optional symbol whitelist (e.g. live_futures_symbols="MES"). Empty/unset = default behavior.
    const symbolsCfg = cfg[`${kp}_symbols`];
    symbolWhitelist = symbolsCfg && symbolsCfg.trim() ? symbolsCfg.split(",").map(s => s.trim()).filter(Boolean) : null;
    databentoMdEnabled = cfg[`${kp}_databento_md`] === "true";   // flip Databento MD on/off without a restart
    // 2026-05-29: Spencer explicit override — AI grader now config-toggleable on LIVE too.
    // Set live_futures_ai_grader="false" in DB to disable; default true preserves the original
    // real-money safety. Demo uses futures_ai_grader.
    aiVetoEnabled = cfg[`${kp}_ai_grader`] !== "false";
    updateTradingSymbols();
    log(`[CONFIG] Loaded risk config from DB: ${JSON.stringify(riskConfig)}${symbolWhitelist ? ` | symbols=${symbolWhitelist.join(",")}` : ""}`);
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
      where: { key: POSITIONS_KEY },
      update: { value: JSON.stringify(data) },
      create: { key: POSITIONS_KEY, value: JSON.stringify(data) },
    });
  } catch (err) { log(`[PERSIST] Failed to save positions: ${err}`); }
}

async function loadPositions() {
  try {
    // Try loading from database first (mode-keyed, with fallback to old key for migration)
    let saved = await prisma.agentConfig.findUnique({
      where: { key: POSITIONS_KEY },
    });
    // Migration: if new key empty, check old key (one-time after deploy)
    if (!saved?.value && IS_DEMO) {
      const legacy = await prisma.agentConfig.findUnique({ where: { key: "futures_positions" } });
      if (legacy?.value && legacy.value !== "{}") {
        log(`[PERSIST] Migrating positions from legacy key to ${POSITIONS_KEY}`);
        saved = legacy;
      }
    }

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
        entryRsi: 50, entryVwap: 0, entryTrend15m: "flat", entryDayType: "unknown", entrySession: getSessionName(),
        emergencyWarningTick: 0,
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

function checkPositions(sym: string, price: number, reliable = true) {
  const pos = positions.get(sym);
  if (!pos) return;

  // FEED GATE: when the price is from the Yahoo fallback (real-time feed down, e.g. right after a
  // deploy restart), pause ALL software position-management. Yahoo quotes lag 15-60s and flap
  // overnight — acting on them caused a phantom emergency close (a +$1,700 winner round-tripped to
  // a -$900 cut on noisy quotes). The broker's on-exchange bracket (stop + target, placed at entry)
  // is the real protection and fires on true exchange prices regardless. Management resumes the
  // instant real-time data returns. Bars/setup-detection already updated upstream in onPrice().
  if (!reliable) {
    if (pos.emergencyWarningTick) pos.emergencyWarningTick = 0; // drop any stale warning
    return;
  }

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

  // TIME-BASED EXIT: Close stale trades that haven't moved 1R in 30 minutes
  // Saves $40-80 per dead trade instead of waiting for full stop loss
  const STALE_TRADE_MINUTES = 30;
  const minutesInTrade = (Date.now() - pos.entryTime) / 60_000;
  if (minutesInTrade >= STALE_TRADE_MINUTES && diff < stopDist && !pos.reachedBreakeven && !pos.scaledOut) {
    log(`${sym}: TIME EXIT — ${minutesInTrade.toFixed(0)} min, hasn't reached 1R ($${pnlDollars.toFixed(0)}). Closing to preserve capital.`);
    closePosition(sym, price, "time_exit");
    return;
  }

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
  if (ALLOW_PYRAMID && pos.reachedBreakeven && diff >= stopDist * 1.2 && diff < stopDist * 2 && !pos.pyramided) {
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
          // Update average entry price: weighted average of existing + new contracts
          const oldQty = pos.quantity;
          const oldEntry = pos.entryPrice;
          pos.quantity += addQty;
          pos.entryPrice = (oldEntry * oldQty + price * addQty) / pos.quantity;
          pos.pyramided = true;
          // Update broker stop to cover full new quantity at breakeven (use NEW average entry)
          if (pos.stopOrderId) try { await apiFetch("/order/cancelorder", { method: "POST", body: JSON.stringify({ orderId: pos.stopOrderId }) }); } catch {}
          const closeSide = pos.direction === "long" ? "Sell" : "Buy";
          const s = await apiFetch("/order/placeorder", { method: "POST", body: JSON.stringify({
            accountSpec: acct.name, accountId, action: closeSide, symbol: pos.contractId,
            orderQty: pos.quantity, orderType: "Stop", stopPrice: pos.entryPrice, timeInForce: "GTC", isAutomated: true,
          })}) as { orderId: number };
          pos.stopOrderId = s.orderId;
          log(`${sym}: Pyramid filled — ${oldQty}x@$${oldEntry.toFixed(2)} + ${addQty}x@$${price.toFixed(2)} = ${pos.quantity}x avg $${pos.entryPrice.toFixed(2)}`);
          notify(`PYRAMID ${sym}: +${addQty}x @ $${price.toFixed(2)}. Now ${pos.quantity}x avg $${pos.entryPrice.toFixed(2)}.`);

          // Log pyramid entry to DB so orders page shows it
          try {
            await prisma.autoTradeLog.create({ data: {
              symbol: `FUT:${sym}`,
              action: `${TRADE_ACTION_PREFIX}_pyramid`,
              qty: addQty,
              price,
              reason: `[${MODE_TAG} ${sym}] Pyramid +${addQty}x @ $${price.toFixed(2)}. Now ${pos.quantity}x avg $${pos.entryPrice.toFixed(2)}. Original: ${oldQty}x @ $${oldEntry.toFixed(2)}`,
            }});
          } catch {}

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

  // Sanity: if quantity is zero or negative the position was already fully closed by a concurrent
  // exit (scale-out + breakeven both firing in the same second). Delete and bail.
  if (pos.quantity <= 0) {
    log(`${sym}: checkPositions found qty=${pos.quantity} — stale position object, purging`);
    positions.delete(sym);
    recentlyClosedAt.set(sym, Date.now());
    return;
  }

  // Per-position emergency: cap single-position loss at 10% of equity or $750, whichever is lower
  // IMPORTANT: Require 2 consecutive ticks (10s) past the limit before closing.
  // Yahoo prices lag 15-60s and can show phantom losses that don't exist on the exchange.
  // The broker bracket stop order handles the REAL stop — this is a last-resort safety net.
  const perPositionLimit = Math.min(750, tradovateEquity * 0.10);
  if (pnlDollars < -perPositionLimit) {
    if (!pos.emergencyWarningTick) {
      pos.emergencyWarningTick = Date.now();
      log(`${sym}: WARNING — Yahoo shows $${pnlDollars.toFixed(0)} past limit $${perPositionLimit.toFixed(0)}. Confirming on next tick (Yahoo can lag)...`);
      return; // Wait for confirmation on next tick
    }
    // Confirmed: still past limit after at least one more tick
    const confirmAge = Date.now() - pos.emergencyWarningTick;
    if (confirmAge < 8_000) return; // Need at least 8s of confirmation (Yahoo updates every ~15s so this ensures a fresh quote)
    log(`${sym}: EMERGENCY CLOSE CONFIRMED — $${pnlDollars.toFixed(0)} past limit $${perPositionLimit.toFixed(0)} for ${(confirmAge / 1000).toFixed(0)}s`);
    closePosition(sym, price, "emergency"); return;
  } else {
    // Price recovered — clear warning
    if (pos.emergencyWarningTick) {
      log(`${sym}: Emergency warning cleared — Yahoo P&L $${pnlDollars.toFixed(0)} back within limit`);
      pos.emergencyWarningTick = 0;
    }
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
        action: `${TRADE_ACTION_PREFIX}_scale_out`,
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
        tradeId: `${new Date().toISOString().slice(0, 10)}-FRT-${MODE_TAG}-${sym}-SCALE`,
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
      }, AGENT_NAME);
      await logDecision(AGENT_NAME, "EXIT", `FUT:${sym}`, `Scale out ${scaleQty}x @ $${price.toFixed(2)}: P&L $${actualPnl.toFixed(0)}. ${pos.quantity}x remaining.`, actualPnl > 0 ? 4 : 2);
    } catch { /* vault optional */ }

    await savePositions();
  } catch (err) { log(`Scale out failed ${sym}: ${err}`); }
}

// ── Deferred P&L: Get REAL fill price from Tradovate, update DB + patterns ──
// Runs 15s after close (fills need time to appear). Retries once at 60s.
// This is the ONLY place that writes real P&L to the database.

interface CloseMeta {
  dbLogId: number | null;
  sym: string;
  direction: "long" | "short";
  entryPrice: number;
  stopLoss: number;
  target: number;
  quantity: number;
  contractId: number;
  closeOrderId: number | null;
  reason: string;
  mult: number;
  estimatedPnl: number;
  entrySession: string;
  entryRsi: number;
  entryVwap: number;
  entryTrend15m: string;
  entryDayType: string;
}

async function deferredPnlCheck(meta: CloseMeta, attempt: number) {
  try {
    const closeSide = meta.direction === "long" ? "Sell" : "Buy";
    const fills = await apiFetch("/fill/list") as { id: number; orderId: number; contractId: number; action: string; price: number; qty: number; timestamp: string }[];

    // Match fills: by orderId (exact) or by contractId + side + recency (fuzzy)
    const myFills = meta.closeOrderId
      ? fills.filter(f => f.orderId === meta.closeOrderId)
      : fills
          .filter(f => f.contractId === meta.contractId && f.action === closeSide)
          .filter(f => Date.now() - new Date(f.timestamp).getTime() < 300_000) // within 5 min
          .sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime())
          .slice(0, meta.quantity);

    if (myFills.length === 0) {
      if (attempt < 2) {
        log(`[DEFERRED] ${meta.sym}: No fills yet (attempt ${attempt}). Retrying in 60s...`);
        setTimeout(() => deferredPnlCheck(meta, attempt + 1), 60_000);
      } else {
        log(`[DEFERRED] ${meta.sym}: No fills after ${attempt} attempts. Reconciliation cron will catch this.`);
      }
      return;
    }

    // Calculate real P&L from actual fill price
    const totalQty = myFills.reduce((s, f) => s + f.qty, 0);
    const fillPrice = myFills.reduce((s, f) => s + f.price * f.qty, 0) / totalQty;
    const diff = meta.direction === "long" ? fillPrice - meta.entryPrice : meta.entryPrice - fillPrice;
    const realPnl = diff * meta.mult * meta.quantity;
    const stopDist = Math.abs(meta.entryPrice - meta.stopLoss);
    const pnlR = stopDist > 0 ? diff / stopDist : 0;

    log(`[DEFERRED] ${meta.sym}: Fill price $${fillPrice.toFixed(2)} | Real P&L: $${realPnl.toFixed(2)} | R: ${pnlR.toFixed(1)} (was est $${meta.estimatedPnl.toFixed(0)})`);

    // Correct dailyPnl: remove Yahoo estimate, add real fill P&L
    const pnlDelta = realPnl - meta.estimatedPnl;
    if (Math.abs(pnlDelta) > 0.01) {
      dailyPnl += pnlDelta;
      log(`[DEFERRED] ${meta.sym}: Daily P&L corrected by $${pnlDelta.toFixed(0)} → $${dailyPnl.toFixed(0)}`);
    }

    // UPDATE the DB entry with real P&L
    if (meta.dbLogId) {
      try {
        await prisma.autoTradeLog.update({
          where: { id: meta.dbLogId },
          data: {
            pnl: realPnl,
            fillPrice,
            reconciledAt: new Date(),
            reason: `[FUTURES ${meta.sym}] ${meta.reason}: Closed ${meta.quantity}x @ $${fillPrice.toFixed(2)} (fill). Entry: $${meta.entryPrice.toFixed(2)}. P&L: $${realPnl.toFixed(2)}`,
          },
        });
        log(`[DEFERRED] ${meta.sym}: DB log #${meta.dbLogId} updated with fill P&L $${realPnl.toFixed(2)}`);
      } catch (err) { log(`[DEFERRED] DB update failed: ${err}`); }
    }

    // Correct dailyPnl estimate with real value
    const estimatedPnl = (meta.direction === "long" ? -1 : 1) * 0; // we already added estimate, adjust delta
    // Note: dailyPnl was set from Yahoo estimate. We can't perfectly fix it here since
    // other trades may have happened. The reconciliation cron handles aggregate accuracy.

    // Store pattern memory with REAL P&L (not Yahoo estimate)
    try {
      const { storePattern } = await import("../lib/pattern-memory");
      await storePattern({
        regime: cachedRegime,
        session: meta.entrySession,
        instrument: meta.sym,
        setupType: meta.reason,
        direction: meta.direction,
        rsi: meta.entryRsi,
        vixLevel: currentVIX,
        vixTrend: currentVIX > 20 ? "rising" as const : "falling" as const,
        atr: stopDist / meta.entryPrice * 1000,
        priceVsVwap: meta.entryVwap > 0 ? (meta.entryPrice - meta.entryVwap) / meta.entryVwap * 100 : 0,
        trend15m: (meta.entryTrend15m || "flat") as "up" | "down" | "flat",
        trendDaily: (meta.entryDayType || "").includes("trend") ? (meta.direction === "long" ? "up" as const : "down" as const) : "flat" as const,
        riskReward: stopDist > 0 ? Math.abs(meta.target - meta.entryPrice) / stopDist : 2,
        dollarTrend: "flat" as const,
        bondTrend: "flat" as const,
        outcome: realPnl > 0 ? "win" : "loss",
        pnlR,
      });
      log(`[DEFERRED] ${meta.sym}: Pattern stored — ${realPnl > 0 ? "WIN" : "LOSS"} ${pnlR.toFixed(1)}R`);
    } catch { /* pattern storage optional */ }

    // Log to vault journal with real fill price
    try {
      await logTradeToJournal({
        tradeId: `${new Date().toISOString().slice(0, 10)}-FRT-${MODE_TAG}-${meta.sym}`,
        timestamp: new Date().toISOString(),
        instrument: `FUT:${meta.sym}`,
        direction: meta.direction === "long" ? "LONG" : "SHORT",
        strategy: "futures-scalping",
        setupType: "realtime",
        contracts: meta.quantity,
        entryPrice: meta.entryPrice,
        stopPrice: meta.stopLoss,
        targetPrice: meta.target,
        exitPrice: fillPrice,
        pnlDollars: realPnl,
        rMultiple: pnlR,
        conviction: 3,
        exitReason: meta.reason,
      }, AGENT_NAME);
      await logDecision(AGENT_NAME, "EXIT", `FUT:${meta.sym}`,
        `${meta.reason}: P&L $${realPnl.toFixed(2)} (${pnlR.toFixed(1)}R) @ $${fillPrice.toFixed(2)} (fill)`,
        realPnl > 0 ? 4 : 2);
    } catch { /* vault optional */ }

    // JARVIS: update dashboard after trade close (throttled)
    throttledJARVIS(`trade-exit-${meta.sym}`);

  } catch (err) {
    log(`[DEFERRED] ${meta.sym}: Error: ${err}`);
    if (attempt < 2) {
      setTimeout(() => deferredPnlCheck(meta, attempt + 1), 60_000);
    }
  }
}

// Lock to prevent concurrent close attempts on the same symbol
const closingLocks = new Map<string, boolean>();

// Track recently closed symbols so syncPositions doesn't re-adopt settlement-lag residuals.
// Root cause of the phantom -$24k emergency: scale-out stop + breakeven close both fired as BUY
// orders within the same second, creating a net-LONG residual on Tradovate's paper account.
// syncPositions saw that LONG and adopted it, then the emergency misfired on it with wrong direction.
const recentlyClosedAt = new Map<string, number>(); // sym → epoch ms of last close
const RECENTLY_CLOSED_TTL = 5 * 60_000; // 5 minutes

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
            action: `${TRADE_ACTION_PREFIX}_close_failed`,
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
    // Estimate P&L from Yahoo price for immediate logging (tilt, notifications)
    // REAL P&L comes from Tradovate fills via deferredPnlCheck() — never trust Yahoo for DB/patterns
    const estimatedDiff = pos.direction === "long" ? price - pos.entryPrice : pos.entryPrice - price;
    const estimatedPnl = estimatedDiff * mult * pos.quantity;

    // Tilt tracking uses estimates (needs to be immediate for risk management)
    dailyPnl += estimatedPnl;
    if (reason === "stop_loss" || reason === "emergency") {
      stoppedSymbols.add(sym);
      consecutiveStops++;
      // Re-entry cooldown: block same symbol+direction for 15 min (3 bars)
      const cooldownKey = `${sym}:${pos.direction}`;
      reEntryCooldowns.set(cooldownKey, Date.now() + 15 * 60_000);
      log(`[COOLDOWN] ${cooldownKey} blocked for 15min (re-entry cooldown after stop)`);

      const pauseSchedule = [0, 0, 30, 60, 120];
      const pauseMin = consecutiveStops >= 5 ? Infinity : (pauseSchedule[consecutiveStops] || 0);

      if (pauseMin > 0) {
        tiltPauseUntil = pauseMin === Infinity ? Infinity : Date.now() + pauseMin * 60_000;
        const label = pauseMin === Infinity ? "rest of session" : `${pauseMin} min`;
        log(`[TILT] Level ${consecutiveStops - 1}: ${consecutiveStops} consecutive stops — pausing ${label}`);
        notify(`TILT L${consecutiveStops - 1}: ${consecutiveStops} stops → pausing ${label}. Daily P&L: $${dailyPnl.toFixed(0)} (est)`, "general");
      }
    } else {
      consecutiveStops = 0;
    }
    log(`CLOSED ${sym}: ${reason} | Est P&L: $${estimatedPnl.toFixed(0)} (Yahoo) | Daily: $${dailyPnl.toFixed(0)} | Fill P&L pending...`);
    feedLog("exit", `**${MODE_TAG} CLOSED ${sym}** ${reason} | ~${estimatedPnl >= 0 ? "+" : ""}$${estimatedPnl.toFixed(0)} | Daily: $${dailyPnl.toFixed(0)}`);
    notify(`CLOSED ${sym}: ${reason} | ~$${estimatedPnl >= 0 ? "+" : ""}${estimatedPnl.toFixed(0)} (fill pending) | Daily: ${dailyPnl >= 0 ? "+" : ""}$${dailyPnl.toFixed(0)}`);

    // Log close to database with pnl: null — real P&L set by deferredPnlCheck()
    // NEVER use Yahoo price for DB P&L. The deferred check gets the actual Tradovate fill.
    let dbLogId: number | null = null;
    try {
      const dbLog = await prisma.autoTradeLog.create({ data: {
        symbol: `FUT:${sym}`,
        action: `${TRADE_ACTION_PREFIX}_${reason}`,
        qty: pos.quantity,
        price, // Yahoo price as reference (fillPrice will have the real one)
        pnl: null, // DEFERRED — filled by deferredPnlCheck() from actual Tradovate fill
        originalPnl: estimatedPnl, // Save Yahoo estimate for audit/comparison
        reason: `[FUTURES ${sym}] ${reason}: Closed ${pos.quantity}x. Entry: $${pos.entryPrice.toFixed(2)}. Est: $${estimatedPnl.toFixed(0)} (fill pending)`,
        orderId: closeOrderId ? String(closeOrderId) : null,
      }});
      dbLogId = dbLog.id;
    } catch {}

    // Schedule deferred P&L check — gets REAL fill price from Tradovate and updates DB + pattern memory
    const closeMeta = {
      dbLogId,
      sym,
      direction: pos.direction,
      entryPrice: pos.entryPrice,
      stopLoss: pos.stopLoss,
      target: pos.target,
      quantity: pos.quantity,
      contractId: pos.contractId,
      closeOrderId,
      reason,
      mult,
      estimatedPnl,
      entrySession: pos.entrySession || getSessionName(),
      entryRsi: pos.entryRsi || 50,
      entryVwap: pos.entryVwap,
      entryTrend15m: pos.entryTrend15m || "flat",
      entryDayType: pos.entryDayType || "unknown",
    };
    // First check after 15s, retry at 60s if no fill yet
    setTimeout(() => deferredPnlCheck(closeMeta, 1), 15_000);

    // Pattern memory is NOT stored here — deferredPnlCheck() stores it with real P&L

    // Vault journal + pattern memory logged by deferredPnlCheck() with REAL fill P&L

    positions.delete(sym);
    recentlyClosedAt.set(sym, Date.now()); // guard against syncPositions re-adopting settlement lag

    await savePositions();

    // Save balance snapshot after every close — ensures accurate daily P&L even with overnight trades or engine restarts
    try {
      await updateTradovateEquity();
      const today = new Date().toISOString().slice(0, 10);
      await prisma.agentConfig.upsert({
        where: { key: IS_LIVE ? `live_eod_balance_${today}` : `eod_balance_${today}` },
        update: { value: String(tradovateEquity) },
        create: { key: IS_LIVE ? `live_eod_balance_${today}` : `eod_balance_${today}`, value: String(tradovateEquity) },
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

    const liveContext = IS_LIVE
      ? `\nTHIS IS REAL MONEY ($${tradovateEquity.toFixed(0)} account). Be EXTREMELY selective. Only confirm genuine A+ setups with clear, unambiguous edge. Reject anything borderline or uncertain. A missed trade costs nothing — a bad trade costs real capital.\n`
      : "";

    const prompt = `You are an elite futures day trader. You only take A+ setups with clear edge.
${liveContext}
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
        model: "claude-sonnet-4-6",     // fast grader — Opus+thinking was timing out (>30s) → starved all trading
        max_tokens: 512,                // one JSON line; no extended thinking needed for a confidence grade
        messages: [{ role: "user", content: prompt }],
      }),
      signal: AbortSignal.timeout(20000),
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
  if (!SYMBOLS.includes(sym)) return;   // PHASE 0: only evaluate/trade whitelisted symbols (e.g. MES-only live)
  const b = barBuilders.get(sym);
  if (!b || b.bars5m.length < 25) return;

  const session = getSessionName();
  const sizeMult = getSizeMultiplier(sym);

  // CORRELATION GATE: don't hold two equity index positions simultaneously
  // ES and NQ are 90%+ correlated — holding both is doubling the same bet
  // Exception: allow MES + MYM since Dow/S&P diverge meaningfully ~20% of sessions
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
  // Mon/Fri penalty removed — let regime/VIX/event data handle sizing dynamically
  const sessionQuality = sizeMult >= 1 ? "prime" : sizeMult >= 0.5 ? "good" : "avoid";

  log(`${sym}: $${price.toFixed(2)} | ATR:${currentATR.toFixed(2)} | RSI:${currentRSI.toFixed(0)} | 15m:${tf15.trend} | ${dayType} | ${session} | ${vix.label}`);
  feedLog("scan", `**${sym}** $${price.toFixed(2)} | RSI ${currentRSI.toFixed(0)} | ${tf15.trend} | ${dayType} | ${session}`);

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

  // SETUP: IB EXTENSION (after first hour, price breaks IB range → target 1.5x extension)
  // Statistical tendency: 80%+ chance of reaching 1.5x IB extension on trend days
  if (b.barCount >= 12 && b.barCount <= 36 && b.openingRangeHigh > 0 && orSize > currentATR * 0.4 &&
      (session === "morning" || session === "midday")) {
    const ext15 = orSize * 1.5; // 1.5x extension target
    const breakAbove = price > b.openingRangeHigh && price < b.openingRangeHigh + ext15;
    const breakBelow = price < b.openingRangeLow && price > b.openingRangeLow - ext15;

    if ((breakAbove || breakBelow) && volRatio > 1.2) {
      const dir = breakAbove ? "long" : "short";
      const targetLevel = breakAbove ? b.openingRangeHigh + ext15 : b.openingRangeLow - ext15;
      const distToTarget = Math.abs(price - targetLevel);

      if (distToTarget > currentATR * 0.5) { // enough room to target
        const { score, reasons } = scoreSetup({
          baseConfidence: 72,
          volTrend, volRatio,
          trend15Aligns: breakAbove ? tf15.trend === "up" : tf15.trend === "down",
          rsiExtreme: false,
          priceAboveVWAP: breakAbove ? price > vwapData.vwap : price < vwapData.vwap,
          dayTypeMatch: dayType === "trend",
          sessionQuality,
        });

        log(`  → IB EXTENSION ${dir.toUpperCase()} | IB: $${b.openingRangeLow.toFixed(2)}-$${b.openingRangeHigh.toFixed(2)} | Target: $${targetLevel.toFixed(2)} | Confidence: ${score}% | ${reasons.join(", ")}`);

        if (score >= 72) {
          evaluateAndTrade(sym, dir, price, Math.max(orSize * 0.5, adjustedATR), distToTarget, effectiveSizeMult, score,
            `IB extension ${dir}: price $${price.toFixed(2)} ${breakAbove ? ">" : "<"} IB ${breakAbove ? "high" : "low"} $${(breakAbove ? b.openingRangeHigh : b.openingRangeLow).toFixed(2)}, targeting 1.5x ext $${targetLevel.toFixed(2)}, conf ${score}%`,
            currentRSI, currentATR, vwapData.vwap, dayType, session, tf15.trend, b.prevDayHigh, b.prevDayLow);
        }
        return;
      }
    }
  }

  // SETUP 2: Trend Continuation (pullback to EMA9) — RTH only
  // DISABLED 2026-05-25: 1yr backtest + walk-forward show it LOSES in-sample AND out-of-sample
  // (PF 0.91/0.93, net negative on ES/NQ/GC). Flip to true to re-enable.
  const TREND_CONTINUATION_ENABLED = false;
  if (TREND_CONTINUATION_ENABLED && (dayType === "trend" || Math.abs(fastEMA - slowEMA) / price > 0.001) &&
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

  // SETUP 4: VWAP Bounce — price pulls back to VWAP on trending day, rejection candle
  // Unlike mean reversion (fading at extremes), this enters WITH the trend at VWAP support
  if (dayType === "trend" && vwapData.vwap > 0 && b.sessionBars.length >= 12) {
    const distToVwap = Math.abs(price - vwapData.vwap);
    const vwapTolerance = currentATR * 0.3; // Within 0.3 ATR of VWAP
    const touchingVwap = distToVwap <= vwapTolerance;

    if (touchingVwap) {
      // Determine direction from trend: if price has been above VWAP most of session → bullish bounce
      const barsAboveVwap = b.sessionBars.filter(sb => sb.c > vwapData.vwap).length;
      const bullishSession = barsAboveVwap / b.sessionBars.length > 0.6;
      const bearishSession = barsAboveVwap / b.sessionBars.length < 0.4;

      // Rejection candle: wick touches VWAP, body closes away from it
      const isLongRejection = bullishSession && bar.l <= vwapData.vwap + vwapTolerance && bar.c > vwapData.vwap && bar.c > bar.o; // bullish candle bouncing off VWAP
      const isShortRejection = bearishSession && bar.h >= vwapData.vwap - vwapTolerance && bar.c < vwapData.vwap && bar.c < bar.o; // bearish candle rejected at VWAP

      if (isLongRejection && tf15.trend === "up" && currentRSI < 70) {
        const dir = "long";
        const { score, reasons } = scoreSetup({
          baseConfidence: 72,
          volTrend, volRatio,
          trend15Aligns: true,
          rsiExtreme: false,
          priceAboveVWAP: true,
          dayTypeMatch: true,
          sessionQuality: session === "morning" || session === "afternoon" ? "prime" : "neutral",
        });
        log(`  → VWAP BOUNCE LONG | VWAP:$${vwapData.vwap.toFixed(2)} | Dist:${distToVwap.toFixed(2)} | Confidence: ${score}% | ${reasons.join(", ")}`);
        if (score >= 70) {
          evaluateAndTrade(sym, dir, price, adjustedATR * 1.2, adjustedATR * 3.0, effectiveSizeMult, score,
            `VWAP bounce ${dir} at $${vwapData.vwap.toFixed(2)}, rejection candle, 15m ${tf15.trend}, conf ${score}%`,
            currentRSI, currentATR, vwapData.vwap, dayType, session, tf15.trend, b.prevDayHigh, b.prevDayLow);
        }
        return;
      }
      if (isShortRejection && tf15.trend === "down" && currentRSI > 30) {
        const dir = "short";
        const { score, reasons } = scoreSetup({
          baseConfidence: 72,
          volTrend, volRatio,
          trend15Aligns: true,
          rsiExtreme: false,
          priceAboveVWAP: false,
          dayTypeMatch: true,
          sessionQuality: session === "morning" || session === "afternoon" ? "prime" : "neutral",
        });
        log(`  → VWAP BOUNCE SHORT | VWAP:$${vwapData.vwap.toFixed(2)} | Dist:${distToVwap.toFixed(2)} | Confidence: ${score}% | ${reasons.join(", ")}`);
        if (score >= 70) {
          evaluateAndTrade(sym, dir, price, adjustedATR * 1.2, adjustedATR * 3.0, effectiveSizeMult, score,
            `VWAP bounce ${dir} at $${vwapData.vwap.toFixed(2)}, rejection candle, 15m ${tf15.trend}, conf ${score}%`,
            currentRSI, currentATR, vwapData.vwap, dayType, session, tf15.trend, b.prevDayHigh, b.prevDayLow);
        }
        return;
      }
    }
  }

  // SETUP 5: Range Bounce — mean reversion at prev day high/low or session extremes
  // Works in CHOPPY/RANGE markets where price oscillates between levels
  if (dayType === "range" && b.barCount >= 12 && b.prevDayHigh > 0 && b.prevDayLow > 0) {
    const distToPDH = Math.abs(price - b.prevDayHigh);
    const distToPDL = Math.abs(price - b.prevDayLow);
    const levelTolerance = currentATR * 0.5;

    // Near previous day high → short (mean revert down)
    const nearPDH = distToPDH <= levelTolerance && price >= b.prevDayHigh - levelTolerance;
    // Near previous day low → long (mean revert up)
    const nearPDL = distToPDL <= levelTolerance && price <= b.prevDayLow + levelTolerance;

    // Also check session high/low as secondary levels
    const sessionHigh = Math.max(...b.sessionBars.map(sb => sb.h));
    const sessionLow = Math.min(...b.sessionBars.map(sb => sb.l));
    const sessionRange = sessionHigh - sessionLow;
    const nearSessionHigh = sessionRange > currentATR * 1.5 && price > sessionHigh - levelTolerance * 0.5 && !nearPDH;
    const nearSessionLow = sessionRange > currentATR * 1.5 && price < sessionLow + levelTolerance * 0.5 && !nearPDL;

    if (nearPDH || nearPDL || nearSessionHigh || nearSessionLow) {
      const dir = (nearPDH || nearSessionHigh) ? "short" : "long";
      const levelName = nearPDH ? "PDH" : nearPDL ? "PDL" : nearSessionHigh ? "Session High" : "Session Low";
      const levelPrice = nearPDH ? b.prevDayHigh : nearPDL ? b.prevDayLow : nearSessionHigh ? sessionHigh : sessionLow;

      // Require rejection candle: wick tests level, body closes away
      const isRejection = dir === "short"
        ? (bar.h >= levelPrice - levelTolerance * 0.3 && bar.c < bar.o) // bearish candle near high
        : (bar.l <= levelPrice + levelTolerance * 0.3 && bar.c > bar.o); // bullish candle near low

      if (isRejection) {
        const rangeTarget = dir === "short"
          ? Math.abs(price - (vwapData.vwap > 0 ? vwapData.vwap : (b.prevDayHigh + b.prevDayLow) / 2))
          : Math.abs((vwapData.vwap > 0 ? vwapData.vwap : (b.prevDayHigh + b.prevDayLow) / 2) - price);
        const rangeStop = adjustedATR * 1.3;

        if (rangeTarget / rangeStop >= 1.5) {
          const { score, reasons } = scoreSetup({
            baseConfidence: 70,
            volTrend, volRatio,
            trend15Aligns: dir === "short" ? tf15.trend !== "up" : tf15.trend !== "down",
            rsiExtreme: dir === "short" ? currentRSI > 60 : currentRSI < 40,
            priceAboveVWAP: dir === "short",
            dayTypeMatch: true,
            sessionQuality,
          });

          log(`  → RANGE BOUNCE ${dir.toUpperCase()} | ${levelName} $${levelPrice.toFixed(2)} | Rejection candle | Confidence: ${score}% | ${reasons.join(", ")}`);

          if (score >= 72) {
            evaluateAndTrade(sym, dir, price, rangeStop, rangeTarget, effectiveSizeMult, score,
              `Range bounce ${dir} at ${levelName} $${levelPrice.toFixed(2)}, rejection candle, RSI ${currentRSI.toFixed(0)}, targeting VWAP/mid, conf ${score}%`,
              currentRSI, currentATR, vwapData.vwap, dayType, session, tf15.trend, b.prevDayHigh, b.prevDayLow);
          }
          return;
        }
      }
    }
  }

  // Log near-miss or why no setup triggered
  if (bestNearMiss) {
    log(`  ✗ Near miss: ${bestNearMiss}`);
  } else {
    // Quick summary of why nothing triggered
    const reasons: string[] = [];
    if (currentRSI > 25 && currentRSI < 75) reasons.push(`RSI ${currentRSI.toFixed(0)} not extreme`);
    if (session !== "morning") reasons.push("not morning (no OR breakout)");
    if (Math.abs(price - fastEMA) / price >= 0.003) reasons.push(`price ${((Math.abs(price - fastEMA) / price) * 100).toFixed(2)}% from EMA9 (need <0.3%)`);
    if (dayType !== "range") reasons.push(`${dayType} day (range bounce needs range)`);
    if (reasons.length > 0) log(`  ✗ No setup: ${reasons.join(" | ")}`);
  }
}

// ── AI Evaluation + Execute ─────────────────────────────

// Orchestrator pause gate. Reads the ephemeral `entries_paused` session flag set by the
// VIX-spike / consecutive-stop workflows. Self-contained prisma read so the engine doesn't
// pull in the orchestrator's heavy deps; callers treat any error as "not paused" (fail-open).
async function checkEntriesPaused(): Promise<{ paused: boolean; reason: string }> {
  const sessionId = new Date().toLocaleDateString("en-CA", { timeZone: "America/New_York" });
  const row = await prisma.sessionContext.findUnique({
    where: { sessionId_key: { sessionId, key: "entries_paused" } },
  });
  if (!row || row.expiresAt < new Date()) return { paused: false, reason: "" };
  const v = JSON.parse(row.value) as { paused?: boolean; reason?: string; mode?: string };
  if (!v.paused) return { paused: false, reason: "" };
  if (v.mode && v.mode !== ENGINE_MODE) return { paused: false, reason: "" }; // mode-scoped pause
  return { paused: true, reason: v.reason || "orchestrator pause" };
}

// Verify an entry order actually filled before we commit a tracked position and rest
// protective stop/target orders. SAFETY-BIASED: only reports "rejected" when positively
// confirmed (order in a terminal non-filled state AND no fill exists). Any uncertainty
// (still working, API error, timeout) returns "unknown" so the caller falls back to current
// behavior — we never abandon a real fill or leave a naked position. Polls ~4s (market
// orders fill in <1s during open hours).
async function verifyOrderFill(orderId: number, requestedQty: number): Promise<
  | { status: "filled"; price: number; qty: number }
  | { status: "rejected"; reason: string }
  | { status: "unknown" }
> {
  let lastFilledQty = 0;
  let lastVwap = 0;
  for (let attempt = 0; attempt < 5; attempt++) {
    await new Promise((r) => setTimeout(r, attempt === 0 ? 700 : 900));
    try {
      const fills = (await apiFetch("/fill/list")) as { orderId: number; price: number; qty: number }[];
      const mine = Array.isArray(fills) ? fills.filter((f) => f.orderId === orderId) : [];
      if (mine.length > 0) {
        const q = mine.reduce((s, f) => s + (f.qty || 0), 0);
        lastVwap = q > 0 ? mine.reduce((s, f) => s + f.price * f.qty, 0) / q : mine[0].price;
        lastFilledQty = q;
        if (q >= requestedQty) return { status: "filled", price: lastVwap, qty: q }; // fully filled
        // partial — keep polling briefly to let the remainder fill
      } else {
        const ord = (await apiFetch(`/order/item?id=${orderId}`)) as { ordStatus?: string };
        if (ord?.ordStatus === "Rejected" || ord?.ordStatus === "Canceled" || ord?.ordStatus === "Expired") {
          return { status: "rejected", reason: ord.ordStatus };
        }
      }
    } catch { /* transient API error — keep polling, resolve as unknown */ }
  }
  // Polling ended: if ANY fill was seen, treat as filled at the ACTUAL (possibly partial) qty so
  // protective orders are sized to what we really hold — never larger (oversize → reversal risk).
  if (lastFilledQty > 0) return { status: "filled", price: lastVwap, qty: lastFilledQty };
  return { status: "unknown" };
}

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
    } else if (aiVetoEnabled) {
      log(`  AI REJECTS (${ai.confidence}%): ${ai.reasoning} — trade blocked`);
      return;
    } else {
      // AI-OFF EXPERIMENT (demo only): the AI would block, but take the MECHANICAL trade anyway and log
      // the veto, so we can compare AI-approved vs AI-rejected outcomes (is the AI overlay worth its trade-suppression?).
      log(`  AI WOULD REJECT (${ai.confidence}%): ${ai.reasoning} — TAKING ANYWAY [ai_grader off, demo experiment]`);
    }
  } else {
    log(`  AI: ${ai.reasoning}`);
  }

  // Re-entry cooldown check: was this symbol+direction recently stopped out?
  const cooldownKey = `${sym}:${direction}`;
  const cooldownExpiry = reEntryCooldowns.get(cooldownKey);
  if (cooldownExpiry && Date.now() < cooldownExpiry) {
    const remainMin = ((cooldownExpiry - Date.now()) / 60_000).toFixed(0);
    log(`  COOLDOWN: ${cooldownKey} blocked for ${remainMin}min after recent stop-out — skipping`);
    feedLog("cooldown", `${sym} ${direction} blocked — ${remainMin}min cooldown after stop-out`);
    return;
  }
  // Clear expired cooldowns
  if (cooldownExpiry && Date.now() >= cooldownExpiry) reEntryCooldowns.delete(cooldownKey);

  // Final gate: live needs 75%+ (A+ only), demo needs 65%+
  const MIN_CONFIDENCE = IS_LIVE ? 75 : 55;   // live: A+ only (selective growth); demo: more active for research signal
  if (finalScore < MIN_CONFIDENCE) {
    log(`  SKIPPED: Final confidence ${finalScore}% below ${MIN_CONFIDENCE}% threshold (${MODE_TAG})`);
    return;
  }

  // Orchestrator pause gate (fail-open) — respect VIX-spike / consecutive-stop pauses
  try {
    const pause = await checkEntriesPaused();
    if (pause.paused) {
      log(`  PAUSED by orchestrator: ${pause.reason} — skipping ${sym} ${direction}`);
      feedLog("cooldown", `Entries paused — ${pause.reason}`);
      return;
    }
  } catch { /* fail-open: proceed normally if the pause check fails */ }

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
        regime: cachedRegime,
        session, instrument: sym, setupType: reasoning.split("]")[0]?.replace("[", "") || "unknown",
        direction: direction as "long" | "short",
        rsi: rsiVal, vixLevel: currentVIX, vixTrend: currentVIX > 20 ? "rising" : "falling",
        atr: atrVal / price * 1000, priceVsVwap: vwapVal > 0 ? (price - vwapVal) / vwapVal * 100 : 0,
        trend15m: trend15 as "up" | "down" | "flat",
        trendDaily: dayType.includes("trend") ? (direction === "long" ? "up" : "down") : "flat",
        riskReward: targetDist / stopDist,
        dollarTrend: "flat", bondTrend: "flat", // TODO: wire cross-asset
      });
      log(`  [PATTERN] ${patternPrediction.matchCount} matches, ${(patternPrediction.winRate * 100).toFixed(0)}% historical WR, score ${patternPrediction.score}`);

      // LIVE: Active gate — block setups with proven low win rate.
      // 2026-05-29: Threshold relaxed from 0.45 → 0.25 per Spencer explicit override.
      // Storage still happens (we keep learning), but only clearly-losing patterns block.
      if (IS_LIVE && patternPrediction.matchCount >= 10 && patternPrediction.winRate < 0.25) {
        log(`  BLOCKED by pattern memory: ${(patternPrediction.winRate * 100).toFixed(0)}% WR < 25% on ${patternPrediction.matchCount} matches — skipping for live`);
        return;
      }
    } catch { /* pattern memory is optional */ }

    log(`  EXECUTING: ${direction.toUpperCase()} ${sym} @ $${price.toFixed(2)} | Confidence: ${finalScore}% | ${MODE_TAG}`);
    feedLog("trade", `**${MODE_TAG} ${direction.toUpperCase()} ${sym}** @ $${price.toFixed(2)} | ${finalScore}% confidence`);
    await executeTrade(sym, direction as "long" | "short", price, stopDist, targetDist, sizeMult, finalScore,
      `[${finalScore}% confidence] ${reasoning}. AI: ${ai.agree ? "confirms" : "disagrees"} — ${ai.reasoning}`,
      { rsi: rsiVal, vwap: vwapVal, trend15m: trend15, dayType, session });
  } else {
    // Hit daily limit or tilt — done for the day. Demo handles learning independently.
    log(`  BLOCKED: ${direction.toUpperCase()} ${sym} (${dailyTradeCount >= 10 ? "daily limit" : "tilt/position limit"}). Done.`);
  }
}

// ── Trade Execution ─────────────────────────────────────

// Phase-0 execution-quality capture (intended vs actual fill, slippage, latency). Fully isolated — never throws into trading.
async function logExecutionQuality(e: { mode: string; sym: string; side: string; intended: number; fill: number; qty: number; latencyMs: number; status: string }) {
  try {
    await prisma.$executeRawUnsafe(`CREATE TABLE IF NOT EXISTS execution_quality (id serial PRIMARY KEY, ts timestamptz DEFAULT now(), mode text, symbol text, side text, intended double precision, fill double precision, slippage double precision, qty int, latency_ms int, status text)`);
    const slip = e.side === "Buy" ? (e.fill - e.intended) : (e.intended - e.fill);   // + = adverse (paid up)
    await prisma.$executeRawUnsafe(`INSERT INTO execution_quality(mode,symbol,side,intended,fill,slippage,qty,latency_ms,status) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)`, e.mode, e.sym, e.side, e.intended, e.fill, slip, e.qty, e.latencyMs, e.status);
    log(`[EXEC-Q] ${e.sym} ${e.side} intended ${e.intended.toFixed(2)} fill ${e.fill.toFixed(2)} slip ${slip.toFixed(2)} lat ${e.latencyMs}ms ${e.status}`);
  } catch { /* telemetry must never affect trading */ }
}

async function executeTrade(sym: string, direction: "long" | "short", price: number, stopDist: number, targetDist: number, sizeMult: number, confidenceScore: number, reasoning: string, setupContext?: { rsi: number; vwap: number; trend15m: string; dayType: string; session: string }) {
  const contract = contracts.get(sym);
  if (!contract) return;

  // Demo always executes (24/7 learning). Live mirrors during RTH if enabled.

  const mult = CONTRACT_MULTIPLIERS[sym] || 5;
  // Use simulated equity for sizing (demo simulates $1K). Fall back to actual if not set.
  const equity = riskConfig.simulatedEquity > 0 ? riskConfig.simulatedEquity : tradovateEquity;
  const riskPct = riskConfig.riskPerTradePct / 100;
  const maxRisk = equity * riskPct * sizeMult;
  const riskPer = stopDist * mult; // Dollar risk per 1 contract

  // REJECT if even 1 contract exceeds the risk-per-trade cap
  // This prevents the old bug: Math.max(1,...) forced 1 contract even when risk was 2x the cap
  if (riskPer > maxRisk) {
    log(`${sym}: SKIP — 1 contract risk $${riskPer.toFixed(0)} exceeds max $${maxRisk.toFixed(0)} (${(riskPct * 100)}% of $${equity.toFixed(0)}). Stop too wide.`);
    return;
  }

  let qty = Math.min(riskConfig.maxContractsPerTrade, Math.floor(maxRisk / riskPer));
  if (qty < 1) { log(`${sym}: SKIP — calculated qty 0`); return; }
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

    const submitTs = Date.now();
    const entry = await apiFetch("/order/placeorder", { method: "POST", body: JSON.stringify({
      accountSpec: acct.name, accountId, action: side, symbol: contract.id,
      orderQty: qty, orderType: "Market", timeInForce: "Day", isAutomated: true,
    })}) as { orderId: number };

    // Confirm the entry filled BEFORE resting protective orders or tracking a position.
    // Only skip on a positively-confirmed rejection (no fill); unknown → fall back to
    // current behavior (track at estimated price) so we never abandon a real fill.
    const fillResult = await verifyOrderFill(entry.orderId, qty);
    if (fillResult.status === "rejected") {
      log(`  ORDER REJECTED (${fillResult.reason}) — no fill, NOT opening ${sym} position (no orphan orders)`);
      notify(`⚠️ ${MODE_TAG} ${sym} entry REJECTED (${fillResult.reason}) — no position opened`);
      feedLog("skip", `${sym} ${direction} entry rejected (${fillResult.reason}) — no position`);
      return;
    }
    const fillConfirmed = fillResult.status === "filled";
    const entryPrice = fillConfirmed ? fillResult.price : price; // real fill price when known
    const fillQty = fillConfirmed ? fillResult.qty : qty;        // size protective orders to ACTUAL fill, never larger
    // EXECUTION TELEMETRY (Phase 0) — fire-and-forget; isolated so it can never affect the order
    void logExecutionQuality({ mode: ENGINE_MODE, sym, side, intended: price, fill: entryPrice, qty: fillQty, latencyMs: Date.now() - submitTs, status: fillResult.status });

    // Protective STOP — retry once; for a real position this is non-negotiable.
    let stopOrderId: number | null = null;
    for (let a = 0; a < 2 && stopOrderId === null; a++) {
      try {
        const s = await apiFetch("/order/placeorder", { method: "POST", body: JSON.stringify({
          accountSpec: acct.name, accountId, action: closeSide, symbol: contract.id,
          orderQty: fillQty, orderType: "Stop", stopPrice, timeInForce: "GTC", isAutomated: true,
        })}) as { orderId: number };
        stopOrderId = s.orderId;
      } catch { if (a === 0) await new Promise(r => setTimeout(r, 800)); }
    }

    // SAFETY: never hold a CONFIRMED position without a protective stop. If the stop couldn't be
    // placed, flatten the just-filled entry immediately rather than run naked.
    if (stopOrderId === null && fillConfirmed) {
      log(`  🚨 STOP PLACEMENT FAILED for ${sym} — flattening ${fillQty}x entry to avoid a naked position`);
      notify(`🚨 ${MODE_TAG} ${sym}: stop order FAILED — flattening entry (no naked position)`);
      try {
        await apiFetch("/order/placeorder", { method: "POST", body: JSON.stringify({
          accountSpec: acct.name, accountId, action: closeSide, symbol: contract.id,
          orderQty: fillQty, orderType: "Market", timeInForce: "Day", isAutomated: true,
        })});
        feedLog("skip", `${sym} flattened — stop placement failed`);
      } catch (e) {
        log(`  🚨🚨 FLATTEN ALSO FAILED for ${sym}: ${e} — MANUAL INTERVENTION NEEDED`);
        notify(`🚨🚨 ${MODE_TAG} ${sym}: entry filled, stop FAILED, flatten FAILED — CHECK ACCOUNT NOW`);
      }
      return; // never track a stopless position; never place a target on a flattened entry
    }
    if (stopOrderId === null) {
      // Fill UNCONFIRMED + stop failed: can't safely flatten (may hold nothing). Track so the
      // software hard-stop manages it, but alert loudly.
      log(`  ⚠️ ${sym}: stop placement failed, fill unconfirmed — tracking with SOFTWARE stop only`);
      notify(`⚠️ ${MODE_TAG} ${sym}: no broker stop (fill unconfirmed) — software stop active, watch it`);
    }

    let targetOrderId: number | null = null;
    try {
      const t = await apiFetch("/order/placeorder", { method: "POST", body: JSON.stringify({
        accountSpec: acct.name, accountId, action: closeSide, symbol: contract.id,
        orderQty: fillQty, orderType: "Limit", price: targetPrice, timeInForce: "GTC", isAutomated: true,
      })}) as { orderId: number };
      targetOrderId = t.orderId;
    } catch {}

    positions.set(sym, {
      symbol: sym, contractId: contract.id, direction, quantity: fillQty,
      entryPrice, stopLoss: stopPrice, target: targetPrice,
      trailStop: null, reachedBreakeven: false,
      stopOrderId, targetOrderId, entryTime: Date.now(),
      scaledOut: false, originalQty: fillQty, consecutiveStops: 0,
      pyramided: false,
      entryRsi: setupContext?.rsi ?? 50,
      entryVwap: setupContext?.vwap ?? 0,
      entryTrend15m: setupContext?.trend15m ?? "flat",
      entryDayType: setupContext?.dayType ?? "unknown",
      entrySession: setupContext?.session ?? getSessionName(),
      emergencyWarningTick: 0,
    });
    dailyTradeCount++;
    log(`Order #${entry.orderId} ${fillConfirmed ? `FILLED @ $${entryPrice.toFixed(2)}` : "placed (fill unconfirmed — tracking at est)"} | Stop #${stopOrderId} | Target #${targetOrderId}`);
    notify(`${side} ${fillQty}x ${sym} @ $${entryPrice.toFixed(2)}${fillConfirmed ? "" : " (est)"} | Stop: $${stopPrice.toFixed(2)} | Target: $${targetPrice.toFixed(2)} | R:R ${rr.toFixed(1)}`);
    await savePositions();

    // Log to database so Vercel dashboard shows it
    try {
      await prisma.autoTradeLog.create({ data: {
        symbol: `FUT:${sym}`,
        action: `${TRADE_ACTION_PREFIX}_${direction}`,
        qty: fillQty,
        price: entryPrice,
        reason: `[FUTURES ${sym}] ${reasoning}. Stop: $${stopPrice.toFixed(2)}, Target: $${targetPrice.toFixed(2)}. R:R ${rr.toFixed(1)}. Risk: $${(riskPer * qty).toFixed(0)}. Size: ${sizeMult.toFixed(1)}x. Fill: ${fillConfirmed ? "confirmed" : "unconfirmed(est)"}`,
        aiScore: confidenceScore,
        aiSignal: direction,
        orderId: String(entry.orderId),
      }});
    } catch {}

    // JARVIS: update dashboard after trade entry (throttled)
    throttledJARVIS(`trade-entry-${sym}`);
  } catch (err) { log(`TRADE FAILED: ${err}`); }

}

// ── Heartbeat (tells dashboard the engine is alive) ─────

async function writeHeartbeat() {
  try {
    const payload = JSON.stringify({
      timestamp: new Date().toISOString(),
      tickCount,
      mode: ENGINE_MODE,
      positions: positions.size,
      dailyPnl: Math.round(dailyPnl),
      dailyTrades: dailyTradeCount,
      session: getSessionName(),
      mdHealth: wsConnected ? "websocket" : mdCircuitOpen ? "circuit_open" : mdConsecutiveFailures > 0 ? `degraded(${mdConsecutiveFailures})` : "yahoo",
    });
    await prisma.agentConfig.upsert({
      where: { key: HEARTBEAT_KEY },
      update: { value: payload },
      create: { key: HEARTBEAT_KEY, value: payload },
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
              action: { in: [`${TRADE_ACTION_PREFIX}_manual_close`, `${TRADE_ACTION_PREFIX}_take_profit`, `${TRADE_ACTION_PREFIX}_stop_loss`, `${TRADE_ACTION_PREFIX}_trail_stop`, `${TRADE_ACTION_PREFIX}_breakeven`, `${TRADE_ACTION_PREFIX}_emergency`, `${TRADE_ACTION_PREFIX}_bracket_close`] },
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
              action: `${TRADE_ACTION_PREFIX}_${closeType}`,
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
              tradeId: `${new Date().toISOString().slice(0, 10)}-FRT-${MODE_TAG}-${sym}`,
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
            }, AGENT_NAME);
            await logDecision(AGENT_NAME, "EXIT", `FUT:${sym}`, `${closeType}: P&L $${pnl.toFixed(0)}`, pnl > 0 ? 4 : 2);
          } catch { /* vault optional */ }
          throttledJARVIS(`synced-close-${sym}`);
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

      // Guard: if we closed this symbol recently, this Tradovate position is almost certainly a
      // settlement-lag residual from overlapping close orders (e.g. scale-out stop + breakeven
      // both firing as BUY orders in the same second, creating a net-LONG remnant on the paper
      // account). Adopting it caused a phantom emergency close with a wrong direction and
      // inflated P&L (-$24k). Instead, cancel any working orders and let it settle.
      const lastClose = recentlyClosedAt.get(sym);
      if (lastClose && Date.now() - lastClose < RECENTLY_CLOSED_TTL) {
        log(`[SYNC] ${sym}: Tradovate shows residual position but we closed ${Math.round((Date.now() - lastClose) / 1000)}s ago — skipping adoption (settlement lag), cancelling orphaned orders`);
        try {
          const allOrders = await apiFetch("/order/list") as { id: number; contractId: number; ordStatus: string }[];
          const orphans = allOrders.filter(o => o.contractId === tp.contractId && (o.ordStatus === "Working" || o.ordStatus === "Accepted"));
          for (const o of orphans) { try { await apiFetch("/order/cancelorder", { method: "POST", body: JSON.stringify({ orderId: o.id }) }); } catch {} }
          if (orphans.length > 0) log(`[SYNC] ${sym}: Cancelled ${orphans.length} orphaned orders for residual position`);
        } catch {}
        continue;
      }

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
        entryRsi: 50, entryVwap: 0, entryTrend15m: "flat", entryDayType: "unknown", entrySession: getSessionName(),
        emergencyWarningTick: 0,
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

      // PRIMARY: Mode's own MD server + token
      try {
        const res = await fetch(
          `${mdUrl}/md/getChart?contractId=${contract.id}&chartDescription=${chartDesc}&timeRange=${timeRange}`,
          { headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(15000) },
        );
        if (res.ok) data = await res.json();
      } catch { /* try fallback */ }

      // FALLBACK 1: Mode's main API
      if (!data?.charts) {
        try {
          data = await apiFetch(
            `/md/getChart?contractId=${contract.id}&chartDescription=${chartDesc}&timeRange=${timeRange}`
          ) as typeof data;
        } catch { /* try demo fallback */ }
      }

      // FALLBACK 2 (live only): Demo MD with demo contract IDs
      if (!data?.charts && IS_LIVE) {
        const demoToken = await authenticateDemoMd();
        const demoContract = demoContracts.get(sym) || demoContracts.get(FULL_EQUIVALENT[sym] || "");
        if (demoToken && demoContract) {
          try {
            const res = await fetch(
              `${DEMO_MD_URL}/md/getChart?contractId=${demoContract.id}&chartDescription=${chartDesc}&timeRange=${timeRange}`,
              { headers: { "Content-Type": "application/json", Authorization: `Bearer ${demoToken}` }, signal: AbortSignal.timeout(15000) },
            );
            if (res.ok) data = await res.json();
          } catch { /* fall through to Yahoo */ }
        }
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

  // Preload for ALL symbols (both full-size and micro) — 20s cap per symbol prevents startup hang
  for (const sym of [...FULL_SIZE_SYMBOLS, ...MICRO_SYMBOLS, "YM"]) {
    try {
      await Promise.race([
        preloadBarsForSymbol(sym),
        new Promise<void>((_, reject) => setTimeout(() => reject(new Error("timeout")), 20_000)),
      ]);
    } catch (err) {
      log(`  ${sym}: preload skipped (${err instanceof Error ? err.message : err}) — will build bars from live feed`);
    }
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
    const yfTimeout = <T>(p: Promise<T>): Promise<T | null> =>
      Promise.race([p, new Promise<null>(r => setTimeout(() => r(null), 10_000))]);
    const [vixQ, vix3mQ] = await Promise.all([
      yfTimeout(getYfEngine().quote("^VIX")).catch(() => null),
      yfTimeout(getYfEngine().quote("^VIX3M")).catch(() => null),
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

// Fetch a symbol's daily % change from Databento historical API (GLBX.MDP3).
// Returns null on failure — callers treat null as "no data" gracefully.
async function fetchDbnDailyChangePct(symbol: string): Promise<number | null> {
  const apiKey = process.env.DATABENTO_API_KEY;
  if (!apiKey) return null;
  const auth = "Basic " + Buffer.from(apiKey + ":").toString("base64");
  // 4 days back to cover weekends (we need at least 2 trading sessions)
  const start = new Date(Date.now() - 4 * 86_400_000).toISOString();
  const body = new URLSearchParams({
    dataset: "GLBX.MDP3", symbols: symbol, stype_in: "continuous",
    schema: "ohlcv-1d", start, end: new Date().toISOString(),
    encoding: "csv", pretty_px: "true", pretty_ts: "true",
  });
  const res = await fetch("https://hist.databento.com/v0/timeseries.get_range", {
    method: "POST",
    headers: { Authorization: auth, "Content-Type": "application/x-www-form-urlencoded" },
    body,
    signal: AbortSignal.timeout(8_000),
  });
  if (!res.ok) return null;
  const csv = await res.text();
  const lines = csv.trim().split("\n").filter((_, i) => i > 0).filter(Boolean);
  if (lines.length < 2) return null;
  const closeOf = (line: string) => parseFloat(line.split(",")[7]); // close column (pretty_px)
  const prev = closeOf(lines[lines.length - 2]);
  const curr = closeOf(lines[lines.length - 1]);
  if (!isFinite(prev) || !isFinite(curr) || prev === 0) return null;
  return ((curr - prev) / prev) * 100;
}

async function updateCrossAssetSignals() {
  try {
    // Databento GLBX.MDP3 — daily % change for gold, oil, bonds
    // GC = gold, CL = crude oil, ZN = 10-yr note (bonds proxy)
    const [goldChange, oilChange, bondsChange] = await Promise.all([
      fetchDbnDailyChangePct("GC.v.0").catch(() => null),
      fetchDbnDailyChangePct("CL.v.0").catch(() => null),
      fetchDbnDailyChangePct("ZN.v.0").catch(() => null),
    ]);

    // VIX — CBOE index, not on GLBX; read from module var set by updateVIX()
    const signals: string[] = [];
    if (currentVIX > 0) signals.push(`VIX:${currentVIX.toFixed(1)}(${vixTermStructure})`);
    if (bondsChange != null) signals.push(`ZN:${bondsChange > 0 ? "+" : ""}${bondsChange.toFixed(1)}%`);
    if (oilChange != null) signals.push(`Oil:${oilChange > 0 ? "+" : ""}${oilChange.toFixed(1)}%`);
    if (goldChange != null) signals.push(`Gold:${goldChange > 0 ? "+" : ""}${goldChange.toFixed(1)}%`);

    // Risk stance: bonds up + gold down = risk-on; bonds down + gold up + VIX spike = risk-off
    let riskSignal = "mixed";
    const riskOnCount = [
      bondsChange != null && bondsChange > 0,
      goldChange != null && goldChange < 0,
      currentVIX > 0 && currentVIX < 18,
    ].filter(Boolean).length;
    const riskOffCount = [
      bondsChange != null && bondsChange < 0,
      goldChange != null && goldChange > 1,
      currentVIX > 23,
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
    // Use barBuilders — prevDayClose populated at startup via preloadBars(), lastPrice from live feed.
    // Micros and full-size share the same index, prefer micro builders since those are always initialized.
    const esB = barBuilders.get("MES") ?? barBuilders.get("ES");
    const nqB = barBuilders.get("MNQ") ?? barBuilders.get("NQ");
    const ymB = barBuilders.get("MYM") ?? barBuilders.get("YM");

    const dayChgPct = (b: typeof esB): number | null => {
      if (!b || b.prevDayClose === 0 || b.lastPrice === 0) return null;
      return ((b.lastPrice - b.prevDayClose) / b.prevDayClose) * 100;
    };

    const esChg = dayChgPct(esB);
    const nqChg = dayChgPct(nqB);
    const ymChg = dayChgPct(ymB);

    const available = [esChg, nqChg, ymChg].filter((x): x is number => x !== null);
    if (available.length === 0) { sectorContext = "Sectors: no data"; return; }

    const allPos = available.every(x => x > 0);
    const allNeg = available.every(x => x < 0);
    // NQ outperforms ES by >0.3% = tech leading; YM > NQ = value/defensive rotation
    const nqLeadsEs = nqChg != null && esChg != null && (nqChg - esChg) > 0.3;
    const ymLeadsNq = ymChg != null && nqChg != null && (ymChg - nqChg) > 0.3;

    if (nqLeadsEs && allPos) sectorBias = "tech_leads";
    else if (allPos) sectorBias = "broad_rally";
    else if (ymLeadsNq || allNeg) sectorBias = "defensive";
    else sectorBias = "mixed";

    const fmt = (v: number | null) => v != null ? `${v > 0 ? "+" : ""}${v.toFixed(2)}%` : "—";
    sectorContext = `Sectors: ${sectorBias.toUpperCase()} | ES:${fmt(esChg)} NQ:${fmt(nqChg)} YM:${fmt(ymChg)}`;
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
      mode: ENGINE_MODE,
      status: healthy ? "healthy" : "degraded",
      uptime: uptimeSeconds,
      tickCount,
      lastTickAgeSec: lastTickAge,
      positions: positions.size,
      dailyPnl: Math.round(dailyPnl),
      dailyTrades: dailyTradeCount,
      session: getSessionName(),
      md: wsConnected ? "websocket" : mdCircuitOpen ? "circuit_open" : mdConsecutiveFailures > 0 ? `degraded(${mdConsecutiveFailures})` : "yahoo",
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

// Poll DB for shared/bootstrap token without hitting the auth endpoint
async function tryDBTokenOnly(): Promise<string | null> {
  try {
    const shareKey = IS_LIVE ? "tradovate_live_shared_token" : "tradovate_demo_shared_token";
    const shared = await prisma.agentConfig.findUnique({ where: { key: shareKey } });
    if (shared?.value) {
      const { token, expires, accountId: savedAcctId, accountName: savedAcctName } = JSON.parse(shared.value);
      const expMs = new Date(expires).getTime();
      if (token && expMs > Date.now() + 300_000) {
        log("[AUTH] Found shared token in DB — using it (no auth call)");
        accessToken = token;
        tokenExpires = expMs;
        if (savedAcctId) { accountId = savedAcctId; accountName = savedAcctName; }
        return accessToken;
      }
    }
    const bootstrapKey = IS_LIVE ? "tradovate_live_bootstrap_token" : "tradovate_bootstrap_token";
    const bootstrap = await prisma.agentConfig.findUnique({ where: { key: bootstrapKey } });
    if (bootstrap?.value) {
      const { token, expires } = JSON.parse(bootstrap.value);
      const expMs = new Date(expires).getTime();
      if (token && expMs > Date.now()) {
        log("[AUTH] Found bootstrap token in DB — using it");
        accessToken = token;
        tokenExpires = expMs;
        await prisma.agentConfig.delete({ where: { key: bootstrapKey } }).catch(() => {});
        const accounts = await apiFetch("/account/list") as { id: number; name: string; active: boolean }[];
        const active = accounts.find((a) => a.active) || accounts[0];
        if (active) { accountId = active.id; accountName = active.name; }
        log(`Authenticated — ${accountName} (#${accountId}) — ${MODE_TAG} (bootstrap)`);
        return accessToken;
      }
    }
  } catch { /* DB lookup failed */ }
  return null;
}

async function authenticateWithRetry(): Promise<string> {
  let attempt = 0;
  let rateLimitHits = 0;
  let lastAuthCallTime = 0;
  const COOLDOWN_MS = 2 * 60 * 60 * 1000; // 2 hours — let Tradovate fully cool down
  const MAX_DIRECT_ATTEMPTS = 5; // After 5 429s, stop hammering the endpoint

  while (true) {
    attempt++;
    try {
      // If we've been rate-limited too many times, stop calling the auth endpoint
      // and only poll DB for shared/bootstrap tokens. This lets the rate limit cool down.
      if (rateLimitHits >= MAX_DIRECT_ATTEMPTS) {
        const dbToken = await tryDBTokenOnly();
        if (dbToken) {
          rateLimitHits = 0; // Reset — we're back in business
          return dbToken;
        }

        // Every 2 hours, try one direct auth call to see if rate limit cleared
        const timeSinceLastCall = Date.now() - lastAuthCallTime;
        if (timeSinceLastCall >= COOLDOWN_MS) {
          log(`[AUTH] Cooldown elapsed (${Math.round(timeSinceLastCall / 60000)}min) — trying one direct auth call...`);
          lastAuthCallTime = Date.now();
          return await authenticate(); // If this 429s, we catch it below
        }

        const waitMin = Math.round((COOLDOWN_MS - timeSinceLastCall) / 60000);
        log(`[AUTH] Rate-limited (${rateLimitHits}x) — DB-only mode, checking every 2 min. Next direct auth in ${waitMin}min. Inject bootstrap token to skip wait.`);
        await new Promise(r => setTimeout(r, 120_000)); // Poll DB every 2 min
        continue;
      }

      lastAuthCallTime = Date.now();
      return await authenticate();
    } catch (err) {
      const errStr = String(err);
      const isRateLimit = errStr.includes("429");
      if (isRateLimit) {
        rateLimitHits++;
        if (rateLimitHits >= MAX_DIRECT_ATTEMPTS) {
          log(`[AUTH] Hit 429 ${rateLimitHits} times — switching to DB-only mode. Stopping auth calls to let rate limit cool down.`);
          log(`[AUTH] Will retry direct auth in 2 hours, or inject a bootstrap token to resume immediately.`);
          continue; // Go back to top of loop — will enter DB-only mode
        }
        const rateLimitDelay = Math.min(900_000, 300_000 * Math.ceil(attempt / 2));
        log(`[AUTH] Rate limited (attempt ${attempt}) — waiting ${Math.round(rateLimitDelay / 60000)} min before retry...`);
        await new Promise(r => setTimeout(r, rateLimitDelay));
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
  log(`║  ESBUENO FUTURES — ${MODE_TAG} ENGINE ${"".padEnd(16 - MODE_TAG.length)}║`);
  log("╚══════════════════════════════════════════════╝");
  log(`Mode: ${IS_LIVE ? "LIVE — real money, RTH prime only" : "DEMO 24/7 learning"} | Data: Tradovate WS → Yahoo fallback (5s) | Orders: ${IS_LIVE ? "LIVE" : "DEMO"} Tradovate`);

  // Validate all required env vars BEFORE doing anything else
  validateEnvironment();

  // Start health server first — Railway can ping us even during init
  startHealthServer();

  await authenticateWithRetry();
  await loadRiskConfig(); // Load risk rules from DB (Agent Hub is the UI)
  // Mode is set by ENGINE_MODE env var — no DB check needed
  await resolveContracts();
  // Init bar builders for ALL symbols (both full-size and micro) so we can switch dynamically
  for (const sym of [...FULL_SIZE_SYMBOLS, ...MICRO_SYMBOLS]) initBarBuilder(sym);

  // Restore positions from database (survive restarts)
  await loadPositions();
  // Each engine loads its own positions from POSITIONS_KEY

  // Pre-load historical bars so we can trade IMMEDIATELY
  await preloadBars();

  // Get account equity + VIX + macro intelligence — this also sets SYMBOLS based on equity
  await updateTradovateEquity();
  // Save balance snapshot on startup — mode-keyed so demo/live don't collide
  try {
    const today = new Date().toISOString().slice(0, 10);
    const startupDailyKey = IS_LIVE ? `live_daily_balance_${today}` : `daily_balance_${today}`;
    const startupSodKey = IS_LIVE ? "live_start_of_day_balance" : "start_of_day_balance";
    // If no SOD snapshot for today, save one now (catches deploys/restarts after 9:29 AM)
    const existing = await prisma.agentConfig.findUnique({ where: { key: startupDailyKey } });
    if (!existing) {
      await prisma.agentConfig.upsert({
        where: { key: startupDailyKey },
        update: { value: String(tradovateEquity) },
        create: { key: startupDailyKey, value: String(tradovateEquity) },
      });
      await prisma.agentConfig.upsert({
        where: { key: startupSodKey },
        update: { value: String(tradovateEquity) },
        create: { key: startupSodKey, value: String(tradovateEquity) },
      });
      log(`[STARTUP] Saved ${MODE_TAG} SOD balance snapshot: $${tradovateEquity.toFixed(2)} (${today})`);
    } else {
      // SOD snapshot exists for today — make sure it matches
      const sodGlobal = await prisma.agentConfig.findUnique({ where: { key: startupSodKey } });
      if (!sodGlobal || sodGlobal.value !== existing.value) {
        await prisma.agentConfig.upsert({
          where: { key: startupSodKey },
          update: { value: existing.value },
          create: { key: startupSodKey, value: existing.value },
        });
        log(`[STARTUP] Synced ${MODE_TAG} SOD balance to today's snapshot: $${existing.value}`);
      }
    }
    // CRITICAL: restore the daily-loss-limit baseline across restarts/deploys. Without this,
    // startOfDayBalance stays 0 (gate falls back to live equity) and dailyPnl resets to 0 — so the
    // engine FORGETS accumulated intraday losses after every deploy and re-arms the loss limit.
    const sodNow = await prisma.agentConfig.findUnique({ where: { key: startupSodKey } });
    startOfDayBalance = parseFloat(sodNow?.value || "") || tradovateEquity;
    dailyPnl = tradovateEquity - startOfDayBalance; // balance-delta = realized intraday P&L
    log(`[STARTUP] Loss-limit baseline restored: SOD $${startOfDayBalance.toFixed(2)}, intraday P&L $${dailyPnl.toFixed(2)}`);
  } catch {}
  await updateVIX();
  log(`VIX: ${currentVIX.toFixed(1)}`);
  await updateEconomicCalendar();
  await updateCrossAssetSignals();
  await updateEarningsWeekFilter();
  await updateSectorRotation();

  // Engine mode set by ENGINE_MODE env var. Demo: 24/7 learning. Live: RTH prime only.

  // Start Tradovate WebSocket for real-time MD (requires CME data subscription)
  // Falls back to Yahoo polling if WebSocket fails — zero risk
  try {
    const wsSymbols = [...FULL_SIZE_SYMBOLS, ...MICRO_SYMBOLS]
      .map(sym => contracts.get(sym)?.name)
      .filter((n): n is string => !!n);
    if (wsSymbols.length > 0) {
      tradovateWS = new TradovateWebSocket({
        accessToken: await authenticate(),
        symbols: wsSymbols,
        useLive: IS_LIVE,
        logger: log,
        onQuote: (quote: QuoteUpdate) => {
          if (!wsConnected) {
            wsConnected = true;
            log("[WS-MD] First quote received — real-time streaming confirmed, Yahoo polling paused");
          }
          onPrice(quote.symbol, quote.price, quote.volume);
          tickCount++;
          lastTickCheckTime = Date.now();
        },
        onConnect: () => {
          // Don't set wsConnected here — wait for actual quote data
          log("[WS-MD] WebSocket authorized — waiting for first quote...");
        },
        onDisconnect: () => {
          wsConnected = false;
          log("[WS-MD] Disconnected — Yahoo polling resumed");
        },
        onError: (err) => {
          wsConnected = false;
          if (err.includes("inaccessible") || err.includes("UnknownSymbol")) {
            log("[WS-MD] CME market data not accessible via API — using Yahoo fallback. Contact Tradovate support.");
          } else {
            log("[WS-MD] Error: " + err);
          }
          tradovateWS?.destroy();
          tradovateWS = null;
        },
      });
      tradovateWS.connect();
      log("[WS-MD] WebSocket connecting... (Yahoo polling active as fallback)");
    }
  } catch (err) {
    log(`[WS-MD] Failed to start WebSocket: ${err} — Yahoo polling active`);
  }

  // Start Yahoo polling as fallback (pauses automatically when WebSocket is active)
  pollIntervalRef = safeInterval(pollPrices, POLL_INTERVAL_MS, "pollPrices");
  safeInterval(checkSessionReset, 60_000, "checkSessionReset");
  safeInterval(syncPositions, 30_000, "syncPositions");
  // No live position sync needed — each engine manages its own positions
  safeInterval(writeHeartbeat, 60_000, "writeHeartbeat");
  safeInterval(updateVIX, 300_000, "updateVIX");
  safeInterval(updateTradovateEquity, 600_000, "updateTradovateEquity"); // every 10min
  safeInterval(loadRiskConfig, 300_000, "loadRiskConfig"); // refresh risk rules from DB every 5min
  safeInterval(proactiveTokenRefresh, 600_000, "tokenRefresh"); // check token expiry every 10min
  // Mode is fixed by ENGINE_MODE env var — no polling needed
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
  // Load regime on startup
  try { await getCurrentRegime(); log(`[VAULT] Regime: ${cachedRegime}`); } catch {}
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
    // Refresh regime cache alongside lessons
    try { await getCurrentRegime(); } catch {}
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
// If main() hangs during startup (e.g. stuck Yahoo/Tradovate call), exit so Railway restarts.
// 6 minutes is generous: auth (up to 30s), preload bars (up to 2 min), cross-asset calls (60s).
const STARTUP_TIMEOUT_MS = 6 * 60_000;

(async function startWithRetry() {
  let restartCount = 0;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    // Arm a watchdog: if main() doesn't return within STARTUP_TIMEOUT_MS, exit for Railway restart
    const startupWatchdog = setTimeout(() => {
      log(`[STARTUP WATCHDOG] main() timed out after ${Math.round(STARTUP_TIMEOUT_MS / 60000)} min — exiting so Railway restarts the engine`);
      process.exit(1);
    }, STARTUP_TIMEOUT_MS);

    try {
      await main();
      clearTimeout(startupWatchdog); // startup succeeded — disarm
      break; // main() sets up intervals and returns — success
    } catch (err) {
      clearTimeout(startupWatchdog);
      restartCount++;
      const delay = Math.min(5000 * Math.pow(2, restartCount - 1), MAX_RESTART_DELAY);
      log(`[STARTUP] main() failed (attempt ${restartCount}): ${err}`);
      log(`[STARTUP] Retrying in ${Math.round(delay / 1000)}s...`);
      await new Promise(r => setTimeout(r, delay));
    }
  }
})();
