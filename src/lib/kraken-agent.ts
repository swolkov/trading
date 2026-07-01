// Kraken accumulator — buy-the-dip-and-HOLD BTC/ETH. NEVER sells (selling-the-bounce loses to fees).
// On a dip signal (from the crypto dip scanner), buys a small fixed $ and holds. Per-coin cooldown +
// a hard max-deploy cap spread the buys across dips over time instead of dumping it all at once.
// Long-only spot, no leverage. Honest framing: this is a long-term BET that BTC/ETH rise, harvested
// with disciplined dip entries — not an active "edge." Runs on a cron (no real-time engine needed).
import { prisma } from "./db";
import { getDipScan, runDipScan, type DipRow } from "./crypto-dip-scanner";
import { krakenConfigured, getKrakenUsd, getKrakenBalance, getKrakenPrice, krakenBuyMarket, krakenBalanceAsset } from "./kraken";
import { logTradeToJournal, logDecision } from "./vault";

interface KrakenConfig {
  enabled: boolean;
  coins: string[];
  perBuyUsd: number;
  cooldownHours: number;
  maxDeployUsd: number;
  minSignal: "DIP" | "DEEP DIP";
  validateOnly: boolean;
}

const KEYS = ["kraken_enabled", "kraken_coins", "kraken_per_buy_usd", "kraken_dip_cooldown_hours", "kraken_max_deploy_usd", "kraken_min_signal", "kraken_validate_only"];

async function loadConfig(): Promise<KrakenConfig> {
  const rows = await prisma.agentConfig.findMany({ where: { key: { in: KEYS } } });
  const c: Record<string, string> = {};
  for (const r of rows) c[r.key] = r.value;
  return {
    enabled: c.kraken_enabled === "true",
    coins: (c.kraken_coins || "BTC/USD,ETH/USD").split(",").map((s) => s.trim().toUpperCase()).filter(Boolean),
    perBuyUsd: parseFloat(c.kraken_per_buy_usd) || 40,
    cooldownHours: parseFloat(c.kraken_dip_cooldown_hours) || 24,
    maxDeployUsd: parseFloat(c.kraken_max_deploy_usd) || 500,
    minSignal: c.kraken_min_signal === "DEEP DIP" ? "DEEP DIP" : "DIP",
    validateOnly: c.kraken_validate_only !== "false", // default TRUE — safe until explicitly armed
  };
}

async function totalDeployed(): Promise<number> {
  const agg = await prisma.autoTradeLog.aggregate({
    where: { symbol: { startsWith: "KRK:" }, action: "kraken_buy" },
    _sum: { price: true },
  });
  return agg._sum.price ?? 0;
}

async function lastBuyAgeHours(coin: string): Promise<number> {
  const row = await prisma.autoTradeLog.findFirst({
    where: { symbol: `KRK:${coin}`, action: "kraken_buy" },
    orderBy: { createdAt: "desc" },
  });
  if (!row) return Infinity;
  return (Date.now() - row.createdAt.getTime()) / 3_600_000;
}

function dipQualifies(row: DipRow | undefined, min: "DIP" | "DEEP DIP"): boolean {
  if (!row) return false;
  if (min === "DEEP DIP") return row.signal === "DEEP DIP";
  return row.signal === "DIP" || row.signal === "DEEP DIP";
}

export interface KrakenAgentResult {
  enabled: boolean;
  connected: boolean;
  validateOnly: boolean;
  buys: number;
  details: string[];
}

export async function runKrakenAccumulator(opts?: { dry?: boolean }): Promise<KrakenAgentResult> {
  const dry = !!opts?.dry;
  const cfg = await loadConfig();
  const details: string[] = [];
  const res: KrakenAgentResult = { enabled: cfg.enabled, connected: krakenConfigured(), validateOnly: cfg.validateOnly, buys: 0, details };

  if (!cfg.enabled) { details.push("Kraken accumulator disabled (set kraken_enabled=true)"); return res; }
  if (!krakenConfigured()) { details.push("Not connected — add KRAKEN_API_KEY / KRAKEN_API_SECRET in the Vercel env, then redeploy."); return res; }

  // Fresh dip signals.
  let scan = await getDipScan();
  if (!scan || Date.now() - new Date(scan.ts).getTime() > 30 * 60_000) scan = await runDipScan();
  const byCoin: Record<string, DipRow> = {};
  for (const r of scan?.rows || []) byCoin[r.symbol] = r;

  // Cash + deployment guardrails.
  let usd = 0;
  try { usd = await getKrakenUsd(); } catch (e) { details.push(`balance error: ${e}`); return res; }
  const deployed = await totalDeployed();
  details.push(`USD available: $${usd.toFixed(2)} | deployed so far: $${deployed.toFixed(2)}/$${cfg.maxDeployUsd}${cfg.validateOnly ? " | VALIDATE-ONLY (no real orders)" : ""}`);

  for (const coin of cfg.coins) {
    const row = byCoin[coin];
    if (!dipQualifies(row, cfg.minSignal)) { details.push(`${coin}: no qualifying dip (${row?.signal ?? "n/a"})`); continue; }
    if (usd < cfg.perBuyUsd) { details.push(`${coin}: skip — only $${usd.toFixed(2)} cash left`); continue; }
    if (deployed + cfg.perBuyUsd > cfg.maxDeployUsd) { details.push(`${coin}: skip — max deploy reached`); continue; }
    const age = await lastBuyAgeHours(coin);
    if (age < cfg.cooldownHours) { details.push(`${coin}: cooldown (${age.toFixed(1)}h < ${cfg.cooldownHours}h)`); continue; }

    if (dry) { details.push(`[DRY] ${coin}: would buy $${cfg.perBuyUsd} (${row!.signal})`); continue; }
    try {
      const price = await getKrakenPrice(coin);
      const order = await krakenBuyMarket(coin, cfg.perBuyUsd, price, cfg.validateOnly);
      const label = cfg.validateOnly ? "VALIDATED (no spend)" : "BOUGHT";
      details.push(`${coin}: ${label} $${cfg.perBuyUsd} → ${order.volume} @ $${price.toFixed(2)} (${row!.signal})`);
      if (!cfg.validateOnly) {
        usd -= cfg.perBuyUsd;
        res.buys++;
        await prisma.autoTradeLog.create({
          data: {
            symbol: `KRK:${coin}`,
            action: "kraken_buy",
            qty: 0,
            price: cfg.perBuyUsd, // USD deployed (buy & hold — no exit row)
            reason: `Dip accumulate (${row!.signal}, RSI ${row!.rsi?.toFixed(0) ?? "?"}): bought $${cfg.perBuyUsd} = ${order.volume} ${coin} @ $${price.toFixed(2)}. Hold.`,
            aiSignal: "bullish",
            orderId: order.txid?.[0] ?? null,
          },
        });
        await logTradeToJournal({
          tradeId: `${new Date().toISOString().slice(0, 10)}-KRK-${coin.split("/")[0]}-${Date.now().toString(36).slice(-4)}`,
          timestamp: new Date().toISOString(),
          instrument: `KRK:${coin}`,
          direction: "LONG",
          strategy: "kraken-accumulator",
          setupType: "dip_accumulate",
          contracts: 1,
          entryPrice: price,
          stopPrice: 0,
          targetPrice: 0,
          conviction: 3,
        }, "kraken-accumulator");
        await logDecision("kraken-accumulator", "ENTRY", `KRK:${coin}`, `Dip buy $${cfg.perBuyUsd} (${row!.signal}) — buy & hold`, 3).catch(() => {});
      }
    } catch (e) {
      details.push(`${coin}: order error — ${e}`);
    }
  }
  try {
    await prisma.agentConfig.upsert({
      where: { key: "kraken_last_run" },
      update: { value: JSON.stringify({ ts: new Date().toISOString(), buys: res.buys, validateOnly: cfg.validateOnly, details: res.details.slice(-6) }) },
      create: { key: "kraken_last_run", value: JSON.stringify({ ts: new Date().toISOString(), buys: res.buys, validateOnly: cfg.validateOnly, details: res.details.slice(-6) }) },
    });
  } catch { /* best-effort */ }
  return res;
}

// Status for the /kraken page: connection, cash, holdings (live value), total invested, buys.
export interface KrakenStatus {
  connected: boolean;
  enabled: boolean;
  validateOnly: boolean;
  usd: number;
  holdings: { coin: string; amount: number; price: number; value: number }[];
  totalValue: number;
  totalInvested: number;
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
  const invested = await totalDeployed();
  const buyCount = await prisma.autoTradeLog.count({ where: { symbol: { startsWith: "KRK:" }, action: "kraken_buy" } });
  let lastRun: unknown = null;
  try { const lr = await prisma.agentConfig.findUnique({ where: { key: "kraken_last_run" } }); if (lr?.value) lastRun = JSON.parse(lr.value); } catch { /* ignore */ }
  const base: KrakenStatus = { connected: krakenConfigured(), enabled: cfg.enabled, validateOnly: cfg.validateOnly, usd: 0, holdings: [], totalValue: 0, totalInvested: invested, buyCount, config, lastRun };
  if (!krakenConfigured()) return base;
  try {
    const bal = await getKrakenBalance();
    base.usd = bal.ZUSD ?? bal.USD ?? 0;
    for (const coin of cfg.coins) {
      const amt = bal[krakenBalanceAsset(coin)] ?? 0;
      if (amt <= 0) continue;
      let price = 0;
      try { price = await getKrakenPrice(coin); } catch { /* skip price */ }
      base.holdings.push({ coin, amount: amt, price, value: amt * price });
    }
    base.totalValue = base.usd + base.holdings.reduce((s, h) => s + h.value, 0);
  } catch (e) {
    base.error = String(e);
  }
  return base;
}
