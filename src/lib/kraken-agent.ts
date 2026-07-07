// Kraken BTC/ETH 50-day TREND-FOLLOWER — the one crypto method that survived out-of-sample testing
// (comparable return to buy&hold but ~30pts less drawdown). Per-coin state machine:
//   above the 50-day trend  → hold, and top up toward the target $ allocation with spare cash
//                             (deploys idle cash + adds on pullbacks that stay above the 50-day)
//   below the 50-day trend + holding → SELL to cash (exit before the deep bears)
// Sizes off the LIVE account balance every run, so adding funds auto-deploys. BTC/ETH only —
// the broad basket test showed almost every other coin (and every meme) lost money through a bull
// market. Long-only spot, no leverage, trades rarely → tiny fee drag. Runs on a cron.
// Honest: a real, disciplined edge with managed drawdown — not a $500-to-fortune machine.
import { prisma } from "./db";
import { getDipScan, runDipScan, type DipRow } from "./crypto-dip-scanner";
import { krakenConfigured, getKrakenBalance, getKrakenPrice, krakenBuyMarket, krakenSellMarket, krakenBalanceAsset } from "./kraken";
import { logTradeToJournal, logDecision, loadAgentContext } from "./vault";
import { sendNotification } from "./notifications";

interface KrakenConfig {
  enabled: boolean;
  coins: string[];
  perCoinUsd: number;    // target allocation per coin when its trend is up (trend mode)
  startCapital: number;  // deposited capital (for honest balance-delta P&L)
  validateOnly: boolean;
  mode: string;          // "trend" (50-day follower) | "dca" (daily accumulate & hold)
  dcaUsd: number;        // per-coin $ bought each day in DCA mode
}

const KEYS = ["kraken_enabled", "kraken_coins", "kraken_per_coin_usd", "kraken_start_capital", "kraken_validate_only", "kraken_mode", "kraken_dca_usd"];
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
    mode: (c.kraken_mode || "trend").toLowerCase(),
    dcaUsd: parseFloat(c.kraken_dca_usd) || 10,
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
  details.push(`USD cash: $${usd.toFixed(2)}${cfg.validateOnly ? " | VALIDATE-ONLY (no real orders)" : ""} | mode: ${cfg.mode}`);

  // ── DCA MODE: buy a fixed $ of each coin once per UTC day and HOLD. No trend gate, no selling.
  // Accumulates daily until the deposited cash runs out (then refund to keep going). The 30-min cron
  // can fire many times a day; the per-coin date guard ensures at most ONE buy per coin per day.
  if (cfg.mode === "dca") {
    const today = new Date().toISOString().slice(0, 10);
    const lastRaw = (await prisma.agentConfig.findUnique({ where: { key: "kraken_dca_last" } }))?.value;
    const last: Record<string, string> = lastRaw ? (() => { try { return JSON.parse(lastRaw); } catch { return {}; } })() : {};
    const alloc = Math.max(cfg.dcaUsd, MIN_ORDER_USD);
    for (const coin of cfg.coins) {
      if (last[coin] === today) { details.push(`${coin}: already bought today — next daily buy tomorrow`); continue; }
      if (usd < alloc) { details.push(`${coin}: only $${usd.toFixed(2)} cash left — DCA paused, refund Kraken to keep accumulating`); continue; }
      let price = byCoin[coin]?.price ?? 0;
      try { price = await getKrakenPrice(coin); } catch { /* fall back to scan price */ }
      if (price <= 0) { details.push(`${coin}: no price — skip`); continue; }
      if (dry) { details.push(`[DRY] ${coin}: would DCA-BUY $${alloc.toFixed(0)}`); continue; }
      try {
        const order = await krakenBuyMarket(coin, alloc, price, cfg.validateOnly);
        details.push(`${coin}: ${cfg.validateOnly ? "VALIDATED DCA buy" : "DCA BOUGHT"} $${alloc.toFixed(0)} → ${order.volume} @ $${price.toFixed(2)}`);
        if (!cfg.validateOnly) {
          usd -= alloc; res.buys++; last[coin] = today;
          await logTrade(coin, "kraken_buy", alloc, price, `Daily DCA: bought $${alloc.toFixed(0)} = ${order.volume} @ $${price.toFixed(2)} (accumulate & hold).`, order.txid?.[0]);
          await logDecision("kraken-dca", "ENTRY", `KRK:${coin}`, `Daily DCA — bought $${alloc.toFixed(0)}`, 3).catch(() => {});
        }
      } catch (e) { details.push(`${coin}: DCA buy error — ${e}`); }
    }
    if (!cfg.validateOnly && !dry) {
      await prisma.agentConfig.upsert({
        where: { key: "kraken_dca_last" },
        update: { value: JSON.stringify(last) },
        create: { key: "kraken_dca_last", value: JSON.stringify(last) },
      }).catch(() => {});
    }
  } else for (const coin of cfg.coins) {
    const row = byCoin[coin];
    if (!row) { details.push(`${coin}: no trend data — skip`); continue; }
    let price = row.price;
    try { price = await getKrakenPrice(coin); } catch { /* use scan price */ }
    const held = bal[krakenBalanceAsset(coin)] ?? 0;
    const heldValue = held * price;
    const isHolding = heldValue >= MIN_HOLD_USD;
    const up = row.aboveTrend;
    const target = cfg.perCoinUsd;                       // target $ allocation per coin while trending up
    const band = Math.max(MIN_ORDER_USD, target * 0.1);  // rebalance band — don't churn on small wiggles

    // UPTREND: hold, and top up toward the target with spare cash (deploys idle cash + adds on
    // pullbacks that stay above the 50-day). Winners above target are left to run — never trimmed.
    if (up) {
      const deficit = target - heldValue;
      const alloc = Math.min(deficit, usd);
      if (deficit < band || alloc < MIN_ORDER_USD) {
        details.push(`${coin}: ${isHolding ? `holding ~$${heldValue.toFixed(0)}` : "flat"} (uptrend, at/near $${target.toFixed(0)} target — hold)`);
        continue;
      }
      if (dry) { details.push(`[DRY] ${coin}: would BUY $${alloc.toFixed(0)} (above 50-day, ${isHolding ? "topping up" : "entering"} toward $${target.toFixed(0)})`); continue; }
      try {
        const order = await krakenBuyMarket(coin, alloc, price, cfg.validateOnly);
        details.push(`${coin}: ${cfg.validateOnly ? "VALIDATED buy" : "BOUGHT"} $${alloc.toFixed(0)} → ${order.volume} @ $${price.toFixed(2)} (${isHolding ? "trend top-up" : "trend entry"})`);
        if (!cfg.validateOnly) {
          usd -= alloc; res.buys++;
          await logTrade(coin, "kraken_buy", alloc, price, `Trend ${isHolding ? "top-up" : "entry"}: above 50-day. Bought $${alloc.toFixed(0)} = ${order.volume} @ $${price.toFixed(2)} toward $${target.toFixed(0)} target.`, order.txid?.[0]);
          await logDecision("kraken-trend", "ENTRY", `KRK:${coin}`, `Trend ${isHolding ? "top-up" : "entry"} (above 50-day) — bought $${alloc.toFixed(0)}`, 3).catch(() => {});
        }
      } catch (e) { details.push(`${coin}: buy error — ${e}`); }
    }
    // EXIT: downtrend + holding → sell to cash
    else if (isHolding) {
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
    // DOWNTREND + flat → wait for the trend to turn up
    else {
      details.push(`${coin}: flat (downtrend — waiting for uptrend)`);
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
