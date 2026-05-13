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

// ── Config ──────────────────────────────────────────────

const DEMO_API = "https://demo.tradovateapi.com/v1";
const ORDER_API = DEMO_API;
const POLL_INTERVAL_MS = 5000; // Poll Yahoo every 5 seconds
const BAR_INTERVAL_MS = 5 * 60 * 1000; // 5-minute bars

const SYMBOLS = ["MES", "MNQ", "MYM", "M2K"];
const YAHOO_MAP: Record<string, string> = {
  MES: "ES=F", MNQ: "NQ=F", MYM: "YM=F", M2K: "RTY=F",
};
const CONTRACT_MULTIPLIERS: Record<string, number> = {
  MES: 5, MNQ: 2, MYM: 0.5, M2K: 5,
};

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
  const res = await fetch(`${ORDER_API}${path}`, {
    ...options,
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}`, ...options?.headers },
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) throw new Error(`API ${res.status}: ${await res.text().catch(() => "")}`);
  return res.json();
}

function log(msg: string) {
  const ts = new Date().toISOString().replace("T", " ").slice(0, 19);
  console.log(`[${ts}] ${msg}`);
}

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
      b.barCount++;

      if (b.barCount <= 3) {
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
  try {
    const yahooSymbols = SYMBOLS.map(s => YAHOO_MAP[s]);
    const quotes = await yfEngine.quote(yahooSymbols);
    const arr = Array.isArray(quotes) ? quotes : [quotes];

    for (let i = 0; i < SYMBOLS.length; i++) {
      const q = arr[i];
      if (q?.regularMarketPrice) {
        onPrice(SYMBOLS[i], q.regularMarketPrice, q.regularMarketVolume || 0);
      }
    }
  } catch (err) {
    // Yahoo occasionally fails — just skip this poll
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

function getSizeMultiplier(): number {
  const s = getSessionName();
  if (s === "morning") return 1.0;
  if (s === "afternoon") return 0.8;
  if (s === "midday") return 0.5;
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
    dailyTradeCount = 0; dailyPnl = 0;
  }
}

// ── Position Tracking ───────────────────────────────────

interface Position {
  symbol: string; contractId: number; direction: "long" | "short";
  quantity: number; entryPrice: number; stopLoss: number; target: number;
  trailStop: number | null; reachedBreakeven: boolean;
  stopOrderId: number | null; targetOrderId: number | null;
  entryTime: number;
}

const positions: Map<string, Position> = new Map();
let dailyTradeCount = 0;
let dailyPnl = 0;

function checkPositions(sym: string, price: number) {
  const pos = positions.get(sym);
  if (!pos) return;

  const mult = CONTRACT_MULTIPLIERS[sym] || 5;
  const diff = pos.direction === "long" ? price - pos.entryPrice : pos.entryPrice - price;
  const stopDist = Math.abs(pos.entryPrice - pos.stopLoss);

  // Trailing stop at 2R+
  if (diff >= stopDist * 2) {
    if (!pos.reachedBreakeven) { pos.reachedBreakeven = true; log(`${sym}: Reached 2R — breakeven active`); }
    const currentATRVal = atr(barBuilders.get(sym)?.bars5m || []);
    if (currentATRVal > 0) {
      const trail = pos.direction === "long" ? price - currentATRVal : price + currentATRVal;
      if (!pos.trailStop || (pos.direction === "long" ? trail > pos.trailStop : trail < pos.trailStop)) {
        pos.trailStop = trail;
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

  // Breakeven stop
  if (pos.reachedBreakeven && diff <= 0) {
    log(`${sym}: BREAKEVEN STOP. P&L: $${(diff * mult * pos.quantity).toFixed(0)}`);
    closePosition(sym, price, "breakeven"); return;
  }

  // Emergency
  if (diff * mult * pos.quantity < -500) {
    log(`${sym}: EMERGENCY CLOSE $${(diff * mult * pos.quantity).toFixed(0)}`);
    closePosition(sym, price, "emergency"); return;
  }
}

async function closePosition(sym: string, price: number, reason: string) {
  const pos = positions.get(sym);
  if (!pos) return;
  const mult = CONTRACT_MULTIPLIERS[sym] || 5;
  const diff = pos.direction === "long" ? price - pos.entryPrice : pos.entryPrice - price;
  const pnl = diff * mult * pos.quantity;

  try {
    // Cancel bracket orders
    if (pos.stopOrderId) try { await apiFetch("/order/cancelorder", { method: "POST", body: JSON.stringify({ orderId: pos.stopOrderId }) }); } catch {}
    if (pos.targetOrderId) try { await apiFetch("/order/cancelorder", { method: "POST", body: JSON.stringify({ orderId: pos.targetOrderId }) }); } catch {}

    const accounts = await apiFetch("/account/list") as { id: number; name: string }[];
    const acct = accounts.find(a => a.id === accountId) || accounts[0];
    await apiFetch("/order/placeorder", {
      method: "POST",
      body: JSON.stringify({
        accountSpec: acct.name, accountId, action: pos.direction === "long" ? "Sell" : "Buy",
        symbol: pos.contractId, orderQty: pos.quantity, orderType: "Market", timeInForce: "Day", isAutomated: true,
      }),
    });
    dailyPnl += pnl;
    log(`CLOSED ${sym}: ${reason} | P&L: $${pnl.toFixed(0)} | Daily: $${dailyPnl.toFixed(0)}`);

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

    positions.delete(sym);
  } catch (err) { log(`Close failed ${sym}: ${err}`); }
}

// ── Setup Detection (on 5-min bar close) ────────────────

function onBarClose(sym: string, bar: Bar) {
  const b = barBuilders.get(sym);
  if (!b || b.bars5m.length < 25) return;

  const session = getSessionName();
  const sizeMult = getSizeMultiplier();
  if (sizeMult === 0 || positions.has(sym) || dailyTradeCount >= 6 || dailyPnl < -500) return;

  const bars = b.bars5m;
  const closes = bars.map(x => x.c);
  const price = bar.c;
  const currentATR = atr(bars);
  if (currentATR <= 0) return;

  const currentRSI = rsi(closes) || 50;
  const fast = ema(closes, 9);
  const slow = ema(closes, 21);
  const fastEMA = fast[fast.length - 1];
  const slowEMA = slow[slow.length - 1];
  const vwapData = b.sessionBars.length >= 3 ? calcVwap(b.sessionBars) : calcVwap(bars.slice(-78));

  // Volume
  const last20 = bars.slice(-20);
  const avgVol = last20.reduce((s, x) => s + x.v, 0) / 20;
  const volRatio = avgVol > 0 ? bar.v / avgVol : 1;
  const volTrend = volRatio > 2 ? "surge" : volRatio < 0.6 ? "dry" : "normal";

  // Day type
  const orSize = b.openingRangeHigh - b.openingRangeLow;
  const outsideRange = (b.prevDayHigh > 0 && price > b.prevDayHigh) || (b.prevDayLow > 0 && price < b.prevDayLow);
  const dayType = outsideRange || orSize > currentATR * 0.5 ? "trend" : "range";

  const vix = getVIXMultiplier();
  const adjustedATR = currentATR * vix.stopMult;

  log(`${sym}: $${price.toFixed(2)} | ATR:${currentATR.toFixed(2)} | RSI:${currentRSI.toFixed(0)} | ${dayType} day | ${session} | ${b.bars5m.length} bars | ${vix.label}`);

  // Apply VIX multiplier to position sizing
  const effectiveSizeMult = sizeMult * vix.sizeMult;

  // SETUP 1: Opening Range Breakout (trend days, morning)
  if (dayType === "trend" && session === "morning" && b.openingRangeHigh > 0 && orSize > currentATR * 0.3) {
    if (price > b.openingRangeHigh && volRatio > 1.5) {
      log(`  → SETUP: OR Breakout LONG | OR high: $${b.openingRangeHigh.toFixed(2)} | Vol: ${volRatio.toFixed(1)}x`);
      executeTrade(sym, "long", price, Math.max(orSize * 0.5, adjustedATR), orSize * 1.5, effectiveSizeMult,
        `OR breakout long $${price.toFixed(2)} > $${b.openingRangeHigh.toFixed(2)}, vol ${volRatio.toFixed(1)}x`); return;
    }
    if (price < b.openingRangeLow && volRatio > 1.5) {
      log(`  → SETUP: OR Breakout SHORT | OR low: $${b.openingRangeLow.toFixed(2)} | Vol: ${volRatio.toFixed(1)}x`);
      executeTrade(sym, "short", price, Math.max(orSize * 0.5, adjustedATR), orSize * 1.5, effectiveSizeMult,
        `OR breakout short $${price.toFixed(2)} < $${b.openingRangeLow.toFixed(2)}, vol ${volRatio.toFixed(1)}x`); return;
    }
  }

  // SETUP 2: Trend Continuation (pullback to EMA9)
  if ((dayType === "trend" || Math.abs(fastEMA - slowEMA) / price > 0.001) &&
      (session === "morning" || session === "afternoon" || session === "eth_europe" || session === "eth_evening")) {
    const nearEMA = Math.abs(price - fastEMA) / price < 0.003;
    if (nearEMA && fastEMA > slowEMA && price > slowEMA && currentRSI > 35 && currentRSI < 65 && volTrend !== "surge") {
      log(`  → SETUP: Trend Continuation LONG | EMA9: $${fastEMA.toFixed(2)} | EMA21: $${slowEMA.toFixed(2)} | RSI: ${currentRSI.toFixed(0)}`);
      executeTrade(sym, "long", price, adjustedATR * 1.2, adjustedATR * 2.5, effectiveSizeMult,
        `Trend pullback long near EMA9 $${fastEMA.toFixed(2)}, RSI ${currentRSI.toFixed(0)}`); return;
    }
    if (nearEMA && fastEMA < slowEMA && price < slowEMA && currentRSI > 35 && currentRSI < 65 && volTrend !== "surge") {
      log(`  → SETUP: Trend Continuation SHORT | EMA9: $${fastEMA.toFixed(2)} | EMA21: $${slowEMA.toFixed(2)} | RSI: ${currentRSI.toFixed(0)}`);
      executeTrade(sym, "short", price, adjustedATR * 1.2, adjustedATR * 2.5, effectiveSizeMult,
        `Trend pullback short near EMA9 $${fastEMA.toFixed(2)}, RSI ${currentRSI.toFixed(0)}`); return;
    }
  }

  // SETUP 3: VWAP Mean Reversion (range days)
  if (dayType === "range" && (session === "morning" || session === "midday" || session === "afternoon")) {
    const targetDist = Math.abs(price - vwapData.vwap) * 0.8;
    if (targetDist > currentATR * 0.3) {
      if (price > vwapData.upper && currentRSI > 65 && volTrend !== "surge") {
        log(`  → SETUP: VWAP Reversion SHORT | VWAP: $${vwapData.vwap.toFixed(2)} | Upper: $${vwapData.upper.toFixed(2)} | RSI: ${currentRSI.toFixed(0)}`);
        executeTrade(sym, "short", price, adjustedATR * 1.2, targetDist, effectiveSizeMult,
          `VWAP fade short $${price.toFixed(2)} > upper $${vwapData.upper.toFixed(2)}, RSI ${currentRSI.toFixed(0)}`); return;
      }
      if (price < vwapData.lower && currentRSI < 35 && volTrend !== "surge") {
        log(`  → SETUP: VWAP Reversion LONG | VWAP: $${vwapData.vwap.toFixed(2)} | Lower: $${vwapData.lower.toFixed(2)} | RSI: ${currentRSI.toFixed(0)}`);
        executeTrade(sym, "long", price, adjustedATR * 1.2, targetDist, effectiveSizeMult,
          `VWAP fade long $${price.toFixed(2)} < lower $${vwapData.lower.toFixed(2)}, RSI ${currentRSI.toFixed(0)}`); return;
      }
    }
  }
}

// ── Trade Execution ─────────────────────────────────────

async function executeTrade(sym: string, direction: "long" | "short", price: number, stopDist: number, targetDist: number, sizeMult: number, reasoning: string) {
  const contract = contracts.get(sym);
  if (!contract) return;

  const mult = CONTRACT_MULTIPLIERS[sym] || 5;
  const equity = 50000;
  const maxRisk = equity * 0.002 * sizeMult;
  const riskPer = stopDist * mult;
  const qty = Math.max(1, Math.min(10, Math.floor(maxRisk / riskPer)));
  const rr = targetDist / stopDist;
  if (rr < 1.5) { log(`${sym}: R:R ${rr.toFixed(1)} too low`); return; }

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
    });
    dailyTradeCount++;
    log(`Order #${entry.orderId} filled | Stop #${stopOrderId} | Target #${targetOrderId}`);

    // Log to database so Vercel dashboard shows it
    try {
      await prisma.autoTradeLog.create({ data: {
        symbol: `FUT:${sym}`,
        action: `futures_${direction}`,
        qty,
        price,
        reason: `[FUTURES ${sym}] ${reasoning}. Stop: $${stopPrice.toFixed(2)}, Target: $${targetPrice.toFixed(2)}. R:R ${rr.toFixed(1)}. Risk: $${(riskPer * qty).toFixed(0)}. Size: ${sizeMult.toFixed(1)}x`,
        aiScore: Math.round(rr * 30), // use R:R as a proxy score
        aiSignal: direction,
        orderId: String(entry.orderId),
      }});
    } catch {}
  } catch (err) { log(`TRADE FAILED: ${err}`); }
}

// ── Heartbeat (tells dashboard the engine is alive) ─────

async function writeHeartbeat() {
  try {
    await prisma.agentConfig.upsert({
      where: { key: "futures_engine_heartbeat" },
      update: { value: new Date().toISOString() },
      create: { key: "futures_engine_heartbeat", value: new Date().toISOString() },
    });
  } catch { /* best-effort */ }
}

// ── Position Sync ───────────────────────────────────────

async function syncPositions() {
  try {
    const tvPos = await apiFetch("/position/list") as { contractId: number; netPos: number }[];
    for (const [sym, pos] of positions) {
      if (!tvPos.find(p => p.contractId === pos.contractId && p.netPos !== 0)) {
        log(`SYNC: ${sym} closed at exchange (stop/target hit)`);
        positions.delete(sym);
      }
    }
  } catch {}
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

        // Opening range from today's first 3 bars
        if (todayBars.length >= 3) {
          const orBars = todayBars.slice(0, 3);
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

let currentVIX = 20;

async function updateVIX() {
  try {
    const q = await yfEngine.quote("^VIX");
    if (q?.regularMarketPrice) {
      currentVIX = q.regularMarketPrice;
    }
  } catch {}
}

function getVIXMultiplier(): { stopMult: number; sizeMult: number; label: string } {
  if (currentVIX > 30) return { stopMult: 2.0, sizeMult: 0.5, label: `VIX ${currentVIX.toFixed(1)} EXTREME — half size, wide stops` };
  if (currentVIX > 25) return { stopMult: 1.5, sizeMult: 0.7, label: `VIX ${currentVIX.toFixed(1)} HIGH — reduced size` };
  if (currentVIX < 14) return { stopMult: 0.8, sizeMult: 1.0, label: `VIX ${currentVIX.toFixed(1)} LOW — tight stops` };
  return { stopMult: 1.0, sizeMult: 1.0, label: `VIX ${currentVIX.toFixed(1)} normal` };
}

// ── Main ────────────────────────────────────────────────

async function main() {
  log("╔══════════════════════════════════════════════╗");
  log("║  ESBUENO FUTURES — REAL-TIME TRADING ENGINE  ║");
  log("╚══════════════════════════════════════════════╝");
  log("Mode: DEMO | Data: Yahoo Finance (5s poll) | Orders: Tradovate");

  await authenticate();
  await resolveContracts();
  for (const sym of SYMBOLS) initBarBuilder(sym);

  // Pre-load historical bars so we can trade IMMEDIATELY
  await preloadBars();

  // Get initial VIX
  await updateVIX();
  log(`VIX: ${currentVIX.toFixed(1)}`);

  // Start polling
  setInterval(pollPrices, POLL_INTERVAL_MS);
  setInterval(checkSessionReset, 60_000);
  setInterval(syncPositions, 30_000);
  setInterval(writeHeartbeat, 60_000); // Heartbeat every 60s
  setInterval(updateVIX, 300_000); // Update VIX every 5 min

  // Status log every 2 minutes
  setInterval(() => {
    const session = getSessionName();
    const vix = getVIXMultiplier();
    const prices = SYMBOLS.map(s => {
      const b = barBuilders.get(s);
      return `${s}:$${b?.lastPrice?.toFixed(2) || "—"}/${b?.bars5m.length || 0}b`;
    }).join(" ");
    log(`STATUS: ${session.toUpperCase()} | ${vix.label} | Ticks:${tickCount} | Pos:${positions.size} | P&L:$${dailyPnl.toFixed(0)} | ${dailyTradeCount}/6 | ${prices}`);
  }, 120_000);

  log("Engine ready — scanning for setups on every 5-min bar close...");

  // First poll immediately
  await pollPrices();
}

main().catch(err => { console.error("Fatal:", err); process.exit(1); });
