// Kraken BTC/ETH 50-day TREND-FOLLOWER — the one crypto method that survived out-of-sample testing
// (comparable return to buy&hold but ~30pts less drawdown). Per-coin state machine:
//   above the 50-day trend  → hold, and top up toward the target $ allocation with spare cash
//                             (deploys idle cash + adds on pullbacks that stay above the 50-day)
//   below the 50-day trend + holding → SELL to cash (exit before the deep bears)
// Sizes each coin at a SHARE of the live account every run, so a deposit auto-deploys. BTC/ETH only —
// the broad basket test showed almost every other coin (and every meme) lost money through a bull
// market. Long-only spot, no leverage, trades rarely → tiny fee drag. Runs on a cron.
// Honest: a real, disciplined edge with managed drawdown — not a $500-to-fortune machine.
import { prisma } from "./db";
import { getDipScan, runDipScan, type DipRow } from "./crypto-dip-scanner";
import { krakenConfigured, getKrakenBalance, getKrakenAvailable, getKrakenPrice, krakenBuyMarket, krakenSellMarket, krakenBalanceAsset, getKrakenCashFlows, valueKrakenAssets } from "./kraken";
import { logTradeToJournal, logDecision, loadAgentContext } from "./vault";
import { sendNotification } from "./notifications";

interface KrakenConfig {
  enabled: boolean;
  coins: string[];
  allocPct: number;      // target allocation per coin as a SHARE of account value (0.48 = 48%)
  perCoinUsd: number;    // legacy fixed-$ target per coin; used only when allocPct is 0
  startCapital: number;  // fallback deposited capital, used only if the Kraken ledger is unreadable
  validateOnly: boolean;
  mode: string;          // "trend" (50-day follower) | "dca" (daily accumulate & hold)
  dcaUsd: number;        // per-coin $ bought each day in DCA mode
}

const KEYS = ["kraken_enabled", "kraken_coins", "kraken_alloc_pct", "kraken_per_coin_usd", "kraken_start_capital", "kraken_validate_only", "kraken_mode", "kraken_dca_usd"];
const MIN_HOLD_USD = 5;    // holdings above this = "in a position" (ignores dust)
const MIN_ORDER_USD = 10;  // don't place sub-$10 orders
// Per-coin target as a share of account value. Sizing off a FIXED dollar figure meant the account
// sat permanently at its target, so any new deposit stayed in cash and earned nothing. A percentage
// makes every deposit deploy itself on the next run, and makes the strategy scale with the account.
const DEFAULT_ALLOC_PCT = 0.48;
const FLOWS_KEY = "kraken_capital_flows";
const FLOWS_TTL_MS = 60 * 60 * 1000;   // re-read the deposit ledger at most hourly
// Hysteresis band around the 50-day line. The cron runs every 30 min against the live intraday price,
// so a RAW crossover whipsaws (buy→sell→buy within hours) whenever price hovers at the 50-day SMA —
// bleeding ~0.5%/round-trip in fees for nothing (observed 5 flip-flops in 4.5h on 2026-07-10). Only
// flipping state when price is clearly across the line (±1.5%) fixes it. Backtested on BTC+ETH daily:
// ~40% fewer trades AND higher net return vs a 0% band. In the dead zone, keep the current position.
const TREND_HYSTERESIS = 0.015; // 1.5%

async function loadConfig(): Promise<KrakenConfig> {
  const rows = await prisma.agentConfig.findMany({ where: { key: { in: KEYS } } });
  const c: Record<string, string> = {};
  for (const r of rows) c[r.key] = r.value;
  // Default 48% per coin: two coins = 96% deployed when both trend up, ~4% left as a fee buffer.
  // Set kraken_alloc_pct to "0" to fall back to the legacy fixed-dollar target.
  const rawPct = parseFloat(c.kraken_alloc_pct);
  return {
    enabled: c.kraken_enabled === "true",
    coins: (c.kraken_coins || "BTC/USD,ETH/USD").split(",").map((s) => s.trim().toUpperCase()).filter(Boolean),
    allocPct: Number.isFinite(rawPct) ? Math.max(0, Math.min(rawPct, 0.95)) : DEFAULT_ALLOC_PCT,
    perCoinUsd: parseFloat(c.kraken_per_coin_usd) || 250,
    startCapital: parseFloat(c.kraken_start_capital) || 500,
    validateOnly: c.kraken_validate_only !== "false", // default TRUE — safe until explicitly armed
    mode: (c.kraken_mode || "trend").toLowerCase(),
    dcaUsd: parseFloat(c.kraken_dca_usd) || 10,
  };
}

// How much money has actually been PUT IN, read from Kraken's own deposit/withdrawal ledger.
// This is the denominator for honest P&L: value − deposited. Cached hourly because the ledger
// barely changes and every status call would otherwise page through it. Falls back to the
// configured starting capital if the ledger can't be read, so P&L never breaks — but says so.
interface InvestedCapital { usd: number; source: "kraken-ledger" | "config"; approximate: boolean; asOf?: string }

async function resolveInvestedCapital(cfg: KrakenConfig, opts: { force?: boolean } = {}): Promise<InvestedCapital> {
  const fallback: InvestedCapital = { usd: cfg.startCapital, source: "config", approximate: false };
  let cached: (InvestedCapital & { ts?: string }) | null = null;
  try {
    const row = await prisma.agentConfig.findUnique({ where: { key: FLOWS_KEY } });
    if (row?.value) cached = JSON.parse(row.value);
  } catch { /* cache miss is fine */ }
  if (!opts.force && cached?.ts && Date.now() - new Date(cached.ts).getTime() < FLOWS_TTL_MS) {
    return { usd: cached.usd, source: cached.source, approximate: cached.approximate, asOf: cached.ts };
  }
  if (!krakenConfigured()) return cached ? { ...cached } : fallback;
  try {
    const { flows, netUsd, approximate } = await getKrakenCashFlows();
    // No deposit history at all (e.g. a key without ledger permission) — don't overwrite a real
    // baseline with zero, which would report the entire account as profit.
    if (!flows.length || netUsd <= 0) return cached ? { ...cached } : fallback;
    const resolved: InvestedCapital & { ts: string } = {
      usd: netUsd, source: "kraken-ledger", approximate, ts: new Date().toISOString(),
    };
    await prisma.agentConfig.upsert({
      where: { key: FLOWS_KEY },
      update: { value: JSON.stringify(resolved) },
      create: { key: FLOWS_KEY, value: JSON.stringify(resolved) },
    }).catch(() => {});
    return { usd: resolved.usd, source: resolved.source, approximate: resolved.approximate, asOf: resolved.ts };
  } catch {
    return cached ? { ...cached } : fallback;
  }
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

  // TWO balances, deliberately. `bal` is everything owned — the right basis for valuing positions
  // and computing equity. `avail` subtracts anything committed to an open order — the only safe
  // basis for SIZING an order. Using the total is what produced a live
  // "EOrder:Insufficient funds" rejection on 2026-08-23.
  let bal: Record<string, number> = {};
  let avail: Record<string, number> = {};
  try { bal = await getKrakenBalance(); } catch (e) { details.push(`balance error: ${e}`); return res; }
  try { avail = await getKrakenAvailable(); } catch { avail = bal; /* fall back to total rather than stall */ }
  const totalUsd = bal.ZUSD ?? bal.USD ?? 0;
  let usd = Math.min(avail.ZUSD ?? avail.USD ?? totalUsd, totalUsd);   // spendable cash
  const heldBack = totalUsd - usd;
  details.push(
    `USD cash: $${usd.toFixed(2)} spendable${heldBack > 0.01 ? ` (of $${totalUsd.toFixed(2)} — $${heldBack.toFixed(2)} tied up in open orders)` : ""}` +
    `${cfg.validateOnly ? " | VALIDATE-ONLY (no real orders)" : ""} | mode: ${cfg.mode}`,
  );

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
  } else {
    // Price every coin ONCE and snapshot total account value BEFORE placing anything. Snapshotting up
    // front matters: sizing off the running cash balance would shrink the second coin's target the
    // moment the first coin's buy settles, so the two coins would end up unevenly weighted.
    const priced: { coin: string; row: DipRow | undefined; price: number; held: number; sellable: number; heldValue: number }[] = [];
    for (const coin of cfg.coins) {
      const row = byCoin[coin];
      let price = row?.price ?? 0;
      try { price = await getKrakenPrice(coin); } catch { /* fall back to the scan price */ }
      const asset = krakenBalanceAsset(coin);
      const held = bal[asset] ?? 0;                          // owned — the basis for value and equity
      const sellable = Math.min(avail[asset] ?? held, held); // free of open orders — the basis for exits
      priced.push({ coin, row, price, held, sellable, heldValue: held * price });
    }
    // Equity uses TOTAL holdings plus total cash: it is what the account is worth, not what is
    // spendable right now. Only the per-order allocation is capped by spendable cash.
    const equity = totalUsd + priced.reduce((s, p) => s + p.heldValue, 0);
    // Target per coin is a SHARE of the account, so a deposit deploys itself on the next run.
    const target = cfg.allocPct > 0 ? equity * cfg.allocPct : cfg.perCoinUsd;
    const band = Math.max(MIN_ORDER_USD, target * 0.1);  // rebalance band — don't churn on small wiggles
    details.push(cfg.allocPct > 0
      ? `Equity $${equity.toFixed(2)} → target $${target.toFixed(2)}/coin (${(cfg.allocPct * 100).toFixed(0)}% each) — deposits auto-deploy`
      : `Fixed target $${target.toFixed(2)}/coin (percentage sizing disabled)`);

    for (const { coin, row, price, sellable, heldValue } of priced) {
      if (!row) { details.push(`${coin}: no trend data — skip`); continue; }
      const isHolding = heldValue >= MIN_HOLD_USD;
      // Trend state WITH hysteresis (see TREND_HYSTERESIS): when holding, stay in unless price drops
      // clearly below the 50-day; when flat, only enter when price is clearly above. Kills the intraday
      // whipsaw churn. Falls back to the raw signal only if the SMA is unavailable.
      const sma = row.sma50;
      const up = (sma != null && sma > 0)
        ? (isHolding ? price >= sma * (1 - TREND_HYSTERESIS) : price > sma * (1 + TREND_HYSTERESIS))
        : row.aboveTrend;

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
        if (dry) { details.push(`[DRY] ${coin}: would SELL ${sellable} (~$${heldValue.toFixed(0)}) (below 50-day, exiting)`); continue; }
        try {
          const order = await krakenSellMarket(coin, sellable, cfg.validateOnly);
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
  await sendNotification(`🪙 KRAKEN ${action === "kraken_buy" ? "BUY" : "SELL"} ${coin.replace("/USD", "")}: ${reason}`, "kraken").catch(() => {});
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
  investedSource: "kraken-ledger" | "config";  // where that figure came from
  investedApproximate: boolean;                // true if a non-USD transfer had to be priced
  allocPct: number;                            // per-coin target as a share of the account
  targetPerCoin: number;                       // what that works out to in dollars right now
  strategyValue: number;                       // cash + the coins the strategy trades
  otherValue: number;                          // everything else held on the account (manual buys, dust)
  otherAssets: { asset: string; value: number }[];
  mode: string;
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
  const invested = await resolveInvestedCapital(cfg);
  const base: KrakenStatus = {
    connected: krakenConfigured(), enabled: cfg.enabled, validateOnly: cfg.validateOnly,
    usd: 0, holdings: [], totalValue: 0,
    totalInvested: invested.usd, investedSource: invested.source, investedApproximate: invested.approximate,
    allocPct: cfg.allocPct, targetPerCoin: 0, strategyValue: 0, otherValue: 0, otherAssets: [], mode: cfg.mode,
    buyCount, config, lastRun,
  };
  if (!krakenConfigured()) return base;

  const trend: Record<string, boolean> = {};
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
    base.strategyValue = base.usd + base.holdings.reduce((s, h) => s + h.value, 0);
    // Anything held that the strategy does NOT trade — a manual buy, leftover dust. Deposited capital
    // is measured account-wide, so total value must be too, or a manual punt reads as a strategy loss.
    try {
      const strategyAssets = new Set(cfg.coins.map((c) => krakenBalanceAsset(c)));
      const valued = await valueKrakenAssets(bal);
      const others = valued.filter((v) => !strategyAssets.has(v.asset) && v.value >= MIN_HOLD_USD);
      base.otherValue = others.reduce((s, v) => s + v.value, 0);
      base.otherAssets = others
        .sort((a, b) => b.value - a.value)
        .map((v) => ({ asset: v.asset.replace(/^X(?=[A-Z]{3,})/, "").replace(/\.[A-Z]+$/, ""), value: v.value }));
    } catch { /* pricing extras is best-effort — never break the panel over dust */ }
    base.totalValue = base.strategyValue + base.otherValue;
    // Sizing follows the STRATEGY's own money, not manual holdings — otherwise a PEPE punt would
    // inflate the BTC/ETH targets and the engine would try to buy with cash that isn't there.
    base.targetPerCoin = cfg.allocPct > 0 ? base.strategyValue * cfg.allocPct : cfg.perCoinUsd;
  } catch (e) {
    base.error = String(e);
  }
  return base;
}
