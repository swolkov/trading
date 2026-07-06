// Automated options agent — buys 7–14 DTE DEFINED-RISK debit spreads on liquid US names, selected
// from Finnhub research signals (post-earnings drift, analyst momentum, sentiment) gated by IV and
// vetoed by an AI grader. BUY-ONLY (vertical debit spreads; max loss = net debit paid).
//
// HONEST STANCE: buying options is negative-EV on average. This agent's job is ruthless selectivity
// plus HARD ruin-protection (tiny per-trade risk, weekly loss budget, account floor). Expect
// break-even-to-negative; the caps + scoreboard exist so we SEE it and stop, not pretend.
//
// Self-contained executor (does NOT reuse options-trader.ts executeSpread, which is hardcoded to
// 14–30 DTE and logs per-leg) so we get the right 7–14 DTE window, a real debit cost cap, explicit
// paper/live mode on every order, and unit-level `OPT:` logging for an honest scoreboard.
import Anthropic from "@anthropic-ai/sdk";
import { prisma } from "./db";
import { sendNotification } from "./notifications";
import type { TradingMode } from "./trading-mode";
import {
  getAccount,
  getPositions,
  placeOrder,
  getOptionsChain,
  getOptionsSnapshots,
  getSnapshot,
  getMarketClock,
  getNews,
  placeMultiLegOrder,
  getOrder,
  cancelOrder,
  type Position,
  type OptionsContract,
} from "./alpaca";
import { analyzeVolatility } from "./options-intelligence";
import {
  getEarningsCalendar,
  getUpgradesDowngrades,
  getRecommendationTrends,
  getInsiderSentiment,
  getSocialSentiment,
  getPriceTargetConsensus,
  getCongressionalTrading,
  type EarningsCalendarItem,
} from "./finnhub";
import { logTradeToJournal, logDecision, logObservation, loadAgentContext } from "./vault";
import { areEntriesPaused } from "./orchestrator";

// ---------- Config ----------

interface OptionsAgentConfig {
  enabled: boolean;
  mode: TradingMode;
  accountSize: number;
  maxRiskUsd: number;
  riskPerTradePct: number;
  maxPositions: number;
  maxTradesPerDay: number;
  minConviction: number;
  minDte: number;
  maxDte: number;
  weeklyLossBudgetUsd: number;
  accountFloorUsd: number;
  universe: string[];
}

const DEFAULTS: OptionsAgentConfig = {
  enabled: false,
  mode: "paper",
  accountSize: 500,
  maxRiskUsd: 50,
  riskPerTradePct: 12,
  maxPositions: 2,
  maxTradesPerDay: 1,
  minConviction: 60,
  minDte: 7,
  maxDte: 14,
  weeklyLossBudgetUsd: 100,
  accountFloorUsd: 300,
  universe: ["SPY", "QQQ", "IWM", "AAPL", "MSFT", "NVDA", "AMD", "META"],
};

const CONFIG_KEYS = [
  "options_enabled",
  "options_account_size",
  "options_max_risk_usd",
  "options_risk_per_trade_pct",
  "options_max_positions",
  "options_max_trades_per_day",
  "options_min_conviction",
  "options_min_dte",
  "options_max_dte",
  "options_weekly_loss_budget_usd",
  "options_account_floor_usd",
  "options_universe",
];

async function loadConfig(): Promise<OptionsAgentConfig> {
  try {
    const rows = await prisma.agentConfig.findMany({ where: { key: { in: CONFIG_KEYS } } });
    const c: Record<string, string> = {};
    for (const r of rows) c[r.key] = r.value;
    const enabledVal = c.options_enabled ?? "";
    return {
      enabled: enabledVal === "paper" || enabledVal === "live",
      mode: (enabledVal === "live" ? "live" : "paper") as TradingMode,
      accountSize: parseFloat(c.options_account_size) || DEFAULTS.accountSize,
      maxRiskUsd: parseFloat(c.options_max_risk_usd) || DEFAULTS.maxRiskUsd,
      riskPerTradePct: parseFloat(c.options_risk_per_trade_pct) || DEFAULTS.riskPerTradePct,
      maxPositions: parseInt(c.options_max_positions) || DEFAULTS.maxPositions,
      maxTradesPerDay: parseInt(c.options_max_trades_per_day) || DEFAULTS.maxTradesPerDay,
      minConviction: parseFloat(c.options_min_conviction) || DEFAULTS.minConviction,
      minDte: parseInt(c.options_min_dte) || DEFAULTS.minDte,
      maxDte: parseInt(c.options_max_dte) || DEFAULTS.maxDte,
      weeklyLossBudgetUsd: parseFloat(c.options_weekly_loss_budget_usd) || DEFAULTS.weeklyLossBudgetUsd,
      accountFloorUsd: parseFloat(c.options_account_floor_usd) || DEFAULTS.accountFloorUsd,
      universe: (c.options_universe || DEFAULTS.universe.join(",")).split(",").map((s) => s.trim().toUpperCase()).filter(Boolean),
    };
  } catch {
    return { ...DEFAULTS };
  }
}

// ---------- Research signal ----------

export interface SignalResult {
  symbol: string;
  price: number;
  direction: "bullish" | "bearish" | null;
  conviction: number; // 0-100 (pre-AI)
  reasons: string[];
  earningsBlocked: boolean; // earnings inside the DTE window → never BUY premium (IV crush)
  postEarningsDrift: boolean; // reported in last 1-3 sessions → IV crushed, drift play (preferred)
  newsHeadlines?: string[]; // recent headlines — surfaced to the AI grader for a real catalyst read
}

function daysBetween(a: Date, b: Date): number {
  return Math.round((b.getTime() - a.getTime()) / 86_400_000);
}

// Score one symbol from Finnhub research. Each finnhub fn already degrades to []/null on error.
async function scoreSymbol(symbol: string, earnings: EarningsCalendarItem[], cfg: OptionsAgentConfig): Promise<SignalResult> {
  const reasons: string[] = [];
  let score = 0; // signed: + = bullish, - = bearish
  let earningsBlocked = false;
  let postEarningsDrift = false;
  const now = new Date();

  let price = 0;
  try {
    const snap = await getSnapshot(symbol);
    price = snap.latestTrade?.p || snap.latestQuote?.ap || 0;
  } catch { /* price 0 → handled by caller */ }

  // Earnings: block buying into an upcoming report (IV crush); reward post-report drift.
  for (const e of earnings.filter((x) => x.symbol === symbol && x.date)) {
    const d = daysBetween(now, new Date(e.date + "T00:00:00Z"));
    if (d > 0 && d <= cfg.maxDte) {
      earningsBlocked = true;
      reasons.push(`earnings in ${d}d (block buy — IV crush risk)`);
    }
    if (d <= 0 && d >= -3 && e.epsActual != null && e.epsEstimate != null) {
      const surprise = e.epsActual - e.epsEstimate;
      if (surprise > 0) { score += 25; postEarningsDrift = true; reasons.push(`EPS beat ${e.epsActual} vs ${e.epsEstimate} (post-earnings drift up)`); }
      else if (surprise < 0) { score -= 25; postEarningsDrift = true; reasons.push(`EPS miss ${e.epsActual} vs ${e.epsEstimate} (post-earnings drift down)`); }
    }
  }

  // Analyst upgrades/downgrades in the last ~30 days.
  try {
    const ud = await getUpgradesDowngrades(symbol);
    const cutoff = now.getTime() - 30 * 86_400_000;
    let net = 0;
    for (const u of ud) {
      const t = new Date((u as { gradeTime?: string }).gradeTime || 0).getTime();
      if (t < cutoff) continue;
      const a = (u.action || "").toLowerCase();
      if (a.includes("up")) net += 1;
      else if (a.includes("down")) net -= 1;
    }
    if (net > 0) { score += 15; reasons.push(`${net} net analyst upgrade(s) 30d`); }
    else if (net < 0) { score -= 15; reasons.push(`${net} net analyst downgrade(s) 30d`); }
  } catch { /* ignore */ }

  // Recommendation-trend shift (latest period vs prior).
  try {
    const rt = await getRecommendationTrends(symbol);
    if (rt.length >= 2) {
      const bull = (r: typeof rt[0]) => r.strongBuy + r.buy - r.sell - r.strongSell;
      const delta = bull(rt[0]) - bull(rt[1]);
      if (delta > 0) { score += 15; reasons.push(`analyst consensus improving (+${delta})`); }
      else if (delta < 0) { score -= 15; reasons.push(`analyst consensus weakening (${delta})`); }
    }
  } catch { /* ignore */ }

  // Price-target gap.
  try {
    const pt = await getPriceTargetConsensus(symbol);
    if (pt && pt.targetMean > 0 && price > 0) {
      const gap = (pt.targetMean - price) / price;
      if (gap > 0.10) { score += 10; reasons.push(`+${(gap * 100).toFixed(0)}% to mean target`); }
      else if (gap < -0.10) { score -= 10; reasons.push(`${(gap * 100).toFixed(0)}% to mean target`); }
    }
  } catch { /* ignore */ }

  // Insider sentiment (MSPR, latest month).
  try {
    const ins = await getInsiderSentiment(symbol);
    if (ins.length) {
      const latest = ins[ins.length - 1];
      if (latest.mspr > 20) { score += 10; reasons.push(`insider buying (MSPR ${latest.mspr.toFixed(0)})`); }
      else if (latest.mspr < -20) { score -= 10; reasons.push(`insider selling (MSPR ${latest.mspr.toFixed(0)})`); }
    }
  } catch { /* ignore */ }

  // Social sentiment (low weight — noisy).
  try {
    const soc = await getSocialSentiment(symbol);
    if (soc && Math.abs(soc.score) > 0.3) {
      const s = soc.score > 0 ? 8 : -8;
      score += s;
      reasons.push(`social sentiment ${soc.score.toFixed(2)}`);
    }
  } catch { /* ignore */ }

  // News catalysts (Alpaca real-time news) — a keyword pass gives directional lean here; the actual
  // headlines are also handed to the AI grader for a proper read. Fresh, high-volume news = a live catalyst.
  let newsHeadlines: string[] = [];
  try {
    const news = await getNews([symbol], 15);
    const recent = news.filter((n) => Date.now() - new Date(n.created_at).getTime() < 3 * 86_400_000); // last 3 days
    newsHeadlines = recent.slice(0, 6).map((n) => n.headline);
    const BULL = /\b(beat|beats|tops? estimates|surge|soar|jump|rally|record|upgrade|raises? guidance|outperform|approval|wins?|acqui|buyback)/i;
    const BEAR = /\b(miss|misses|plunge|slump|fall|drop|downgrade|cut|slash|lawsuit|probe|recall|warn|weak|halts?|investigation|guidance cut)/i;
    let ns = 0;
    for (const n of recent) { const t = `${n.headline} ${n.summary}`; if (BULL.test(t)) ns += 1; if (BEAR.test(t)) ns -= 1; }
    if (recent.length >= 3 && ns > 0) { score += 12; reasons.push(`${recent.length} recent headlines, net bullish`); }
    else if (recent.length >= 3 && ns < 0) { score -= 12; reasons.push(`${recent.length} recent headlines, net bearish`); }
  } catch { /* ignore */ }

  // Congressional trading — following disclosed buys/sells is a documented alt-data edge.
  try {
    const ct = await getCongressionalTrading(symbol);
    const cutoff = now.getTime() - 90 * 86_400_000; // last 90 days
    let net = 0;
    for (const t of ct) {
      const rec = t as unknown as { transactionDate?: string; transactionType?: string };
      if (new Date(rec.transactionDate || 0).getTime() < cutoff) continue;
      const type = String(rec.transactionType || "").toLowerCase();
      if (type.includes("purchase") || type.includes("buy")) net += 1;
      else if (type.includes("sale") || type.includes("sell")) net -= 1;
    }
    if (net > 0) { score += 12; reasons.push(`${net} net congressional buy(s) 90d`); }
    else if (net < 0) { score -= 12; reasons.push(`${net} net congressional sale(s) 90d`); }
  } catch { /* ignore */ }

  const direction: SignalResult["direction"] = score > 0 ? "bullish" : score < 0 ? "bearish" : null;
  const conviction = Math.min(100, Math.abs(score));
  return { symbol, price, direction, conviction, reasons, earningsBlocked, postEarningsDrift, newsHeadlines };
}

// ---------- AI grader veto ----------

// Ring buffer of veto decisions so the /options page shows what the agent graded — kills included
async function recordOptionsDecision(d: {
  sym: string; direction: string | null; conviction: string; agree: boolean;
  ivRank: number; maxRisk: number; reason: string;
}) {
  try {
    const key = "options_decisions";
    const row = await prisma.agentConfig.findUnique({ where: { key } });
    let arr: unknown[] = [];
    try { arr = JSON.parse(row?.value || "[]"); if (!Array.isArray(arr)) arr = []; } catch { arr = []; }
    arr.unshift({ ts: new Date().toISOString(), ...d });
    const value = JSON.stringify(arr.slice(0, 40));
    await prisma.agentConfig.upsert({ where: { key }, update: { value }, create: { key, value } });
  } catch { /* best-effort — never block trading on telemetry */ }
}

async function aiConfirmOptionsSetup(
  sig: SignalResult,
  ivRank: number,
  debit: number,
  maxRisk: number,
  brainContext = "",
): Promise<{ agree: boolean; conviction: string; reasoning: string }> {
  const anthropic = new Anthropic();
  const prompt = `You are a disciplined options trader managing a tiny (~$500) account. You ONLY buy DEFINED-RISK vertical DEBIT spreads, 7-14 DTE. Buying options is negative-EV on average, so you reject anything that isn't a clean, well-supported setup.
CRITICAL: Only A+ and A execute. B and C are KILLED.

${sig.symbol} ${sig.direction} debit spread:
Underlying price: $${sig.price.toFixed(2)}
IV rank: ${ivRank.toFixed(0)}/100 (lower = options cheaper)
Net debit (max loss): $${debit.toFixed(2)}/contract, total risk ~$${maxRisk.toFixed(0)}
Post-earnings drift: ${sig.postEarningsDrift ? "yes (IV already crushed)" : "no"}
Research signals: ${sig.reasons.join("; ") || "none"}
${sig.newsHeadlines && sig.newsHeadlines.length ? `\nRecent news headlines (judge whether these are a REAL directional catalyst or already priced in):\n- ${sig.newsHeadlines.join("\n- ")}\n` : ""}${brainContext ? `\nTRADING BRAIN (respect the current regime + honor active lessons/anti-patterns):\n${brainContext}\n` : ""}
A+ = strong catalyst + cheap IV + clean direction. A = solid edge. B = marginal. C = no real edge.
Reply ONLY with JSON: {"agree": true/false, "conviction": "A+"|"A"|"B"|"C", "reasoning": "one sentence"}`;
  try {
    // Fable 5 veto: rare call (≤1 trade/day), no tight clock, real money — worth the
    // deepest skeptic. Thinking tokens count against max_tokens, so give them room.
    const response = await anthropic.messages.create({
      model: "claude-fable-5",
      max_tokens: 6000,
      thinking: { type: "adaptive" },
      messages: [{ role: "user", content: prompt }],
    });
    const text = response.content
      .filter((b): b is Anthropic.TextBlock => b.type === "text")
      .map((b) => b.text)
      .join("");
    let jsonText = text.trim();
    const m = jsonText.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/);
    if (m) jsonText = m[1].trim();
    // Model may prepend prose before bare JSON — extract the outermost object
    const braceMatch = jsonText.match(/\{[\s\S]*\}/);
    if (braceMatch) jsonText = braceMatch[0];
    const verdict = JSON.parse(jsonText) as { agree: boolean; conviction: string; reasoning: string };
    await recordOptionsDecision({
      sym: sig.symbol, direction: sig.direction, conviction: verdict.conviction || "?",
      agree: !!verdict.agree, ivRank, maxRisk, reason: verdict.reasoning || "",
    });
    return verdict;
  } catch (err) {
    console.error("[options-agent] AI error:", err);
    await recordOptionsDecision({
      sym: sig.symbol, direction: sig.direction, conviction: "C", agree: false,
      ivRank, maxRisk, reason: "AI error — skipping",
    });
    return { agree: false, conviction: "C", reasoning: "AI error — skipping" };
  }
}

// ---------- Spread group metadata (stored in autoTradeLog.reason as JSON) ----------

interface SpreadMeta {
  groupId: string;
  buySym: string;
  sellSym: string;
  qty: number;
  debit: number; // net debit per contract
  maxRisk: number; // debit * 100 * qty
  expiry: string;
  direction: "bullish" | "bearish";
}

function encodeMeta(prefix: string, meta: Partial<SpreadMeta> & Record<string, unknown>): string {
  return `${prefix} ${JSON.stringify(meta)}`;
}
function decodeMeta(reason: string): (SpreadMeta & Record<string, unknown>) | null {
  const i = reason.indexOf("{");
  if (i < 0) return null;
  try { return JSON.parse(reason.slice(i)); } catch { return null; }
}

function mid(snap: { latestQuote?: { ap: number; bp: number } } | undefined): number {
  if (!snap?.latestQuote) return 0;
  const { ap, bp } = snap.latestQuote;
  if (ap > 0 && bp > 0) return (ap + bp) / 2;
  return ap || bp || 0;
}

// ---------- Executor: 7-14 DTE defined-risk debit spread ----------

interface ExecResult { success: boolean; details: string; meta?: SpreadMeta; }

async function executeAgentDebitSpread(
  sig: SignalResult,
  cfg: OptionsAgentConfig,
  maxRiskUsd: number,
  buyingPower: number,
  dry: boolean,
): Promise<ExecResult> {
  if (!sig.direction) return { success: false, details: "no direction" };
  const type: "call" | "put" = sig.direction === "bullish" ? "call" : "put";
  const now = Date.now();
  const gte = new Date(now + cfg.minDte * 86_400_000).toISOString().split("T")[0];
  const lte = new Date(now + cfg.maxDte * 86_400_000).toISOString().split("T")[0];

  let contracts: OptionsContract[] = [];
  try { contracts = await getOptionsChain(sig.symbol, undefined, type, gte, lte); }
  catch (e) { return { success: false, details: `chain error: ${e}` }; }
  if (contracts.length < 2) return { success: false, details: "not enough contracts in 7-14 DTE window" };

  // Use the nearest expiration within the window.
  const expiry = [...new Set(contracts.map((c) => c.expiration_date))].sort()[0];
  const exp = contracts.filter((c) => c.expiration_date === expiry).sort((a, b) => parseFloat(a.strike_price) - parseFloat(b.strike_price));
  const px = sig.price;
  const nearATM = exp.filter((c) => {
    const s = parseFloat(c.strike_price);
    return s >= px * 0.98 && s <= px * 1.02;
  });
  if (nearATM.length === 0) return { success: false, details: "no near-ATM strike" };

  let buyC: OptionsContract, sellC: OptionsContract;
  if (type === "call") {
    buyC = nearATM[0];
    const higher = exp.filter((c) => parseFloat(c.strike_price) > parseFloat(buyC.strike_price));
    if (!higher.length) return { success: false, details: "no higher strike" };
    sellC = higher[0];
  } else {
    buyC = nearATM[nearATM.length - 1];
    const lower = exp.filter((c) => parseFloat(c.strike_price) < parseFloat(buyC.strike_price));
    if (!lower.length) return { success: false, details: "no lower strike" };
    sellC = lower[lower.length - 1];
  }

  // Net debit from mid prices.
  let snaps: Record<string, { latestQuote?: { ap: number; bp: number } }> = {};
  try { snaps = await getOptionsSnapshots([buyC.symbol, sellC.symbol]); }
  catch (e) { return { success: false, details: `snapshot error: ${e}` }; }
  const debit = mid(snaps[buyC.symbol]) - mid(snaps[sellC.symbol]);
  if (!(debit > 0)) return { success: false, details: `bad pricing (debit ${debit.toFixed(2)})` };

  const qty = Math.floor(maxRiskUsd / (debit * 100));
  if (qty < 1) return { success: false, details: `too expensive: 1 spread = $${(debit * 100).toFixed(0)} > cap $${maxRiskUsd.toFixed(0)}` };
  const maxRisk = debit * 100 * qty;
  if (maxRisk > buyingPower) return { success: false, details: `insufficient buying power ($${buyingPower.toFixed(0)} < $${maxRisk.toFixed(0)})` };

  const buyStrike = parseFloat(buyC.strike_price);
  const sellStrike = parseFloat(sellC.strike_price);
  const planned = `${sig.direction.toUpperCase()} ${type} debit spread ${sig.symbol} ${buyStrike}/${sellStrike} exp ${expiry} x${qty} @ $${debit.toFixed(2)} debit (max loss $${maxRisk.toFixed(0)})`;

  if (dry) return { success: true, details: `[DRY] would open: ${planned}` };

  // SAFETY: refuse a live order unless explicitly enabled live.
  if (cfg.mode === "live" && !(await isLiveEnabled())) {
    return { success: false, details: "refused: live order but options_enabled !== live" };
  }

  const groupId = `OPTG-${Date.now().toString(36)}`;
  // ATOMIC multi-leg entry — both legs fill together or neither (no naked-leg risk). Net-debit LIMIT
  // at a 10% buffer so it fills but can never pay more than intended for the spread.
  const limitPrice = (Math.ceil(debit * 1.10 * 100) / 100).toFixed(2);
  const order = await placeMultiLegOrder({
    qty: String(qty),
    type: "limit",
    time_in_force: "day",
    limit_price: limitPrice,
    legs: [
      { symbol: buyC.symbol, side: "buy", ratio_qty: "1", position_intent: "buy_to_open" },
      { symbol: sellC.symbol, side: "sell", ratio_qty: "1", position_intent: "sell_to_open" },
    ],
  }, cfg.mode);

  // A limit spread can sit unfilled. Only record the spread once it ACTUALLY fills — otherwise cancel
  // and skip, so we never book a phantom position that fakes a max-loss and blocks the position/day caps.
  let filled = false;
  for (let i = 0; i < 5; i++) {
    await new Promise((r) => setTimeout(r, 3000));
    try {
      const st = (await getOrder(order.id, cfg.mode)).status;
      if (st === "filled" || st === "partially_filled") { filled = true; break; }
      if (st === "canceled" || st === "rejected" || st === "expired") break;
    } catch { /* keep polling */ }
  }
  if (!filled) {
    await cancelOrder(order.id, cfg.mode).catch(() => {});
    return { success: false, details: `spread limit ($${limitPrice}) did not fill — canceled, no position opened` };
  }

  const meta: SpreadMeta = { groupId, buySym: buyC.symbol, sellSym: sellC.symbol, qty, debit, maxRisk, expiry, direction: sig.direction };

  // Real-money fill — Slack alert on every spread open
  await sendNotification(
    `📊 OPTIONS OPEN [${cfg.mode}] ${sig.symbol} ${sig.direction} debit spread ${qty}x — debit $${debit.toFixed(2)}, max risk $${maxRisk.toFixed(0)}, exp ${expiry}`,
    "options"
  ).catch(() => {});

  await prisma.autoTradeLog.create({
    data: {
      symbol: `OPT:${sig.symbol}`,
      action: "opt_open",
      qty,
      price: debit,
      reason: encodeMeta(`[OPT-OPEN] ${planned}.`, { ...meta, reasons: sig.reasons, mlegOrderId: order.id, limitPrice }),
      aiSignal: sig.direction,
      orderId: order.id,
    },
  });
  await logTradeToJournal({
    tradeId: `${new Date().toISOString().slice(0, 10)}-OPT-${groupId.slice(-4)}`,
    timestamp: new Date().toISOString(),
    instrument: `OPT:${sig.symbol}`,
    direction: sig.direction === "bullish" ? "LONG" : "SHORT",
    strategy: "options-agent",
    setupType: `${type}_debit_spread`,
    contracts: qty,
    entryPrice: debit,
    stopPrice: debit * 0.5,
    targetPrice: debit * 1.5,
    conviction: Math.round(sig.conviction / 20),
  }, `options-agent-${cfg.mode}`);
  await logDecision("options-agent", "ENTRY", `OPT:${sig.symbol}`, `${planned}. ${sig.reasons.join("; ")}`, Math.round(sig.conviction / 20));

  return { success: true, details: `OPENED ${planned}`, meta };
}

async function isLiveEnabled(): Promise<boolean> {
  const row = await prisma.agentConfig.findUnique({ where: { key: "options_enabled" } });
  return row?.value === "live";
}

// ---------- Position management (unit-level) ----------

async function getOpenGroups(): Promise<SpreadMeta[]> {
  // Open groups = opt_open rows whose groupId has no matching opt_close.
  const opens = await prisma.autoTradeLog.findMany({
    where: { symbol: { startsWith: "OPT:" }, action: "opt_open" },
    orderBy: { createdAt: "desc" },
    take: 50,
  });
  const closes = await prisma.autoTradeLog.findMany({
    where: { symbol: { startsWith: "OPT:" }, action: "opt_close" },
    orderBy: { createdAt: "desc" },
    take: 100,
  });
  const closedIds = new Set<string>();
  for (const c of closes) { const m = decodeMeta(c.reason); if (m?.groupId) closedIds.add(m.groupId); }
  const groups: SpreadMeta[] = [];
  for (const o of opens) {
    const m = decodeMeta(o.reason);
    if (m?.groupId && !closedIds.has(m.groupId)) groups.push(m);
  }
  return groups;
}

async function logClose(meta: SpreadMeta, pnl: number, exitReason: string, mode: TradingMode) {
  const r = meta.maxRisk > 0 ? pnl / meta.maxRisk : 0;
  // Real-money close — Slack alert with P&L
  await sendNotification(
    `📊 OPTIONS CLOSE [${mode}] ${meta.buySym.replace(/\d.*/, "")} ${exitReason}: ${pnl >= 0 ? "+" : "-"}$${Math.abs(pnl).toFixed(0)} (${r >= 0 ? "+" : ""}${r.toFixed(2)}R)`,
    "options"
  ).catch(() => {});
  await prisma.autoTradeLog.create({
    data: {
      symbol: `OPT:${meta.buySym.replace(/\d.*/, "")}`,
      action: "opt_close",
      qty: meta.qty,
      price: meta.debit,
      pnl,
      reason: encodeMeta(`[OPT-CLOSE] ${exitReason} r=${r.toFixed(2)}`, { groupId: meta.groupId, pnl, r, exit: exitReason }),
      aiSignal: meta.direction,
    },
  });
  await logTradeToJournal({
    tradeId: `${new Date().toISOString().slice(0, 10)}-OPT-${meta.groupId.slice(-4)}-x`,
    timestamp: new Date().toISOString(),
    instrument: `OPT:${meta.buySym.replace(/\d.*/, "")}`,
    direction: meta.direction === "bullish" ? "LONG" : "SHORT",
    strategy: "options-agent",
    setupType: "debit_spread",
    contracts: meta.qty,
    entryPrice: meta.debit,
    stopPrice: meta.debit * 0.5,
    targetPrice: meta.debit * 1.5,
    exitPrice: meta.debit + pnl / (meta.qty * 100),
    pnlDollars: pnl,
    rMultiple: r,
    conviction: 3,
    exitReason,
  }, `options-agent-${mode}`);
}

async function manageAgentSpreads(positions: Position[], cfg: OptionsAgentConfig, dry: boolean): Promise<string[]> {
  const out: string[] = [];
  const groups = await getOpenGroups();
  const posBySym: Record<string, Position> = {};
  for (const p of positions) posBySym[p.symbol] = p;
  const now = Date.now();

  for (const g of groups) {
    const buyP = posBySym[g.buySym];
    const sellP = posBySym[g.sellSym];
    const dte = Math.round((new Date(g.expiry + "T00:00:00Z").getTime() - now) / 86_400_000);

    // Legs gone (expired / settled externally): close the group conservatively at max loss.
    if (!buyP && !sellP) {
      if (dte <= 0) {
        if (!dry) await logClose(g, -g.maxRisk, "expired (assumed worthless)", cfg.mode);
        out.push(`${g.buySym}: expired → assumed −$${g.maxRisk.toFixed(0)}`);
      }
      continue;
    }

    const unitUnreal = (buyP ? parseFloat(buyP.unrealized_pl) : 0) + (sellP ? parseFloat(sellP.unrealized_pl) : 0);
    const cost = g.maxRisk;
    const pnlPct = cost > 0 ? unitUnreal / cost : 0;

    let exit: string | null = null;
    if (pnlPct >= 0.5) exit = "target +50%";
    else if (pnlPct <= -0.5) exit = "stop -50%";
    else if (dte <= cfg.minDte) exit = `time-stop (${dte} DTE)`;
    if (!exit) { out.push(`${g.buySym}: hold (${(pnlPct * 100).toFixed(0)}%, ${dte} DTE)`); continue; }

    if (dry) { out.push(`[DRY] ${g.buySym}: would close — ${exit} (${(pnlPct * 100).toFixed(0)}%)`); continue; }
    try {
      if (buyP) await placeOrder({ symbol: g.buySym, qty: String(Math.abs(parseFloat(buyP.qty))), side: "sell", type: "market", time_in_force: "day" }, cfg.mode);
      if (sellP) await placeOrder({ symbol: g.sellSym, qty: String(Math.abs(parseFloat(sellP.qty))), side: "buy", type: "market", time_in_force: "day" }, cfg.mode);
      await logClose(g, unitUnreal, exit, cfg.mode);
      out.push(`CLOSED ${g.buySym}: ${exit} → $${unitUnreal.toFixed(0)}`);
    } catch (e) {
      out.push(`${g.buySym}: close error ${e}`);
    }
  }
  return out;
}

// ---------- Scoreboard ----------

export interface OptionsScoreboard {
  closed: number;
  wins: number;
  winRate: number;
  avgR: number;
  totalPnl: number;
  openGroups: number;
}

export async function getOptionsScoreboard(): Promise<OptionsScoreboard> {
  const closes = await prisma.autoTradeLog.findMany({
    where: { symbol: { startsWith: "OPT:" }, action: "opt_close", pnl: { not: null } },
    orderBy: { createdAt: "desc" },
    take: 500,
  });
  const closed = closes.length;
  let wins = 0, totalPnl = 0, sumR = 0;
  for (const c of closes) {
    const pnl = c.pnl ?? 0;
    totalPnl += pnl;
    if (pnl > 0) wins++;
    const m = decodeMeta(c.reason) as { r?: number } | null;
    sumR += typeof m?.r === "number" ? m.r : 0;
  }
  const groups = await getOpenGroups();
  return {
    closed,
    wins,
    winRate: closed ? wins / closed : 0,
    avgR: closed ? sumR / closed : 0,
    totalPnl,
    openGroups: groups.length,
  };
}

// ---------- Risk: weekly realized P&L ----------

async function weekRealizedPnl(): Promise<number> {
  const start = new Date();
  const day = start.getUTCDay();
  const diff = (day + 6) % 7; // days since Monday
  start.setUTCDate(start.getUTCDate() - diff);
  start.setUTCHours(0, 0, 0, 0);
  const agg = await prisma.autoTradeLog.aggregate({
    where: { symbol: { startsWith: "OPT:" }, action: "opt_close", pnl: { not: null }, createdAt: { gte: start } },
    _sum: { pnl: true },
  });
  return agg._sum.pnl ?? 0;
}

async function todayOpenCount(): Promise<number> {
  const start = new Date(); start.setHours(0, 0, 0, 0);
  return prisma.autoTradeLog.count({ where: { symbol: { startsWith: "OPT:" }, action: "opt_open", createdAt: { gte: start } } });
}

// ---------- Orchestrator ----------

export interface OptionsAgentResult {
  enabled: boolean;
  mode: TradingMode;
  dry: boolean;
  opened: number;
  managed: string[];
  details: string[];
  scoreboard?: OptionsScoreboard;
}

export async function runOptionsAgent(opts?: { dry?: boolean }): Promise<OptionsAgentResult> {
  const dry = !!opts?.dry;
  const cfg = await loadConfig();
  const details: string[] = [];
  const result: OptionsAgentResult = { enabled: cfg.enabled, mode: cfg.mode, dry, opened: 0, managed: [], details };

  if (!cfg.enabled && !dry) { details.push("options agent disabled (set options_enabled=paper|live)"); return result; }

  // Market hours (orders only fill RTH).
  let isOpen = false;
  try { isOpen = (await getMarketClock()).is_open; } catch { /* assume closed */ }
  if (!isOpen && !dry) { details.push("market closed — skipping"); return result; }

  // Positions + manage existing first (always, even when entries halted).
  let positions: Position[] = [];
  try { positions = await getPositions(cfg.mode); } catch (e) { details.push(`positions error: ${e}`); }
  const optionPositions = positions.filter((p) => p.symbol.length > 10); // OCC symbols
  result.managed = await manageAgentSpreads(optionPositions, cfg, dry);

  // ---- Entry gates ----
  const reasonsHalt: string[] = [];
  let account;
  try { account = await getAccount(cfg.mode); } catch (e) { details.push(`account error: ${e}`); }
  const equity = account ? parseFloat(account.equity) : 0;
  const buyingPower = account ? (parseFloat(account.options_buying_power) || parseFloat(account.buying_power) || 0) : 0;

  if (equity > 0 && equity < cfg.accountFloorUsd) reasonsHalt.push(`account floor: equity $${equity.toFixed(0)} < $${cfg.accountFloorUsd}`);
  const weekPnl = await weekRealizedPnl();
  if (weekPnl <= -cfg.weeklyLossBudgetUsd) reasonsHalt.push(`weekly loss budget hit ($${weekPnl.toFixed(0)})`);
  const openGroups = await getOpenGroups();
  if (openGroups.length >= cfg.maxPositions) reasonsHalt.push(`max positions (${openGroups.length}/${cfg.maxPositions})`);
  const opensToday = await todayOpenCount();
  if (opensToday >= cfg.maxTradesPerDay) reasonsHalt.push(`max trades/day (${opensToday}/${cfg.maxTradesPerDay})`);
  try {
    const pause = await areEntriesPaused(cfg.mode === "live" ? "live" : "demo");
    if (pause?.paused) reasonsHalt.push(`orchestrator paused: ${pause.reason}`);
  } catch { /* ignore */ }

  if (reasonsHalt.length && !dry) {
    details.push(`entries halted — ${reasonsHalt.join("; ")}. Managing only.`);
    result.scoreboard = await getOptionsScoreboard();
    return result;
  }
  if (reasonsHalt.length) details.push(`(dry) would halt entries: ${reasonsHalt.join("; ")}`);

  const perTradeCap = Math.min(cfg.maxRiskUsd, (equity || cfg.accountSize) * (cfg.riskPerTradePct / 100));

  // ---- Scan universe → score → IV gate → AI veto → execute best ----
  let earnings: EarningsCalendarItem[] = [];
  try {
    const from = new Date(Date.now() - 4 * 86_400_000).toISOString().split("T")[0];
    const to = new Date(Date.now() + cfg.maxDte * 86_400_000).toISOString().split("T")[0];
    earnings = await getEarningsCalendar(from, to);
  } catch { /* ignore */ }

  // Pull the trading brain once (market regime + active lessons + anti-patterns) to inform the grader.
  let brainContext = "";
  try {
    const ctx = await loadAgentContext("options-agent", "options-spreads.md");
    brainContext = [
      ctx.marketRegime ? `REGIME: ${ctx.marketRegime.slice(0, 250)}` : "",
      ctx.activeLessons ? `LESSONS: ${ctx.activeLessons.slice(0, 250)}` : "",
      ctx.antiPatterns ? `ANTI-PATTERNS: ${ctx.antiPatterns.slice(0, 200)}` : "",
    ].filter(Boolean).join("\n");
  } catch { /* brain optional — never block a run on it */ }

  const candidates: SignalResult[] = [];
  for (const sym of cfg.universe) {
    try {
      const sig = await scoreSymbol(sym, earnings, cfg);
      if (sig.direction && sig.price > 0 && sig.conviction >= cfg.minConviction && !sig.earningsBlocked) {
        candidates.push(sig);
      } else {
        // Always log WHY a symbol was skipped (not just in dry runs) — otherwise a real run that
        // finds no signal reports empty details and looks broken. This is why "no options yet".
        details.push(`skip ${sym}: ${!sig.direction ? "no signal" : sig.earningsBlocked ? "earnings window" : `conviction ${sig.conviction}<${cfg.minConviction}`}`);
      }
    } catch (e) { details.push(`score ${sym} error: ${e}`); }
  }
  candidates.sort((a, b) => b.conviction - a.conviction);
  if (candidates.length === 0) {
    details.push(`— scanned ${cfg.universe.length} symbols, 0 met the conviction ≥ ${cfg.minConviction} bar (needs a strong Finnhub research signal — mostly post-earnings drift/analyst momentum)`);
  }

  // One entry per tick (max_trades_per_day governs the rest).
  for (const sig of candidates) {
    // IV gate: only BUY when options are cheap/fair (don't overpay for vol).
    let ivRank = 50, ivVsHv = "fair";
    try { const vol = await analyzeVolatility(sig.symbol); ivRank = vol.ivRank; ivVsHv = vol.ivVsHv; } catch { /* ignore */ }
    if (ivVsHv === "expensive" && !sig.postEarningsDrift) {
      details.push(`skip ${sig.symbol}: IV ${ivRank.toFixed(0)} expensive (buy-only would overpay)`);
      continue;
    }
    // Probe a debit + size with a dry executor pass first so the AI sees the real risk.
    const probe = await executeAgentDebitSpread(sig, cfg, perTradeCap, buyingPower, true);
    if (!probe.success) { details.push(`skip ${sig.symbol}: ${probe.details}`); continue; }

    // AI veto (only A+/A execute).
    const debitGuess = perTradeCap; // probe already proved a fit; use cap for the prompt magnitude
    const ai = await aiConfirmOptionsSetup(sig, ivRank, debitGuess / 100, perTradeCap, brainContext);
    if (!ai.agree || ai.conviction === "B" || ai.conviction === "C") {
      await logDecision("options-agent", "SKIP", `OPT:${sig.symbol}`, `AI ${ai.conviction}: ${ai.reasoning}`, 1).catch(() => {});
      details.push(`KILLED ${sig.symbol}: AI ${ai.conviction} — ${ai.reasoning}`);
      continue;
    }

    const exec = await executeAgentDebitSpread(sig, cfg, perTradeCap, buyingPower, dry);
    details.push(`${sig.symbol}: ${exec.details}`);
    if (exec.success && !dry) { result.opened++; break; } // one entry per tick
    if (dry && exec.success) { break; }
  }

  if (result.opened > 0) {
    await logObservation("options-agent", `Session: opened ${result.opened}, ${result.managed.length} managed. ${details.slice(-3).join(" | ")}`).catch(() => {});
  }
  // Persist per-run reasoning so the UI can show WHY it skipped/traded (mirrors kraken_last_run).
  try {
    const payload = JSON.stringify({ ts: new Date().toISOString(), opened: result.opened, managed: result.managed, halted: reasonsHalt.length > 0, haltReasons: reasonsHalt, details: details.slice(-10) });
    await prisma.agentConfig.upsert({ where: { key: "options_last_run" }, update: { value: payload }, create: { key: "options_last_run", value: payload } });
  } catch { /* best-effort */ }
  result.scoreboard = await getOptionsScoreboard();
  return result;
}

// Status for the /options page: config + scoreboard + last-run reasoning (mirrors getKrakenStatus).
export async function getOptionsStatus() {
  const rows = await prisma.agentConfig.findMany({ where: { key: { in: [...CONFIG_KEYS, "options_last_run", "options_cron_last_run", "options_decisions"] } } });
  const config: Record<string, string> = {};
  for (const r of rows) config[r.key] = r.value;
  let lastRun: unknown = null;
  try { if (config.options_last_run) lastRun = JSON.parse(config.options_last_run); } catch { /* ignore */ }
  let decisions: unknown[] = [];
  try { const d = JSON.parse(config.options_decisions || "[]"); if (Array.isArray(d)) decisions = d; } catch { /* ignore */ }
  delete config.options_decisions; // don't double-ship the raw JSON string
  return {
    enabled: config.options_enabled === "paper" || config.options_enabled === "live",
    mode: config.options_enabled === "live" ? "live" : "paper",
    config,
    scoreboard: await getOptionsScoreboard(),
    lastRun,
    decisions,
  };
}
