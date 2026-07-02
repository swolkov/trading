// Kraken BTC/ETH 50-day TREND-FOLLOWER — the one crypto method that survived out-of-sample testing
// (comparable return to buy&hold but ~30pts less drawdown). Per-coin state machine:
//   above the 50-day trend + not holding  → BUY (enter)
//   below the 50-day trend + holding       → SELL to cash (exit before the deep bears)
// Long-only spot, no leverage. Trades a few times a year (trend crosses) → tiny fee drag. Runs on a
// cron. Honest: a real, disciplined edge with managed drawdown — not a $500-to-fortune machine.
import { prisma } from "./db";
import { getDipScan, runDipScan, type DipRow } from "./crypto-dip-scanner";
import { krakenConfigured, getKrakenBalance, getKrakenPrice, krakenBuyMarket, krakenSellMarket, krakenBalanceAsset } from "./kraken";
import { logTradeToJournal, logDecision, loadAgentContext } from "./vault";
import { sendNotification } from "./notifications";

interface KrakenConfig {
  enabled: boolean;
  coins: string[];
  perCoinUsd: number;    // target allocation per coin when its trend is up
  startCapital: number;  // deposited capital (for honest balance-delta P&L)
  validateOnly: boolean;
}

const KEYS = ["kraken_enabled", "kraken_coins", "kraken_per_coin_usd", "kraken_start_capital", "kraken_validate_only"];
const MIN_HOLD_USD = 5;    // holdings above this = "in a position" (ignores dust)
const MIN_ORDER_USD = 10;  // don't place sub-$10 orders

async function loadConfig(): Promise<KrakenConfig> {
  const rows = await prisma.agentConfig.findMany({ where: { key: { in: KEYS } } });
  const c: Record<string, string> = {};
  for (const r of rows) c[r.key] = r.value;
  return {
    enabled: c.kraken_enabled === "true",
    coins: (c.kraken_coins || "BTC/USD,ETH/USD").split(",").map((s) => s.trim().toUpperCase()).filter(Boolean),
    perCoinUsd: parseFloat(c.kraken_per_coin_usd) || 250,
    startCapital: parseFloat(c.kraken_start_capital) || 500,
    validateOnly: c.kraken_validate_only !== "false", // default TRUE — safe until explicitly armed
  };
}

export interface KrakenAgentResult {
  enabled: boolean;
  connected: boolean;
  validateOnly: boolean;
  buys: number;
  sells: number;
  details: string[];
}

export async function runKrakenAgent(opts?: { dry?: boolean }): Promise<KrakenAgentResult> {
  const dry = !!opts?.dry;
  const cfg = await loadConfig();
  const details: string[] = [];
  const res: KrakenAgentResult = { enabled: cfg.enabled, connected: krakenConfigured(), validateOnly: cfg.validateOnly, buys: 0, sells: 0, details };

  if (!cfg.enabled) { details.push("Kraken agent disabled (set kraken_enabled=true)"); return res; }
  if (!krakenConfigured()) { details.push("Not connected — add KRAKEN_API_KEY / KRAKEN_API_SECRET in the Vercel env, then redeploy."); return res; }

  // Fresh 50-day trend signals (aboveTrend per coin) from the scanner.
  let scan = await getDipScan();
  if (!scan || Date.now() - new Date(scan.ts).getTime() > 30 * 60_000) scan = await runDipScan();
  const byCoin: Record<string, DipRow> = {};
  for (const r of scan?.rows || []) byCoin[r.symbol] = r;

  // Pull the trading brain (regime + active anti-patterns) so the agent reads context, not just writes.
  try {
    const ctx = await loadAgentContext("kraken-trend", "crypto-trend.md");
    const regime = ctx.marketRegime ? ctx.marketRegime.split("\n").find((l) => l.trim())?.slice(0, 120) : null;
    if (regime) details.push(`Brain regime: ${regime}`);
  } catch { /* brain optional — never block a run on it */ }

  let bal: Record<string, number> = {};
  try { bal = await getKrakenBalance(); } catch (e) { details.push(`balance error: ${e}`); return res; }
  let usd = bal.ZUSD ?? bal.USD ?? 0;
  details.push(`USD cash: $${usd.toFixed(2)}${cfg.validateOnly ? " | VALIDATE-ONLY (no real orders)" : ""}`);

  for (const coin of cfg.coins) {
    const row = byCoin[coin];
    if (!row) { details.push(`${coin}: no trend data — skip`); continue; }
    let price = row.price;
    try { price = await getKrakenPrice(coin); } catch { /* use scan price */ }
    const held = bal[krakenBalanceAsset(coin)] ?? 0;
    const heldValue = held * price;
    const isHolding = heldValue >= MIN_HOLD_USD;
    const up = row.aboveTrend;

    // ENTER: uptrend + flat → buy the per-coin allocation
    if (up && !isHolding) {
      const alloc = Math.min(cfg.perCoinUsd, usd);
      if (alloc < MIN_ORDER_USD) { details.push(`${coin}: uptrend but only $${usd.toFixed(2)} cash — can't enter`); continue; }
      if (dry) { details.push(`[DRY] ${coin}: would BUY $${alloc.toFixed(0)} (above 50-day, entering)`); continue; }
      try {
        const order = await krakenBuyMarket(coin, alloc, price, cfg.validateOnly);
        details.push(`${coin}: ${cfg.validateOnly ? "VALIDATED buy" : "BOUGHT"} $${alloc.toFixed(0)} → ${order.volume} @ $${price.toFixed(2)} (trend entry)`);
        if (!cfg.validateOnly) {
          usd -= alloc; res.buys++;
          await logTrade(coin, "kraken_buy", alloc, price, `Trend entry: above 50-day. Bought $${alloc.toFixed(0)} = ${order.volume} @ $${price.toFixed(2)}.`, order.txid?.[0]);
          await logDecision("kraken-trend", "ENTRY", `KRK:${coin}`, `Trend entry (above 50-day) — bought $${alloc.toFixed(0)}`, 3).catch(() => {});
        }
      } catch (e) { details.push(`${coin}: buy error — ${e}`); }
    }
    // EXIT: downtrend + holding → sell to cash
    else if (!up && isHolding) {
      if (dry) { details.push(`[DRY] ${coin}: would SELL ${held} (~$${heldValue.toFixed(0)}) (below 50-day, exiting)`); continue; }
      try {
        const order = await krakenSellMarket(coin, held, cfg.validateOnly);
        details.push(`${coin}: ${cfg.validateOnly ? "VALIDATED sell" : "SOLD"} ${order.volume} (~$${heldValue.toFixed(0)}) @ $${price.toFixed(2)} (trend exit)`);
        if (!cfg.validateOnly) {
          usd += heldValue; res.sells++;
          await logTrade(coin, "kraken_sell", heldValue, price, `Trend exit: below 50-day. Sold ${order.volume} (~$${heldValue.toFixed(0)}) @ $${price.toFixed(2)}.`, order.txid?.[0]);
          await logDecision("kraken-trend", "EXIT", `KRK:${coin}`, `Trend exit (below 50-day) — sold ~$${heldValue.toFixed(0)}`, 3).catch(() => {});
        }
      } catch (e) { details.push(`${coin}: sell error — ${e}`); }
    }
    // HOLD / WAIT
    else {
      details.push(`${coin}: ${isHolding ? `holding ~$${heldValue.toFixed(0)} (uptrend — hold)` : "flat (downtrend — waiting for uptrend)"}`);
    }
  }

  try {
    await prisma.agentConfig.upsert({
      where: { key: "kraken_last_run" },
      update: { value: JSON.stringify({ ts: new Date().toISOString(), buys: res.buys, sells: res.sells, validateOnly: cfg.validateOnly, details: res.details.slice(-6) }) },
      create: { key: "kraken_last_run", value: JSON.stringify({ ts: new Date().toISOString(), buys: res.buys, sells: res.sells, validateOnly: cfg.validateOnly, details: res.details.slice(-6) }) },
    });
  } catch { /* best-effort */ }
  return res;
}

async function logTrade(coin: string, action: string, usd: number, price: number, reason: string, txid?: string) {
  // Real-money fill — Spencer gets a Slack alert for every Kraken trade
  await sendNotification(`🪙 KRAKEN ${action === "kraken_buy" ? "BUY" : "SELL"} ${coin.replace("/USD", "")}: ${reason}`, "general").catch(() => {});
  await prisma.autoTradeLog.create({
    data: { symbol: `KRK:${coin}`, action, qty: 0, price: usd, reason, aiSignal: action === "kraken_buy" ? "bullish" : "bearish", orderId: txid ?? null },
  }).catch(() => {});
  await logTradeToJournal({
    tradeId: `${new Date().toISOString().slice(0, 10)}-KRK-${coin.split("/")[0]}-${Date.now().toString(36).slice(-4)}`,
    timestamp: new Date().toISOString(),
    instrument: `KRK:${coin}`,
    direction: action === "kraken_buy" ? "LONG" : "SHORT",
    strategy: "kraken-trend",
    setupType: action === "kraken_buy" ? "trend_entry_50d" : "trend_exit_50d",
    contracts: 1,
    entryPrice: price,
    stopPrice: 0,
    targetPrice: 0,
    conviction: 3,
    exitReason: action === "kraken_sell" ? "trend_exit" : undefined,
  }, "kraken-trend").catch(() => {});
}

// Status for the /kraken page: connection, cash, holdings (live value), P&L vs deposited capital.
export interface KrakenStatus {
  connected: boolean;
  enabled: boolean;
  validateOnly: boolean;
  usd: number;
  holdings: { coin: string; amount: number; price: number; value: number; aboveTrend: boolean }[];
  totalValue: number;
  totalInvested: number; // = deposited capital, so panel P&L = totalValue - deposited (honest)
  buyCount: number;
  config: Record<string, string>;
  lastRun?: unknown;
  error?: string;
}

export async function getKrakenStatus(): Promise<KrakenStatus> {
  const cfg = await loadConfig();
  const rows = await prisma.agentConfig.findMany({ where: { key: { in: KEYS } } });
  const config: Record<string, string> = {};
  for (const r of rows) config[r.key] = r.value;
  const buyCount = await prisma.autoTradeLog.count({ where: { symbol: { startsWith: "KRK:" }, action: { in: ["kraken_buy", "kraken_sell"] } } });
  let lastRun: unknown = null;
  try { const lr = await prisma.agentConfig.findUnique({ where: { key: "kraken_last_run" } }); if (lr?.value) lastRun = JSON.parse(lr.value); } catch { /* ignore */ }
  const base: KrakenStatus = { connected: krakenConfigured(), enabled: cfg.enabled, validateOnly: cfg.validateOnly, usd: 0, holdings: [], totalValue: 0, totalInvested: cfg.startCapital, buyCount, config, lastRun };
  if (!krakenConfigured()) return base;

  let trend: Record<string, boolean> = {};
  try { const scan = await getDipScan(); for (const r of scan?.rows || []) trend[r.symbol] = r.aboveTrend; } catch { /* ignore */ }

  try {
    const bal = await getKrakenBalance();
    base.usd = bal.ZUSD ?? bal.USD ?? 0;
    for (const coin of cfg.coins) {
      const amt = bal[krakenBalanceAsset(coin)] ?? 0;
      if (amt <= 0) continue;
      let price = 0;
      try { price = await getKrakenPrice(coin); } catch { /* skip price */ }
      const value = amt * price;
      if (value < MIN_HOLD_USD) continue;
      base.holdings.push({ coin, amount: amt, price, value, aboveTrend: trend[coin] ?? true });
    }
    base.totalValue = base.usd + base.holdings.reduce((s, h) => s + h.value, 0);
  } catch (e) {
    base.error = String(e);
  }
  return base;
}
