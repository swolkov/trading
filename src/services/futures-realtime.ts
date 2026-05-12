#!/usr/bin/env node
// ============ REAL-TIME FUTURES TRADING ENGINE ============
// Persistent process — connects to Tradovate WebSocket, streams quotes,
// builds bars, detects setups on bar close, executes instantly.
// Deploy on Railway (or any persistent Node.js host).

import WebSocket from "ws";

// ── Config ──────────────────────────────────────────────

const DEMO_API = "https://demo.tradovateapi.com/v1";
const LIVE_API = "https://live.tradovateapi.com/v1";

const MD_WS_DEMO = "wss://md-demo.tradovateapi.com/v1/websocket";
const MD_WS_LIVE = "wss://md.tradovateapi.com/v1/websocket";
let MD_WS_URL = MD_WS_DEMO;
const ORDER_API = DEMO_API;
let authApiUrl = DEMO_API; // Start with demo auth, can switch to live

const SYMBOLS = ["MES", "MNQ", "MYM", "M2K"];
const BAR_INTERVAL_MS = 5 * 60 * 1000; // 5-minute bars

// ── Tradovate Auth ──────────────────────────────────────

let accessToken = "";
let mdAccessToken = ""; // separate token for market data WebSocket
let tokenExpires = 0;
let accountId = 0;
let accountName = "";

async function authenticate(): Promise<string> {
  if (accessToken && Date.now() < tokenExpires) return accessToken;

  const res = await fetch(`${authApiUrl}/auth/accesstokenrequest`, {
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

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Auth failed (${res.status}): ${body}`);
  }

  const data = await res.json();
  accessToken = data.accessToken;
  // Tradovate returns separate mdAccessToken for market data WebSocket
  if (data.mdAccessToken) {
    mdAccessToken = data.mdAccessToken;
    log(`Got separate mdAccessToken for market data`);
  } else {
    mdAccessToken = accessToken;
  }
  tokenExpires = Date.now() + 23 * 60 * 60 * 1000;

  // Get account
  const accounts = await apiFetch("/account/list") as { id: number; name: string; active: boolean }[];
  const active = accounts.find((a) => a.active) || accounts[0];
  if (active) {
    accountId = active.id;
    accountName = active.name;
  }

  log(`Authenticated — Account: ${accountName} (#${accountId})`);
  return accessToken;
}

async function apiFetch(path: string, options?: RequestInit): Promise<unknown> {
  const token = await authenticate();
  // Orders/positions use DEMO, everything else uses current auth API
  const base = path.startsWith("/order") || path.startsWith("/position") || path.startsWith("/account") || path.startsWith("/cashBalance")
    ? ORDER_API
    : authApiUrl;
  const res = await fetch(`${base}${path}`, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
      ...options?.headers,
    },
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`API ${res.status}: ${body}`);
  }
  return res.json();
}

// ── Logging ──────────────────────────────────────────────

function log(msg: string) {
  const ts = new Date().toISOString().replace("T", " ").slice(0, 19);
  console.log(`[${ts}] ${msg}`);
}

// ── Contract Resolution ──────────────────────────────────

interface ContractInfo {
  id: number;
  name: string;
  tickSize: number;
  symbol: string; // our symbol (MES, MNQ, etc.)
}

const contracts: Map<string, ContractInfo> = new Map();

async function resolveContracts() {
  for (const sym of SYMBOLS) {
    try {
      const results = await apiFetch(`/contract/suggest?t=${sym}&l=5`) as {
        id: number; name: string; tickSize: number; providerTickSize: number;
      }[];
      if (results.length > 0) {
        contracts.set(sym, {
          id: results[0].id,
          name: results[0].name,
          tickSize: results[0].providerTickSize || results[0].tickSize,
          symbol: sym,
        });
        log(`Resolved ${sym} → ${results[0].name} (ID: ${results[0].id})`);
      }
    } catch (err) {
      log(`Failed to resolve ${sym}: ${err}`);
    }
  }
}

// ── Technical Indicators ────────────────────────────────

function ema(data: number[], period: number): number[] {
  if (data.length === 0) return [];
  const k = 2 / (period + 1);
  const result = [data[0]];
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

function atr(bars: Bar[], period = 14): number {
  if (bars.length < period + 1) return 0;
  const trs: number[] = [];
  for (let i = bars.length - period; i < bars.length; i++) {
    trs.push(Math.max(bars[i].h - bars[i].l, Math.abs(bars[i].h - bars[i - 1].c), Math.abs(bars[i].l - bars[i - 1].c)));
  }
  return trs.reduce((a, b) => a + b, 0) / trs.length;
}

function calcVwap(bars: Bar[]): { vwap: number; upper: number; lower: number } {
  let cumPV = 0, cumV = 0, cumPV2 = 0;
  for (const b of bars) {
    const tp = (b.h + b.l + b.c) / 3;
    cumPV += tp * b.v;
    cumPV2 += tp * tp * b.v;
    cumV += b.v;
  }
  const v = cumV > 0 ? cumPV / cumV : 0;
  const variance = cumV > 0 ? (cumPV2 / cumV) - v * v : 0;
  const sd = Math.sqrt(Math.max(0, variance));
  return { vwap: v, upper: v + sd, lower: v - sd };
}

// ── Bar Building ────────────────────────────────────────

interface Bar {
  t: number; // unix seconds
  o: number;
  h: number;
  l: number;
  c: number;
  v: number;
}

interface Quote {
  contractId: number;
  symbol: string;
  price: number;
  bid: number;
  ask: number;
  volume: number;
  timestamp: number;
}

// Per-symbol bar builders
const barBuilders: Map<string, {
  currentBar: Bar | null;
  bars5m: Bar[];       // rolling 5-min bars (last 200)
  lastQuote: Quote | null;
  sessionBars: Bar[];  // today's bars for VWAP
  prevDayHigh: number;
  prevDayLow: number;
  prevDayClose: number;
  openingRangeHigh: number;
  openingRangeLow: number;
  barCount: number;     // bars since session open
}> = new Map();

function initBarBuilder(symbol: string) {
  barBuilders.set(symbol, {
    currentBar: null,
    bars5m: [],
    lastQuote: null,
    sessionBars: [],
    prevDayHigh: 0,
    prevDayLow: 0,
    prevDayClose: 0,
    openingRangeHigh: 0,
    openingRangeLow: 0,
    barCount: 0,
  });
}

function getBarPeriodStart(timestamp: number): number {
  return Math.floor(timestamp / (BAR_INTERVAL_MS / 1000)) * (BAR_INTERVAL_MS / 1000);
}

function onQuote(quote: Quote) {
  const builder = barBuilders.get(quote.symbol);
  if (!builder) return;

  builder.lastQuote = quote;
  const periodStart = getBarPeriodStart(quote.timestamp);

  if (!builder.currentBar || builder.currentBar.t !== periodStart) {
    // New bar period — close previous bar and start new one
    if (builder.currentBar) {
      // Previous bar is complete
      const completedBar = { ...builder.currentBar };
      builder.bars5m.push(completedBar);
      builder.sessionBars.push(completedBar);
      if (builder.bars5m.length > 200) builder.bars5m.shift();
      builder.barCount++;

      // Update opening range (first 3 bars = 15 min)
      if (builder.barCount <= 3) {
        builder.openingRangeHigh = Math.max(builder.openingRangeHigh, completedBar.h);
        builder.openingRangeLow = builder.openingRangeLow === 0
          ? completedBar.l
          : Math.min(builder.openingRangeLow, completedBar.l);
      }

      // ──── BAR CLOSE — RUN SETUP DETECTION ────
      onBarClose(quote.symbol, completedBar);
    }

    // Start new bar
    builder.currentBar = {
      t: periodStart,
      o: quote.price,
      h: quote.price,
      l: quote.price,
      c: quote.price,
      v: 0,
    };
  } else {
    // Update current bar
    builder.currentBar.h = Math.max(builder.currentBar.h, quote.price);
    builder.currentBar.l = Math.min(builder.currentBar.l, quote.price);
    builder.currentBar.c = quote.price;
    builder.currentBar.v += quote.volume;
  }

  // ──── TICK-BY-TICK POSITION MANAGEMENT ────
  checkPositions(quote);
}

// ── Session Management ──────────────────────────────────

function isRTH(): boolean {
  const now = new Date();
  const utcH = now.getUTCHours() + now.getUTCMinutes() / 60;
  return utcH >= 13.5 && utcH < 20;
}

function getSessionName(): string {
  const now = new Date();
  const utcH = now.getUTCHours() + now.getUTCMinutes() / 60;
  if (utcH >= 21 && utcH < 22) return "halt";
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
  const utcH = now.getUTCHours() + now.getUTCMinutes() / 60;
  return Math.max(0, (utcH - 13.5) * 60);
}

function getSizeMultiplier(): number {
  const session = getSessionName();
  if (session === "morning") return 1.0;
  if (session === "afternoon") return 0.8;
  if (session === "midday") return 0.5;
  if (session === "eth_europe") return 0.6;
  if (session === "eth_evening") return 0.4;
  if (session === "eth_asia") return 0.3;
  if (session === "close" || session === "halt" || session === "open") return 0;
  return 0.7;
}

// ── Daily Session Reset ─────────────────────────────────

function checkSessionReset() {
  const now = new Date();
  const utcH = now.getUTCHours();
  const utcM = now.getUTCMinutes();

  // Reset at RTH open (13:30 UTC = 9:30 AM ET)
  if (utcH === 13 && utcM >= 29 && utcM <= 31) {
    for (const [sym, builder] of barBuilders) {
      // Save previous day levels from session bars
      if (builder.sessionBars.length > 0) {
        builder.prevDayHigh = Math.max(...builder.sessionBars.map((b) => b.h));
        builder.prevDayLow = Math.min(...builder.sessionBars.map((b) => b.l));
        builder.prevDayClose = builder.sessionBars[builder.sessionBars.length - 1].c;
      }
      builder.sessionBars = [];
      builder.openingRangeHigh = 0;
      builder.openingRangeLow = 0;
      builder.barCount = 0;
      log(`Session reset for ${sym} — PDH: ${builder.prevDayHigh.toFixed(2)} PDL: ${builder.prevDayLow.toFixed(2)}`);
    }
    dailyTradeCount = 0;
    dailyPnl = 0;
  }
}

// ── Position Tracking ───────────────────────────────────

interface Position {
  symbol: string;
  contractId: number;
  direction: "long" | "short";
  quantity: number;
  entryPrice: number;
  stopLoss: number;
  target: number;
  trailStop: number | null;
  reachedBreakeven: boolean;
  scaledOut: boolean;
  entryTime: number;
  stopOrderId: number | null;
  targetOrderId: number | null;
}

const positions: Map<string, Position> = new Map();
let dailyTradeCount = 0;
let dailyPnl = 0;

const CONTRACT_MULTIPLIERS: Record<string, number> = {
  MES: 5, MNQ: 2, MYM: 0.5, M2K: 5,
};

function checkPositions(quote: Quote) {
  const pos = positions.get(quote.symbol);
  if (!pos) return;

  const price = quote.price;
  const multiplier = CONTRACT_MULTIPLIERS[quote.symbol] || 5;
  const priceDiff = pos.direction === "long" ? price - pos.entryPrice : pos.entryPrice - price;
  const stopDist = Math.abs(pos.entryPrice - pos.stopLoss);

  // ── TRAILING STOP (tick-by-tick) ──
  if (priceDiff >= stopDist * 2 && !pos.reachedBreakeven) {
    pos.reachedBreakeven = true;
    log(`${quote.symbol}: Reached 2R — breakeven flag set`);
  }

  if (priceDiff >= stopDist * 2) {
    const currentATRVal = atr(barBuilders.get(quote.symbol)?.bars5m || []);
    if (currentATRVal > 0) {
      const newTrail = pos.direction === "long"
        ? price - currentATRVal
        : price + currentATRVal;

      // Only tighten the trail, never widen
      if (!pos.trailStop ||
        (pos.direction === "long" && newTrail > pos.trailStop) ||
        (pos.direction === "short" && newTrail < pos.trailStop)) {
        pos.trailStop = newTrail;
      }
    }
  }

  // ── CHECK TRAIL HIT ──
  if (pos.trailStop) {
    const trailHit = pos.direction === "long"
      ? price <= pos.trailStop
      : price >= pos.trailStop;

    if (trailHit) {
      const pnl = priceDiff * multiplier * pos.quantity;
      log(`${quote.symbol}: TRAIL STOP HIT at $${price.toFixed(2)} (trail: $${pos.trailStop.toFixed(2)}). P&L: $${pnl.toFixed(0)}`);
      closePosition(quote.symbol, price, "trail_stop");
      return;
    }
  }

  // ── BREAKEVEN STOP ──
  if (pos.reachedBreakeven && priceDiff <= 0) {
    const pnl = priceDiff * multiplier * pos.quantity;
    log(`${quote.symbol}: BREAKEVEN STOP — was at 2R+, pulled back. P&L: $${pnl.toFixed(0)}`);
    closePosition(quote.symbol, price, "breakeven");
    return;
  }

  // ── EMERGENCY DRAWDOWN ──
  const unrealizedPnl = priceDiff * multiplier * pos.quantity;
  if (unrealizedPnl < -500) { // $500 emergency stop per position
    log(`${quote.symbol}: EMERGENCY CLOSE — unrealized $${unrealizedPnl.toFixed(0)}`);
    closePosition(quote.symbol, price, "emergency");
    return;
  }
}

async function closePosition(symbol: string, price: number, reason: string) {
  const pos = positions.get(symbol);
  if (!pos) return;

  const multiplier = CONTRACT_MULTIPLIERS[symbol] || 5;
  const priceDiff = pos.direction === "long" ? price - pos.entryPrice : pos.entryPrice - price;
  const pnl = priceDiff * multiplier * pos.quantity;

  try {
    // Cancel existing stop/target orders
    if (pos.stopOrderId) try { await cancelOrderById(pos.stopOrderId); } catch {}
    if (pos.targetOrderId) try { await cancelOrderById(pos.targetOrderId); } catch {}

    // Market close
    await apiFetch("/order/placeorder", {
      method: "POST",
      body: JSON.stringify({
        accountSpec: accountName,
        accountId,
        action: pos.direction === "long" ? "Sell" : "Buy",
        symbol: pos.contractId,
        orderQty: pos.quantity,
        orderType: "Market",
        timeInForce: "Day",
        isAutomated: true,
      }),
    });

    dailyPnl += pnl;
    log(`CLOSED ${symbol}: ${reason} | P&L: $${pnl.toFixed(0)} | Daily: $${dailyPnl.toFixed(0)}`);
    positions.delete(symbol);
  } catch (err) {
    log(`Failed to close ${symbol}: ${err}`);
  }
}

async function cancelOrderById(orderId: number) {
  await apiFetch("/order/cancelorder", {
    method: "POST",
    body: JSON.stringify({ orderId }),
  });
}

// ── Setup Detection (on each 5-min bar close) ───────────

function onBarClose(symbol: string, bar: Bar) {
  const builder = barBuilders.get(symbol);
  if (!builder || builder.bars5m.length < 25) return;

  const session = getSessionName();
  const sizeMult = getSizeMultiplier();
  if (sizeMult === 0) return; // Don't trade during halt/close/open

  // Don't open new if already in position for this symbol
  if (positions.has(symbol)) return;

  // Daily limits
  if (dailyTradeCount >= 6) return;
  if (dailyPnl < -500) { // $500 daily loss limit on demo
    return;
  }

  const bars = builder.bars5m;
  const closes = bars.map((b) => b.c);
  const price = bar.c;
  const currentATR = atr(bars);
  if (currentATR <= 0) return;

  const currentRSI = rsi(closes) || 50;
  const emaFast = ema(closes, 9);
  const emaSlow = ema(closes, 21);
  const fastEMA = emaFast[emaFast.length - 1];
  const slowEMA = emaSlow[emaSlow.length - 1];

  // Session VWAP
  const vwapData = builder.sessionBars.length >= 3
    ? calcVwap(builder.sessionBars)
    : calcVwap(bars.slice(-78));

  // Volume analysis
  const last20 = bars.slice(-20);
  const avgVol = last20.reduce((s, b) => s + b.v, 0) / 20;
  const volRatio = avgVol > 0 ? bar.v / avgVol : 1;
  const volTrend = volRatio > 2 ? "surge" : volRatio > 1.3 ? "rising" : volRatio < 0.6 ? "dry" : volRatio < 0.8 ? "declining" : "normal";

  // Day type
  const orSize = builder.openingRangeHigh - builder.openingRangeLow;
  const outsidePrevRange = (builder.prevDayHigh > 0 && price > builder.prevDayHigh) || (builder.prevDayLow > 0 && price < builder.prevDayLow);
  const dayType = outsidePrevRange || orSize > currentATR * 0.5 ? "trend" : "range";

  // ── SETUP 1: OPENING RANGE BREAKOUT (trend days, morning) ──
  if ((dayType === "trend") && session === "morning" && builder.openingRangeHigh > 0 && orSize > currentATR * 0.3) {
    if (price > builder.openingRangeHigh && volRatio > 1.5) {
      executeTrade(symbol, "long", price, currentATR, orSize, sizeMult,
        `OR breakout long: $${price.toFixed(2)} > OR high $${builder.openingRangeHigh.toFixed(2)}, vol ${volRatio.toFixed(1)}x`);
      return;
    }
    if (price < builder.openingRangeLow && volRatio > 1.5) {
      executeTrade(symbol, "short", price, currentATR, orSize, sizeMult,
        `OR breakout short: $${price.toFixed(2)} < OR low $${builder.openingRangeLow.toFixed(2)}, vol ${volRatio.toFixed(1)}x`);
      return;
    }
  }

  // ── SETUP 2: TREND CONTINUATION (pullback to EMA9) ──
  if ((dayType === "trend" || (fastEMA > slowEMA && Math.abs(fastEMA - slowEMA) / price > 0.001)) &&
      (session === "morning" || session === "afternoon" || session === "eth_europe")) {
    const nearEMA = Math.abs(price - fastEMA) / price < 0.003;
    if (nearEMA && fastEMA > slowEMA && price > slowEMA && currentRSI > 35 && currentRSI < 65 && volTrend !== "surge") {
      executeTrade(symbol, "long", price, currentATR, currentATR * 2.5, sizeMult,
        `Trend continuation long: near EMA9 $${fastEMA.toFixed(2)}, RSI ${currentRSI.toFixed(0)}, vol ${volTrend}`);
      return;
    }
    if (nearEMA && fastEMA < slowEMA && price < slowEMA && currentRSI > 35 && currentRSI < 65 && volTrend !== "surge") {
      executeTrade(symbol, "short", price, currentATR, currentATR * 2.5, sizeMult,
        `Trend continuation short: near EMA9 $${fastEMA.toFixed(2)}, RSI ${currentRSI.toFixed(0)}, vol ${volTrend}`);
      return;
    }
  }

  // ── SETUP 3: VWAP MEAN REVERSION (range days) ──
  if (dayType === "range" && (session === "morning" || session === "midday" || session === "afternoon")) {
    const targetDist = Math.abs(price - vwapData.vwap) * 0.8;
    if (targetDist > currentATR * 0.3) {
      if (price > vwapData.upper && currentRSI > 65 && volTrend !== "surge") {
        executeTrade(symbol, "short", price, currentATR * 1.2, targetDist, sizeMult,
          `VWAP fade short: $${price.toFixed(2)} > upper $${vwapData.upper.toFixed(2)}, RSI ${currentRSI.toFixed(0)}`);
        return;
      }
      if (price < vwapData.lower && currentRSI < 35 && volTrend !== "surge") {
        executeTrade(symbol, "long", price, currentATR * 1.2, targetDist, sizeMult,
          `VWAP fade long: $${price.toFixed(2)} < lower $${vwapData.lower.toFixed(2)}, RSI ${currentRSI.toFixed(0)}`);
        return;
      }
    }
  }
}

// ── Trade Execution ─────────────────────────────────────

async function executeTrade(
  symbol: string,
  direction: "long" | "short",
  price: number,
  stopDist: number,
  targetDist: number,
  sizeMult: number,
  reasoning: string,
) {
  const contract = contracts.get(symbol);
  if (!contract) return;

  const multiplier = CONTRACT_MULTIPLIERS[symbol] || 5;

  // Position sizing: risk 0.2% of equity per trade, scaled by time-of-day
  const equity = 50000; // Demo account — will fetch dynamically later
  const maxRisk = equity * 0.002 * sizeMult;
  const riskPerContract = stopDist * multiplier;
  const qty = Math.max(1, Math.min(10, Math.floor(maxRisk / riskPerContract)));

  const stopPrice = direction === "long" ? price - stopDist : price + stopDist;
  const targetPrice = direction === "long" ? price + targetDist : price - targetDist;
  const rr = targetDist / stopDist;

  if (rr < 1.5) {
    log(`${symbol}: R:R ${rr.toFixed(1)} too low — skipping`);
    return;
  }

  const side = direction === "long" ? "Buy" : "Sell";
  const closeSide = direction === "long" ? "Sell" : "Buy";

  log(`\n${"=".repeat(60)}`);
  log(`TRADE: ${side} ${qty}x ${symbol} @ $${price.toFixed(2)}`);
  log(`  Stop: $${stopPrice.toFixed(2)} | Target: $${targetPrice.toFixed(2)} | R:R: ${rr.toFixed(1)}`);
  log(`  Risk: $${(riskPerContract * qty).toFixed(0)} | Size mult: ${sizeMult}`);
  log(`  ${reasoning}`);
  log(`${"=".repeat(60)}\n`);

  try {
    const accounts = await apiFetch("/account/list") as { id: number; name: string }[];
    const acct = accounts.find((a) => a.id === accountId) || accounts[0];

    // Entry order (market for immediate fill)
    const entry = await apiFetch("/order/placeorder", {
      method: "POST",
      body: JSON.stringify({
        accountSpec: acct.name,
        accountId,
        action: side,
        symbol: contract.id,
        orderQty: qty,
        orderType: "Market",
        timeInForce: "Day",
        isAutomated: true,
      }),
    }) as { orderId: number };

    // Wait for fill
    await new Promise((r) => setTimeout(r, 1500));

    // Stop loss
    let stopOrderId: number | null = null;
    try {
      const stop = await apiFetch("/order/placeorder", {
        method: "POST",
        body: JSON.stringify({
          accountSpec: acct.name,
          accountId,
          action: closeSide,
          symbol: contract.id,
          orderQty: qty,
          orderType: "Stop",
          stopPrice,
          timeInForce: "GTC",
          isAutomated: true,
        }),
      }) as { orderId: number };
      stopOrderId = stop.orderId;
    } catch {}

    // Take profit
    let targetOrderId: number | null = null;
    try {
      const target = await apiFetch("/order/placeorder", {
        method: "POST",
        body: JSON.stringify({
          accountSpec: acct.name,
          accountId,
          action: closeSide,
          symbol: contract.id,
          orderQty: qty,
          orderType: "Limit",
          price: targetPrice,
          timeInForce: "GTC",
          isAutomated: true,
        }),
      }) as { orderId: number };
      targetOrderId = target.orderId;
    } catch {}

    // Track position
    positions.set(symbol, {
      symbol,
      contractId: contract.id,
      direction,
      quantity: qty,
      entryPrice: price,
      stopLoss: stopPrice,
      target: targetPrice,
      trailStop: null,
      reachedBreakeven: false,
      scaledOut: false,
      entryTime: Date.now(),
      stopOrderId,
      targetOrderId,
    });

    dailyTradeCount++;
    log(`Order placed: #${entry.orderId} | Stop: #${stopOrderId} | Target: #${targetOrderId}`);
  } catch (err) {
    log(`TRADE FAILED: ${err}`);
  }
}

// ── WebSocket Connection ────────────────────────────────
// Tradovate uses a CUSTOM framing protocol:
//   "o"        = server open frame (send auth after this)
//   "h"        = server heartbeat
//   "a[...]"   = data frame (strip "a", JSON.parse the array)
// Client sends "[]" every 2.5s as heartbeat.

let ws: WebSocket | null = null;
let wsHeartbeat: ReturnType<typeof setInterval> | null = null;
let wsAuthorized = false;
let lastServerMessage = Date.now();
let wsReqId = 2; // 0=authorize, 1=reserved, 2+=requests

function connectWebSocket() {
  log("Connecting to Tradovate WebSocket...");
  wsAuthorized = false;

  ws = new WebSocket(MD_WS_URL);

  ws.on("open", () => {
    log("WebSocket TCP connected — waiting for server open frame...");
  });

  ws.on("message", (data: Buffer) => {
    const raw = data.toString();
    lastServerMessage = Date.now();

    // ── "o" frame = server ready, send authorization ──
    if (raw === "o") {
      log("Server open frame received — sending authorization...");
      ws!.send(`authorize\n0\n\n${mdAccessToken}`);
      return;
    }

    // ── "h" frame = server heartbeat ──
    if (raw === "h") {
      return; // just update lastServerMessage timestamp
    }

    // ── "a[...]" frame = data array ──
    if (raw.startsWith("a")) {
      const jsonStr = raw.slice(1); // strip the "a" prefix
      try {
        const messages = JSON.parse(jsonStr) as Record<string, unknown>[];
        // Log first 20 frames for debugging, then only errors/trades
        if (tickCount < 5) {
          log(`WS FRAME: ${raw.slice(0, 300)}`);
        }
        for (const msg of messages) {
          handleWsMessage(msg);
        }
      } catch (err) {
        log(`WS PARSE ERROR: ${raw.slice(0, 200)}`);
      }
      return;
    }

    // Log unknown frame types for debugging
    if (raw.length > 0 && raw.length < 200) {
      log(`WS UNKNOWN FRAME: "${raw.slice(0, 100)}"`);
    }
  });

  ws.on("close", (code: number) => {
    log(`WebSocket closed (${code}) — reconnecting in 5s`);
    cleanup();
    setTimeout(connectWebSocket, 5000);
  });

  ws.on("error", (err: Error) => {
    log(`WebSocket error: ${err.message}`);
  });
}

function cleanup() {
  if (wsHeartbeat) clearInterval(wsHeartbeat);
  wsHeartbeat = null;
  wsAuthorized = false;
}

function handleWsMessage(msg: Record<string, unknown>) {
  // ── Response to a request (has "i" = request ID, "s" = status) ──
  if ("i" in msg && "s" in msg) {
    const reqId = msg.i as number;
    const status = msg.s as number;

    // Auth response
    if (reqId === 0) {
      if (status === 200) {
        log("WebSocket AUTHORIZED — subscribing to market data...");
        wsAuthorized = true;

        // Start client heartbeat (every 2.5s)
        if (!wsHeartbeat) {
          wsHeartbeat = setInterval(() => {
            if (ws?.readyState === WebSocket.OPEN) {
              ws.send("[]");
            }
            // Check for server silence (>10s = dead connection)
            if (Date.now() - lastServerMessage > 10000) {
              log("Server silent for 10s — reconnecting");
              ws?.close();
            }
          }, 2500);
        }

        // Subscribe to quotes for all resolved contracts
        for (const [sym, contract] of contracts) {
          const id = wsReqId++;
          // Use contract ID (number) instead of name — more reliable
          ws!.send(`md/subscribeQuote\n${id}\n\n{"symbol":${contract.id}}`);
          log(`Subscribing to ${contract.name} (${sym}) ID:${contract.id} — req #${id}`);
        }
      } else {
        log(`WebSocket auth FAILED (status ${status}): ${JSON.stringify(msg)}`);
      }
      return;
    }

    // Subscription response
    if (msg.d) {
      const d = msg.d as Record<string, unknown>;
      if (d.subscriptionId) {
        log(`Subscription confirmed — req #${reqId}, subscriptionId: ${d.subscriptionId}`);
      } else if (d.errorCode === "UnknownSymbol") {
        if (MD_WS_URL === MD_WS_DEMO) {
          log(`Demo MD rejected symbol — switching to LIVE market data...`);
          MD_WS_URL = MD_WS_LIVE;
          authApiUrl = LIVE_API;
          accessToken = "";
          mdAccessToken = "";
          tokenExpires = 0;
          ws?.close();
          return;
        }
        // Live also rejected — try subscribing by contract NAME instead of ID
        log(`Live MD also rejected ID — trying contract name string...`);
        for (const [sym, contract] of contracts) {
          const id = wsReqId++;
          ws!.send(`md/subscribeQuote\n${id}\n\n{"symbol":"${contract.name}"}`);
          log(`Retry subscribe by name: ${contract.name} — req #${id}`);
        }
        return;
      } else if (d.errorText) {
        log(`Subscription error req #${reqId}: ${d.errorText}`);
      }
    }
    return;
  }

  // ── Event message (has "e" = event type) ──
  if ("e" in msg) {
    const eventType = msg.e as string;

    if (eventType === "md" && msg.d) {
      // Market data event
      const d = msg.d as { quotes?: QuoteUpdate[] };
      if (d.quotes && Array.isArray(d.quotes)) {
        for (const quote of d.quotes) {
          processQuoteUpdate(quote);
        }
      }
    }
  }
}

interface QuoteUpdate {
  timestamp?: string;
  contractId: number;
  entries: Record<string, { price?: number; size?: number }>;
}

function processQuoteUpdate(quote: QuoteUpdate) {
  // Find which symbol this contractId maps to
  let sym: string | null = null;
  for (const [s, c] of contracts) {
    if (c.id === quote.contractId) {
      sym = s;
      break;
    }
  }
  if (!sym) return;

  const entries = quote.entries || {};

  // Extract trade price (most important for bar building)
  const trade = entries.Trade || entries.Bid || entries.Offer;
  if (!trade?.price) return;

  const bid = entries.Bid?.price || 0;
  const ask = entries.Offer?.price || 0;
  const volume = entries.Trade?.size || 0;

  tickCount++;
  onQuote({
    contractId: quote.contractId,
    symbol: sym,
    price: trade.price,
    bid,
    ask,
    volume,
    timestamp: quote.timestamp
      ? Math.floor(new Date(quote.timestamp).getTime() / 1000)
      : Math.floor(Date.now() / 1000),
  });
}

// ── Heartbeat (write to DB so Vercel cron knows we're alive) ──

let tickCount = 0;

async function writeHeartbeat() {
  try {
    // Use direct SQL since we don't want full Prisma setup in this service
    const dbUrl = process.env.DATABASE_URL;
    if (!dbUrl) return;

    const res = await fetch(dbUrl.includes("neon.tech")
      ? `https://ep-jolly-field-anjir64r-pooler.c-6.us-east-1.aws.neon.tech/sql`
      : dbUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Neon-Connection-String": dbUrl },
      body: JSON.stringify({
        query: `INSERT INTO "AgentConfig" (key, value) VALUES ('futures_engine_heartbeat', $1)
                ON CONFLICT (key) DO UPDATE SET value = $1`,
        params: [new Date().toISOString()],
      }),
    });
    if (!res.ok) {
      // Fallback: just log, don't crash
    }
  } catch {
    // Heartbeat is best-effort — don't crash the engine
  }
}

// ── Position Sync (periodic check against Tradovate) ────

async function syncPositions() {
  try {
    const tvPositions = await apiFetch("/position/list") as {
      id: number; contractId: number; netPos: number; netPrice: number;
    }[];

    for (const tvPos of tvPositions) {
      if (tvPos.netPos === 0) continue;
      // Check if we're tracking this position
      let found = false;
      for (const [, pos] of positions) {
        if (pos.contractId === tvPos.contractId) {
          found = true;
          break;
        }
      }
      if (!found) {
        // Position exists on Tradovate but not in our tracker — log it
        log(`SYNC: Untracked position found — contractId ${tvPos.contractId}, qty ${tvPos.netPos}`);
      }
    }

    // Check if our tracked positions still exist
    for (const [sym, pos] of positions) {
      const exists = tvPositions.find((p) => p.contractId === pos.contractId && p.netPos !== 0);
      if (!exists) {
        // Position was closed (by stop/target at exchange)
        log(`SYNC: Position ${sym} no longer exists — removed from tracker (stop/target hit at exchange)`);
        positions.delete(sym);
      }
    }
  } catch (err) {
    log(`Position sync failed: ${err}`);
  }
}

// ── Main Entry Point ────────────────────────────────────

async function main() {
  log("╔══════════════════════════════════════════════╗");
  log("║  ESBUENO FUTURES — REAL-TIME TRADING ENGINE  ║");
  log("╚══════════════════════════════════════════════╝");
  log(`Mode: DEMO orders / LIVE market data`);
  log(`Symbols: ${SYMBOLS.join(", ")}`);
  log(`Bar interval: ${BAR_INTERVAL_MS / 1000}s`);

  // Authenticate
  await authenticate();

  // Resolve contracts
  await resolveContracts();

  // Init bar builders
  for (const sym of SYMBOLS) initBarBuilder(sym);

  // Connect WebSocket (will auto-fallback demo→live if needed)
  connectWebSocket();

  // If we later switch to live MD, re-resolve contracts against live
  const origResolve = resolveContracts;
  const reconnectWithLiveContracts = async () => {
    if (authApiUrl === LIVE_API && contracts.size > 0) {
      log("Re-resolving contracts against LIVE API...");
      contracts.clear();
      await resolveContracts();
    }
  };
  // Check every 10s if we switched to live and need to re-resolve
  setInterval(async () => {
    if (authApiUrl === LIVE_API && !wsAuthorized) {
      await reconnectWithLiveContracts();
    }
  }, 10000);

  // Periodic tasks
  setInterval(checkSessionReset, 60_000);     // Check session reset every minute
  setInterval(syncPositions, 30_000);          // Sync positions every 30s
  setInterval(writeHeartbeat, 60_000);         // Write heartbeat to DB every minute

  // Status log every 2 minutes
  setInterval(() => {
    const session = getSessionName();
    const posCount = positions.size;
    const quoteCounts = [...barBuilders.entries()].map(([sym, b]) => {
      const lastPrice = b.lastQuote?.price ? `$${b.lastQuote.price.toFixed(2)}` : "—";
      return `${sym}:${b.bars5m.length}bars/${lastPrice}`;
    }).join(" ");
    log(`STATUS: ${session.toUpperCase()} | Ticks: ${tickCount} | Positions: ${posCount} | P&L: $${dailyPnl.toFixed(0)} | Trades: ${dailyTradeCount}/6 | ${quoteCounts}`);
  }, 120_000);

  log("Engine started — waiting for market data...");
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
