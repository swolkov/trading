#!/usr/bin/env node
// ============ REAL-TIME FUTURES TRADING ENGINE ============
// Persistent process — streams real-time prices via Tradovate WebSocket,
// falls back to Databento live_quotes polling if the WebSocket is unavailable.
// Builds bars, detects setups on bar close, executes via Tradovate.
// Deploy on Railway — two instances: ENGINE_MODE=demo and ENGINE_MODE=live.

import { prisma } from "../lib/db";
import { sendNotification } from "../lib/notifications";
import { logTradeToJournal, logDecision, logObservation, vaultRead, vaultWrite, updateBrain, appendLiveFeed } from "../lib/vault";
import { getETHour, getETDayOfWeek, getETDateString, isWeekend as isWeekendET, isHalt as isHaltET } from "../lib/session-time";
import { TradovateWebSocket, type QuoteUpdate } from "./tradovate-ws";
import { getPlanContextForGrading } from "../lib/advisor";
import { matchEdge, isEdgeEnabled, allEdgeFlagKeys, edgeFlagKey, REALTIME_EDGES } from "../lib/realtime-edges";
import { VAULT_SESSION_RULES } from "../lib/vault-session-gates";
import { reconcileBrokerPosition } from "../lib/broker-position-reconciliation";
import { cappedContractLimit, isFreshPositiveEquity, nonNegativeConfigNumber } from "../lib/risk-sizing";
import { contractMappingMatchesBroker, selectFreshContractMapping } from "../lib/databento-contract-mapping";
import { FUTURES_STRATEGY_VERSION } from "../lib/strategy-version";
import {
  FULL_SIZE_FUTURES,
  MICRO_FUTURES,
  livePolicySessionMultiplier,
  overnightMarginContractCap,
  selectFuturesSymbols,
} from "../lib/futures-trading-policy";
import { createServer } from "node:http";


// ── Config ──────────────────────────────────────────────

const DEMO_API = "https://demo.tradovateapi.com/v1";
const LIVE_API = "https://live.tradovateapi.com/v1";

// ENGINE_MODE: "demo" or "live" — set per Railway service via env var
// Demo engine: 24/7 learning, full-size, DEMO_API, 5s polling
// Live engine: RTH prime only, micros, LIVE_API
const ENGINE_MODE = (process.env.ENGINE_MODE || "demo") as "demo" | "live";
const IS_DEMO = ENGINE_MODE === "demo";
const IS_LIVE = ENGINE_MODE === "live";
// Real-money entries require an explicit infrastructure-level arm in addition to every DB gate.
// Current corrected Databento replays fail, so an old DB flag must not silently keep live risk on.
const LIVE_TRADING_ARMED = process.env.LIVE_TRADING_ARMED === "true";
const ORDER_API = IS_LIVE ? LIVE_API : DEMO_API;
const POLL_INTERVAL_MS = 1000; // Match the sidecar cadence; single-flight guard prevents overlap.

// WebSocket state — when connected, polling pauses
let wsConnected = false;
let tradovateWS: TradovateWebSocket | null = null;
const BAR_INTERVAL_MS = 5 * 60 * 1000; // 5-minute bars

// Mode-keyed DB keys (both engines share DB, don't collide)
const HEARTBEAT_KEY = `futures_engine_heartbeat_${ENGINE_MODE}`;
const POSITIONS_KEY = `futures_positions_${ENGINE_MODE}`;
const PENDING_ORDER_KEY = `futures_pending_order_${ENGINE_MODE}`;
const TRADE_ACTION_PREFIX = IS_LIVE ? "live" : "futures";
const MODE_TAG = IS_LIVE ? "LIVE" : "DEMO";
const AGENT_NAME = `futures-realtime-${ENGINE_MODE}`;
const STRATEGY_VERSION = FUTURES_STRATEGY_VERSION;
const ENGINE_STARTED_AT = new Date().toISOString();
const ORDER_OWNER_ID = `${process.env.RAILWAY_DEPLOYMENT_ID || "local"}:${ENGINE_STARTED_AT}`;
let engineReady = false;
type PendingOrderKind = "entry" | "close" | "stop" | "target";
type PendingOrderSubmission = {
  clOrdId: string;
  label: string;
  kind: PendingOrderKind;
  symbol: string;
  contractId: number;
  createdAt: string;
  phase: "reserved" | "sent" | "rejected";
  ownerId: string;
};
let activePendingOrderSubmission: PendingOrderSubmission | null = null;
let pendingOrderReservationInFlight = false;

// DEMO ($50K): Trade full-size ES, NQ, GC for maximum learning
// LIVE ($1K): Micros only MES, MNQ, MYM until equity scales
// FOCUS (June 9, from P&L attribution): NQ is the only instrument the demo actually made money on;
// EDGE-FOCUSED MULTI-INSTRUMENT (Jun 26): backtest (12k trades, walk-forward) verdict —
//   • GOLD RSI-bounce = the durable edge (GC PF 1.25 OOS, positive every recent year) → trade fully.
//   • Index (NQ/ES) only has OOS edge on the OVERBOUGHT-SHORT fade (RSI>80 short, PF 1.4-1.8); index
//     longs + other index setups LOSE OOS → the evaluateAndTrade gate trades ONLY that pocket on index.
// DEMO ($60k) trades gold + NQ + ES full-size; LIVE ($924) trades all three via micros. Per-trade
// 1-contract stop vs the $924 account: MES ~$75 (8%), MGC ~$93 (10%), MNQ ~$132 (14%) — all fit under
// the 15% risk cap (MES is actually cheaper than gold). All trade only their validated pocket via the
// evaluateAndTrade gate: gold = full RSI-bounce edge, index (NQ/ES) = RSI≥80 overbought-shorts only.
const FULL_SIZE_SYMBOLS: string[] = [...FULL_SIZE_FUTURES];
// Live <$60k micros — same edges, ~1/10 size. Databento feeds them via FULL_EQUIVALENT (MGC→GC etc).
const MICRO_SYMBOLS: string[] = [...MICRO_FUTURES];
// Map full-size to micro equivalents (for market data fallback — micros have same price)
const MICRO_EQUIVALENT: Record<string, string> = { ES: "MES", NQ: "MNQ", GC: "MGC", YM: "MYM" };
const FULL_EQUIVALENT: Record<string, string> = { MES: "ES", MNQ: "NQ", MGC: "GC", MYM: "YM" };
// Equity indices (ES/NQ + micros) are 90%+ correlated — hold at most ONE at a time. The onBarClose guard
// only catches an index ALREADY held from a prior cycle; when MNQ+MES fire the SAME bar, both pass it
// before either registers a position (that doubled a −$61 loss to −$122 on 2026-07-15). This synchronous
// same-cycle reservation closes that race: the first index to commit reserves the slot, the second aborts.
// Auto-expires — once the fill registers, the open-position check takes over.
const INDEX_SYMS = new Set(["ES", "NQ", "YM", "RTY", "MES", "MNQ", "MYM", "M2K"]);
// Index symbols cleared for the trend-continuation LONG edge. 4.5-yr backtest (2022 bear included) with the
// 200-EMA regime filter: NQ PF 1.24 / ES PF 1.18, both +both halves. (Without the filter ES failed — the filter,
// applied in setup detection via price>ema200, is what makes both work.)
const INDEX_LONG_SYMS = new Set(["NQ", "MNQ", "ES", "MES"]);
let indexEntryReservedUntil = 0;
let entryExecutionInFlight = false;
// Live full-size threshold — set so the MNQ→NQ switch is a RAMP, not a cliff (Fable 5 review).
// At 1% risk a ~30pt NQ stop ($600) needs ~$60k for 1 NQ to equal the ~10 MNQ the account was already
// trading; below $60k MNQ scales smoothly via risk-based sizing. (Was $25k — a 10× exposure jump.)
const FULL_SIZE_EQUITY_THRESHOLD = 60_000;

// Active trading symbols — recalculated when equity updates
let SYMBOLS = FULL_SIZE_SYMBOLS; // default to full-size (demo), downgraded to micros for small live accounts
// PHASE 0 (live): optional symbol whitelist from DB config (live_futures_symbols), e.g. "MES" for day-1.
let symbolWhitelist: string[] | null = null;
const DEMO_LIVE_CLONE = process.env.DEMO_LIVE_CLONE !== "false";
const USES_LIVE_POLICY = IS_LIVE || (IS_DEMO && DEMO_LIVE_CLONE);
// Pyramiding changes payoff geometry and makes demo incomparable with the live book. A stale
// Railway ALLOW_PYRAMID=true must not bypass policy, so only a separate research demo may opt in.
const ALLOW_PYRAMID = !USES_LIVE_POLICY && process.env.ALLOW_PYRAMID === "true";
const LIVE_HEARTBEAT_KEY = "futures_engine_heartbeat_live";
const LIVE_MIRROR_MAX_AGE_MS = 3 * 60_000;
const BROKER_EQUITY_MAX_AGE_MS = 15 * 60_000;
let liveMirrorEquity = 0;
let liveMirrorHeartbeatAt = 0;

function updateTradingSymbols() {
  const prev = SYMBOLS.join(",");
  const selectionEquity = IS_DEMO && DEMO_LIVE_CLONE ? liveMirrorEquity : tradovateEquity;
  // Demo defaults to the same micro contracts as live so its execution evidence transfers.
  // Set DEMO_LIVE_CLONE=false only for a deliberately separate full-size research service.
  SYMBOLS = selectFuturesSymbols({
    mode: ENGINE_MODE,
    accountEquity: tradovateEquity,
    liveMirrorEquity,
    demoLiveClone: DEMO_LIVE_CLONE,
    fullSizeThreshold: FULL_SIZE_EQUITY_THRESHOLD,
    whitelist: symbolWhitelist,
  });
  if (prev !== SYMBOLS.join(",")) {
    log(`[SIZING] Policy equity $${selectionEquity.toFixed(0)} → trading ${SYMBOLS.join(", ") || "(none)"}${symbolWhitelist ? ` [whitelist: ${symbolWhitelist.join(",")}]` : ""}`);
  }
}

// Lazy-load Yahoo. Its ONLY remaining job in this engine is ^VIX / ^VIX3M — CBOE indices with no
// GLBX equivalent, and not contract-specific, so the wrong-month problem cannot apply to them.
// All PRICE data is Databento (live_quotes) → Tradovate. See fetchDatabentoQuotes / pollPrices.
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
  // Crypto futures — MBT (Micro Bitcoin) = 0.1 BTC/contract, $0.10/pt
  MBT: 0.1,
};
// Symbols that are metals (different session timing + strategy)
const METALS = new Set(["MGC", "GC"]);
// 8:30 ET macro-release blackout dates (CPI etc), loaded from `macro_blackout_dates` config by
// loadRiskConfig. NFP days are computed (first Friday), so only irregular dates live here.
let macroBlackoutDates = new Set<string>();
// GROWTH RAMP (micro gold only): contract ceiling by account equity so per-trade risk stays ~constant (~1%)
// as the account grows, instead of being frozen at 1 micro forever. Dormant until $10k — at ~$5k it returns 1,
// so it does NOT change current behavior. Scoped to MGC ONLY (never applied to full GC). Above ~$60k the
// MICRO→FULL switch flips MGC→GC, so this only governs the micro range. Sim (Jul 13) showed >1 micro trips the
// −25% kill-switch on a SMALL account — this ramp respects that by only sizing up once equity can absorb it.
/**
 * Contract ladder for MICRO contracts (MGC/MNQ/MES) — size scales with the ACCOUNT, never with a
 * trade count or a flag flipped mid-streak.
 *
 * Calibrated off the live book's own realised losses (33 losing closes: avg $63.57, median $55,
 * worst $147). The safety measure that matters is "how many average losers does the 25% kill switch
 * absorb", which today is ~21 at one micro:
 *     2 micros (~$127 avg loss) needs ~$10.7k for the same margin  -> threshold $10,000
 *     3 micros (~$191 avg loss) at $18,000 absorbs ~24 losers      -> threshold $18,000  (safer still)
 * Below $10k this returns 1, so at today's $5,214 it changes NOTHING — it only ever engages once the
 * account has genuinely earned the size.
 *
 * MICRO ONLY, deliberately: demo trades FULL-SIZE GC/NQ/ES on ~$75k, and a micro-calibrated ladder
 * there would hand it 3 full contracts (~30x its current exposure) and destroy demo as a shadow of
 * live. Full-size symbols keep the configured cap; once live crosses FULL_SIZE_EQUITY_THRESHOLD it
 * moves to full-size contracts and this ladder correctly stops applying.
 */
function microContractCap(equity: number): number {
  if (equity >= 18000) return 3;
  if (equity >= 10000) return 2;
  return 1;
}

// ── OVERNIGHT MARGIN GOVERNOR (2026-07-29) ───────────────────────────────────────────────────────
// Sessions the exchange treats as RTH, where it charges DAY-TRADE margin (~$50-100/micro). Anything
// else charges INITIAL margin, which is 20-40x higher — that is the whole reason overnight size must
// be governed separately. Module-scope so the entry sizer and the pyramid add cannot drift apart
// (they previously used different caps: per-trade 2 vs maxTotalContracts 8).
const RTH_SESSIONS = new Set(["open", "morning", "midday", "afternoon", "close"]);
/** Hard contract ceiling for a single overnight entry, independent of margin. */
const OVERNIGHT_CONTRACT_CAP = 2;
/** Overnight INITIAL margin per contract, in dollars. MGC was verified from Tradovate 2026-07-28.
 *  GC uses the conservative 10x notional equivalent until a live broker snapshot verifies it.
 *  Index micros are never traded overnight today (getSizeMultiplier returns 0 for non-metals), but
 *  they are listed so a future session change cannot get a free pass.
 *  A hardcoded margin number HAS already gone stale here once — a comment claimed MGC was
 *  ~$1,000-1,150 when the real figure was $2,242.90 — so updateTradovateEquity() now self-audits
 *  this table against what the broker actually charges and logs loudly on drift. */
const OVERNIGHT_INITIAL_MARGIN: Record<string, number> = {
  GC: 22429, MGC: 2242.90, MNQ: 4171, MES: 2657, MYM: 1000, M2K: 1000,
};
/** Ceiling on the share of equity that overnight INITIAL margin may consume.
 *  This is the point of the whole governor: the limit tracks EQUITY instead of being a blind
 *  contract count that only happens to fit the balance it was written for. On ~$5,227:
 *      1x MGC = $2,242.90  = 43%  → allowed
 *      2x MGC = $4,485.80  = 86%  → allowed (deliberately inside the cap)
 *      3x MGC = $6,728.70  = 129% → impossible, and now refused BEFORE the order is sent
 *  A drawdown therefore reduces size on its own: below ~$4,984 the 2nd contract stops fitting. */
const OVERNIGHT_MARGIN_UTILISATION_CAP = 0.90;
/** Largest quantity of `sym` whose overnight INITIAL margin fits inside the utilisation cap.
 *  Returns 0 when the requirement is unknown — refusing to trade beats guessing a margin figure,
 *  which is exactly how the 2026-06-30 naked-stop incident started ("the broker will just reject
 *  it" is not a safety mechanism). */
function overnightMarginCap(sym: string, equity: number): number {
  return overnightMarginContractCap(
    equity,
    OVERNIGHT_INITIAL_MARGIN[sym],
    OVERNIGHT_MARGIN_UTILISATION_CAP,
  );
}

// ── THE EXECUTION-COST CEILING ───────────────────────────────────────────────────────────────────
/** CHASE GUARD ceiling: how far price may already have run against us since the signal before we
 *  refuse to chase, as a fraction of the trade's own risk. Coarse by design — it exists to kill the
 *  slippage TAIL (MNQ's worst fills were 42.1 and 54.4 points), not to price the entry. */
const EXEC_COST_CAP_FRACTION = 0.10;

/** ENTRY LIMIT ceiling: how far through the signal a marketable-limit entry may fill, in TICKS.
 *
 *  This is deliberately NOT a fraction of the stop, and the arithmetic is why. Measured on live
 *  (60 MNQ fills, commit 6f21711) MNQ's stop that day was 77.1 points and its MEDIAN slip 7.13 —
 *  so a 10%-of-stop cap trips at 7.71 points and the median slip sails straight through it. The
 *  cap would have looked prudent and bound almost nothing.
 *
 *  What the edge can actually afford, from the engine-exact NQ morning run by entry slippage:
 *      7.13 pt → PF 0.72 (-$9,704)   3.00 → 0.91   2.00 → 0.97   1.00 → PF 1.01 (+$308)
 *  Positive below ~1.5 points — which is 1.9% of that stop, not 10%. But 2%-of-stop applied to GOLD
 *  (stop ~12.3 pt) is 0.25 pt, under MGC's own 0.50 median, so it would reject half of gold's
 *  entries. No single fraction-of-stop serves both instruments.
 *
 *  TICKS do, because tick size already scales with each contract's notional:
 *      MNQ  6 x 0.25 = 1.50 pt = $3.00   (median slip 7.13 — binds hard, which is the point)
 *      MES  6 x 0.25 = 1.50 pt = $7.50   (median slip 0.89 — passes comfortably)
 *      MGC  6 x 0.10 = 0.60 pt = $6.00   (median slip 0.50 — passes comfortably)
 *  One number that lands on the economic threshold for the instrument that bleeds and stays out of
 *  the way of the two that don't. Tunable per engine via `<live_futures|futures>_entry_limit_ticks`.
 *
 *  Still bounded by EXEC_COST_CAP_FRACTION of the stop as a secondary ceiling, so an unusually tight
 *  stop can never pay a disproportionate share of its own risk just to get filled. */
const ENTRY_LIMIT_TICKS_DEFAULT = 6;
let entryLimitTicks = ENTRY_LIMIT_TICKS_DEFAULT;

// LIVE only: minimum account equity before we let gold (MGC) trade into the evening session. Below
// this the account cannot cover MGC's overnight initial margin at all → stay RTH-only. Once funded
// past it, evening gold auto-enables. Index never gets the evening (its overnight margin is far
// heavier — see OVERNIGHT_INITIAL_MARGIN). Auto-reverts if equity ever drops back below.
const LIVE_EVENING_GOLD_MIN_EQUITY = 3000;
// Minimum price increment per contract. EVERY price sent to Tradovate (stop, target, trail) MUST be
// aligned to this or the broker rejects the order as "Illegal Price" — and because /order/placeorder
// returns an orderId BEFORE the async rejection, the engine would otherwise believe the stop was
// placed and run the position NAKED. The engine computes stops/targets from ATR multiples that produce
// arbitrary decimals (e.g. 4058.9794), so each must be snapped to the tick before it leaves.
const TICK_SIZES: Record<string, number> = {
  ES: 0.25, MES: 0.25, NQ: 0.25, MNQ: 0.25,
  YM: 1, MYM: 1, RTY: 0.1, M2K: 0.1,
  GC: 0.1, MGC: 0.1, MBT: 5,
};
function roundToTick(sym: string, price: number): number {
  const tick = TICK_SIZES[sym] || contracts.get(sym)?.tickSize || 0.25;
  const snapped = Math.round(price / tick) * tick;
  // Kill binary-float dust (e.g. 4059.0000000000005) so the FIX price string is clean & legal.
  const decimals = (String(tick).split(".")[1] || "").length;
  return Number(snapped.toFixed(decimals));
}

// ── Brain Dashboard Update (throttled) ──────────────────
let lastBrainUpdate = 0;
const BRAIN_THROTTLE_MS = 30_000; // 30s min between updates
async function throttledBrainUpdate(trigger: string) {
  if (Date.now() - lastBrainUpdate < BRAIN_THROTTLE_MS) return;
  lastBrainUpdate = Date.now();
  try { await updateBrain(trigger); } catch { /* brain optional */ }
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

// Every graded setup (confirmed AND killed) → DB ring buffer so the UI can show what the
// engine is finding in real time, not just the trades it takes. Read by /api/futures/decisions.
async function recordDecision(d: {
  sym: string; direction: string; setupType: string; confidence: number;
  verdict: "confirmed" | "rejected" | "pattern_blocked" | "no_verdict";
  aiConfidence?: number; reason: string;
  // Would-be trade geometry — present on BLOCKED setups so the shadow tracker can
  // mark the counterfactual to real price and score whether the veto helped.
  entry?: number; stop?: number; target?: number;
}) {
  try {
    const key = `engine_decisions_${IS_LIVE ? "live" : "demo"}`;
    const row = await prisma.agentConfig.findUnique({ where: { key } });
    let arr: unknown[] = [];
    try { arr = JSON.parse(row?.value || "[]"); if (!Array.isArray(arr)) arr = []; } catch { arr = []; }
    arr.unshift({ ts: new Date().toISOString(), ...d });
    const value = JSON.stringify(arr.slice(0, 40));
    await prisma.agentConfig.upsert({ where: { key }, update: { value }, create: { key, value } });
  } catch { /* best-effort — never block trading on telemetry */ }

  // Shadow tracker: durably log every setup that was BLOCKED (would-be trade never fired)
  // with its entry/stop/target so a resolver cron can score the counterfactual later.
  // Confirmed setups actually trade — their real P&L lives in the fill/journal path.
  if (d.verdict !== "confirmed" && Number.isFinite(d.entry) && Number.isFinite(d.stop) && Number.isFinite(d.target)) {
    try {
      await prisma.shadowTrade.create({
        data: {
          mode: IS_LIVE ? "live" : "demo",
          symbol: d.sym, direction: d.direction, setupType: d.setupType,
          blockReason: d.verdict, confidence: d.confidence, aiConfidence: d.aiConfidence ?? null,
          reason: d.reason.slice(0, 500),
          entry: d.entry!, stop: d.stop!, target: d.target!,
        },
      });
    } catch { /* best-effort — telemetry must never block or crash trading */ }
  }
}

// Compute would-be stop/target prices from the setup geometry (for the shadow tracker).
function shadowGeometry(direction: string, price: number, stopDist: number, targetDist: number) {
  const long = direction === "long";
  return {
    entry: price,
    stop: long ? price - stopDist : price + stopDist,
    target: long ? price + targetDist : price - targetDist,
  };
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
    // DEMO engine alerts go to their own webhook and are DROPPED if it isn't configured — demo
    // 🚨 messages landing in the real-money Slack channel look like emergencies and bury the
    // alerts that matter. Live routing is unchanged (channel webhook → legacy fallback).
    if (IS_DEMO) {
      const demoConfig = await prisma.agentConfig.findUnique({ where: { key: "webhook_futures_demo" } });
      if (!demoConfig?.value) return;
      await fetch(demoConfig.value, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: `[FUTURES-${MODE_TAG}] ${msg}` }),
        signal: AbortSignal.timeout(5000),
      });
      return;
    }
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
// The sidecar row chosen while resolving the broker contract. This must remain pinned: micro and
// full-size continuous symbols can roll on different ticks, so dynamically switching quote rows
// after resolution can price one month while sending the order to another.
const databentoPriceRoots: Map<string, string> = new Map();

async function resolveContracts() {
  // Resolve both full-size and micro contracts so we can switch dynamically
  for (const sym of [...FULL_SIZE_SYMBOLS, ...MICRO_SYMBOLS, "YM"]) {
    try {
      const results = await apiFetch(`/contract/suggest?t=${sym}&l=5`) as { id: number; name: string; tickSize: number; providerTickSize: number }[];
      // /contract/suggest is ordered by expiry, so results[0] is the NEAREST month — wrong for any
      // symbol the exchange also lists in thin months. Full-size gold listed GCN6 (July, days from
      // expiry) ahead of the actively traded GCQ6, which is why demo gold silently stopped trading
      // after the late-May roll.
      //
      // FIRST, trade the month the PRICES are on (2026-08-17). Every price this engine sees is the
      // Databento continuous v.0 (volume-ranked). When gold entered its August delivery period,
      // volume rolled Q6→Z6 (skipping thin October) and the feed followed — but this list still led
      // with Q6, so live priced a validated short on Z6 and ORDERED it on Q6: broker rejected, twice,
      // 2026-08-17 morning. (lib/tradovate.findContract got this fix first, but THIS map — not
      // findContract — is what executeTrade uses, which is why the first deploy didn't stop the
      // rejections.) Resolution unavailable now fails closed. Trading nothing is safer than
      // pricing one contract and submitting an order in another month.
      let picked: typeof results[number] | undefined;
      let mappedPriceRoot: string | undefined;
      try {
        // Resolve from the SAME row pollPrices/getActionableEntryPrice will prefer. Micro and full
        // volume-ranked continuous symbols can roll on different days, so pricing MNQ from MNQU6
        // while deriving the order month from NQZ6 recreates the wrong-contract failure this guard
        // exists to prevent. Exact symbol first; sibling fallback remains an atomic quote+mapping pair.
        const priceRoots = [...new Set([sym, FULL_EQUIVALENT[sym]].filter((root): root is string => Boolean(root)))];
        const contractRows: Array<{ symbol: string; rawContract: string | null; timestampMs: number }> = [];
        for (const priceRoot of priceRoots) {
          const rows = await prisma.$queryRawUnsafe<{ raw_contract: string | null; ts: bigint | number }[]>(
            "SELECT raw_contract, ts FROM live_quotes WHERE symbol = $1 LIMIT 1", priceRoot,
          );
          if (rows[0]) contractRows.push({ symbol: priceRoot, rawContract: rows[0].raw_contract, timestampMs: Number(rows[0].ts) });
        }
        const mapped = selectFreshContractMapping(priceRoots, contractRows, Date.now(), DBN_STALE_MS);
        if (!mapped) throw new Error(`sidecar contract mapping unavailable for ${priceRoots.join("/")}`);
        const code = mapped.rawContract!.slice(mapped.symbol.length);
        picked = results.find((r) => r.name === `${sym}${code}`);
        if (!picked) throw new Error(`${sym}${code} not present in Tradovate suggestions`);
        mappedPriceRoot = mapped.symbol;
      } catch (error) {
        contracts.delete(sym);
        databentoPriceRoots.delete(sym);
        log(`Failed to resolve ${sym} to the Databento price contract: ${error}. Symbol disabled until next resolution.`);
        continue;
      }
      if (picked && mappedPriceRoot) {
        contracts.set(sym, { id: picked.id, name: picked.name, tickSize: picked.providerTickSize || picked.tickSize, symbol: sym });
        databentoPriceRoots.set(sym, mappedPriceRoot);
        log(`Resolved ${sym} → ${picked.name} (ID: ${picked.id})`);
      }
    } catch (err) {
      contracts.delete(sym);
      databentoPriceRoots.delete(sym);
      log(`Failed to resolve ${sym}: ${err}`);
    }
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
  /** Bars counted INSIDE the RTH opening hour — drives the opening range. Separate from barCount,
   *  which counts from the accounting-day reset and no longer starts at the RTH open. */
  orBarCount: number;
}> = new Map();

function initBarBuilder(sym: string) {
  barBuilders.set(sym, {
    currentBar: null, bars5m: [], sessionBars: [], lastPrice: 0, lastVolume: 0,
    prevDayHigh: 0, prevDayLow: 0, prevDayClose: 0,
    openingRangeHigh: 0, openingRangeLow: 0, barCount: 0, orBarCount: 0,
  });
}

let tickCount = 0;

// Date-based flags to ensure exactly one session reset and one EOD close per day
let lastResetDate = "";
let lastEODDate = "";

/** What the engine currently sees per symbol, published on the heartbeat for the admin "today's plan"
 *  panel. Telemetry ONLY — never read by a trading decision. The web app must render these numbers
 *  rather than recompute them, so there is exactly one copy of the maths. */
interface PlanSnapshot {
  price: number; atr: number; rsi: number;
  ema9DistPct: number | null; above200: boolean | null;
  trend15: string; dayType: string; bars: number;
  plannedQty: number; quoteAgeSec: number; quarantine: number; at: number;
}
const planSnapshots = new Map<string, PlanSnapshot>();

/** One authoritative contract ceiling shared by telemetry and execution. The equity ladder is an
 * automatic growth ceiling, while maxContractsPerTrade remains a true operator maximum that can
 * always reduce exposure. Aggregate open exposure is subtracted before a new order is sized. */
function contractCapFor(sym: string, equity: number, session: string | undefined): number {
  const openContracts = [...positions.values()].reduce((sum, position) => sum + position.quantity, 0);
  let cap = cappedContractLimit(
    riskConfig.maxContractsPerTrade,
    MICRO_SYMBOLS.includes(sym) ? microContractCap(equity) : riskConfig.maxContractsPerTrade,
    riskConfig.maxTotalContracts,
    openContracts,
  );
  if (!session || !RTH_SESSIONS.has(session)) {
    cap = Math.min(cap, OVERNIGHT_CONTRACT_CAP, overnightMarginCap(sym, equity));
  }
  return cap;
}

/** MIRRORS the sizing block in evaluateAndTrade — see the warning comment there. Answers "if a setup
 *  fired on this bar, how many contracts would it take?" so the admin panel can show intent without a
 *  second implementation of the maths living in the web app. */
function plannedQtyFor(sym: string, adjustedATR: number, session: string, sizeMult: number): number {
  const equity = riskSizingEquity();
  if (equity <= 0 || adjustedATR <= 0 || sizeMult <= 0) return 0;
  const maxRisk = equity * (riskConfig.riskPerTradePct / 100) * sizeMult;
  const mult = CONTRACT_MULTIPLIERS[sym] || 5;
  const stopDist = adjustedATR * 1.5;                     // the hardcoded stop every live edge uses
  const riskPer = stopDist * mult;
  if (riskPer > maxRisk) return 0;                        // never change validated stop geometry to force a trade
  const cap = contractCapFor(sym, equity, session);
  if (cap < 1) return 0;
  const qty = Math.min(cap, Math.floor(maxRisk / riskPer));
  if (qty < 1) return 0;
  return riskPer * qty > equity * 0.15 ? Math.max(1, Math.floor((equity * 0.15) / riskPer)) : qty;
}

/** Exchange timestamp of the last real quote per symbol (Databento's own ts when we have it, else
 *  arrival time). Drives both the feed-gap detector and the entry-freshness gate. */
const lastReliableAt = new Map<string, number>();
/** Clean 5-min bars still required before this symbol may open new risk. Set when a genuine feed
 *  discontinuity lands in the buffer; decremented on each clean bar close. */
const quarantineBars = new Map<string, number>();
/** Since when a symbol has had no usable quote at all (telemetry only). */
const unpricedSince = new Map<string, number>();

/** A silence longer than this means we lost the feed rather than missed a poll (Databento polls ~5s). */
const MD_GAP_MS = 90_000;
/** Bars needed to fully rebuild a 14-period indicator, so a discontinuity can't drive ATR/RSI. */
const INDICATOR_WARMUP_BARS = 15;
/** How old the underlying quote may be to open NEW risk. Deliberately much tighter than DBN_STALE_MS
 *  (90s, which governs BAR building): a slightly-stale quote is fine for drawing a bar but must never
 *  price a live order or the stop that hangs off it. */
const ENTRY_MAX_QUOTE_AGE_MS = 30_000;

/** Is this symbol's price fresh enough to open new risk on? */
function isRealtimePriced(sym: string): boolean {
  return Date.now() - (lastReliableAt.get(sym) ?? 0) < ENTRY_MAX_QUOTE_AGE_MS;
}
/** Is every open position's symbol fresh enough to trust an aggregate P&L calculation? */
function allPositionsFreshlyPriced(): boolean {
  for (const sym of positions.keys()) if (!isRealtimePriced(sym)) return false;
  return true;
}

// Every caller now passes a price from the CONTRACT WE TRADE (Databento live_quotes → Tradovate);
// the Yahoo path that fed a different contract month was removed 2026-07-29. `reliable` is kept as
// defence-in-depth so that if a future fallback is ever added, it still cannot drive the software
// emergency close — but nothing sets it false today. `quoteTs` is the quote's own exchange timestamp
// where the source provides one, so entry-freshness measures the PRICE's age, not our poll's.
function onPrice(sym: string, price: number, volume: number, reliable = true, quoteTs?: number) {
  const b = barBuilders.get(sym);
  if (!b || price <= 0) return;

  // ── FEED-GAP QUARANTINE (2026-07-29) ────────────────────────────────────────────────────────
  // Every price reaching this function is now on the CONTRACT WE TRADE (Yahoo was removed from the
  // price path — see pollPrices). What remains is DISCONTINUITY: if the feed goes silent and comes
  // back at a different level, the buffer straddles a step that is not a real 5-minute move.
  //
  // This is what the previous guard got wrong. It stopped a single BAR from spanning two sources,
  // but ATR's true range is max(h-l, |h - prevClose|, |l - prevClose|) — it spans BARS by design.
  // Restarting the bar at the new level therefore GUARANTEED a clean step straight into ATR, and a
  // 14-period ATR carries it for ~70 minutes. Measured 2026-07-29: gold's real 5-min ATR was 3.34
  // while the engine read 8.75-12.68 and RSI sat at 94-98 for over 20 minutes, emitting an
  // 83%-confidence OR BREAKOUT LONG on a price that did not exist.
  //
  // So: never edit history to hide a step. Detect it, let the bars tell the truth, and refuse to
  // open NEW RISK until enough clean bars have rebuilt the indicators.
  // Only a MID-SESSION discontinuity is a problem. On the FIRST live tick after startup there is no
  // prior tick to compare against, and the preload→live seam is a benign, expected artifact: the
  // buffer is 100% clean Databento history and the market genuinely moved while we were offline
  // (measured on the 2026-07-29 deploy: a $23.45 seam on gold). Quarantining that would block every
  // symbol for 75 minutes after every restart, which is a real trading cost for no safety gain.
  const lastAt = lastReliableAt.get(sym);
  if (lastAt !== undefined) {
    const gapMs = Date.now() - lastAt;
    const prevClose = b.currentBar?.c ?? b.bars5m[b.bars5m.length - 1]?.c;
    if (gapMs > MD_GAP_MS && prevClose && prevClose > 0) {
      const jump = Math.abs(price - prevClose);
      const ref = atr(b.bars5m) || prevClose * 0.002;   // fall back to ~20bps when there is no ATR yet
      if (jump > ref * 2) {
        quarantineBars.set(sym, INDICATOR_WARMUP_BARS);
        log(`  ${sym}: FEED GAP ${(gapMs / 1000).toFixed(0)}s then a $${jump.toFixed(2)} step (>2x ATR ${ref.toFixed(2)}) — holding entries for ${INDICATOR_WARMUP_BARS} clean bars so the step can't drive ATR/RSI`);
      }
    }
  }
  lastReliableAt.set(sym, quoteTs && quoteTs > 0 ? quoteTs : Date.now());
  unpricedSince.delete(sym);

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

      // OPENING RANGE = the first 60 min of RTH (institutional standard), gated on the CLOCK.
      // It used to key off barCount<=12, i.e. the first 12 bars after the accounting-day reset. That
      // was equivalent while the reset sat at 9:29 AM, but the reset moved to 02:00 ET on 2026-08-02
      // (so a losing day could not disable the next morning's London window) — which silently
      // redefined the "opening range" as 02:00-03:00 ET, the London hour. That is not just wrong for
      // or_breakout/failed_ib/ib_extension; orSize also feeds dayType, and dayType gates
      // trend_continuation, which is live's main edge. Clock-gating restores the intended meaning
      // and makes it independent of when the accounting day rolls.
      if (getETHour() >= 9.5 && b.orBarCount < 12) {
        b.orBarCount++;
        b.openingRangeHigh = Math.max(b.openingRangeHigh, completed.h);
        b.openingRangeLow = b.openingRangeLow === 0 ? completed.l : Math.min(b.openingRangeLow, completed.l);
      }

      // A bar built entirely from clean, same-contract ticks pays down any quarantine. Once the
      // count reaches zero the 14-period indicators no longer see the discontinuity at all.
      const qLeft = quarantineBars.get(sym) ?? 0;
      if (qLeft > 0) {
        quarantineBars.set(sym, qLeft - 1);
        if (qLeft - 1 === 0) log(`  ${sym}: indicators rebuilt on clean data — entries re-enabled`);
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
  if (USES_LIVE_POLICY) {
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

// fetchYahooQuotes() was DELETED on 2026-07-29 along with YAHOO_MAP. It quoted a different contract
// month at a price frozen at the 17:00 ET close, and every indicator built on it was wrong. There is
// deliberately no price fallback now: an unpriced symbol freezes and trades nothing. If you are here
// to re-add a fallback, it must be the SAME CONTRACT the broker fills — Yahoo's continuous `=F`
// symbols are not, and no staleness tuning can make them so.

// Phase 4: read the Databento sidecar's real-time L1 from live_quotes. OFF by default (set
// DATABENTO_MD_ENABLED=true per engine to activate). FAIL-SAFE: any error/staleness → empty → existing MD chain.
let dbnMdLogged = 0;
let lastUnpricedLogAt = 0;        // throttles the UNPRICED log to once a minute
let lastAggSkipLogAt = 0;         // throttles the aggregate-drawdown-skipped log to once a minute
// Market-data blackout alarms. Databento is the ONLY price source since Yahoo was removed, and a
// sidecar that serves nothing without throwing produces no alert anywhere else — see pollPrices.
let mdBlackoutSince = 0;
let mdBlackoutAlerted = false;
const symBlackoutAlerted = new Set<string>();
/** Minutes of ZERO quotes across all symbols before shouting. Long enough to ride out a redeploy of
 *  the sidecar, short enough to catch a dead feed inside one trading session. */
const MD_BLACKOUT_ALERT_MIN = 3;
/** Minutes a SINGLE symbol may stay unpriced before shouting. Gold ticks sparsely, so this is
 *  deliberately looser than the all-symbol alarm to avoid crying wolf on a quiet metal. */
const MD_SYMBOL_BLACKOUT_ALERT_MIN = 15;
let databentoMdEnabled = false;   // flipped via DB config (no engine restart needed)
let lastMdSource = "yahoo";       // tracks actual MD source for heartbeat reporting
let aiReviewEnabled = true;       // Post-trade AI review only. Never blocks or delays an order.
// Marketable-LIMIT entries instead of market orders, capped at EXEC_COST_CAP_FRACTION of the stop.
// Disabled for the live-clone demo because entry type must match before its fills can validate live.
// A separate research service may enable it explicitly to measure capped-IOC behavior.
let entryLimitEnabled = false;
// Live-only empirical entry floor: block at a genuine 25-trade sample of sub-25% win rate. Reads
// pattern memory locally — no API call, no latency — so it is ON by default independently of the
// grader. See the long note at its call site for why the two were untangled.
let patternFloorEnabled = true;
let indexTrendLongEnabled = true; // 2nd validated index edge: trend-continuation LONG on NQ/ES micros, regime-filtered price>200-EMA (4.5-yr backtest PF 1.22, +both halves). Reversible via DB key index_trend_long_enabled="false".
// Per-edge on/off switches for THIS engine (demo/live), loaded from DB each config cycle. Absent flag →
// registry default (current edges default ON for both, so behaviour is unchanged until a switch is set).
let edgeFlags: Record<string, string | undefined> = {};
let futuresTradingEnabled = !IS_LIVE;
let riskConfigHealthy = false;
let operatorGateRequestSequence = 0;
let operatorGateAppliedSequence = 0;

async function refreshOperatorTradingGate(): Promise<boolean> {
  const requestSequence = ++operatorGateRequestSequence;
  try {
    const [row, heartbeatRow] = await Promise.all([
      prisma.agentConfig.findUnique({ where: { key: "trading_mode_futures" } }),
      prisma.agentConfig.findUnique({ where: { key: HEARTBEAT_KEY } }),
    ]);
    const heartbeat = heartbeatRow?.value
      ? JSON.parse(heartbeatRow.value) as { timestamp?: string; startedAt?: string; deploymentId?: string | null }
      : null;
    const heartbeatOwner = heartbeat?.startedAt ? `${heartbeat.deploymentId || "local"}:${heartbeat.startedAt}` : "";
    const heartbeatAge = Date.now() - Date.parse(heartbeat?.timestamp || "");
    const anotherGenerationIsActive = heartbeatOwner !== "" && heartbeatOwner !== ORDER_OWNER_ID
      && Number.isFinite(heartbeatAge) && heartbeatAge < 90_000;
    const enabled = !anotherGenerationIsActive
      && row?.value !== "disabled" && (!IS_LIVE || row?.value === "live");
    // An older, slower DB read must never overwrite a newer kill-switch result.
    if (requestSequence >= operatorGateAppliedSequence) {
      operatorGateAppliedSequence = requestSequence;
      futuresTradingEnabled = enabled;
    }
    return enabled;
  } catch (error) {
    if (requestSequence >= operatorGateAppliedSequence && USES_LIVE_POLICY) {
      operatorGateAppliedSequence = requestSequence;
      futuresTradingEnabled = false;
    }
    log(`[CONFIG] Operator trading gate unavailable${USES_LIVE_POLICY ? "; entries fail closed" : ""}: ${error}`);
    return !USES_LIVE_POLICY;
  }
}
const lastCumVol = new Map<string, number>();   // per-poll traded-volume delta from the sidecar's cumulative count
const lastDatabentoTop = new Map<string, { bid: number; ask: number; ts: number; rawContract: string }>();
const lastContractMismatchLogAt = new Map<string, number>();
/** How old a Databento live_quotes row may be and still DRAW A BAR. Gold ticks sparsely (ES/NQ update
 *  every ~1s, GC ages to 8-18s in quiet stretches), so a 30s cutoff was discarding paid data we pay
 *  for. 90s stays well inside a 5-minute bar.
 *  NOTE: this governs BARS ONLY. Opening new risk uses ENTRY_MAX_QUOTE_AGE_MS (30s) against the row's
 *  own exchange timestamp — the two used to be conflated, which let a 90s-old quote price a live
 *  order and the stop hanging off it. */
const DBN_STALE_MS = 90_000;
type DatabentoQuote = { mid: number; vol: number; ts: number; rawContract: string };

function databentoContractIsAligned(sym: string, sourceRoot: string, rawContract: string): boolean {
  const brokerContract = contracts.get(sym);
  if (!brokerContract || !rawContract.startsWith(sourceRoot)) return false;
  if (contractMappingMatchesBroker(sym, sourceRoot, rawContract, brokerContract.name)) return true;

  // A volume-ranked continuous contract can roll between resolution cycles. Remove both mappings
  // immediately so neither Databento nor Tradovate can open risk until the next resolution picks
  // the new broker month. Existing broker brackets remain untouched.
  contracts.delete(sym);
  databentoPriceRoots.delete(sym);
  const now = Date.now();
  if (now - (lastContractMismatchLogAt.get(sym) ?? 0) >= 60_000) {
    lastContractMismatchLogAt.set(sym, now);
    log(`[MD] CONTRACT ROLL/MISMATCH ${sym}: ${sourceRoot} row is ${rawContract}, broker map is ${brokerContract.name}. Symbol disabled until re-resolution.`);
  }
  return false;
}

async function fetchDatabentoQuotes(): Promise<Map<string, DatabentoQuote>> {
  if (!databentoMdEnabled) return new Map();
  try {
    const rows = await prisma.$queryRawUnsafe<{ symbol: string; bid: number; ask: number; mid: number; vol: number; ts: bigint | number; raw_contract: string | null }[]>(
      "SELECT symbol, bid, ask, mid, vol, ts, raw_contract FROM live_quotes",
    );
    const out = new Map<string, DatabentoQuote>();
    const now = Date.now();
    for (const r of rows) {
      const ts = Number(r.ts), bid = Number(r.bid), ask = Number(r.ask), mid = Number(r.mid), cum = Number(r.vol) || 0;
      const rawContract = r.raw_contract ?? "";
      if (mid > 0 && rawContract.startsWith(r.symbol) && now - ts < DBN_STALE_MS) {
        const last = lastCumVol.get(r.symbol) ?? cum;
        const delta = cum >= last ? cum - last : cum;   // reset-safe (sidecar restart drops the cumulative count)
        lastCumVol.set(r.symbol, cum);
        if (bid > 0 && ask >= bid) lastDatabentoTop.set(r.symbol, { bid, ask, ts, rawContract });
        out.set(r.symbol, { mid, vol: Math.max(1, delta), ts, rawContract });   // usable quote + traded volume since last poll
      }
    }
    if (out.size !== dbnMdLogged) { log(`[MD] Databento primary: ${out.size} fresh symbols from live_quotes`); dbnMdLogged = out.size; }
    return out;
  } catch {
    return new Map();   // fail-safe: never let an MD-source error halt the engine
  }
}

function getActionableEntryPrice(sym: string, direction: string): number {
  const sourceRoot = databentoPriceRoots.get(sym);
  if (!sourceRoot) return 0;
  const top = lastDatabentoTop.get(sourceRoot);
  if (!top || Date.now() - top.ts >= ENTRY_MAX_QUOTE_AGE_MS) return 0;
  if (!databentoContractIsAligned(sym, sourceRoot, top.rawContract)) return 0;
  return direction === "long" ? top.ask : top.bid;
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
    // PRIMARY: real-time L1 from the Databento sidecar's live_quotes — the contract we actually trade.
    // Anything it misses falls through to Tradovate (also the right contract). Nothing falls to Yahoo.
    const served = new Set<string>();
    const dbn = await fetchDatabentoQuotes();
    for (const sym of SYMBOLS) {
      const sourceRoot = databentoPriceRoots.get(sym);
      const q = sourceRoot ? dbn.get(sourceRoot) : undefined;
      // Pass the sidecar's own exchange timestamp so entry-freshness measures the QUOTE's age, not
      // the age of our poll — a 90s-old row must not read as a fresh price to trade on.
      if (sourceRoot && q && q.mid > 0 && databentoContractIsAligned(sym, sourceRoot, q.rawContract)) {
        onPrice(sym, q.mid, q.vol, true, q.ts); received++; served.add(sym);
      }
    }
    const querySymbols = SYMBOLS.filter(s => !served.has(s));

    // Tradovate md/getChart (parallel) — only for symbols Databento didn't serve
    const tradovateResults = await Promise.allSettled(
      querySymbols.map(async (sym) => {
        const quote = await fetchTradovateQuote(sym);
        return quote ? { sym, ...quote } : null;
      })
    );

    const needMicro: string[] = [];

    for (const r of tradovateResults) {
      if (r.status === "fulfilled" && r.value) {
        onPrice(r.value.sym, r.value.price, r.value.volume);
        received++;
      } else {
        const sym = querySymbols[tradovateResults.indexOf(r)];
        needMicro.push(sym);
      }
    }

    // Fallback: the micro/full sibling via Tradovate. Same underlying, same contract month, so this
    // is a legitimate substitute — unlike Yahoo, which is a different month entirely.
    const unpriced: string[] = [];
    if (needMicro.length > 0) {
      for (const sym of needMicro) {
        const microSym = MICRO_EQUIVALENT[sym];
        if (microSym) {
          try {
            const fullContract = contracts.get(sym)?.name;
            const microContract = contracts.get(microSym)?.name;
            const sameMonth = fullContract?.startsWith(sym)
              && microContract?.startsWith(microSym)
              && fullContract.slice(sym.length) === microContract.slice(microSym.length);
            const microQuote = sameMonth ? await fetchTradovateQuote(microSym) : null;
            if (microQuote) {
              onPrice(sym, microQuote.price, microQuote.volume); // verified same delivery month
              received++;
              continue;
            }
          } catch { /* no sibling quote either → symbol goes unpriced */ }
        }
        unpriced.push(sym);
      }
    }

    // ── NO YAHOO IN THE PRICE PATH (2026-07-29) ──────────────────────────────────────────────
    // Yahoo's GC=F / NQ=F / ES=F are DIFFERENT CONTRACT MONTHS from the contracts this engine
    // trades, AND their quotes FREEZE at the 17:00 ET RTH close. Verified 2026-07-29 21:5x UTC:
    //     Yahoo GC=F 4126.00  ("Gold Aug 26", GCZ26.CMX, market time 16:59:59 ET)
    //     Databento GC 4063.00 (live, 1.7s old)          → a 63.00-point basis on a STALE price
    // NQ=F (27259.25) and ES=F (7335.25) matched the corrupted engine prices exactly too.
    //
    // The trigger was never a Databento outage — the sidecar measured 0 failures in 20 polls with
    // all 7 symbols 1-2s fresh. It is the DAILY CME MAINTENANCE BREAK (17:00-18:00 ET): nothing
    // trades, the live_quotes rows age past DBN_STALE_MS, and the engine concluded "feed down" and
    // substituted a different instrument. That happens on schedule every day, in the hour right
    // before gold's evening session opens. No staleness window can cover a 60-minute halt.
    //
    // A symbol with no Databento/Tradovate quote is now simply UNPRICED: its bars freeze, its
    // indicators hold their last real values, and it opens no new risk. A frozen bar is honest; a
    // wrong-contract bar is poison that corrupts ATR, RSI, VWAP, the opening range, the stop
    // distance AND the aggregate drawdown kill. Yahoo keeps exactly one job — ^VIX, a CBOE index
    // with no GLBX equivalent, which is not contract-specific.
    if (unpriced.length > 0) {
      const now = Date.now();
      for (const sym of unpriced) if (!unpricedSince.has(sym)) unpricedSince.set(sym, now);
      if (now - lastUnpricedLogAt > 60_000) {
        lastUnpricedLogAt = now;
        const detail = unpriced.map(s => `${s} ${((now - (unpricedSince.get(s) ?? now)) / 1000).toFixed(0)}s`).join(", ");
        log(`[MD] UNPRICED — bars frozen, no new entries: ${detail} (Databento + Tradovate both missing; Yahoo is NOT used for prices)`);
      }
    }
    if (served.size > 0) lastMdSource = "databento";
    else if (received === 0) lastMdSource = "none";

    // Track failures. A SCHEDULED halt (the daily 17:00-18:00 ET CME break) legitimately has no
    // ticks — that is market structure, not a feed failure, so it must neither count toward the
    // circuit breaker nor spam the log every 5 seconds.
    const scheduledHalt = getSessionName() === "halt";
    if (received === 0 && !scheduledHalt) {
      mdConsecutiveFailures++;
      log(`[MD] Zero quotes received (${mdConsecutiveFailures}/${MD_MAX_FAILURES})`);
    } else if (received > 0 && mdConsecutiveFailures > 0) {
      log(`[MD] Recovered after ${mdConsecutiveFailures} failures — ${received} quotes received`);
      mdConsecutiveFailures = 0;
    }

    // ── BLACKOUT ALERT (2026-08-02) ──────────────────────────────────────────────────────────
    // Removing Yahoo from the price path made Databento a SINGLE POINT OF FAILURE, and the only
    // existing alert lives in this function's catch block — i.e. it fires when a poll THROWS. A
    // sidecar that is alive but serving nothing (or rows that all age out) throws nothing: quotes
    // simply stop, bars freeze, no entries open, and the engine goes quiet with a Railway log line
    // nobody is watching. Before Yahoo was removed that failure was masked by the fallback; now it
    // is silent, so it needs its own alarm. Fires ONCE per outage, recovers loudly.
    if (received === 0 && !scheduledHalt) {
      if (!mdBlackoutSince) mdBlackoutSince = Date.now();
      const outMin = (Date.now() - mdBlackoutSince) / 60_000;
      if (!mdBlackoutAlerted && outMin >= MD_BLACKOUT_ALERT_MIN) {
        mdBlackoutAlerted = true;
        const msg = `🚨 ${MODE_TAG} MARKET DATA BLACKOUT — no quotes for ${outMin.toFixed(0)} min during ${getSessionName()}. Databento is the ONLY price source, so the engine is NOT opening trades until it returns. Open positions stay protected by their broker brackets.`;
        log(msg); notify(msg, "general");
      }
    } else if (received > 0) {
      if (mdBlackoutAlerted) {
        const msg = `✅ ${MODE_TAG} market data recovered after ${((Date.now() - mdBlackoutSince) / 60_000).toFixed(0)} min — trading resumes.`;
        log(msg); notify(msg, "general");
      }
      mdBlackoutSince = 0; mdBlackoutAlerted = false;
    }

    // PER-SYMBOL blackout. The total-blackout check above misses the case that actually bites: ES/NQ
    // healthy while GOLD alone goes dark, which silently removes the London long and the morning
    // short — two of live's three edges — while everything looks fine.
    if (!scheduledHalt) {
      const now2 = Date.now();
      for (const [sym, since] of unpricedSince) {
        const mins = (now2 - since) / 60_000;
        if (mins >= MD_SYMBOL_BLACKOUT_ALERT_MIN && !symBlackoutAlerted.has(sym)) {
          symBlackoutAlerted.add(sym);
          const msg = `⚠️ ${MODE_TAG} ${sym} has had NO usable quote for ${mins.toFixed(0)} min (${getSessionName()}). Any edge on ${sym} cannot trade until it returns.`;
          log(msg); notify(msg, "general");
        }
      }
      for (const sym of [...symBlackoutAlerted]) if (!unpricedSince.has(sym)) symBlackoutAlerted.delete(sym);
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

  // LIVE ENGINE: RTH-only by default (reverted from 24/7 on 2026-05-27 — overnight initial margin for 1 MES
  // (~$2,657, confirmed real from Tradovate's cashBalance API) EXCEEDS a ~$1K account → margin deficit /
  // liquidation risk. Day-trade margin (~$50) only applies during RTH.
  // EXCEPTION (auto-gated on equity): GOLD (MGC) overnight initial margin is only ~$1,000-1,150. Once equity
  // clears LIVE_EVENING_GOLD_MIN_EQUITY the account can safely hold one gold micro overnight, so let gold
  // trade the evening session — where its RSI-bounce edge lives and the demo already trades metals. Index
  // stays RTH-only always. At sub-threshold equity (e.g. $821 today) this branch is skipped → identical to
  // the old RTH-only behavior. It flips on by itself the moment the account is funded past the threshold.
  if (USES_LIVE_POLICY) {
    // Funded-enough GOLD gets the evening and London sessions; Asia stays blocked.
    // 2026-07-28: was 0.5, which had become a BLOCK rather than a reduction. "Half size" is meaningless
    // once the position is already the smallest contract that exists — you get 1 micro or 0, never half.
    // At gold ATR 8.2 one MGC risks ~$122 while a half-size budget is 3% x $5,250 x 0.5 = $78, so the
    // engine computed qty 0 and skipped EVERY evening setup. The evening is where all six live gold
    // trades came from. At 1.0 the same trade risks $122 = 2.3% of equity — identical to what a morning
    // trade already risks — and MGC initial margin (VERIFIED $2,242.90 from Tradovate today, not the
    // ~$1,000-1,150 this comment used to claim) fits comfortably in a $5,250 account.
    // SIDE EFFECT, deliberate: sessionQuality is derived from this multiplier, so the evening moves from
    // "good" (+0) to "prime" (+5) in scoreSetup. Evening gold setups therefore clear the 75 gate more
    // easily and will fire more often. Evening gold backtests PF 1.05 (train 0.67 / test 1.18) — real but
    // regime-dependent — so watch the frequency. Revert = put 0.5 back.
    // London and evening remain technically available to the gold session policy, but edge flags
    // decide whether any setup may use them. The corrected 2026-08-20 replay invalidated the older
    // London-long PF 1.37 claim (PF 0.89, train 0.74 / test 0.99; fresh holdout PF 0.71), so every
    // live edge is explicitly off. Availability is not evidence and must never be treated as such.
    //
    // ⚠️ CORRECTED 2026-07-29 — this comment used to end "that leaves this branch UNREACHABLE for
    // live gold". THAT IS NO LONGER TRUE. a288af2 added `gold_long_europe`, which is ON for live, so
    // this branch IS reached: live trades gold LONG in London (03:00-09:00 ET) at sizeMult 1.0.
    // Anyone reading the old text would conclude live cannot trade Europe gold. It can.
    //
    // WHY IT IS SAFE: the stop rests AT THE EXCHANGE so it fills unattended; the 45-min stale exit
    // cuts dead trades; the 15:50 ET EOD flatten means a London position never carries through the
    // 17:00-18:00 break; the daily-loss and kill switches are unchanged; and SIZE is now governed by
    // the OVERNIGHT MARGIN GOVERNOR (see OVERNIGHT_INITIAL_MARGIN) rather than a bare contract count,
    // so the position can never exceed what the account can actually margin. On ~$5,227 that is 2 MGC
    // ($4,486 initial, 86% of equity) with the stop binding at ~$150 — the risk controls bind roughly
    // 7x sooner than the margin controls. Do NOT re-derive safety from a hardcoded margin figure:
    // this file already carried a stale one (~$1,000-1,150 for MGC vs a real $2,242.90), which is why
    // updateTradovateEquity() now self-audits the table against the broker and alerts on drift.
    // INDEX IS NEVER ADDED HERE — MNQ initial margin is $4,171, i.e. 79% of the account for one contract.
    // Side effect as with the evening: sizeMult 1.0 makes these sessions "prime" (+5 confluence). If that
    // proves too loose, raise the score threshold rather than dropping the multiplier — a fractional
    // multiplier silently becomes a total block once one contract's risk exceeds the reduced budget.
    return livePolicySessionMultiplier(sym, s, riskSizingEquity(), LIVE_EVENING_GOLD_MIN_EQUITY);
  }

  if (s === "halt") return 0; // market closed (5-6 PM daily break)

  // DEMO ENGINE: trades 24/7 for maximum learning
  if (sym && METALS.has(sym)) {
    const etH = getETHour();
    if (etH >= 8.33 && etH < 13.5) return 1.0;  // COMEX prime
    // 2026-07-28: off-COMEX was 0.5 and, exactly like the live evening rule, had become a BLOCK rather
    // than a reduction. Demo trades FULL-SIZE GC: one contract risks gold-ATR 8.2 x 1.5 x $100 = $1,230,
    // while a half-size budget is 3% x $76,249 x 0.5 = $1,144. floor(1144/1230) = 0, so demo skipped
    // EVERY off-COMEX gold setup. "Half size" cannot work when the position is already one contract.
    // This matters now: live opened eth_evening and eth_europe for gold on 2026-07-28, and demo is
    // supposed to be the shadow that accumulates evidence on exactly those hours for free. At 0.5 it
    // could not shadow them at all. At 1.0 demo risks $1,230 = 1.6% of its equity — LESS, in percentage
    // terms, than live risks on the same setup (2.3%), so the shadow stays the conservative one.
    return 1.0;
  }

  // Equities
  if (s === "morning" || s === "afternoon") return 1.0;  // RTH prime
  if (s === "open" || s === "close") return 1.0;  // Open/close — full size (high-edge times)
  if (s === "midday") return 0.75; // Lunch
  return 0.5; // ETH (Asia + Europe overnight) — active 24/7 research, meaningful size
}

/** ET hour at which the trading day rolls over: P&L, trade count, tilt and the loss-limit baseline.
 *
 *  WAS 9:29 AM (9.483), WHICH SAT ON THE WRONG SIDE OF EVERY LIVE SESSION (fixed 2026-08-02).
 *  Live trades London gold 03:00-09:00 and the index/gold morning 09:45-12:00 — so between midnight
 *  and 9:29 the engine still carried YESTERDAY's dailyPnl, and the execution gate reads
 *      dailyPnl >= -startOfDayBalance * dailyLossLimitPct/100
 *  which means an 8% losing day SILENTLY DISABLED the next morning's London session, hours before the
 *  reset that would have cleared it. It also booked every London fill's P&L to the previous day.
 *
 *  02:00 ET sits before the first session live can trade and after the CME 17:00-18:00 break, so a
 *  whole trading morning now falls inside one accounting day with a fresh budget. Deliberately NOT
 *  midnight: Asia (22:00-03:00) straddles it, and rolling mid-session would split one session's P&L
 *  across two days. */
const SESSION_RESET_ET_HOUR = 2.0;

// ── ET time helpers for ARBITRARY timestamps (2026-08-19) ────────────────────────────────────
// session-time.ts's getETHour()/getETDateString() only answer "right now". Bucketing historical
// bars needs the same answers for a given bar, in ET, with the engine's 02:00 accounting-day
// boundary — doing it in UTC (as preload did) puts the day break at ~19:00/20:00 ET, mid-session.
const ET_PARTS = new Intl.DateTimeFormat("en-US", {
  timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit",
  hour: "2-digit", minute: "2-digit", hourCycle: "h23",
});
function etPartsOf(ms: number) {
  const p = ET_PARTS.formatToParts(new Date(ms));
  const g = (t: string) => parseInt(p.find(x => x.type === t)!.value, 10);
  return { y: g("year"), mo: g("month"), d: g("day"), h: g("hour") + g("minute") / 60 };
}
/** ET clock hour (fractional) of a timestamp, e.g. 9.5 = 09:30 ET. */
function etHourOf(ms: number): number { return etPartsOf(ms).h; }
/** The engine's accounting day (YYYY-MM-DD) a timestamp belongs to: rolls at 02:00 ET, not UTC midnight. */
function etAccountingDay(ms: number): string {
  const { y, mo, d, h } = etPartsOf(ms);
  const base = Date.UTC(y, mo - 1, d) - (h < SESSION_RESET_ET_HOUR ? 86_400_000 : 0);
  return new Date(base).toISOString().slice(0, 10);
}

function checkSessionReset() {
  const now = new Date();
  const todayET = getETDateString();
  const etH = getETHour();

  // Session reset once per day (DST-aware, date-flag ensures no misses)
  if (lastResetDate !== todayET && etH >= SESSION_RESET_ET_HOUR) {
    lastResetDate = todayET;
    for (const [sym, b] of barBuilders) {
      if (b.sessionBars.length > 0) {
        b.prevDayHigh = Math.max(...b.sessionBars.map(x => x.h));
        b.prevDayLow = Math.min(...b.sessionBars.map(x => x.l));
        b.prevDayClose = b.sessionBars[b.sessionBars.length - 1].c;
      }
      b.sessionBars = []; b.openingRangeHigh = 0; b.openingRangeLow = 0; b.barCount = 0; b.orBarCount = 0;
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

        // Write to Obsidian vault — persistent brain for agents (demo only — live writes corrupt the shared doc)
        if (IS_DEMO) try {
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
    // Re-resolve contracts each morning so quarterly rollovers (e.g. NQM→NQU) are picked up
    // without requiring a manual Railway redeploy.
    resolveContracts().catch(err => log(`[RESET] Contract re-resolution failed: ${err}`));
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

          // Update vault daily-balances.md with EOD (demo only — live writes corrupt the shared doc)
          const balancesDoc = IS_DEMO ? await vaultRead("Performance/daily-balances.md") : null;
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
          // ── END-OF-DAY DIGEST (2026-08-03) ────────────────────────────────────────────────
          // Slack reported every individual event but never said what the DAY did, so the only way
          // to know was to reassemble a stream of fragments or open the dashboard. Headline is
          // BALANCE DELTA, never a sum of trade rows — summed rows have been wrong in this system
          // before (double-logged, partially reconciled) and the balance is what the broker actually
          // did. Isolated so a formatting or query error can never disturb the EOD flatten.
          try {
            const { buildDailyDigest } = await import("../lib/daily-digest");
            const digest = await buildDailyDigest({
              mode: IS_LIVE ? "live" : "demo",
              balanceDelta, endBalance: eodBalance, engineDailyPnl: dailyPnl,
              tradesToday: dailyTradeCount,
              dailyLossLimit: riskSizingEquity() > 0 ? riskSizingEquity() * (riskConfig.dailyLossLimitPct / 100) : null,
            });
            log(digest);
            await notify(digest, "futures");
          } catch (err) { log(`[EOD] digest failed (non-fatal): ${err}`); }
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
  // ORIGINAL stop, captured at entry and NEVER mutated. `stopLoss` above moves — to breakeven at
  // 0.6R, then up the profit-lock ratchet — so by the time a winner closes it sits at or near the
  // exit. Risk is defined by the stop the trade was SIZED against, so every R-multiple must divide
  // by this, not by whatever the stop had become. Using the moved stop silently recorded 41 of 48
  // winning trend_continuation trades as EXACTLY 0.00R (breakeven moves the stop to entryPrice, so
  // |entry - stop| = 0 and the divide-by-zero guard returned 0), which taught pattern memory that
  // both profitable setups were losers. See the 2026-08-06 fix in deferredPnlCheck().
  entryStopLoss: number;
  peakDiff?: number; // high-water-mark: best favorable excursion (points) — drives the profit-lock ratchet
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
  entrySetupType: string;  // canonical setup ID (trend_continuation, vwap_bounce, …) — keys pattern memory
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
const lastTrackSaveAt = new Map<string, number>(); // sym → last time we persisted the position's high-water-mark (throttle)

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
  // ⚠️ INERT FOR THIS ENGINE — verified 2026-07-29. These are loaded from the DB (and are editable on
  // /agents, which makes them LOOK like live controls) but NOTHING in setup detection reads them.
  // Every stop/target is hardcoded per setup instead: extreme_rsi_bounce uses stop = adjustedATR x 1.5
  // and target = currentATR x 3.5 → R:R 2.33, and the other setups compute their own inline.
  // The DB currently holds 1.4 / 5.0 for live, i.e. someone tuned these expecting an effect and got
  // none. DO NOT "fix" this by wiring them in: every edge's evidence — the 3-yr engine-exact
  // corrected validations and the index_overbought_short rejection were measured at the hardcoded
  // setup geometry. Wiring the stale 1.4/5.0 config fields in would
  // change R:R from 2.33 to 3.57 and silently invalidate all of it. The hardcoded values ARE the
  // validated ones; the config fields are what is wrong, and the fix belongs in the UI.
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

// Live defaults — REAL money. These are the FALLBACKS ONLY; the live engine runs on live_futures_*
// DB config, which currently overrides riskPerTradePct to 5. Read the DB (or the heartbeat), never
// this block, when you need to know what live is actually risking.
//
// HISTORY, because this comment was stale for five weeks and the "$1K" in it propagated into
// analysis as if it were current: the account opened ~$1,025, and at 1% ($10) no micro fit (smallest
// stop ~$55+), so live correctly STOPPED trading — that halt was the right outcome for an account
// too small to trade futures at professional risk with no proven edge. It was then funded +$4,000
// on 2026-07-11 and rebaselined to ~$4,821 (`starting_capital_live`, `strategy_inception`
// 2026-07-10). At that size 1% (~$48) DOES fit a micro, so the old "1% is impossible here" argument
// no longer holds and the 5% override is now a choice rather than a floor. See PHASE-0-LIVE.md.
const LIVE_DEFAULTS: RiskConfig = {
  maxContractsPerTrade: 3,
  maxTotalContracts: 4,
  maxTradesPerDay: 6,
  riskPerTradePct: 1,            // 1% — pro standard. FALLBACK ONLY: live_futures_risk_per_trade_pct is 5.
  dailyLossLimitPct: 3,          // 3% daily loss → full stop
  maxDrawdownPct: 15,            // 15% drawdown → kill switch
  maxConcurrentPositions: 2,     // tight on a small real account
  atrStopMultiplier: 1.5,
  atrTargetMultiplier: 4.0,
  simulatedEquity: 0,            // Use actual live equity
};

let riskConfig: RiskConfig = IS_LIVE ? LIVE_DEFAULTS : DEMO_DEFAULTS;

/** Equity used for every strategy-level risk decision. A demo live-clone must never size from its
 * much larger broker balance: it follows the live heartbeat and fails closed if that heartbeat is
 * missing or stale. The actual demo balance remains available for broker/margin reconciliation. */
function riskSizingEquity(): number {
  if (IS_DEMO && DEMO_LIVE_CLONE) {
    return liveMirrorEquity > 0 && Date.now() - liveMirrorHeartbeatAt <= LIVE_MIRROR_MAX_AGE_MS
      ? liveMirrorEquity
      : 0;
  }
  // Real-money sizing must always use a fresh broker balance. Simulated equity is research-only;
  // a stale positive live_futures_simulated_equity value must never manufacture buying power.
  if (IS_DEMO && !DEMO_LIVE_CLONE && riskConfig.simulatedEquity > 0) return riskConfig.simulatedEquity;
  return isFreshPositiveEquity(tradovateEquity, lastTradovateEquityAt, Date.now(), BROKER_EQUITY_MAX_AGE_MS)
    ? tradovateEquity
    : 0;
}

async function refreshLiveMirrorEquity(): Promise<void> {
  if (!IS_DEMO || !DEMO_LIVE_CLONE) return;
  try {
    const row = await prisma.agentConfig.findUnique({ where: { key: LIVE_HEARTBEAT_KEY } });
    const heartbeat = row?.value ? JSON.parse(row.value) as { equity?: number; timestamp?: string } : null;
    const equity = Number(heartbeat?.equity ?? 0);
    const heartbeatAt = Date.parse(heartbeat?.timestamp ?? "");
    if (equity > 0 && Number.isFinite(heartbeatAt)) {
      liveMirrorEquity = equity;
      liveMirrorHeartbeatAt = heartbeatAt;
      updateTradingSymbols();
    }
  } catch (err) {
    log(`[LIVE MIRROR] Could not refresh live equity; new demo entries remain fail-closed: ${err}`);
  }
}

async function loadRiskConfig() {
  const isLiveRiskProfile = IS_LIVE || (IS_DEMO && DEMO_LIVE_CLONE);
  const defaults = isLiveRiskProfile ? LIVE_DEFAULTS : DEMO_DEFAULTS;
  // A demo live-clone reads the live risk/execution profile but keeps its independent demo edge flags.
  const kp = isLiveRiskProfile ? "live_futures" : "futures";
  try {
    const keys = [
      `${kp}_max_contracts`, `${kp}_max_total_contracts`, `${kp}_max_trades_per_day`,
      `${kp}_risk_per_trade_pct`, `${kp}_daily_loss_limit_pct`, `${kp}_max_drawdown_pct`,
      `${kp}_atr_stop_multiplier`, `${kp}_atr_target_multiplier`, `${kp}_max_positions`, "max_positions",
      `${kp}_simulated_equity`, `${kp}_symbols`, `${kp}_databento_md`, `${kp}_ai_grader`,
      `${kp}_entry_limit`,          // marketable-limit entries (slippage cap) — demo on, live off by default
      `${kp}_entry_limit_ticks`,    // how far through the signal a limit entry may fill (default 6 ticks)
      `${kp}_pattern_floor`,        // live empirical entry floor (own switch — no longer tied to the grader)
      "index_trend_long_enabled",   // global (both modes) off-switch for the NQ trend-long edge — MUST be in this list or the DB flag is never read
      ...allEdgeFlagKeys(),         // per-edge, per-engine on/off switches (edge_<key>_<demo|live>) — the strategy control board writes these
      "macro_blackout_dates",       // comma-separated YYYY-MM-DD (CPI etc, 8:30 ET releases) — maintained in config, no deploy to update
      "trading_mode_futures",       // operator kill switch; live requires the explicit "live" value
      ...REALTIME_EDGES.map((edge) => `edge_${edge.key}_live_version`),
    ];
    const configs = await prisma.agentConfig.findMany({ where: { key: { in: keys } } });
    const cfg: Record<string, string> = {};
    for (const c of configs) cfg[c.key] = c.value;
    macroBlackoutDates = new Set((cfg["macro_blackout_dates"] || "").split(",").map(x => x.trim()).filter(Boolean));

    const nonNegative = nonNegativeConfigNumber;
    const nonNegativeInt = (raw: string | undefined, fallback: number): number => Math.floor(nonNegative(raw, fallback));
    const dbTradesPerDay = nonNegativeInt(cfg[`${kp}_max_trades_per_day`], defaults.maxTradesPerDay);
    const dbDailyLossPct = nonNegative(cfg[`${kp}_daily_loss_limit_pct`], defaults.dailyLossLimitPct);

    riskConfig = {
      maxContractsPerTrade: nonNegativeInt(cfg[`${kp}_max_contracts`], defaults.maxContractsPerTrade),
      maxTotalContracts: nonNegativeInt(cfg[`${kp}_max_total_contracts`], defaults.maxTotalContracts),
      maxTradesPerDay: IS_DEMO && !DEMO_LIVE_CLONE ? Math.max(dbTradesPerDay, DEMO_DEFAULTS.maxTradesPerDay) : dbTradesPerDay,
      riskPerTradePct: nonNegative(cfg[`${kp}_risk_per_trade_pct`], defaults.riskPerTradePct),
      dailyLossLimitPct: IS_DEMO && !DEMO_LIVE_CLONE ? Math.max(dbDailyLossPct, DEMO_DEFAULTS.dailyLossLimitPct) : dbDailyLossPct,
      maxDrawdownPct: nonNegative(cfg[`${kp}_max_drawdown_pct`], defaults.maxDrawdownPct),
      // Live is ISOLATED to its mode-keyed limit (no leak from the shared max_positions / stocks setting);
      // demo keeps the legacy shared key for backward-compat.
      maxConcurrentPositions: cfg[`${kp}_max_positions`] !== undefined
        ? nonNegativeInt(cfg[`${kp}_max_positions`], defaults.maxConcurrentPositions)
        : (IS_DEMO && !DEMO_LIVE_CLONE && cfg.max_positions !== undefined
          ? nonNegativeInt(cfg.max_positions, defaults.maxConcurrentPositions)
          : defaults.maxConcurrentPositions),
      atrStopMultiplier: nonNegative(cfg[`${kp}_atr_stop_multiplier`], defaults.atrStopMultiplier),
      atrTargetMultiplier: nonNegative(cfg[`${kp}_atr_target_multiplier`], defaults.atrTargetMultiplier),
      simulatedEquity: nonNegative(cfg[`${kp}_simulated_equity`], defaults.simulatedEquity),
    };
    // PHASE 0: optional symbol whitelist (e.g. live_futures_symbols="MES"). Empty/unset = default behavior.
    const symbolsCfg = cfg[`${kp}_symbols`];
    symbolWhitelist = symbolsCfg && symbolsCfg.trim() ? symbolsCfg.split(",").map(s => s.trim()).filter(Boolean) : null;
    databentoMdEnabled = cfg[`${kp}_databento_md`] === "true";   // flip Databento MD on/off without a restart
    // Existing config key retained for compatibility; review is post-trade advisory only.
    aiReviewEnabled = cfg[`${kp}_ai_grader`] !== "false";
    // Absent key → mode default (demo true / live false), so this only turns on where it is asked for.
    const configuredEntryLimit = cfg[`${kp}_entry_limit`] !== undefined ? cfg[`${kp}_entry_limit`] === "true" : false;
    entryLimitEnabled = configuredEntryLimit;
    // Guarded: a 0/NaN cap would price every entry AT the signal and miss essentially everything.
    const ticksCfg = parseFloat(cfg[`${kp}_entry_limit_ticks`]);
    entryLimitTicks = Number.isFinite(ticksCfg) && ticksCfg >= 1 ? ticksCfg : ENTRY_LIMIT_TICKS_DEFAULT;
    patternFloorEnabled = cfg[`${kp}_pattern_floor`] !== "false";   // opt-OUT, not opt-in — it is free
    indexTrendLongEnabled = cfg["index_trend_long_enabled"] !== "false"; // legacy global off-switch (kept as a backstop; see edge switches below)
    // Per-edge switches for the registry gate. Copy the queried flags into edgeFlags. Back-compat: if
    // the legacy index_trend_long_enabled="false" is set but no new switch exists, honour the legacy OFF
    // so the trend-long edge can't silently turn back on for this engine.
    edgeFlags = {};
    for (const k of allEdgeFlagKeys()) edgeFlags[k] = cfg[k];
    if (IS_LIVE) {
      for (const edge of REALTIME_EDGES) {
        const flag = edgeFlagKey(edge.key, "live");
        if (edgeFlags[flag] === "true" && cfg[`edge_${edge.key}_live_version`] !== STRATEGY_VERSION) {
          edgeFlags[flag] = "false";
          await prisma.agentConfig.upsert({ where: { key: flag }, update: { value: "false" }, create: { key: flag, value: "false" } });
          log(`[EDGE VERSION BLOCK] ${edge.key}: stale or missing promotion version; live disabled.`);
        }
      }
    }
    if (cfg["index_trend_long_enabled"] === "false") {
      const md = IS_LIVE ? "live" : "demo";
      if (edgeFlags[`edge_index_trend_long_${md}`] === undefined) edgeFlags[`edge_index_trend_long_${md}`] = "false";
    }
    // Forward-performance circuit breaker. Exact edge keys are now written into RoundTrip.setupType;
    // once 20 position-level fills exist, negative rolling expectancy automatically removes live risk.
    for (const edge of REALTIME_EDGES) {
      const recent = await prisma.roundTrip.findMany({
        where: { mode: IS_LIVE ? "live" : "paper", setupType: edge.key },
        orderBy: { exitTime: "desc" },
        take: 20,
        select: { pnl: true },
      });
      if (recent.length < 20) continue;
      const expectancy = recent.reduce((sum, row) => sum + row.pnl, 0) / recent.length;
      const flag = edgeFlagKey(edge.key, IS_LIVE ? "live" : "demo");
      if (IS_LIVE && expectancy < 0) {
        edgeFlags[flag] = "false";
        if (cfg[flag] !== "false") {
          await prisma.agentConfig.upsert({ where: { key: flag }, update: { value: "false" }, create: { key: flag, value: "false" } });
          log(`[EDGE AUTO-DEMOTE] ${edge.key}: rolling-20 expectancy $${expectancy.toFixed(2)} < 0; live disabled.`);
        }
      } else if (IS_DEMO && expectancy > 0 && cfg[flag] === "false") {
        edgeFlags[flag] = "true";
        await prisma.agentConfig.upsert({ where: { key: flag }, update: { value: "true" }, create: { key: flag, value: "true" } });
        log(`[EDGE DEMO RE-ARM] ${edge.key}: rolling-20 expectancy $${expectancy.toFixed(2)} > 0; demo re-enabled.`);
      }
    }
    await refreshLiveMirrorEquity();
    // Read the operator gate again after the config loop's awaited queries. Reusing the snapshot from
    // the beginning of this function could re-enable trading after a kill arrived mid-refresh.
    await refreshOperatorTradingGate();
    riskConfigHealthy = true;
    updateTradingSymbols();
    const mirrorStatus = IS_DEMO && DEMO_LIVE_CLONE
      ? ` | liveMirror=${riskSizingEquity() > 0 ? `$${riskSizingEquity().toFixed(0)}` : "STALE/MISSING (entries blocked)"}`
      : "";
    log(`[CONFIG] Loaded risk config from DB: ${JSON.stringify(riskConfig)}${symbolWhitelist ? ` | symbols=${symbolWhitelist.join(",")}` : ""} | entry=${entryLimitEnabled ? `LIMIT(cap ${entryLimitTicks} ticks)` : "MARKET"} | postTradeAI=${aiReviewEnabled ? "ON" : "off"}${IS_LIVE ? ` | patternFloor=${patternFloorEnabled ? "ON" : "off"}` : ""}${mirrorStatus}`);
    // DEPLOY VERIFICATION — prints which edges THIS BINARY contains and how each resolves for this
    // engine. Added 2026-07-28 after a stale deploy went unnoticed for a full session: `railway
    // redeploy` (without --from-source) REBUILDS THE PREVIOUS COMMIT, so the container image carries a
    // fresh timestamp while the code inside is old. Timestamps therefore cannot distinguish builds, and
    // the only other signal was waiting for a setup to fire. The edge COUNT is the tell — a build
    // predating a registry change lists fewer keys — so a stale engine is now visible in one log line
    // instead of being discovered by an unintended live trade.
    log(`[EDGES] ${REALTIME_EDGES.length} registered for ${IS_LIVE ? "LIVE" : "DEMO"} | ` +
      REALTIME_EDGES.map((e) => `${e.key}=${isEdgeEnabled(e.key, ENGINE_MODE, edgeFlags) ? "ON" : "off"}`).join(" "));
  } catch (err) {
    riskConfig = defaults;
    riskConfigHealthy = false;
    if (USES_LIVE_POLICY) {
      futuresTradingEnabled = false;
      for (const edge of REALTIME_EDGES) edgeFlags[edgeFlagKey(edge.key, ENGINE_MODE)] = "false";
    }
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

async function savePositionsForOrderRecovery(): Promise<void> {
  const data = Object.fromEntries([...positions].map(([key, value]) => [key, { ...value }]));
  await prisma.agentConfig.upsert({
    where: { key: POSITIONS_KEY },
    update: { value: JSON.stringify(data) },
    create: { key: POSITIONS_KEY, value: JSON.stringify(data) },
  });
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
          action: direction === "long" ? `${TRADE_ACTION_PREFIX}_long` : `${TRADE_ACTION_PREFIX}_short`,
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
        entryStopLoss: stopLoss,
        scaledOut: false, originalQty: qty, consecutiveStops: 0,
        pyramided: false,
        entryRsi: 50, entryVwap: 0, entryTrend15m: "flat", entryDayType: "unknown", entrySession: getSessionName(),
        entrySetupType: "unknown",
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

  // FEED GATE (defence-in-depth). Nothing sets `reliable` false today — the Yahoo path that used to
  // was removed 2026-07-29, and an unpriced symbol now produces NO ticks at all, so this function
  // simply isn't called rather than being called with a bad price. Kept because acting on an
  // untrustworthy quote once cost a phantom emergency close (a +$1,700 winner round-tripped to a
  // -$900 cut on noisy quotes): if a fallback is ever re-added, software position-management must
  // stay paused for it. The broker's on-exchange bracket (stop + target, placed at entry) is the
  // real protection and fires on true exchange prices regardless.
  if (!reliable) {
    if (pos.emergencyWarningTick) pos.emergencyWarningTick = 0; // drop any stale warning
    return;
  }

  // AGGREGATE DRAWDOWN CHECK: close ALL positions if total drawdown exceeds 15% of equity.
  //
  // FAIL CLOSED (2026-07-29). This reads OTHER symbols' last bar close, so it was the one path that
  // could still act on a price the feed gate had already rejected for the ticking symbol. With the
  // 63-point wrong-contract basis that was live until today, a single poisoned gold bar produced
  // 63 x $10 x 4 contracts = $2,520 of PHANTOM loss against a trip threshold of 15% x $5,227 = $784
  // — enough to market-close every position for no reason. Two contracts alone crossed it.
  //
  // A kill switch must never fire on data it cannot vouch for. If ANY open position's symbol lacks a
  // fresh quote, skip the check entirely rather than guess: each position still has its on-exchange
  // broker bracket, and the hard-loss backstop below covers a genuine stop failure. Not acting on
  // unknown data is strictly safer than acting on wrong data.
  // Only the AGGREGATE check is gated — this symbol just ticked, so its own profit-lock, time exit
  // and hard-loss backstop below must keep running normally.
  const maxDrawdownFraction = riskConfig.maxDrawdownPct / 100;
  const aggregateTrustworthy = allPositionsFreshlyPriced();
  if (!aggregateTrustworthy && Date.now() - lastAggSkipLogAt > 60_000) {
    lastAggSkipLogAt = Date.now();
    const stale = [...positions.keys()].filter(s => !isRealtimePriced(s)).join(",");
    log(`  aggregate drawdown check SKIPPED — no fresh quote for ${stale} (per-position broker brackets still in force)`);
  }
  const aggregateUnrealized = [...positions.entries()].reduce((sum, [s, p]) => {
    const m = CONTRACT_MULTIPLIERS[s] || 5;
    const lastPrice = s === sym ? price : (barBuilders.get(s)?.currentBar?.c || p.entryPrice);
    const d = p.direction === "long" ? lastPrice - p.entryPrice : p.entryPrice - lastPrice;
    return sum + d * m * p.quantity;
  }, 0);
  const totalDrawdown = aggregateUnrealized + dailyPnl;
  const drawdownEquity = riskSizingEquity();
  if (aggregateTrustworthy && drawdownEquity > 0 && totalDrawdown < -(drawdownEquity * maxDrawdownFraction)) {
    log(`🚨 AGGREGATE DRAWDOWN KILL: Combined P&L $${totalDrawdown.toFixed(0)} exceeds ${riskConfig.maxDrawdownPct}% of fresh sizing equity $${drawdownEquity.toFixed(0)} — CLOSING ALL`);
    notify(`🚨 AGGREGATE DRAWDOWN KILL: ~$${totalDrawdown.toFixed(0)} (est) — closing all positions; actual fill P&L posts per-position as it reconciles.`, "general");
    for (const [s, p] of positions) {
      closePosition(s, barBuilders.get(s)?.currentBar?.c || p.entryPrice, "emergency");
    }
    return;
  }

  const mult = CONTRACT_MULTIPLIERS[sym] || 5;
  const diff = pos.direction === "long" ? price - pos.entryPrice : pos.entryPrice - price;
  const prevPeak = pos.peakDiff ?? 0;
  pos.peakDiff = Math.max(prevPeak, diff); // track best favorable excursion for the profit-lock
  // Persist the high-water-mark (and current reachedBreakeven/trail state — savePositions serializes the
  // whole position) whenever it advances, throttled to ~12s. Without this, a restart/crash between the
  // sparse event-driven saves resets peakDiff + reachedBreakeven, which caused a live long to time-exit
  // early at +$68 after peaking ~+$186. Best-effort — never blocks trade logic.
  if (pos.peakDiff > prevPeak && Date.now() - (lastTrackSaveAt.get(sym) ?? 0) > 12_000) {
    lastTrackSaveAt.set(sym, Date.now());
    savePositions().catch(() => {});
  }
  const stopDist = Math.abs(pos.entryPrice - pos.stopLoss);
  const pnlDollars = diff * mult * pos.quantity;

  // PROFIT-LOCK LADDER (in R = multiples of stop distance). Pulled EARLY so a trade that goes our
  // way doesn't round-trip back to a full stop — the old ladder only armed at 1R (≈15% of a $1k
  // account), so almost nothing was ever protected before it reversed. Lock capital fast, then bank.
  // Move the broker stop to entry once up this many R — a winner can no longer become a loser.
  //
  // 0.6 -> 0.8 (2026-08-06), on CONVERGENT evidence from two independent methods:
  //   scripts/index-edge-validation.ts, NQ index_trend_long morning, at live's REAL geometry
  //     (stop 1.4x ATR / target 5.0x — see that file; it had been hardcoding 1.5/4.0):
  //       BE 0.4 PF 1.05 ($1,209) | 0.6 PF 1.08 ($2,300) | 0.8 PF 1.14 ($3,884, halves 1.14/1.14)
  //   scripts/live-exit-forensics.ts, replaying 44 REAL broker fills (live+demo):
  //       BE 0.6 +0.395R/trade 64% win  ->  BE 0.8 +0.412R/trade 70% win  (best of 17 variants)
  // Both agree, and the mechanism is the same in each: arming breakeven at 0.6R scratches trades
  // that were still working. Win rate rises because fewer winners get flattened, not because more
  // trades win. RISK IS UNCHANGED -- this only delays when the stop moves UP to entry; the original
  // bracket stop governs the loss until then.
  //
  // ⚠️ My earlier "0.6 is optimal" was measured at the harness's WRONG hardcoded geometry and never
  // tested 0.8 on real fills. Re-verify against live-exit-forensics.ts before moving this again.
  // Revert = put 0.6 back.
  const BREAKEVEN_R = 0.8;
  const SCALE_R = 1.0;      // take 50% off once up 1R (only possible at ≥2 contracts / larger accounts)
  const TRAIL_R = 1.1;      // start trailing just ABOVE the scale level — banks the move on a 1-contract
                            // position, and the offset stops scale-out + trail racing the broker stop on one tick

  // HARD LOSS BACKSTOP (fixes the -$24,100 naked-stop runaway): if a position's loss blows far past
  // what any working stop would allow, the broker bracket has failed — or a cancel-then-place stop
  // move left it naked — so force-close NOW. Runs only on reliable quotes (the !reliable gate above
  // already returned) and only at 2× the intended risk, so it never pre-empts the broker stop (which
  // fills at 1×) in normal operation — it ONLY catches genuine stop failures. The 5%-equity fallback
  // covers the post-breakeven case where the stop sits at entry and intended risk is ~0.
  const intendedRisk = Math.abs(pos.entryPrice - pos.stopLoss) * mult * pos.quantity;
  // Last fallback is an absolute $500, not Infinity: this branch only runs post-breakeven (stop at
  // entry, intended risk ~0), where a $500 loss already means something is wrong. Infinity would
  // silently disable the backstop for the ~60s after a restart while equity is still loading.
  const hardLossCap = intendedRisk > 0 ? intendedRisk * 2 : (tradovateEquity > 0 ? tradovateEquity * 0.05 : 500);
  if (pnlDollars <= -hardLossCap) {
    log(`🚨 ${sym}: HARD LOSS BACKSTOP — loss $${pnlDollars.toFixed(0)} exceeds cap $${hardLossCap.toFixed(0)} (broker stop failed). Force-closing.`);
    notify(`🚨 ${sym} hard backstop fired — broker stop failed, cut at ~$${pnlDollars.toFixed(0)} (est); actual fill P&L posts on reconcile.`, "general");
    closePosition(sym, price, "stop_backstop");
    return;
  }

  // TIME-BASED EXIT: close a trade that still hasn't reached 1R, and never reached breakeven.
  // Was 30 minutes, never tested despite closing ~HALF of all gold trades (615 of 1,232 for -$4,620).
  // Swept 2026-07-25 at 20/30/45/60/none on gold and 30/45/60 on the index. 45 beats 30 on ALL
  // THREE instruments and gets worse on none:
  //     gold  PF 0.92 -> 0.98 (train 0.70 -> 0.80, test 1.04 -> 1.08)
  //     ES    PF 0.74 -> 0.77 (train 0.71 flat,    test 0.77 -> 0.85)
  //     NQ    PF 0.90 -> 0.91 (train 0.86 -> 0.88, test 0.94 -> 0.96)
  // 20 minutes is clearly worse (gold 0.85), 60 is a wash with 45. Risk per trade is UNCHANGED —
  // the hard stop still governs the loss; this only stops cutting slow trades quite so early.
  // Revert = put 30 back.
  //
  // 2026-08-06: 45 -> 90, on REAL FILLS this time. The sweep above came from
  // scripts/index-edge-validation.ts, which was found on 2026-08-06 to be INSENSITIVE TO STOP WIDTH
  // (G_STOP 1.5 vs 1.4 returns byte-identical output; 1.2 moves net by 0.6%) — stopDist is not
  // reaching its exit path, so its absolute numbers are not trustworthy. Re-derived instead with
  // scripts/live-exit-forensics.ts, which replays ACTUAL broker fills from RoundTrip over real
  // 1-minute bars and has no entry model at all, across 44 live+demo round-trips:
  //     20m 0.341R | 30m 0.360R | 45m 0.368R | 60m 0.381R | 90m 0.395R | none 0.416R
  // Strictly monotonic over six settings on both engines = a real effect, not a fitted peak. 90 is
  // chosen over removing the rule entirely so a genuinely dead trade still gets closed rather than
  // held to the session boundary. Worth ~+0.027R (~$4/trade at $153 risk) — small, but free.
  // RISK PER TRADE IS UNCHANGED: the broker bracket stop still governs the loss. This only stops
  // cutting slow-but-alive trades early. Revert = put 45 back.
  const STALE_TRADE_MINUTES = 90;
  const minutesInTrade = (Date.now() - pos.entryTime) / 60_000;
  if (minutesInTrade >= STALE_TRADE_MINUTES && diff < stopDist && !pos.reachedBreakeven && !pos.scaledOut) {
    log(`${sym}: TIME EXIT — ${minutesInTrade.toFixed(0)} min, hasn't reached 1R ($${pnlDollars.toFixed(0)}). Closing to preserve capital.`);
    closePosition(sym, price, "time_exit");
    return;
  }

  // 0.6R: Move stop to breakeven ON THE BROKER — protect capital early, NO scale out yet
  if (diff >= stopDist * BREAKEVEN_R && !pos.reachedBreakeven) {
    pos.reachedBreakeven = true;
    savePositions().catch(() => {}); // persist immediately — a restart must not reset this flag (else a premature time-exit)
    const breakevenPrice = roundToTick(sym, pos.entryPrice);
    log(`${sym}: Reached ${BREAKEVEN_R}R ($${pnlDollars.toFixed(0)}) — moving broker stop to breakeven $${breakevenPrice.toFixed(2)} (winner can't become a loser now)`);

    // CRITICAL: Cancel old stop and place new one at breakeven on the broker
    // This protects against fast moves between bar closes
    if (!stopMoveLocks.get(sym)) {
      stopMoveLocks.set(sym, true);
      (async () => {
        try {
          // ROOT FIX (Fable 5 review): modify the stop IN PLACE — no cancel-then-place naked window.
          // If the modify fails, the ORIGINAL stop stays live (nothing was cancelled), so the position
          // is never left unprotected — the exact failure that caused the -$24,100 runaway.
          if (pos.stopOrderId) {
            await apiFetch("/order/modifyorder", { method: "POST", body: JSON.stringify({
              orderId: pos.stopOrderId, orderType: "Stop", orderQty: pos.quantity, stopPrice: breakevenPrice, isAutomated: true,
            })});
            pos.stopLoss = breakevenPrice;
            log(`${sym}: Broker stop MODIFIED to breakeven $${breakevenPrice.toFixed(2)} (order #${pos.stopOrderId})`);
          } else {
            // No tracked stop order — place a fresh protective stop.
            const accounts = await apiFetch("/account/list") as { id: number; name: string }[];
            const acct = accounts.find(a => a.id === accountId) || accounts[0];
            const closeSide = pos.direction === "long" ? "Sell" : "Buy";
            const s = await apiFetch("/order/placeorder", { method: "POST", body: JSON.stringify({
              accountSpec: acct.name, accountId, action: closeSide, symbol: pos.contractId,
              orderQty: pos.quantity, orderType: "Stop", stopPrice: breakevenPrice, timeInForce: "GTC", isAutomated: true,
            })}) as { orderId: number };
            pos.stopOrderId = s.orderId;
            pos.stopLoss = breakevenPrice;
            log(`${sym}: Broker stop placed at breakeven $${breakevenPrice.toFixed(2)} (order #${s.orderId})`);
          }

        } catch (err) {
          // modify failed → the original broker stop is still live (modify never cancels). Alert loudly;
          // the hard-loss backstop also covers. Do NOT pretend the stop moved to breakeven.
          log(`🚨 ${sym}: stop-move to breakeven FAILED (${err}) — original stop still live + backstop active.`);
          notify(`🚨 ${sym}: stop-move FAILED — original stop intact, backstop covering. Check broker.`, "general");
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
    let maxTotalContracts = riskConfig.maxTotalContracts; // BUGFIX: enforce the CONFIGURED cap (was equity/500 → 118 on $59k, letting pyramids balloon to 30+ contracts past the 8/10 limit)
    // OVERNIGHT GOVERNOR ON ADDS (2026-07-29). This path checked ONLY maxTotalContracts (8 on live),
    // so it walked straight past the per-entry overnight cap of 2: a pyramid on 2 MGC would have
    // taken a 3rd contract at $2,242.90 initial margin — 129% of a $5,227 account — on margin that
    // does not exist. ALLOW_PYRAMID is false on live today, so this is defence-in-depth against the
    // env flag being flipped, but an entry cap that an ADD can ignore is not a cap.
    const addSession = getSessionName();
    if (!RTH_SESSIONS.has(addSession)) {
      const overnightCap = Math.min(OVERNIGHT_CONTRACT_CAP, overnightMarginCap(sym, riskSizingEquity()));
      if (overnightCap < maxTotalContracts) maxTotalContracts = overnightCap;
    }
    if (pos.quantity + addQty <= maxTotalContracts) {
      log(`${sym}: PYRAMID +${addQty}x @ $${price.toFixed(2)} (1.2R, original at breakeven). Total: ${pos.quantity + addQty}x`);
      // Place add order — stop for NEW contracts at breakeven (same as original)
      (async () => {
        try {
          const accounts = await apiFetch("/account/list") as { id: number; name: string }[];
          const acct = accounts.find(a => a.id === accountId) || accounts[0];
          const side = pos.direction === "long" ? "Buy" : "Sell";
          const addOrder = await apiFetch("/order/placeorder", { method: "POST", body: JSON.stringify({
            accountSpec: acct.name, accountId, action: side, symbol: pos.contractId,
            orderQty: addQty, orderType: "Market", timeInForce: "Day", isAutomated: true,
          })}) as { orderId: number };
          // VERIFY THE ADD FILLED before mutating position state (2026-08-19). This was
          // fire-and-forget: a rejected or partial add still incremented pos.quantity and then
          // RESIZED THE BROKER STOP LARGER THAN THE POSITION ACTUALLY HELD — when that stop
          // triggered, the excess would have opened a brand-new position in the opposite
          // direction. Size everything to what actually filled, or change nothing at all.
          let addFill = await verifyOrderFill(addOrder.orderId, addQty);
          if (addFill.status === "unknown") {
            if (!await cancelOrderAndWaitForTerminal(addOrder.orderId)) {
              log(`🚨 ${sym}: pyramid add cancellation did not reach a terminal state; quarantining this add.`);
              notify(`🚨 ${MODE_TAG} ${sym}: pyramid add still indeterminate. Check broker position and protection.`, "general");
              return;
            }
            const brokerPosition = await getBrokerPositionSnapshot(pos.contractId);
            const expectedSign = pos.direction === "long" ? 1 : -1;
            if (brokerPosition && Math.sign(brokerPosition.netPos) === expectedSign && Math.abs(brokerPosition.netPos) > pos.quantity) {
              addFill = {
                status: "filled",
                price: brokerPosition.netPrice > 0 ? brokerPosition.netPrice : price,
                qty: Math.abs(brokerPosition.netPos) - pos.quantity,
              };
              log(`${sym}: indeterminate pyramid add reconciled from broker position (+${addFill.qty}x).`);
            } else if (brokerPosition === undefined) {
              log(`🚨 ${sym}: pyramid add state unresolved — position state unchanged; broker sync required.`);
              notify(`🚨 ${MODE_TAG} ${sym}: pyramid add state unresolved. Check broker position and protection.`, "general");
              return;
            }
          }
          if (addFill.status !== "filled" || addFill.qty < 1) {
            const why = addFill.status === "rejected" ? addFill.reason : addFill.status;
            log(`${sym}: PYRAMID ADD DID NOT FILL (${why}) — position unchanged at ${pos.quantity}x, existing stop untouched.`);
            notify(`${MODE_TAG} ${sym}: pyramid add did not fill (${why}) — position unchanged at ${pos.quantity}x.`);
            return;
          }
          const filledAddQty = addFill.qty;
          const addPrice = addFill.price > 0 ? addFill.price : price;
          if (filledAddQty < addQty) log(`${sym}: PARTIAL pyramid add — ${filledAddQty}/${addQty} filled; sizing to the fill.`);
          // Update average entry price: weighted average of existing + ACTUALLY FILLED contracts
          const oldQty = pos.quantity;
          const oldEntry = pos.entryPrice;
          pos.quantity += filledAddQty;
          pos.entryPrice = (oldEntry * oldQty + addPrice * filledAddQty) / pos.quantity;
          pos.pyramided = true;
          // ROOT FIX: modify the existing stop IN PLACE to cover the new total quantity at the new
          // average entry — no cancel-then-place naked window. Falls back to place only if untracked.
          const closeSide = pos.direction === "long" ? "Sell" : "Buy";
          const pyramidStop = roundToTick(sym, pos.entryPrice); // weighted avg → must snap to tick
          if (pos.stopOrderId) {
            await apiFetch("/order/modifyorder", { method: "POST", body: JSON.stringify({
              orderId: pos.stopOrderId, orderType: "Stop", orderQty: pos.quantity, stopPrice: pyramidStop, isAutomated: true,
            })});
          } else {
            const s = await apiFetch("/order/placeorder", { method: "POST", body: JSON.stringify({
              accountSpec: acct.name, accountId, action: closeSide, symbol: pos.contractId,
              orderQty: pos.quantity, orderType: "Stop", stopPrice: pyramidStop, timeInForce: "GTC", isAutomated: true,
            })}) as { orderId: number };
            pos.stopOrderId = s.orderId;
          }
          // Resize the TARGET to the new total as well — it was left at the pre-pyramid quantity,
          // so a target fill would flatten only part of the position and leave an untracked residual.
          if (pos.targetOrderId) {
            try {
              await apiFetch("/order/modifyorder", { method: "POST", body: JSON.stringify({
                orderId: pos.targetOrderId, orderType: "Limit", orderQty: pos.quantity, price: roundToTick(sym, pos.target), isAutomated: true,
              })});
            } catch (e) { log(`${sym}: pyramid target resize failed (${e}) — cancelling it so the stop/trail owns the exit`); 
              try { await apiFetch("/order/cancelorder", { method: "POST", body: JSON.stringify({ orderId: pos.targetOrderId }) }); } catch {}
              pos.targetOrderId = null; }
          }
          log(`${sym}: Pyramid filled — ${oldQty}x@$${oldEntry.toFixed(2)} + ${filledAddQty}x@$${addPrice.toFixed(2)} = ${pos.quantity}x avg $${pos.entryPrice.toFixed(2)}`);
          notify(`PYRAMID ${sym}: +${filledAddQty}x @ $${addPrice.toFixed(2)}. Now ${pos.quantity}x avg $${pos.entryPrice.toFixed(2)}.`);

          // Log pyramid entry to DB so orders page shows it
          try {
            await prisma.autoTradeLog.create({ data: {
              symbol: `FUT:${sym}`,
              action: `${TRADE_ACTION_PREFIX}_pyramid`,
              qty: filledAddQty,
              price,
              reason: `[${MODE_TAG} ${sym}] Pyramid +${filledAddQty}x @ $${addPrice.toFixed(2)}. Now ${pos.quantity}x avg $${pos.entryPrice.toFixed(2)}. Original: ${oldQty}x @ $${oldEntry.toFixed(2)}`,
            }});
          } catch {}

          await savePositions();
        } catch (err) { log(`${sym}: Pyramid order failed: ${err}`); }
      })();
    }
  }

  // 1R+: Scale out 50% — bank real profit. Only possible at ≥2 contracts; a $1k/1-contract account
  // physically can't take "a little" off (no fractional futures), so for it the trailing stop below
  // is the profit-banking mechanism. Taking partials requires a larger account (≥2 contracts).
  if (diff >= stopDist * SCALE_R && !pos.scaledOut && pos.quantity >= 2 && (!ALLOW_PYRAMID || pos.pyramided)) {
    const scaleQty = Math.max(1, Math.floor(pos.quantity / 2));
    // Hold the stop-move lock across the scale-out so the trailing-stop block below (and breakeven)
    // can't modify the same broker stop order concurrently — scale-out cancels/replaces the bracket,
    // and a simultaneous trail modify could double-place or cancel each other's stop. The lock guard
    // also means we won't scale while a breakeven/trail move is already in flight.
    if (!stopMoveLocks.get(sym)) {
      stopMoveLocks.set(sym, true);
      log(`${sym}: Reached ${SCALE_R}R ($${pnlDollars.toFixed(0)}) — scaling out ${scaleQty} of ${pos.quantity} contracts`);
      scaleOutPosition(sym, price, scaleQty).finally(() => stopMoveLocks.set(sym, false));
    }
  }

  // 1R+: Activate trailing stop — capture profit as price moves our way (banks gains on 1 contract)
  if (diff >= stopDist * TRAIL_R) {
    const currentATRVal = atr(barBuilders.get(sym)?.bars5m || []);
    if (currentATRVal > 0) {
      // Tightened: gold was 1.5 (→ 2.25× ATR ≈ 12+ pts behind) which let a +$170 gain trail out at +$25.
      // Now gold trails ~1.5× ATR, index ~1.35× ATR.
      // Index trail widened 0.9 -> 1.4 on 2026-08-05. The trail sat at 0.9*1.5 = 1.35x ATR against a
      // 1.5x ATR stop — i.e. 90% of the stop distance — so a trade that reached the 1.1R trigger was
      // stopped out by a 0.9R pullback. Live proved it: avg WIN 0.59R against a 2.33R target, 96% of
      // winners never reaching 1R, while losses ran to -0.93R. That turns a designed 2.33:1 into an
      // actual 0.63:1 and forces a 61% breakeven win rate.
      // METALS DELIBERATELY UNCHANGED: the same widening was tested on gold and made it WORSE —
      // morning short PF 1.67 -> 1.47 (net $1,361 -> $957). Gold's edge depends on banking quickly;
      // the index's depends on letting winners run. One global number cannot serve both.
      const atrMult = METALS.has(sym) ? 1.0 : 1.4;
      let rawTrail = pos.direction === "long" ? price - currentATRVal * atrMult * 1.5 : price + currentATRVal * atrMult * 1.5;

      // PROFIT-LOCK RATCHET: once the trade has been up ≥1.0R, never give back more than ~35% of the
      // best excursion. Lowered from 1.5R → 1.0R so common spikes (e.g. a +$186 / ~1.3R peak on gold)
      // actually get protected — the trailing stop alone can't bank profit on a 1-contract account.
      const peak = pos.peakDiff ?? diff;
      if (peak >= stopDist * 1.0) {
        // Give back more of the peak on the INDEX so a runner is not ratcheted shut at ~0.7R; gold
        // keeps 0.65 because banking early is what makes its morning short work (see atrMult above).
        const lockFrac = METALS.has(sym) ? 0.65 : 0.45;
        const lockDist = peak * lockFrac; // protect this share of the peak favorable move
        const lockStop = pos.direction === "long" ? pos.entryPrice + lockDist : pos.entryPrice - lockDist;
        rawTrail = pos.direction === "long" ? Math.max(rawTrail, lockStop) : Math.min(rawTrail, lockStop);
      }
      const trail = roundToTick(sym, rawTrail); // broker rejects un-tick-aligned stop prices
      if (!pos.trailStop || (pos.direction === "long" ? trail > pos.trailStop : trail < pos.trailStop)) {
        const isNew = !pos.trailStop;
        if (isNew) log(`${sym}: 1.5R+ ($${pnlDollars.toFixed(0)}) — trailing stop at $${trail.toFixed(2)} (1.5x ATR)`);
        pos.trailStop = trail;

        // Ratchet the broker stop up to the trail (locked to prevent concurrent modifications).
        // Modify IN PLACE — no cancel-then-place naked window; only place fresh if no stop is tracked.
        if (!stopMoveLocks.get(sym)) {
          stopMoveLocks.set(sym, true);
          (async () => {
            try {
              if (pos.stopOrderId) {
                await apiFetch("/order/modifyorder", { method: "POST", body: JSON.stringify({
                  orderId: pos.stopOrderId, orderType: "Stop", orderQty: pos.quantity, stopPrice: trail, isAutomated: true,
                })});
                if (isNew) log(`${sym}: Broker trail stop MODIFIED to $${trail.toFixed(2)} (1.5x ATR, order #${pos.stopOrderId})`);
              } else {
                const accounts = await apiFetch("/account/list") as { id: number; name: string }[];
                const acct = accounts.find(a => a.id === accountId) || accounts[0];
                const closeSide = pos.direction === "long" ? "Sell" : "Buy";
                const s = await apiFetch("/order/placeorder", { method: "POST", body: JSON.stringify({
                  accountSpec: acct.name, accountId, action: closeSide, symbol: pos.contractId,
                  orderQty: pos.quantity, orderType: "Stop", stopPrice: trail, timeInForce: "GTC", isAutomated: true,
                })}) as { orderId: number };
                pos.stopOrderId = s.orderId;
                if (isNew) log(`${sym}: Broker trail stop PLACED at $${trail.toFixed(2)} (1.5x ATR, order #${s.orderId})`);
              }
            } catch (err) {
              log(`${sym}: WARNING — failed to set broker trail stop: ${err}`);
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
    syncMissCount.delete(sym); // clear reconcile miss-counter when a position leaves the book
    recentlyClosedAt.set(sym, Date.now());
    return;
  }

  // Per-position emergency: cap single-position loss at 10% of equity or $750, whichever is lower
  // IMPORTANT: Require 2 consecutive ticks (10s) past the limit before closing.
  // A mark price can briefly show a loss that does not exist on the exchange.
  // The broker bracket stop order handles the REAL stop — this is a last-resort safety net.
  // Equity 0 means "not yet fetched", NOT "no money". Math.min(750, 0) would be a $0 limit, which
  // makes ANY unrealized loss trip the emergency close — so fall back to the $750 ceiling until the
  // real balance lands (2026-07-29, when the optimistic $50,000 default was removed).
  // 2026-08-06: FLOORED AT 2x THE TRADE'S OWN RISK. The flat $750 ceiling was written for a small
  // live account and silently became a HAIR TRIGGER on demo, where 3% of $80,160 is ~$2,405 of
  // intended risk per trade — so the "last-resort safety net" fired at 0.31x the risk the trade was
  // deliberately sized to take, cutting positions BEFORE their own broker stop could work. It fired
  // 9 times between Jul 30 and Aug 6, every one at -$735 to -$930, which corrupts demo as the signal
  // live is promoted from. A backstop must sit BEYOND the stop it is backing up, never inside it.
  //   live  (risk $256):  max(2x256=512, min(750, 10% of $5,114 = 511))  = $512  — unchanged in practice
  //   demo  (risk $2,405): max(2x2405=4810, min(750, $8,016))            = $4,810 — now a real backstop
  // Still equity-relative on the upper side, so a drawdown tightens it automatically.
  const sizingEquity = riskSizingEquity();
  const perTradeRisk = sizingEquity > 0 ? sizingEquity * (riskConfig.riskPerTradePct / 100) : 0;
  const perPositionLimit = Math.max(
    perTradeRisk * 2,
    sizingEquity > 0 ? Math.min(750, sizingEquity * 0.10) : 750,
  );
  if (pnlDollars < -perPositionLimit) {
    if (!pos.emergencyWarningTick) {
      pos.emergencyWarningTick = Date.now();
      log(`${sym}: WARNING — est P&L $${pnlDollars.toFixed(0)} past limit $${perPositionLimit.toFixed(0)}. Confirming on next tick...`);
      return; // Wait for confirmation on next tick
    }
    // Confirmed: still past limit after at least one more tick
    const confirmAge = Date.now() - pos.emergencyWarningTick;
    if (confirmAge < 8_000) return; // Need at least 8s of confirmation so this is not one odd tick
    log(`${sym}: EMERGENCY CLOSE CONFIRMED — $${pnlDollars.toFixed(0)} past limit $${perPositionLimit.toFixed(0)} for ${(confirmAge / 1000).toFixed(0)}s`);
    closePosition(sym, price, "emergency"); return;
  } else {
    // Price recovered — clear warning
    if (pos.emergencyWarningTick) {
      log(`${sym}: Emergency warning cleared — est P&L $${pnlDollars.toFixed(0)} back within limit`);
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

    // VERIFY THE SCALE ACTUALLY FILLED before mutating any state (2026-08-19).
    // This used to only *look up a price*: on a rejected scale order it fell through to
    // `catch { /* use bar price */ }`, then halved pos.quantity, resized the stop down to that
    // phantom half (leaving the OTHER half of a real position unprotected), booked profit into
    // dailyPnl that never happened, and had already cancelled the target. Now the fill is
    // authoritative — and a partial fill scales exactly what filled, never what was requested.
    let scaleFill = await verifyOrderFill(scaleOrder.orderId, scaleQty);
    if (scaleFill.status === "unknown") {
      if (!await cancelOrderAndWaitForTerminal(scaleOrder.orderId)) {
        log(`🚨 ${sym}: scale-out cancellation did not reach a terminal state; tracked quantity remains unchanged.`);
        notify(`🚨 ${MODE_TAG} ${sym}: scale-out still indeterminate. Check broker quantity and protection.`, "general");
        return;
      }
      const brokerPosition = await getBrokerPositionSnapshot(pos.contractId);
      const expectedSign = pos.direction === "long" ? 1 : -1;
      if (brokerPosition === null) {
        // Another exit flattened the position. Remove every leftover close-side order before it can
        // become a reverse entry, then remove local tracking. Fills are reconciled asynchronously.
        for (const orderId of [pos.stopOrderId, pos.targetOrderId]) {
          if (orderId) await cancelOrderAndWaitForTerminal(orderId);
        }
        try {
          const orders = await apiFetch("/order/list") as { id: number; contractId: number; ordStatus: string }[];
          for (const order of orders.filter((item) => item.contractId === pos.contractId && ["Working", "Accepted"].includes(item.ordStatus))) {
            await cancelOrderAndWaitForTerminal(order.id);
          }
        } catch { /* sync will retry orphan cleanup */ }
        positions.delete(sym);
        recentlyClosedAt.set(sym, Date.now());
        await savePositions();
        log(`${sym}: indeterminate scale-out reconciled FLAT; remaining orders cancelled and tracking cleared.`);
        return;
      } else if (brokerPosition && Math.sign(brokerPosition.netPos) === expectedSign && Math.abs(brokerPosition.netPos) < pos.quantity) {
        scaleFill = {
          status: "filled",
          price,
          qty: pos.quantity - Math.abs(brokerPosition.netPos),
        };
        log(`${sym}: indeterminate scale-out reconciled from broker position (-${scaleFill.qty}x).`);
      } else if (brokerPosition === undefined) {
        log(`🚨 ${sym}: scale-out state unresolved — not changing tracked quantity or stop size.`);
        notify(`🚨 ${MODE_TAG} ${sym}: scale-out state unresolved. Check broker quantity and stop size now.`, "general");
        return;
      }
    }
    if (scaleFill.status !== "filled" || scaleFill.qty < 1) {
      const why = scaleFill.status === "rejected" ? scaleFill.reason : scaleFill.status;
      log(`${sym}: SCALE-OUT DID NOT FILL (${why}) — position left intact at ${pos.quantity}x. Stop still covers full size; target was cancelled, trailing stop now owns the exit.`);
      notify(`${MODE_TAG} ${sym}: scale-out did not fill (${why}) — position unchanged at ${pos.quantity}x, protected by its stop.`);
      pos.targetOrderId = null; // it WAS cancelled above; don't leave a stale id pointing at nothing
      await savePositions();
      return;
    }
    const filledScaleQty = scaleFill.qty;
    if (scaleFill.price > 0 && Math.abs(scaleFill.price - price) > 0.01) {
      log(`${sym}: Scale-out actual fill $${scaleFill.price.toFixed(2)} (bar was $${price.toFixed(2)})`);
      price = scaleFill.price;
    }
    if (filledScaleQty < scaleQty) log(`${sym}: PARTIAL scale-out — ${filledScaleQty}/${scaleQty} filled; sizing everything to what actually filled.`);

    // Recalculate P&L with actual fill price AND actual filled quantity
    const actualDiff = pos.direction === "long" ? price - pos.entryPrice : pos.entryPrice - price;
    const actualPnl = actualDiff * mult * filledScaleQty;

    pos.quantity -= filledScaleQty;
    pos.scaledOut = true;
    dailyPnl += actualPnl;
    log(`${sym}: SCALE OUT ${filledScaleQty}x @ $${price.toFixed(2)} — locked in $${actualPnl.toFixed(0)}. ${pos.quantity}x remaining.`);
    notify(`SCALE OUT ${sym}: +$${actualPnl.toFixed(0)} locked (${filledScaleQty}x @ $${price.toFixed(2)}). ${pos.quantity}x trailing.`);


    // Log to database
    try {
      await prisma.autoTradeLog.create({ data: {
        symbol: `FUT:${sym}`,
        action: `${TRADE_ACTION_PREFIX}_scale_out`,
        qty: filledScaleQty,
        price,
        pnl: actualPnl,
        reason: `[FUTURES ${sym}] Scale out 50% at 1R: ${filledScaleQty}x @ $${price.toFixed(2)}. Entry: $${pos.entryPrice.toFixed(2)}. P&L: $${actualPnl.toFixed(0)}. Remaining: ${pos.quantity}x`,
        orderId: null,
      }});
    } catch {}

    // Resize the stop bracket to the remaining qty — modify IN PLACE (no cancel-then-place naked
    // window); only place fresh if no stop is tracked.
    try {
      const closeSide = pos.direction === "long" ? "Sell" : "Buy";
      const remStop = roundToTick(sym, pos.stopLoss);
      if (pos.stopOrderId) {
        await apiFetch("/order/modifyorder", { method: "POST", body: JSON.stringify({
          orderId: pos.stopOrderId, orderType: "Stop", orderQty: pos.quantity, stopPrice: remStop, isAutomated: true,
        })});
      } else {
        const accounts2 = await apiFetch("/account/list") as { id: number; name: string }[];
        const acct2 = accounts2.find(a => a.id === accountId) || accounts2[0];
        const s = await apiFetch("/order/placeorder", { method: "POST", body: JSON.stringify({
          accountSpec: acct2.name, accountId, action: closeSide, symbol: pos.contractId,
          orderQty: pos.quantity, orderType: "Stop", stopPrice: remStop, timeInForce: "GTC", isAutomated: true,
        })}) as { orderId: number };
        pos.stopOrderId = s.orderId;
      }
    } catch (error) {
      log(`🚨 ${sym}: stop resize after scale-out failed (${error}); flattening the remainder to prevent an oversized stop reversal.`);
      notify(`🚨 ${MODE_TAG} ${sym}: protection resize failed after scale-out. Flattening ${pos.quantity}x remainder.`, "general");
      if (pos.stopOrderId) await cancelOrderAndWaitForTerminal(pos.stopOrderId);
      pos.stopOrderId = null;
      pos.targetOrderId = null;
      await savePositions();
      await closePosition(sym, price, "protection_resize_failed");
      return;
    }
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
        contracts: filledScaleQty,
        entryPrice: pos.entryPrice,
        stopPrice: pos.stopLoss,
        targetPrice: pos.target,
        exitPrice: price,
        pnlDollars: actualPnl,
        rMultiple: pos.stopLoss ? (price - pos.entryPrice) / Math.abs(pos.entryPrice - pos.stopLoss) * (pos.direction === "long" ? 1 : -1) : undefined,
        conviction: 3,
        exitReason: "scale_out",
      }, AGENT_NAME);
      await logDecision(AGENT_NAME, "EXIT", `FUT:${sym}`, `Scale out ${filledScaleQty}x @ $${price.toFixed(2)}: P&L $${actualPnl.toFixed(0)}. ${pos.quantity}x remaining.`, actualPnl > 0 ? 4 : 2);
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
  closeOrderIds: number[];
  reason: string;
  mult: number;
  estimatedPnl: number;
  entrySession: string;
  entryRsi: number;
  entryVwap: number;
  entryTrend15m: string;
  entryDayType: string;
  entrySetupType: string;
  entryStopLoss: number;   // ORIGINAL stop — the R denominator. Never the moved stop.
}

// Auto-clean phantom close-rows: a close attempt that never reconciled to a real fill (double-close /
// orphan-adoption artifacts). >2h cutoff is far past any legitimate fill delay, and open-entry rows
// (_long/_short, also pnl:null) are excluded — so this never touches a genuinely-pending trade. Mark
// superseded (pnl 0 + reconciled) so they drop out of "pending" and out of P&L stats.
async function sweepPhantomCloseRows() {
  try {
    const cutoff = new Date(Date.now() - 2 * 3600_000);
    const r = await prisma.autoTradeLog.updateMany({
      where: {
        symbol: { startsWith: "FUT:" }, pnl: null, reconciledAt: null, createdAt: { lt: cutoff },
        action: { startsWith: `${TRADE_ACTION_PREFIX}_` },
        NOT: [{ action: { contains: "_long" } }, { action: { contains: "_short" } }],
      },
      data: { pnl: 0, reconciledAt: new Date() },
    });
    if (r.count > 0) log(`[SWEEP] Marked ${r.count} phantom close-row(s) superseded (never reconciled >2h)`);
  } catch (e) { log(`[SWEEP] phantom sweep failed: ${e}`); }
}

async function deferredPnlCheck(meta: CloseMeta, attempt: number) {
  // Build + store this trade's pattern-memory vector with a given outcome. Used in BOTH the
  // real-fill path (accurate) and the give-up path (estimate) so the learning loop captures
  // ~100% of closed trades — not just the clean stop-outs whose fills match by orderId.
  const storeOutcomePattern = async (outcome: "win" | "loss", pnlRVal: number) => {
    try {
      const { storePattern } = await import("../lib/pattern-memory");
      const sd = Math.abs(meta.entryPrice - (meta.entryStopLoss || meta.stopLoss));
      await storePattern({
        regime: cachedRegime,
        session: meta.entrySession,
        instrument: meta.sym,
        setupType: meta.entrySetupType || "unknown",  // canonical entry setup, NOT exit reason
        direction: meta.direction,
        rsi: meta.entryRsi,
        vixLevel: currentVIX,
        vixTrend: currentVIX > 20 ? "rising" as const : "falling" as const,
        atr: meta.entryPrice > 0 ? sd / meta.entryPrice * 1000 : 0,
        priceVsVwap: meta.entryVwap > 0 ? (meta.entryPrice - meta.entryVwap) / meta.entryVwap * 100 : 0,
        trend15m: (meta.entryTrend15m || "flat") as "up" | "down" | "flat",
        trendDaily: (meta.entryDayType || "").includes("trend") ? (meta.direction === "long" ? "up" as const : "down" as const) : "flat" as const,
        riskReward: sd > 0 ? Math.abs(meta.target - meta.entryPrice) / sd : 2,
        dollarTrend, bondTrend,
        outcome,
        pnlR: pnlRVal,
      });
    } catch { /* pattern storage optional */ }
  };

  try {
    const closeSide = meta.direction === "long" ? "Sell" : "Buy";
    const fills = await apiFetch("/fill/list") as { id: number; orderId: number; contractId: number; action: string; price: number; qty: number; timestamp: string }[];

    // Match fills: by orderId (exact) or by contractId + side + recency (fuzzy)
    const myFills = meta.closeOrderIds.length > 0
      ? fills.filter(f => meta.closeOrderIds.includes(f.orderId))
      : fills
          .filter(f => f.contractId === meta.contractId && f.action === closeSide)
          .filter(f => Date.now() - new Date(f.timestamp).getTime() < 300_000) // within 5 min
          .sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime())
          .slice(0, meta.quantity);

    // ACCURACY GUARD: without an exact close orderId, the fuzzy match (contract+side+recency) can grab
    // the WRONG fills when several trades on this symbol close in the same window — producing a wrong P&L.
    // Only trust the fuzzy match when its total quantity exactly equals the close size; otherwise treat
    // it as "no fill yet" and defer to the reconciliation cron, which sees the full fill history.
    const matchedQty = myFills.reduce((s, f) => s + f.qty, 0);
    const quantityMismatch = matchedQty !== meta.quantity;

    if (myFills.length === 0 || quantityMismatch) {
      if (quantityMismatch) log(`[DEFERRED] ${meta.sym}: matched close qty ${matchedQty}≠${meta.quantity} — waiting for the complete fill set`);
      if (attempt < 2) {
        log(`[DEFERRED] ${meta.sym}: No fills yet (attempt ${attempt}). Retrying in 60s...`);
        setTimeout(() => deferredPnlCheck(meta, attempt + 1), 60_000);
      } else {
        log(`[DEFERRED] ${meta.sym}: No fills after ${attempt} attempts. Reconciliation cron will catch this.`);
        // Capture the pattern from the engine's close estimate so the learning loop still sees this
        // trade. Without this, unmatched-fill trades (disproportionately wins closed via fuzzy paths)
        // were dropped, biasing pattern memory toward losses. The reconciliation cron corrects $ P&L
        // later; this only feeds the win/loss + R signal the AI grader learns from.
        const sd = Math.abs(meta.entryPrice - (meta.entryStopLoss || meta.stopLoss));
        const estDiff = meta.mult > 0 && meta.quantity > 0 ? meta.estimatedPnl / (meta.mult * meta.quantity) : 0;
        const estR = sd > 0 ? estDiff / sd : 0;
        await storeOutcomePattern(meta.estimatedPnl >= 0 ? "win" : "loss", estR);
        log(`[DEFERRED] ${meta.sym}: Pattern stored from ESTIMATE (${meta.estimatedPnl >= 0 ? "WIN" : "LOSS"} ${estR.toFixed(1)}R) — fills unmatched`);
      }
      return;
    }

    // Calculate real P&L from actual fill price
    const totalQty = myFills.reduce((s, f) => s + f.qty, 0);
    const fillPrice = myFills.reduce((s, f) => s + f.price * f.qty, 0) / totalQty;
    const diff = meta.direction === "long" ? fillPrice - meta.entryPrice : meta.entryPrice - fillPrice;
    const realPnl = diff * meta.mult * meta.quantity;
    // Divide by the ORIGINAL stop, not meta.stopLoss — that one has been ratcheted to (or past)
    // the exit on every winner, which recorded them all as 0.00R. See Position.entryStopLoss.
    const stopDist = Math.abs(meta.entryPrice - (meta.entryStopLoss || meta.stopLoss));
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
    // Post the ACCURATE, reconciled fill P&L to Slack/feed (closePosition no longer broadcasts the estimate).
    notify(`${meta.sym} ${meta.reason} actual fill: ${realPnl >= 0 ? "+$" : "-$"}${Math.abs(realPnl).toFixed(0)} @ $${fillPrice.toFixed(2)} | Daily: ${dailyPnl >= 0 ? "+$" : "-$"}${Math.abs(dailyPnl).toFixed(0)}`);
    feedLog("exit", `**${MODE_TAG} ${meta.sym} ${meta.reason} filled** ${realPnl >= 0 ? "+$" : "-$"}${Math.abs(realPnl).toFixed(0)} @ $${fillPrice.toFixed(2)}`);

    // Correct dailyPnl estimate with real value
    const estimatedPnl = (meta.direction === "long" ? -1 : 1) * 0; // we already added estimate, adjust delta
    // Note: dailyPnl was set from Yahoo estimate. We can't perfectly fix it here since
    // other trades may have happened. The reconciliation cron handles aggregate accuracy.

    // Store pattern memory with REAL P&L (not Yahoo estimate)
    await storeOutcomePattern(realPnl > 0 ? "win" : "loss", pnlR);
    log(`[DEFERRED] ${meta.sym}: Pattern stored — ${realPnl > 0 ? "WIN" : "LOSS"} ${pnlR.toFixed(1)}R`);

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

    // Brain: update dashboard after trade close (throttled)
    throttledBrainUpdate(`trade-exit-${meta.sym}`);

  } catch (err) {
    log(`[DEFERRED] ${meta.sym}: Error: ${err}`);
    if (attempt < 2) {
      setTimeout(() => deferredPnlCheck(meta, attempt + 1), 60_000);
    }
  }
}

// Lock to prevent concurrent close attempts on the same symbol
const closingLocks = new Map<string, boolean>();

// Continuous position reconciliation (the fix for the Jul 17 orphaned-bracket cascade):
// syncMissCount = consecutive syncs where a tracked position was absent from /position/list. We require
// 2 misses before reconcile-closing, so a single transient/empty broker read can't false-close a REAL
// position and cancel its stop. lastSyncTs throttles the periodic sweep so it runs ~once/cycle, not per-symbol.
const syncMissCount = new Map<string, number>();
let lastSyncTs = 0;
let syncInFlight = false; // re-entrancy guard: never run two reconciles at once (concurrent runs could double-cancel a real stop)

// Track recently closed symbols so syncPositions doesn't re-adopt settlement-lag residuals.
// Root cause of the phantom -$24k emergency: scale-out stop + breakeven close both fired as BUY
// orders within the same second, creating a net-LONG residual on Tradovate's paper account.
// syncPositions saw that LONG and adopted it, then the emergency misfired on it with wrong direction.
const recentlyClosedAt = new Map<string, number>(); // sym → epoch ms of last close
const RECENTLY_CLOSED_TTL = 5 * 60_000; // 5 minutes

async function closePosition(sym: string, price: number, reason: string, brokerAlreadyFlat = false) {
  // Prevent double-close: if another close is already in progress, skip
  if (closingLocks.get(sym)) {
    log(`${sym}: Close already in progress (${reason}) — skipping duplicate`);
    return;
  }
  const pos = positions.get(sym);
  if (!pos) return;
  // The original stop remains valid only while the broker position stays on the same side. If a
  // close over-fills and reverses the account, keep flattening it instead of inventing risk geometry
  // for an unintended trade.
  let stopLossIsValidated = true;
  closingLocks.set(sym, true);
  const mult = CONTRACT_MULTIPLIERS[sym] || 5;
  const originalQuantity = pos.quantity;

  // CHECK: Is the position still open on Tradovate? Bracket stop/target may have already filled.
  let positionAlreadyClosed = brokerAlreadyFlat;
  if (!brokerAlreadyFlat) {
    const initialBrokerPosition = await getBrokerPositionSnapshot(pos.contractId, 3);
    if (initialBrokerPosition === undefined) {
      // Never guess that a tracked position still exists and send an opposite-side order. If the
      // bracket filled while the broker API was unavailable, that "close" would open a reversal.
      log(`[CLOSE] ${sym}: broker position unavailable; refusing to submit a close that could reverse the account`);
      notify(`🚨 ${MODE_TAG} ${sym}: close paused because broker position could not be verified. Existing protection remains in place.`, "general");
      closingLocks.delete(sym);
      return;
    }
    if (initialBrokerPosition === null) positionAlreadyClosed = true;
  }
  if (positionAlreadyClosed) {
    log(`${sym}: Position already closed on Tradovate (bracket filled). Using actual fill for P&L.`);
  }

  const closeOrderIds: number[] = [];

  // Helper: cancel ALL working orders for this contract (catches orphans after restarts)
  const cancelAllOrdersForContract = async (): Promise<boolean> => {
    try {
      // Also scan for ANY working orders on this contract (catches orphans with unknown IDs)
      const allOrders = await apiFetch("/order/list") as { id: number; contractId: number; ordStatus: string }[];
      const orphans = allOrders.filter(o => o.contractId === pos.contractId && (o.ordStatus === "Working" || o.ordStatus === "Accepted"));
      const orderIds = new Set<number>([
        ...(pos.stopOrderId ? [pos.stopOrderId] : []),
        ...(pos.targetOrderId ? [pos.targetOrderId] : []),
        ...orphans.map((order) => order.id),
      ]);
      for (const orderId of orderIds) {
        if (!await cancelOrderAndWaitForTerminal(orderId)) {
          log(`${sym}: order #${orderId} did not reach a terminal state after cancellation`);
          return false;
        }
      }
      if (orderIds.size > 0) log(`${sym}: Confirmed ${orderIds.size} contract order(s) terminal before close`);
      return true;
    } catch (e) {
      log(`${sym}: cancelAllOrdersForContract FAILED: ${e}`);
      return false;
    }
  };

  const restoreProtectiveStop = async (quantity = pos.quantity): Promise<boolean> => {
    if (quantity < 1) return true;
    pos.stopOrderId = null;
    pos.targetOrderId = null;
    await savePositions();
    try {
      const accounts = await apiFetch("/account/list") as { id: number; name: string }[];
      const acct = accounts.find(a => a.id === accountId) || accounts[0];
      const restoredOrderId = await submitRecoverableOrder({
        accountSpec: acct.name, accountId,
        action: pos.direction === "long" ? "Sell" : "Buy",
        symbol: pos.contractId, orderQty: quantity, orderType: "Stop",
        stopPrice: roundToTick(sym, pos.stopLoss), timeInForce: "GTC", isAutomated: true,
      }, `${sym} replacement stop`, { kind: "stop", symbol: sym, contractId: pos.contractId });
      // Persist before status checks. If the status API is ambiguous, later close/sync still owns it.
      pos.stopOrderId = restoredOrderId;
      await savePositionsForOrderRecovery();
      const restoredStatus = await protectionOrderStatus(restoredOrderId);
      if (restoredStatus === "unknown") {
        // The order may be working. Persist its id so a later close/sync can cancel and reconcile it;
        // never place a second guessed stop against the same position.
        notify(`🚨 ${MODE_TAG} ${sym}: replacement stop #${restoredOrderId} could not be verified. It remains tracked; check broker now.`, "general");
        return false;
      }
      if (restoredStatus === "rejected" || restoredStatus === "filled") {
        pos.stopOrderId = null;
        await savePositions();
        if (restoredStatus === "filled") {
          const brokerAfterStop = await getBrokerPositionSnapshot(pos.contractId, 3);
          if (brokerAfterStop) {
            pos.direction = brokerAfterStop.netPos > 0 ? "long" : "short";
            pos.quantity = Math.abs(brokerAfterStop.netPos);
            pos.entryPrice = brokerAfterStop.netPrice || pos.entryPrice;
            stopLossIsValidated = false;
            await savePositions();
          } else if (brokerAfterStop === null) {
            await clearPendingOrderSubmission(activePendingOrderSubmission?.clOrdId || "");
          }
        }
        throw new Error(`restored stop #${restoredOrderId} is ${restoredStatus}`);
      }
      await clearPendingOrderSubmission(activePendingOrderSubmission?.clOrdId || "");
      pos.targetOrderId = null;
      await savePositions();
      log(`[CLOSE] ${sym}: restored protective stop #${restoredOrderId} for ${quantity}x after incomplete close.`);
      return true;
    } catch (error) {
      log(`[CLOSE] CRITICAL: ${sym} could not restore protection after incomplete close: ${error}`);
      notify(`🚨 ${MODE_TAG} ${sym}: close incomplete and protective stop restore FAILED. Check broker now.`, "general");
      return false;
    }
  };

  if (positionAlreadyClosed) {
    // Bracket already closed the position — cancel any remaining bracket orders
    if (!await cancelAllOrdersForContract()) {
      log(`[CLOSE] CRITICAL: ${sym} is flat but a sibling/orphan order could not be confirmed canceled; retaining local tracking`);
      notify(`🚨 ${MODE_TAG} ${sym}: position is flat but an order remains unresolved. Check broker orders now.`, "general");
      closingLocks.delete(sym);
      return;
    }
    // A previously-unverified stop can fill while its cancellation is settling. Terminal "Filled"
    // is not the same as harmlessly canceled: when the position was already flat, that late fill
    // creates a reverse position. Recheck after every sibling is terminal before deleting tracking.
    const brokerAfterCancellation = await getBrokerPositionSnapshot(pos.contractId, 3);
    if (brokerAfterCancellation === undefined) {
      log(`[CLOSE] CRITICAL: ${sym} broker state unavailable after terminal cancellation; retaining local tracking`);
      notify(`🚨 ${MODE_TAG} ${sym}: broker state unavailable after bracket cleanup. Tracking retained; check account.`, "general");
      closingLocks.delete(sym);
      return;
    }
    if (brokerAfterCancellation !== null) {
      const reversedDirection = brokerAfterCancellation.netPos > 0 ? "long" : "short";
      log(`[CLOSE] CRITICAL: ${sym} has ${brokerAfterCancellation.netPos} contract(s) after terminal cancellation; flattening the late-fill reversal`);
      notify(`🚨 ${MODE_TAG} ${sym}: a bracket filled during cancellation and created a ${reversedDirection} position. Flattening now.`, "general");
      pos.direction = reversedDirection;
      pos.quantity = Math.abs(brokerAfterCancellation.netPos);
      pos.entryPrice = brokerAfterCancellation.netPrice || price;
      pos.stopOrderId = null;
      pos.targetOrderId = null;
      await savePositions();
      closingLocks.delete(sym);
      await closePosition(sym, pos.entryPrice, "late_bracket_reversal");
      return;
    }
  } else {
    // Position still open — close it manually with retry
    for (let attempt = 1; ; attempt++) {
      try {
        // Resolve account identity before the final broker snapshot so no avoidable network round
        // trip reopens the stop-fill race between "position exists" and close submission.
        let acct: { id: number; name: string };
        if (accountId && accountName) {
          acct = { id: accountId, name: accountName };
        } else {
          const accounts = await apiFetch("/account/list") as { id: number; name: string }[];
          acct = accounts.find(a => a.id === accountId) || accounts[0];
        }
        // Prepare authentication before the final broker snapshot. Close orders, like entries, must
        // not authenticate or rate-limit-retry after their quantity was verified.
        const closeToken = await authenticate();

        // Cancel ALL bracket/working orders for this contract
        if (!await cancelAllOrdersForContract()) {
          log(`[CLOSE] CRITICAL: ${sym} bracket cancellation was not confirmed; no close order submitted`);
          notify(`🚨 ${MODE_TAG} ${sym}: brackets could not be confirmed canceled. No close submitted to prevent reversal.`, "general");
          closingLocks.delete(sym);
          return;
        }

        // Reconcile again AFTER cancellation and immediately before any close order. A stop can fill
        // between the initial snapshot and its cancellation. Sending the old quantity after that
        // race would reverse an already-flat position or over-close a partial remainder.
        const brokerBeforeClose = await getBrokerPositionSnapshot(pos.contractId, 3);
        if (brokerBeforeClose === undefined) {
          log(`[CLOSE] CRITICAL: ${sym} broker state unavailable after bracket cancellation; no close submitted`);
          notify(`🚨 ${MODE_TAG} ${sym}: broker state unavailable after canceling brackets. No order can be sized safely; check account now.`, "general");
          closingLocks.delete(sym);
          return;
        }
        if (brokerBeforeClose === null) {
          log(`[CLOSE] ${sym}: bracket filled during cancellation; broker is flat and no close order is needed.`);
          break;
        }
        const brokerDirection = brokerBeforeClose.netPos > 0 ? "long" : "short";
        if (brokerDirection !== pos.direction) {
          log(`[CLOSE] CRITICAL: ${sym} broker direction is ${brokerDirection}, expected ${pos.direction}; flattening the unintended reversal`);
          pos.direction = brokerDirection;
          pos.quantity = Math.abs(brokerBeforeClose.netPos);
          pos.entryPrice = brokerBeforeClose.netPrice || price;
          stopLossIsValidated = false;
          pos.stopOrderId = null;
          pos.targetOrderId = null;
          await savePositions();
          notify(`🚨 ${MODE_TAG} ${sym}: broker direction changed before close. Flattening the unintended reversal now.`, "general");
        }
        const brokerQty = Math.abs(brokerBeforeClose.netPos);
        if (brokerQty !== pos.quantity) {
          log(`[CLOSE] ${sym}: broker quantity changed ${pos.quantity} → ${brokerQty} before close; using the verified remainder.`);
          pos.quantity = brokerQty;
        }

        const quantityBeforeAttempt = pos.quantity;
        const closeClientOrderId = `FRT-CLOSE-${ENGINE_MODE}-${sym}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        await reservePendingOrderSubmission({
          clOrdId: closeClientOrderId,
          label: `${sym} close`,
          kind: "close",
          symbol: sym,
          contractId: pos.contractId,
          createdAt: new Date().toISOString(),
          phase: "reserved",
          ownerId: ORDER_OWNER_ID,
        });
        const brokerAtSend = await getBrokerPositionSnapshot(pos.contractId, 3);
        if (!brokerAtSend || brokerAtSend.netPos !== brokerBeforeClose.netPos) {
          await updatePendingOrderPhase(closeClientOrderId, "rejected");
          throw new Error(`${sym} broker position changed while close intent was persisted`);
        }
        await updatePendingOrderPhase(closeClientOrderId, "sent");
        const closeResponsePromise = fetch(`${ORDER_API}/order/placeorder`, {
          method: "POST",
          body: JSON.stringify({
            accountSpec: acct.name, accountId, action: pos.direction === "long" ? "Sell" : "Buy",
            symbol: pos.contractId, clOrdId: closeClientOrderId, orderQty: quantityBeforeAttempt,
            orderType: "Market", timeInForce: "Day", isAutomated: true,
          }),
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${closeToken}` },
          signal: AbortSignal.timeout(15_000),
        });
        const closeOrderId = await resolveSubmittedOrder(closeResponsePromise, closeClientOrderId, `${sym} close`);
        closeOrderIds.push(closeOrderId);
        // "The POST returned an id" is NOT a close (2026-08-19). Tradovate answers synchronously
        // and can reject milliseconds later — the entry path already guards for exactly this. If
        // the close was rejected we must NOT fall through: the brackets were cancelled at the top
        // of this attempt, and the caller goes on to positions.delete(sym) + recentlyClosedAt,
        // which blocks re-adoption for 5 minutes. That combination is a real position with no
        // stop, no target and no engine tracking. Treat a rejection as a failed attempt and retry.
        const closeFill = await verifyOrderFill(closeOrderId, quantityBeforeAttempt);
        if (closeFill.status === "rejected") {
          await updatePendingOrderPhase(closeClientOrderId, "rejected");
          throw new Error(`close order rejected: ${closeFill.reason}`);
        }
        if (closeFill.status === "unknown") {
          await cancelOrderUntilTerminal(closeOrderId, `${sym} close`);
        }

        // A fill record is not proof the account is flat. Reconcile after every terminal close so a
        // partial, concurrent add, or accidental reversal can never fall through to tracking deletion.
        const brokerAfterClose = await getBrokerPositionSnapshot(pos.contractId, 5);
        if (brokerAfterClose === undefined) {
          log(`[CLOSE] CRITICAL: ${sym} post-close broker state unresolved. Tracking retained.`);
          notify(`🚨 ${MODE_TAG} ${sym}: close completed but final broker position is unavailable. Check broker now.`, "general");
          closingLocks.delete(sym);
          return;
        }
        if (brokerAfterClose === null) {
          await clearPendingOrderSubmission(closeClientOrderId);
          break;
        }

        const remainingDirection = brokerAfterClose.netPos > 0 ? "long" : "short";
        const remainingQty = Math.abs(brokerAfterClose.netPos);
        if (remainingDirection !== pos.direction) {
          stopLossIsValidated = false;
          log(`[CLOSE] CRITICAL: ${sym} close left an unintended ${remainingDirection} ${remainingQty}x reversal; retrying only to flatten it.`);
          notify(`🚨 ${MODE_TAG} ${sym}: close reversed the position. Retrying to flatten it now.`, "general");
        } else if (remainingQty >= quantityBeforeAttempt) {
          pos.quantity = remainingQty;
          pos.entryPrice = brokerAfterClose.netPrice || pos.entryPrice;
          await savePositionsForOrderRecovery();
          log(`[CLOSE] ${sym}: broker position did not shrink after terminal close; no duplicate close will be sent.`);
          if (stopLossIsValidated) {
            await restoreProtectiveStop(remainingQty);
            closingLocks.delete(sym);
            return;
          }
          throw new Error(`unintended reversal remains ${remainingDirection} ${remainingQty}x`);
        } else {
          log(`[CLOSE] ${sym}: broker confirms partial close ${quantityBeforeAttempt - remainingQty}/${quantityBeforeAttempt}; retrying ${remainingQty}x remainder.`);
        }
        pos.direction = remainingDirection;
        pos.quantity = remainingQty;
        pos.entryPrice = brokerAfterClose.netPrice || pos.entryPrice;
        pos.stopOrderId = null;
        pos.targetOrderId = null;
        await savePositionsForOrderRecovery();
        throw new Error(`broker remainder ${remainingDirection} ${remainingQty}x after close`);
    } catch (err) {
      log(`[CLOSE] Attempt ${attempt} failed for ${sym}: ${err}`);
      if (attempt % 3 === 0) {
        log(`[CLOSE] CRITICAL: Could not close ${sym} after ${attempt} attempts; entries remain blocked and flattening continues`);
        // Persist failed close to database — survives restarts, visible on dashboard
        try {
          await prisma.autoTradeLog.create({ data: {
            symbol: `FUT:${sym}`,
            action: `${TRADE_ACTION_PREFIX}_close_failed`,
            qty: pos.quantity,
            price,
            pnl: 0,
            reason: `CRITICAL: Failed to close ${sym} ${pos.direction} ${pos.quantity}x after ${attempt} attempts. Entry: $${pos.entryPrice.toFixed(2)}. Current: $${price.toFixed(2)}. Automated flattening continues.`,
            orderId: null,
          }});
        } catch {}
        // Notify once per symbol to prevent Slack spam
        if (!stoppedSymbols.has(`close_failed_${sym}`)) {
          stoppedSymbols.add(`close_failed_${sym}`);
          notify(`CRITICAL: Failed to close ${sym} ${pos.direction} ${pos.quantity}x after ${attempt} attempts. New entries are blocked and flattening continues.`, "general");
        }
        const confirmedRemainder = await getBrokerPositionSnapshot(pos.contractId, 3);
        if (confirmedRemainder) {
          const confirmedDirection = confirmedRemainder.netPos > 0 ? "long" : "short";
          if (confirmedDirection !== pos.direction) stopLossIsValidated = false;
          pos.direction = confirmedDirection;
          pos.quantity = Math.abs(confirmedRemainder.netPos);
          pos.entryPrice = confirmedRemainder.netPrice || price;
          pos.stopOrderId = null;
          pos.targetOrderId = null;
          await savePositions();
          if (stopLossIsValidated) {
            const restored = await restoreProtectiveStop(pos.quantity);
            if (!restored) log(`[CLOSE] ${sym}: replacement protection remains unresolved; flattening retries continue`);
            closingLocks.delete(sym);
            return;
          } else {
            notify(`🚨 ${MODE_TAG} ${sym}: unintended reverse position remains. Automated flattening is continuing without submitting new entries.`, "general");
          }
        } else if (confirmedRemainder === null) {
          log(`[CLOSE] ${sym}: broker confirms flat after failed close attempts.`);
          break;
        } else {
          notify(`🚨 ${MODE_TAG} ${sym}: broker state remains unavailable after failed close. Automated reconciliation continues.`, "general");
        }
      }
      await new Promise(r => setTimeout(r, Math.min(10_000, 2000 * attempt)));
      continue;
    }
  } // end retry loop
  } // end else (position still open)

  try {
    // Estimate P&L from Yahoo price for immediate logging (tilt, notifications)
    // REAL P&L comes from Tradovate fills via deferredPnlCheck() — never trust Yahoo for DB/patterns
    const estimatedDiff = pos.direction === "long" ? price - pos.entryPrice : pos.entryPrice - price;
    const estimatedPnl = estimatedDiff * mult * originalQuantity;

    // Tilt tracking uses estimates (needs to be immediate for risk management)
    dailyPnl += estimatedPnl;
    if (reason === "stop_loss" || reason === "emergency") {
      stoppedSymbols.add(sym);
      consecutiveStops++;
      // Re-entry cooldown: block same symbol+direction for 15 min (3 bars)
      const cooldownKey = `${sym}:${pos.direction}`;
      reEntryCooldowns.set(cooldownKey, Date.now() + 15 * 60_000);
      log(`[COOLDOWN] ${cooldownKey} blocked for 15min (re-entry cooldown after stop)`);

      // Demo (paper): no tilt pause — let the engine press through variance and accumulate data.
      // Auto-prune disables truly broken setupTypes mechanically, so tilt protection is redundant
      // for paper testing. Live keeps full tilt protection (real money discipline).
      const pauseSchedule = USES_LIVE_POLICY ? [0, 0, 30, 60, 120] : [0, 0, 0, 0, 0];
      const pauseMin = USES_LIVE_POLICY
        ? (consecutiveStops >= 5 ? Infinity : (pauseSchedule[consecutiveStops] || 0))
        : 0;

      if (pauseMin > 0) {
        tiltPauseUntil = pauseMin === Infinity ? Infinity : Date.now() + pauseMin * 60_000;
        const label = pauseMin === Infinity ? "rest of session" : `${pauseMin} min`;
        log(`[TILT] Level ${consecutiveStops - 1}: ${consecutiveStops} consecutive stops — pausing ${label}`);
        notify(`TILT L${consecutiveStops - 1}: ${consecutiveStops} stops → pausing ${label}. Daily P&L: $${dailyPnl.toFixed(0)} (est)`, "general");
      }
    } else {
      consecutiveStops = 0;
    }
    log(`CLOSED ${sym}: ${reason} | Est P&L: $${estimatedPnl.toFixed(0)} (mark) | Daily: $${dailyPnl.toFixed(0)} | Fill P&L pending...`);
    // Do NOT broadcast the Yahoo estimate (it can be wildly wrong on fast/emergency closes — e.g. a
    // phantom -$17,200 vs a real -$9,325). Announce the close; deferredPnlCheck() posts the ACTUAL fill P&L.
    feedLog("exit", `**${MODE_TAG} CLOSED ${sym}** ${reason} — confirming actual fill, P&L posting…`);
    notify(`CLOSED ${sym}: ${reason} — confirming actual fill, P&L posting shortly…`);

    // Log close to database with pnl: null — real P&L set by deferredPnlCheck()
    // NEVER use Yahoo price for DB P&L. The deferred check gets the actual Tradovate fill.
    let dbLogId: number | null = null;
    try {
      const dbLog = await prisma.autoTradeLog.create({ data: {
        symbol: `FUT:${sym}`,
        action: `${TRADE_ACTION_PREFIX}_${reason}`,
        qty: originalQuantity,
        price, // Yahoo price as reference (fillPrice will have the real one)
        pnl: null, // DEFERRED — filled by deferredPnlCheck() from actual Tradovate fill
        originalPnl: estimatedPnl, // Save Yahoo estimate for audit/comparison
        reason: `[FUTURES ${sym}] ${reason}: Closed ${originalQuantity}x. Entry: $${pos.entryPrice.toFixed(2)}. Est: $${estimatedPnl.toFixed(0)} (fill pending)`,
        orderId: closeOrderIds.length ? String(closeOrderIds.at(-1)) : null,
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
      quantity: originalQuantity,
      contractId: pos.contractId,
      closeOrderIds,
      reason,
      mult,
      estimatedPnl,
      entrySession: pos.entrySession || getSessionName(),
      entryRsi: pos.entryRsi || 50,
      entryVwap: pos.entryVwap,
      entryTrend15m: pos.entryTrend15m || "flat",
      entryDayType: pos.entryDayType || "unknown",
      entrySetupType: pos.entrySetupType || "unknown",
      // Fall back to the live stop only for positions predating this field (restored from JSON).
      entryStopLoss: pos.entryStopLoss || pos.stopLoss,
    };
    // First check after 15s, retry at 60s if no fill yet
    setTimeout(() => deferredPnlCheck(closeMeta, 1), 15_000);

    // Pattern memory is NOT stored here — deferredPnlCheck() stores it with real P&L

    // Vault journal + pattern memory logged by deferredPnlCheck() with REAL fill P&L

    positions.delete(sym);
    syncMissCount.delete(sym); // clear reconcile miss-counter when a position leaves the book
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
  patternStats?: { matchCount: number; winRate: number; avgR: number } | null;
}): Promise<{ agree: boolean; confidence: number; reasoning: string; aiDown?: boolean }> {
  try {
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) return { agree: true, confidence: 0, reasoning: "AI unavailable", aiDown: true };

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

    // 2026-05-29: Data-driven grader. Live no longer reflexively conservative;
    // empirical historical performance from pattern memory carries the decision.
    // The account size is READ, never hardcoded. This string said "the LIVE $1K account" for five
    // weeks after the account was funded to ~$4,821 — so on every grade the model was reasoning about
    // risk, sizing and survivability against an account 4.7x smaller than the real one, which biases
    // it toward reflexive caution on exactly the trades this context was added to stop it fearing.
    const liveContext = IS_LIVE
      ? `\nThis is the LIVE account, currently $${Math.round(riskSizingEquity() || 0).toLocaleString()}, risking ${riskConfig.riskPerTradePct}% per trade. Be empirically grounded. Trust historical pattern data over subjective intuition. If the data says a setup works, take it.\n`
      : "";

    // Pattern-memory empirical evidence block — 2026-06-03: thresholds raised because 10 trades
    // is variance, not signal. Only treat the data as authoritative at 25+ matching trades.
    const ps = setup.patternStats;
    const patternBlock = ps && ps.matchCount >= 25
      ? `\n📊 EMPIRICAL EVIDENCE (from ${ps.matchCount} matching historical trades — THIS DOMINATES):
   Historical win rate: ${(ps.winRate * 100).toFixed(0)}%
   Average R-multiple: ${ps.avgR.toFixed(2)}R

   DECISION RULE (apply first, before reasoning):
   - WR ≥ 50% → APPROVE. The data says this works. Don't second-guess.
   - WR ≤ 25% → REJECT. The data says this loses.
   - WR 25-50% → DEFAULT TO APPROVE if pre-AI confidence > 58%. A counter-bias direction or an
     avoid-list setup type is a STRONG negative — drop conviction one grade so it sizes smaller —
     but is NOT by itself a reason to reject. Only hard-REJECT when it ALSO carries WR ≤ 30%,
     negative/impossible R:R, or an active anti-pattern. We want to fire a bit more and let the
     stop-loss + auto-prune cull whatever doesn't earn its keep (2026-06-16: loosened a notch).\n`
      : ps && ps.matchCount >= 10
      ? `\n📊 Early pattern signal: ${ps.matchCount} matching trades (need 25+ for the hard rule), current WR ${(ps.winRate * 100).toFixed(0)}%, avg R ${ps.avgR.toFixed(2)}. This is informative but NOT authoritative — variance dominates at this sample size. **Default to APPROVE on pre-AI confidence > 60%** unless WR is catastrophically low (under 15%) AND avg R is negative.\n`
      : ps && ps.matchCount > 0
      ? `\n📊 Sparse history: only ${ps.matchCount} matching trades. Use reasoning. **Default to APPROVE if pre-AI confidence > 60%** — we need to fire to populate the data.\n`
      : `\n📊 No matching historical pattern yet (cold-start). **Default to APPROVE on pre-AI confidence > 60%** — we need data to populate.\n`;

    // Inject daily plan context from Fable 5 advisor (if available)
    let planCtx = "";
    try { planCtx = await getPlanContextForGrading(setup.sym); } catch { /* plan optional */ }

    const prompt = `You are a DATA-DRIVEN futures trader. Empirical historical performance is your primary signal. Subjective reasoning is secondary.
${liveContext}
${patternBlock}
${planCtx}
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
DEFAULT TO APPROVE unless:
- Pattern data clearly says this loses (WR < 30%), OR
- Macro event in next 5 min creates directional uncertainty, OR
- Matches a confirmed anti-pattern, OR
- R:R < 1.5:1

Reasoning is a tiebreaker, NOT the primary filter. We want to TRADE and gather data to feed the learning loop.

Reason carefully on BORDERLINE grades — mixed pattern history (WR 30-55%), conflicting signals, or a setup that conflicts with today's plan. Be decisive on clear-cut cases (obvious approve with WR > 55%; obvious reject with WR < 30%, confirmed anti-pattern, or avoid-list setup).

Respond ONLY with JSON: {"agree":true/false,"confidence":75,"reasoning":"one sentence citing data or specific block reason"}`;

    // GRADER MODEL CHAIN (resilience): ALL grading — demo + live, every setup — uses OPUS 4.8 DIRECTLY,
    // the strongest judge. The daily-plan/avoid-list context is already in the prompt (planCtx above),
    // so Opus needs no advisor-tool round-trip — one fast call vs the old Sonnet-4.6+Opus-advisor flow
    // that timed out at 90s and skipped live. (Was Sonnet for clear-cut demo calls; unified to Opus for
    // consistent top-quality grading + a cleaner learning signal — demo is paper, so the modest extra
    // token cost is worth it.) On UNAVAILABLE or TIMEOUT, fall through to the fast Haiku fallback so a
    // verdict is still produced; only if EVERY model fails does it return aiDown (LIVE pauses, demo keeps
    // trading). Tried fresh every call → auto-recovers the instant a model responds.
    const graderChain: { model: string; advisor: boolean; timeoutMs: number }[] =
      [{ model: "claude-opus-5", advisor: false, timeoutMs: 60000 }, { model: "claude-haiku-4-5", advisor: false, timeoutMs: 30000 }];

    let anyUnavailable = false;
    let lastDetail = "";
    for (let i = 0; i < graderChain.length; i++) {
      const att = graderChain[i];
      const isLast = i === graderChain.length - 1;
      try {
        const res = await fetch("https://api.anthropic.com/v1/messages", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "x-api-key": apiKey,
            "anthropic-version": "2023-06-01",
            ...(att.advisor ? { "anthropic-beta": "advisor-tool-2026-03-01" } : {}),
          },
          body: JSON.stringify({
            model: att.model,
            max_tokens: 1024,                // room for advisor flow text
            ...(att.advisor ? { tools: [{ type: "advisor_20260301", name: "advisor", model: "claude-opus-5" }] } : {}),
            messages: [{ role: "user", content: prompt }],
          }),
          // Opus-direct grading is a single short call (~10-40s); 60s gives headroom. Haiku 30s.
          // A timeout now falls through to the next (faster) model rather than skipping live.
          signal: AbortSignal.timeout(att.timeoutMs),
        });

        if (!res.ok) {
          const errBody = await res.text().catch(() => "");
          anyUnavailable = true;
          lastDetail = String(res.status);
          log(`[AI] model "${att.model}"${att.advisor ? "+advisor" : ""} failed (${res.status})${isLast ? "" : " — trying next model"}: ${errBody.slice(0, 160)}`);
          continue; // unavailability is a fast failure → fall through to the next model
        }

        const data = await res.json() as {
          content: { type: string; text?: string; name?: string; content?: { type: string; text?: string } }[];
        };
        // With advisor tool, response may include server_tool_use + advisor_tool_result blocks.
        // Extract the LAST text block which contains the final JSON grade.
        const textBlocks = data.content?.filter(b => b.type === "text" && b.text) || [];
        const advisorUsed = data.content?.some(b => b.type === "server_tool_use" && b.name === "advisor");
        const text = textBlocks.length > 0 ? textBlocks[textBlocks.length - 1].text! : "";
        if (advisorUsed) log(`  [AI] Advisor tool consulted (Opus 4.8)`);
        if (i > 0) log(`  [AI] primary grader unavailable — graded by fallback "${att.model}"`);
        // Handle Claude sometimes wrapping JSON in markdown code blocks
        let jsonText = text.trim();
        const jsonMatch = jsonText.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/);
        if (jsonMatch) jsonText = jsonMatch[1].trim();
        const parsed = JSON.parse(jsonText);
        return { agree: !!parsed.agree, confidence: parsed.confidence || 50, reasoning: parsed.reasoning || "" };
      } catch (err) {
        const isTimeout = err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError");
        const msg = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
        if (isTimeout) {
          // Slow model. Fall through to the faster fallback so live still gets a verdict (90s worst-case
          // total is well within the 5-min bar). Only if the LAST model also times out do we surface
          // aiDown → LIVE skips (never trade real money on a missing verdict); demo ignores aiDown and
          // still trades. Auto-recovers next setup.
          anyUnavailable = true;
          lastDetail = `timeout(${att.model})`;
          log(`[AI] grader timeout on "${att.model}"${isLast ? " — no verdict; live will skip, demo proceeds" : " — trying faster fallback"}`);
          if (isLast) return { agree: true, confidence: 0, reasoning: "AI timeout (all models)", aiDown: true };
          continue;
        }
        // Network/parse error → treat as unavailable and try the next model.
        anyUnavailable = true;
        lastDetail = msg.slice(0, 80);
        log(`[AI] model "${att.model}" error${isLast ? "" : " — trying next model"}: ${lastDetail}`);
        continue;
      }
    }

    // Whole chain exhausted without producing a grade.
    log(`[AI] all grader models unavailable (${lastDetail})`);
    return { agree: true, confidence: 0, reasoning: `AI unavailable: ${lastDetail}`, aiDown: anyUnavailable };
  } catch (err) {
    const msg = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
    log(`[AI] ERROR — ${msg}`);
    // Unexpected error (not a model availability failure): degrade to approve as before.
    return { agree: true, confidence: 0, reasoning: `AI error: ${msg.slice(0, 80)}`, aiDown: false };
  }
}

// ── Confidence Scoring ──────────────────────────────────


/** Vault anti-pattern gate, extracted from onBarClose so blocks are RECORDED (2026-08-11). Returns
 *  the block reason or null. Same thresholds: session <30% WR blocks, instrument <25% blocks. */
function vaultBlockReason(sym: string, session: string): string | null {
  if (!vaultLessonsCache?.antiPatterns) return null;
  const ap = vaultLessonsCache.antiPatterns.toLowerCase();
  for (const rule of VAULT_SESSION_RULES) {
    if (!ap.includes(rule.pattern)) continue;
    if (!rule.sessions.includes(session)) continue;
    const wrMatch = ap.match(new RegExp(`${rule.pattern}[^\\n]*?(\\d+)%\\s*win\\s*rate`));
    const winRate = wrMatch ? parseInt(wrMatch[1]) : null;
    if (winRate !== null && winRate < 30) return `vault anti-pattern: ${rule.label} has ${winRate}% win rate`;
  }
  const instMatch = ap.match(new RegExp(`${sym.toLowerCase()}[^\\n]*?(\\d+)%\\s*win\\s*rate`));
  if (instMatch && parseInt(instMatch[1]) < 25) return `vault anti-pattern: ${sym} has ${instMatch[1]}% win rate`;
  return null;
}

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

async function onBarClose(sym: string, bar: Bar) {
  if (!SYMBOLS.includes(sym)) return;   // PHASE 0: only evaluate/trade whitelisted symbols (e.g. MES-only live)

  // CONTINUOUS RECONCILIATION (Jul 17 fix): reconcile tracked positions against the broker every ~cycle
  // (throttled), not just at startup. This is what prevents an orphaned bracket leg from filling hours after
  // its partner closed the position — syncPositions detects the close within a bar and cancels the orphan.
  if (positions.size > 0 && Date.now() - lastSyncTs > 25_000) {
    lastSyncTs = Date.now();
    await syncPositions().catch((e) => log(`[RECONCILE] periodic syncPositions failed: ${e}`));
  }

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
  // VAULT GATE MOVED (2026-08-11): it used to fire HERE, before setup detection — a blind early
  // return that produced NO decision record and NO shadow row. That made it the only gate in the
  // system whose cost is unmeasured, on the least-trusted data source (vault-era stats the clean
  // ledger cannot verify: zero midday round-trips exist BECAUSE the gate blocks them — frozen,
  // self-preserving evidence). Behavior is unchanged, but the check now runs in the entry path via
  // vaultBlockReason(), where the blocked SETUP exists and is recorded + shadow-tracked — so the
  // promotion radar can finally catch a wrong vault block. See vaultBlockReason().

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
  // 200-EMA = higher-timeframe TREND REGIME. The index trend-continuation LONG only holds when price is
  // ABOVE it (confirmed uptrend). 4.5-yr backtest incl. the 2022 bear: filtered long PF 1.22 (+both halves,
  // NQ 1.24 / ES 1.18); the SAME long BELOW the 200-EMA loses (PF 0.55 OOS). The filter IS the edge.
  const ema200arr = closes.length >= 200 ? ema(closes, 200) : [];
  // Fallback to Infinity (NOT slowEMA) when <200 bars: the trend-long uses `price > ema200`, so Infinity
  // BLOCKS the long during warmup (~first 2.5 sessions after a restart) rather than letting an un-validated
  // long through — the backtest that validated it always had a real 200-EMA. Only the long reads ema200.
  const ema200 = ema200arr.length ? ema200arr[ema200arr.length - 1] : Infinity;
  // VWAP ANCHOR (fixed 2026-08-19). sessionBars accumulate from the 02:00 ET accounting roll, so
  // during RTH the "session VWAP" every setup reads was polluted with ~7.5h of Asia/Europe/pre-market
  // volume — not the institutional 09:30-anchored VWAP the strategies were written against. Opening
  // Range got this clock-gating fix on 2026-08-02; VWAP was missed. Once RTH has begun we anchor at
  // 09:30 ET; overnight sessions (London gold) legitimately keep the accounting-day anchor since
  // there is no RTH open to anchor to yet. Falls back to the old behaviour in the first ~15 minutes
  // after the open, when too few RTH bars exist to form a meaningful VWAP.
  const rthVwapBars = getETHour() >= 9.5
    ? b.sessionBars.filter(x => etHourOf(x.t * 1000) >= 9.5 && etAccountingDay(x.t * 1000) === etAccountingDay(Date.now()))
    : [];
  const vwapSource = rthVwapBars.length >= 3 ? rthVwapBars : b.sessionBars;
  const vwapData = vwapSource.length >= 3 ? calcVwap(vwapSource) : calcVwap(bars.slice(-78));

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

  // ── PLAN SNAPSHOT (2026-07-29) ───────────────────────────────────────────────────────────────
  // Publish what THIS engine currently sees, so the admin panel can show "what will it do today"
  // without recomputing anything. The panel must never re-derive ATR/RSI/size in the web app: a
  // second copy of this maths would drift from the engine and quietly start lying, which is the
  // exact failure this codebase keeps hitting. Engine computes, panel renders. Telemetry only —
  // nothing here feeds a trading decision.
  // TRY/CATCH IS LOAD-BEARING: this block sits UPSTREAM of setup detection in onBarClose, and
  // onBarClose is called un-awaited from onPrice. A throw here would abort the rest of the function
  // — i.e. silently skip every setup on this bar — and surface only as one [FATAL] line from the
  // global unhandledRejection handler. Telemetry must never be able to stop the engine trading.
  try {
    planSnapshots.set(sym, {
      price, atr: currentATR, rsi: currentRSI,
      ema9DistPct: fastEMA > 0 ? Math.abs(price - fastEMA) / price * 100 : null,
      above200: Number.isFinite(ema200) ? price > ema200 : null,
      trend15: tf15.trend, dayType, bars: b.bars5m.length,
      // Size the engine WOULD take if a setup fired on this bar, using the same inputs the sizer uses.
      plannedQty: plannedQtyFor(sym, adjustedATR, session, effectiveSizeMult),
      quoteAgeSec: Math.round((Date.now() - (lastReliableAt.get(sym) ?? 0)) / 1000),
      quarantine: quarantineBars.get(sym) ?? 0,
      at: Date.now(),
    });
  } catch { /* telemetry only — never let it touch the trading path */ }
  feedLog("scan", `**${sym}** $${price.toFixed(2)} | RSI ${currentRSI.toFixed(0)} | ${tf15.trend} | ${dayType} | ${session}`);

  // ── REGISTRY STRATEGIES (Tier 1/2 validated edges from /lib/strategies) ──
  // Crypto futures (MBT/MET/BFF/MXR/MSL) ARE the registry's exclusive domain — the 5m equity-index
  // setups catastrophically lose on them per backtest (MET PF 0.06, BFF PF 0.27). So registry-only
  // symbols return after the registry pass even if no signal fired.
  try {
    const { strategiesFor, isRegistryOnlySymbol } = await import("../lib/strategies/registry");
    const registered = strategiesFor(sym);
    if (registered.length > 0 && IS_DEMO && !DEMO_LIVE_CLONE) {  // separate research demo only
      const { runStrategy, buildTodayDailyBar } = await import("../lib/strategy-runner");
      const today = buildTodayDailyBar(b.bars5m, Date.now());
      for (const strat of registered) {
        const sig = await runStrategy(strat, today, sym, Date.now());
        if (!sig) continue;
        const stopDist = Math.abs(sig.entryPrice - sig.stopPrice);
        const targetDist = Math.abs(sig.targetPrice - sig.entryPrice);
        if (stopDist <= 0 || targetDist <= 0) continue;
        log(`  → ${sig.setupName.toUpperCase()} ${sig.direction.toUpperCase()} | strategy:${sig.strategyId} | entry:${sig.entryPrice.toFixed(2)} stop:${sig.stopPrice.toFixed(2)} target:${sig.targetPrice.toFixed(2)} | ${sig.reason}`);
        evaluateAndTrade(sym, sig.direction, sig.entryPrice, stopDist, targetDist, effectiveSizeMult, sig.confidence ?? 75,
          sig.reason, currentRSI, currentATR, vwapData.vwap, dayType, session, tf15.trend, b.prevDayHigh, b.prevDayLow,
          sig.strategyId);
        return;
      }
    }
    if (isRegistryOnlySymbol(sym)) {
      // Registry symbols don't fall through to 5m setups (proven failures on these instruments).
      return;
    }
  } catch (err) {
    log(`  [REGISTRY] ${sym} skipped: ${err instanceof Error ? err.message : err}`);
  }

  // ── EVALUATE ALL SETUPS WITH CONFIDENCE SCORING ──

  // Track near-misses for logging
  let bestNearMiss = "";

  // SETUP 0: Extreme RSI Bounce (any day type, any tradeable session)
  // When RSI is deeply oversold (<25) or overbought (>75), a bounce/reversal is likely
  // even on trend days. These are high-probability mean reversion trades.
  if (currentRSI < 25 || currentRSI > 75) {
    const isOversold = currentRSI < 25;
    const dir = isOversold ? "long" : "short";
    // Target 3.5 ATR vs 1.5 ATR stop = 2.33:1 R:R — clears the engine's hard 2.0 R:R gate (line ~3178)
    // AND is the exact config the backtest validated for gold (RSI-bounce PF 1.25 OOS). Win rate on this
    // setup is ~37% but winners are ~2.3x losers, so it nets positive. The improved trailing stop (1.1R)
    // banks gains on pullbacks BEFORE the far target, which lifts the effective win rate without a closer
    // target (a closer 1:1 target would fail the R:R gate and block every gold trade — verified in review).
    // BOTH legs scale with VIX (fixed 2026-08-19). The stop used `adjustedATR` (= currentATR ×
    // vix.stopMult) while the target used the RAW currentATR, so the R:R silently collapsed exactly
    // when volatility rose: at VIX>25 (stopMult 1.5) R:R = 3.5/2.25 = 1.56, and at VIX>30
    // (stopMult 2.0) it is 3.5/3.0 = 1.17 — both BELOW the hard rr<2.0 gate in executeTrade, which
    // silently returns. Since gold_long_europe and gold_short (two of the three live edges) are both
    // this setup, the live book switched itself off in every high-vol regime — after already paying
    // for the pattern-memory lookup and, when enabled, a ~9s grader round trip. Scaling both legs
    // keeps the ratio at the validated 2.33 in every regime while the wider stop still absorbs the
    // extra volatility (position size shrinks via vix.sizeMult, which is the intended defence).
    const targetDist = adjustedATR * 3.5;
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
          currentRSI, currentATR, vwapData.vwap, dayType, session, tf15.trend, b.prevDayHigh, b.prevDayLow,
          "extreme_rsi_bounce");
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
            currentRSI, currentATR, vwapData.vwap, dayType, session, tf15.trend, b.prevDayHigh, b.prevDayLow,
            "gap_fill");
        }
        return;
      }
    }
  }

  // SETUP 1: Opening Range (IB) Breakout (trend days, morning/COMEX open, after IB complete)
  const isMorningSession = session === "morning" || (METALS.has(sym) && sizeMult >= 0.7);
  if (dayType === "trend" && isMorningSession && b.orBarCount >= 12 && b.openingRangeHigh > 0 && orSize > currentATR * 0.3) {
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
          currentRSI, currentATR, vwapData.vwap, dayType, session, tf15.trend, b.prevDayHigh, b.prevDayLow,
          "or_breakout");
      }
      return;
    }
  }

  // SETUP: FAILED IB BREAKOUT (fade the failure — high edge reversal)
  if (b.orBarCount >= 12 && b.openingRangeHigh > 0 && (session === "morning" || session === "midday" || session === "afternoon")) {
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
            currentRSI, currentATR, vwapData.vwap, dayType, session, tf15.trend, b.prevDayHigh, b.prevDayLow,
            "failed_ib_breakout");
        }
        return;
      }
    }
  }

  // SETUP: IB EXTENSION (after first hour, price breaks IB range → target 1.5x extension)
  // Statistical tendency: 80%+ chance of reaching 1.5x IB extension on trend days
  if (b.orBarCount >= 12 && b.barCount <= 36 && b.openingRangeHigh > 0 && orSize > currentATR * 0.4 &&
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
            currentRSI, currentATR, vwapData.vwap, dayType, session, tf15.trend, b.prevDayHigh, b.prevDayLow,
            "ib_extension");
        }
        return;
      }
    }
  }

  // SETUP 2: Trend Continuation (pullback to EMA9) — RTH only
  // 2026-05-25: raw-backtest PF 0.91 → disabled. 2026-05-29: re-enabled on BOTH demo and live.
  // The data-driven AI grader (pattern-memory WR + R-multiple) is now the empirical filter
  // that the raw backtest didn't have — it rejects sub-30% WR setups and approves the rest.
  // Trend days are the bulk of profitable days; without this setup the engine sits idle.
  const TREND_CONTINUATION_ENABLED = true;
  if (TREND_CONTINUATION_ENABLED && (dayType === "trend" || Math.abs(fastEMA - slowEMA) / price > 0.001) &&
      (session === "morning" || session === "afternoon")) {
    const nearEMA = Math.abs(price - fastEMA) / price < 0.003;
    // LONG also requires price ABOVE the 200-EMA (uptrend regime) — the validated "be smart about WHEN" filter.
    const isLong = nearEMA && fastEMA > slowEMA && price > slowEMA && price > ema200 && currentRSI > 35 && currentRSI < 65 && volTrend !== "surge";
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
          currentRSI, currentATR, vwapData.vwap, dayType, session, tf15.trend, b.prevDayHigh, b.prevDayLow,
          "trend_continuation");
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
            currentRSI, currentATR, vwapData.vwap, dayType, session, tf15.trend, b.prevDayHigh, b.prevDayLow,
            "vwap_bounce");
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
            currentRSI, currentATR, vwapData.vwap, dayType, session, tf15.trend, b.prevDayHigh, b.prevDayLow,
            "vwap_bounce");
        }
        return;
      }
    }
  }

  // SETUP 4.5: VWAP Reclaim — price was on one side of VWAP for most of session, then closes back through.
  // Strong continuation signal: institutions defending the level. Enter in direction of reclaim.
  // Works on TREND days; "reclaim" = breaking back through VWAP after a sustained one-sided session.
  if (vwapData.vwap > 0 && b.sessionBars.length >= 12) {
    const RECLAIM_LOOKBACK = 6;  // last 30 min of 5m bars
    const recent = b.sessionBars.slice(-RECLAIM_LOOKBACK - 1, -1);  // exclude current bar
    if (recent.length === RECLAIM_LOOKBACK) {
      const aboveCount = recent.filter((br) => br.c > vwapData.vwap).length;
      const belowCount = recent.filter((br) => br.c < vwapData.vwap).length;
      const wasAllAbove = aboveCount >= RECLAIM_LOOKBACK - 1;  // 5 of 6 bars above
      const wasAllBelow = belowCount >= RECLAIM_LOOKBACK - 1;
      const closedBelow = bar.c < vwapData.vwap;
      const closedAbove = bar.c > vwapData.vwap;
      const distFromVwap = Math.abs(bar.c - vwapData.vwap) / vwapData.vwap;

      // Short reclaim: was above all session, now closed below → expect continuation lower
      if (wasAllAbove && closedBelow && distFromVwap < 0.003 && tf15.trend !== "up" && currentRSI < 60) {
        const dir = "short";
        const { score, reasons } = scoreSetup({
          baseConfidence: 73,
          volTrend, volRatio,
          trend15Aligns: tf15.trend === "down",
          rsiExtreme: false,
          priceAboveVWAP: false,
          dayTypeMatch: dayType === "trend",
          sessionQuality,
        });
        log(`  → VWAP RECLAIM SHORT | VWAP:$${vwapData.vwap.toFixed(2)} | Closed below after ${aboveCount}/${RECLAIM_LOOKBACK} above | Confidence: ${score}% | ${reasons.join(", ")}`);
        if (score >= 72) {
          evaluateAndTrade(sym, dir, price, adjustedATR * 1.3, adjustedATR * 3.5, effectiveSizeMult, score,
            `VWAP reclaim ${dir}: ${aboveCount}/${RECLAIM_LOOKBACK} bars above VWAP $${vwapData.vwap.toFixed(2)}, now broken below, 15m ${tf15.trend}, conf ${score}%`,
            currentRSI, currentATR, vwapData.vwap, dayType, session, tf15.trend, b.prevDayHigh, b.prevDayLow,
            "vwap_reclaim");
        }
        return;
      }
      // Long reclaim: was below all session, now closed above → expect continuation higher
      if (wasAllBelow && closedAbove && distFromVwap < 0.003 && tf15.trend !== "down" && currentRSI > 40) {
        const dir = "long";
        const { score, reasons } = scoreSetup({
          baseConfidence: 73,
          volTrend, volRatio,
          trend15Aligns: tf15.trend === "up",
          rsiExtreme: false,
          priceAboveVWAP: true,
          dayTypeMatch: dayType === "trend",
          sessionQuality,
        });
        log(`  → VWAP RECLAIM LONG | VWAP:$${vwapData.vwap.toFixed(2)} | Closed above after ${belowCount}/${RECLAIM_LOOKBACK} below | Confidence: ${score}% | ${reasons.join(", ")}`);
        if (score >= 72) {
          evaluateAndTrade(sym, dir, price, adjustedATR * 1.3, adjustedATR * 3.5, effectiveSizeMult, score,
            `VWAP reclaim ${dir}: ${belowCount}/${RECLAIM_LOOKBACK} bars below VWAP $${vwapData.vwap.toFixed(2)}, now broken above, 15m ${tf15.trend}, conf ${score}%`,
            currentRSI, currentATR, vwapData.vwap, dayType, session, tf15.trend, b.prevDayHigh, b.prevDayLow,
            "vwap_reclaim");
        }
        return;
      }
    }
  }

  // SETUP 5: Range Bounce — mean reversion at prev day high/low or session extremes
  // Works in CHOPPY/RANGE markets where price oscillates between levels
  if (dayType === "range" && b.orBarCount >= 12 && b.prevDayHigh > 0 && b.prevDayLow > 0) {
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
              currentRSI, currentATR, vwapData.vwap, dayType, session, tf15.trend, b.prevDayHigh, b.prevDayLow,
              "range_bounce");
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

// Confirm a just-placed order is actually LIVE at the broker, not rejected. CRITICAL: Tradovate's
// /order/placeorder returns an orderId synchronously, then validates the order and may REJECT it a
// moment later (e.g. illegal price, margin). Without this check the engine trusts the returned id and
// believes a stop is protecting the position when nothing is — the exact failure that left a gold
// position naked for 39 min. Polls briefly; fail-OPEN on uncertainty (don't flatten a possibly-good
// stop over an API hiccup) — the price-rounding fix is what prevents rejection in the first place.
async function protectionOrderStatus(orderId: number): Promise<"active" | "filled" | "rejected" | "unknown"> {
  for (let i = 0; i < 3; i++) {
    await new Promise((r) => setTimeout(r, i === 0 ? 600 : 500));
    try {
      const o = (await apiFetch(`/order/item?id=${orderId}`)) as { ordStatus?: string };
      if (o?.ordStatus === "Rejected" || o?.ordStatus === "Canceled" || o?.ordStatus === "Expired") return "rejected";
      if (o?.ordStatus === "Working" || o?.ordStatus === "Accepted") return "active";
      if (o?.ordStatus === "Filled") return "filled";
    } catch { /* keep polling */ }
  }
  return "unknown";
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
        // PARTIAL. Normally we keep polling to let the remainder fill — but if the order is already
        // in a terminal state the remainder is never coming, and every extra poll is ~900ms holding
        // a REAL position with no protective stop behind it. Return what we actually hold instead;
        // the caller sizes the stop/target to this qty. Matters most for IOC entries, which cancel
        // their unfilled remainder by design, but a terminal status is conclusive for any order type.
        try {
          const ord = (await apiFetch(`/order/item?id=${orderId}`)) as { ordStatus?: string };
          if (ord?.ordStatus === "Canceled" || ord?.ordStatus === "Rejected" || ord?.ordStatus === "Expired" || ord?.ordStatus === "Filled") {
            return { status: "filled", price: lastVwap, qty: q };
          }
        } catch { /* status unknown — fall through and keep polling, the old behaviour */ }
      } else {
        const ord = (await apiFetch(`/order/item?id=${orderId}`)) as { ordStatus?: string };
        if (ord?.ordStatus === "Rejected" || ord?.ordStatus === "Canceled" || ord?.ordStatus === "Expired") {
          return { status: "rejected", reason: ord.ordStatus };
        }
      }
    } catch { /* transient API error — keep polling, resolve as unknown */ }
  }
  // A partial fill with non-terminal order state is unresolved. Returning it as filled would let the
  // caller bracket only the observed quantity while the working remainder can fill later. The caller
  // must cancel the order, wait for terminal state, then reconcile the final broker position.
  return { status: "unknown" };
}

async function cancelOrderAndWaitForTerminal(orderId: number): Promise<boolean> {
  try {
    await apiFetch("/order/cancelorder", { method: "POST", body: JSON.stringify({ orderId }) });
  } catch { /* the order may already be terminal */ }
  for (let attempt = 0; attempt < 8; attempt++) {
    await new Promise((resolve) => setTimeout(resolve, 500));
    try {
      const order = await apiFetch(`/order/item?id=${orderId}`) as { ordStatus?: string };
      if (["Filled", "Canceled", "Rejected", "Expired"].includes(order.ordStatus || "")) return true;
    } catch { /* keep polling */ }
  }
  return false;
}

async function cancelOrderUntilTerminal(orderId: number, label: string): Promise<void> {
  let alerted = false;
  while (!await cancelOrderAndWaitForTerminal(orderId)) {
    if (!alerted) {
      alerted = true;
      notify(`🚨 ${MODE_TAG} ${label}: order #${orderId} is still indeterminate. New action is blocked until broker confirms terminal.`, "general");
    }
    log(`[ORDER RECOVERY] ${label}: order #${orderId} still nonterminal; retrying cancellation without submitting another order`);
    await new Promise((resolve) => setTimeout(resolve, 2_000));
  }
}

async function findOrderIdByClientId(clOrdId: string, attempts = 6): Promise<number | null> {
  for (let attempt = 0; attempt < attempts; attempt++) {
    if (attempt > 0) await new Promise((resolve) => setTimeout(resolve, 750));
    try {
      const orders = await apiFetch("/order/list") as { id: number; clOrdId?: string }[];
      const match = orders.find((order) => order.clOrdId === clOrdId);
      if (match?.id) return match.id;
    } catch { /* keep polling; an accepted order can appear after the client lost its response */ }
  }
  return null;
}

class DefinitiveOrderSubmissionError extends Error {}

async function reservePendingOrderSubmission(pending: PendingOrderSubmission): Promise<void> {
  if (pendingOrderReservationInFlight || (activePendingOrderSubmission
    && activePendingOrderSubmission.clOrdId !== pending.clOrdId
    && activePendingOrderSubmission.symbol !== pending.symbol)) {
    throw new Error(`order submission blocked by ${activePendingOrderSubmission?.label || "another order reservation"}`);
  }
  pendingOrderReservationInFlight = true;
  try {
    await prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT 1 AS locked FROM pg_advisory_xact_lock(hashtext(${PENDING_ORDER_KEY}))`;
      const row = await tx.agentConfig.findUnique({ where: { key: PENDING_ORDER_KEY } });
      if (row?.value) {
        const existing = JSON.parse(row.value) as PendingOrderSubmission;
        const replaceOwnedSymbol = existing.ownerId === ORDER_OWNER_ID && existing.symbol === pending.symbol;
        if (existing.clOrdId !== pending.clOrdId && !replaceOwnedSymbol) {
          throw new Error(`durable order submission blocked by ${existing.label} owned by ${existing.ownerId}`);
        }
      }
      await tx.agentConfig.upsert({
        where: { key: PENDING_ORDER_KEY },
        update: { value: JSON.stringify(pending) },
        create: { key: PENDING_ORDER_KEY, value: JSON.stringify(pending) },
      });
    });
    activePendingOrderSubmission = pending;
  } finally {
    pendingOrderReservationInFlight = false;
  }
}

async function updatePendingOrderPhase(clOrdId: string, phase: PendingOrderSubmission["phase"]): Promise<void> {
  if (activePendingOrderSubmission?.clOrdId !== clOrdId) {
    throw new Error(`cannot mark unowned order ${clOrdId} as ${phase}`);
  }
  const updated = { ...activePendingOrderSubmission, phase };
  await prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT 1 AS locked FROM pg_advisory_xact_lock(hashtext(${PENDING_ORDER_KEY}))`;
    const row = await tx.agentConfig.findUnique({ where: { key: PENDING_ORDER_KEY } });
    const stored = row?.value ? JSON.parse(row.value) as PendingOrderSubmission : null;
    if (!stored || stored.clOrdId !== clOrdId || stored.ownerId !== ORDER_OWNER_ID) {
      throw new Error(`durable ownership changed while marking ${clOrdId} as ${phase}`);
    }
    await tx.agentConfig.update({ where: { key: PENDING_ORDER_KEY }, data: { value: JSON.stringify(updated) } });
  });
  activePendingOrderSubmission = updated;
}

async function authorizePendingEntryAndMarkSent(clOrdId: string): Promise<boolean> {
  const updated = await prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT 1 AS locked FROM pg_advisory_xact_lock(hashtext(${PENDING_ORDER_KEY}))`;
    const [pendingRow, gateRow, heartbeatRow] = await Promise.all([
      tx.agentConfig.findUnique({ where: { key: PENDING_ORDER_KEY } }),
      tx.agentConfig.findUnique({ where: { key: "trading_mode_futures" } }),
      tx.agentConfig.findUnique({ where: { key: HEARTBEAT_KEY } }),
    ]);
    const stored = pendingRow?.value ? JSON.parse(pendingRow.value) as PendingOrderSubmission : null;
    if (!stored || stored.clOrdId !== clOrdId || stored.ownerId !== ORDER_OWNER_ID || stored.phase !== "reserved") {
      throw new Error(`durable entry ownership changed before authorization for ${clOrdId}`);
    }
    const heartbeat = heartbeatRow?.value
      ? JSON.parse(heartbeatRow.value) as { timestamp?: string; startedAt?: string; deploymentId?: string | null }
      : null;
    const heartbeatOwner = heartbeat?.startedAt ? `${heartbeat.deploymentId || "local"}:${heartbeat.startedAt}` : "";
    const heartbeatAge = Date.now() - Date.parse(heartbeat?.timestamp || "");
    const anotherGenerationIsActive = heartbeatOwner !== "" && heartbeatOwner !== ORDER_OWNER_ID
      && Number.isFinite(heartbeatAge) && heartbeatAge < 90_000;
    const gateAllowed = !anotherGenerationIsActive
      && gateRow?.value !== "disabled" && (!IS_LIVE || gateRow?.value === "live");
    if (!gateAllowed) return null;
    const sent = { ...stored, phase: "sent" as const };
    await tx.agentConfig.update({ where: { key: PENDING_ORDER_KEY }, data: { value: JSON.stringify(sent) } });
    return sent;
  });
  if (!updated) return false;
  activePendingOrderSubmission = updated;
  return true;
}

async function clearPendingOrderSubmission(clOrdId: string): Promise<void> {
  if (activePendingOrderSubmission?.clOrdId !== clOrdId) return;
  await prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT 1 AS locked FROM pg_advisory_xact_lock(hashtext(${PENDING_ORDER_KEY}))`;
    const row = await tx.agentConfig.findUnique({ where: { key: PENDING_ORDER_KEY } });
    const stored = row?.value ? JSON.parse(row.value) as PendingOrderSubmission : null;
    if (!stored || stored.clOrdId !== clOrdId || stored.ownerId !== ORDER_OWNER_ID) {
      throw new Error(`durable ownership changed before clearing ${clOrdId}`);
    }
    await tx.agentConfig.delete({ where: { key: PENDING_ORDER_KEY } });
  });
  activePendingOrderSubmission = null;
}

async function resolveSubmittedOrder(
  responsePromise: Promise<Response>,
  clOrdId: string,
  label: string,
): Promise<number> {
  try {
    const response = await responsePromise;
    if (!response.ok) {
      const detail = await response.text().catch(() => "");
      // A client error is a broker rejection of this command, not an uncertain network outcome.
      if (response.status >= 400 && response.status < 500 && ![408, 425].includes(response.status)) {
        throw new DefinitiveOrderSubmissionError(`${label} API ${response.status}: ${detail}`);
      }
      throw new Error(`${label} API ${response.status}: ${detail}`);
    }
    const result = await response.json() as { orderId?: number; failureReason?: string; failureText?: string };
    if (result.failureReason || result.failureText) {
      throw new DefinitiveOrderSubmissionError(
        `${label} rejected: ${result.failureReason || "broker rejection"}${result.failureText ? ` (${result.failureText})` : ""}`,
      );
    }
    if (!result.orderId) throw new Error(`${label} response did not contain an order id`);
    return result.orderId;
  } catch (error) {
    if (error instanceof DefinitiveOrderSubmissionError) {
      await updatePendingOrderPhase(clOrdId, "rejected");
      throw error;
    }
    log(`🚨 ${label}: response ambiguous (${error}); blocking until broker order ${clOrdId} is recovered`);
    notify(`🚨 ${MODE_TAG} ${label}: broker response was lost. New submissions are blocked while order ${clOrdId} is recovered.`, "general");
    // A bounded timeout cannot prove a command never reached the broker. Keep ownership of this
    // submission indefinitely. The durable pending record lets startup resume this exact clOrdId.
    let lastWaitLogAt = 0;
    while (true) {
      const recovered = await findOrderIdByClientId(clOrdId, 3);
      if (recovered) return recovered;
      if (Date.now() - lastWaitLogAt >= 60_000) {
        lastWaitLogAt = Date.now();
        log(`[ORDER RECOVERY] ${label}: still waiting for ${clOrdId}; no retry will be submitted`);
      }
      await new Promise((resolve) => setTimeout(resolve, 2_000));
    }
  }
}

async function submitRecoverableOrder(
  body: Record<string, unknown>,
  label: string,
  metadata: { kind: PendingOrderKind; symbol: string; contractId: number },
): Promise<number> {
  const clOrdId = typeof body.clOrdId === "string"
    ? body.clOrdId
    : `FRT-${label.replace(/[^A-Za-z0-9]/g, "").slice(0, 12)}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const token = await authenticate();
  await reservePendingOrderSubmission({
    clOrdId,
    label,
    kind: metadata.kind,
    symbol: metadata.symbol,
    contractId: metadata.contractId,
    createdAt: new Date().toISOString(),
    phase: "reserved",
    ownerId: ORDER_OWNER_ID,
  });
  await updatePendingOrderPhase(clOrdId, "sent");
  const responsePromise = fetch(`${ORDER_API}/order/placeorder`, {
    method: "POST",
    body: JSON.stringify({ ...body, clOrdId }),
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(15_000),
  });
  return resolveSubmittedOrder(responsePromise, clOrdId, label);
}

async function recoverPendingOrderSubmissionOnStartup(): Promise<void> {
  const row = await prisma.agentConfig.findUnique({ where: { key: PENDING_ORDER_KEY } });
  if (!row?.value) return;
  let pending = JSON.parse(row.value) as PendingOrderSubmission;
  if (!pending.clOrdId || !pending.contractId || !pending.symbol || !pending.kind || !pending.phase || !pending.ownerId) {
    throw new Error(`${PENDING_ORDER_KEY} is malformed; refusing to start trading`);
  }
  if (pending.ownerId !== ORDER_OWNER_ID) {
    const heartbeatRow = await prisma.agentConfig.findUnique({ where: { key: HEARTBEAT_KEY } });
    const heartbeat = heartbeatRow?.value
      ? JSON.parse(heartbeatRow.value) as { timestamp?: string; startedAt?: string; deploymentId?: string | null }
      : null;
    const heartbeatOwner = heartbeat?.startedAt
      ? `${heartbeat.deploymentId || "local"}:${heartbeat.startedAt}`
      : "";
    const heartbeatAge = Date.now() - Date.parse(heartbeat?.timestamp || "");
    if (heartbeatOwner === pending.ownerId && Number.isFinite(heartbeatAge) && heartbeatAge < 90_000) {
      throw new Error(`${pending.label} is still owned by a healthy prior process; refusing overlapping startup`);
    }
    pending = await prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT 1 AS locked FROM pg_advisory_xact_lock(hashtext(${PENDING_ORDER_KEY}))`;
      const current = await tx.agentConfig.findUnique({ where: { key: PENDING_ORDER_KEY } });
      const stored = current?.value ? JSON.parse(current.value) as PendingOrderSubmission : null;
      if (!stored || stored.clOrdId !== pending.clOrdId || stored.ownerId !== pending.ownerId) {
        throw new Error("pending order ownership changed during startup claim");
      }
      const claimed = { ...stored, ownerId: ORDER_OWNER_ID };
      await tx.agentConfig.update({ where: { key: PENDING_ORDER_KEY }, data: { value: JSON.stringify(claimed) } });
      return claimed;
    });
  }
  activePendingOrderSubmission = pending;
  log(`[ORDER RECOVERY] Resuming durable ${pending.label} (${pending.clOrdId}) before engine startup`);
  notify(`🚨 ${MODE_TAG}: recovering ${pending.label} from a prior process before any new order can be submitted.`, "general");

  if (pending.phase !== "sent") {
    if (pending.kind === "entry" || pending.kind === "target") {
      await clearPendingOrderSubmission(pending.clOrdId);
      log(`[ORDER RECOVERY] Cleared ${pending.phase} ${pending.kind} intent; no broker request could have been sent`);
      return;
    }
    const brokerPosition = await getBrokerPositionSnapshot(pending.contractId, 5);
    if (brokerPosition === undefined) {
      throw new Error(`${pending.label} was ${pending.phase}, but broker position is unavailable`);
    }
    if (brokerPosition === null) {
      await clearPendingOrderSubmission(pending.clOrdId);
      return;
    }
    await syncPositions();
    const pos = positions.get(pending.symbol);
    if (!pos) throw new Error(`${pending.label} left an unprotected broker position that startup could not adopt`);
    log(`[ORDER RECOVERY] ${pending.label} was not safely active; flattening before startup completes`);
    await closePosition(pending.symbol, brokerPosition.netPrice || pos.entryPrice, "startup_unsent_order_recovery");
    return;
  }

  let orderId: number | null = null;
  let lastWaitLogAt = 0;
  const missingOrderDeadline = Date.now() + 60_000;
  while (!orderId) {
    orderId = await findOrderIdByClientId(pending.clOrdId, 3);
    if (!orderId) {
      if (Date.now() >= missingOrderDeadline) {
        const brokerPosition = await getBrokerPositionSnapshot(pending.contractId, 5);
        if (brokerPosition !== undefined) {
          if (brokerPosition === null) {
            await clearPendingOrderSubmission(pending.clOrdId);
            log(`[ORDER RECOVERY] ${pending.label}: no order appeared and broker is stably flat`);
            return;
          }
          await syncPositions();
          const pos = positions.get(pending.symbol);
          if (!pos) throw new Error(`${pending.label} has broker exposure that startup could not adopt`);
          if (pending.kind === "target" && pos.stopOrderId
            && await protectionOrderStatus(pos.stopOrderId) === "active") {
            await clearPendingOrderSubmission(pending.clOrdId);
            log(`[ORDER RECOVERY] ${pending.label}: missing optional target cleared; active stop #${pos.stopOrderId} remains`);
            return;
          }
          await updatePendingOrderPhase(pending.clOrdId, "rejected");
          log(`[ORDER RECOVERY] ${pending.label}: no broker order appeared after 60s while exposure remains; flattening fail-closed`);
          await closePosition(pending.symbol, brokerPosition.netPrice || pos.entryPrice, "startup_missing_order_recovery");
          return;
        }
      }
      if (Date.now() - lastWaitLogAt >= 60_000) {
        lastWaitLogAt = Date.now();
        log(`[ORDER RECOVERY] ${pending.label}: exact clOrdId not visible yet; startup remains fail-closed`);
      }
      await new Promise((resolve) => setTimeout(resolve, 2_000));
    }
  }

  let status = await protectionOrderStatus(orderId);
  while (status === "unknown") {
    await new Promise((resolve) => setTimeout(resolve, 2_000));
    status = await protectionOrderStatus(orderId);
  }

  if ((pending.kind === "stop" || pending.kind === "target") && status === "active") {
    const pos = positions.get(pending.symbol);
    if (pos && pos.contractId === pending.contractId) {
      if (pending.kind === "stop") pos.stopOrderId = orderId;
      else pos.targetOrderId = orderId;
      await savePositionsForOrderRecovery();
      await clearPendingOrderSubmission(pending.clOrdId);
      log(`[ORDER RECOVERY] Reattached active ${pending.kind} #${orderId} to ${pending.symbol}`);
      return;
    }
  }

  if (status === "active") await cancelOrderUntilTerminal(orderId, pending.label);
  const brokerPosition = await getBrokerPositionSnapshot(pending.contractId, 5);
  if (brokerPosition === undefined) {
    throw new Error(`${pending.label} reached terminal state but broker position remains unavailable`);
  }
  if (brokerPosition === null) {
    await clearPendingOrderSubmission(pending.clOrdId);
    return;
  }
  await syncPositions();
  const pos = positions.get(pending.symbol);
  if (!pos) throw new Error(`${pending.label} left a broker position that startup could not adopt`);
  log(`[ORDER RECOVERY] ${pending.label} left ${brokerPosition.netPos} contract(s); flattening before startup completes`);
  await closePosition(pending.symbol, brokerPosition.netPrice || pos.entryPrice, "startup_order_recovery");
}

type BrokerPositionSnapshot = { netPos: number; netPrice: number };

/**
 * Resolve an indeterminate order from the broker's actual position.
 * null means the broker answered and the contract is flat; undefined means the
 * broker never answered, which must not be interpreted as either filled or flat.
 */
async function getBrokerPositionSnapshot(
  contractId: number,
  attempts = 5,
): Promise<BrokerPositionSnapshot | null | undefined> {
  let previous: BrokerPositionSnapshot | null | undefined;
  for (let attempt = 0; attempt < attempts; attempt++) {
    if (attempt > 0) await new Promise((resolve) => setTimeout(resolve, 750));
    try {
      const brokerPositions = await apiFetch("/position/list") as {
        contractId: number;
        netPos: number;
        netPrice?: number;
      }[];
      const match = brokerPositions.find((position) => position.contractId === contractId && position.netPos !== 0);
      const current = match ? { netPos: match.netPos, netPrice: Number(match.netPrice || 0) } : null;
      if (previous !== undefined && JSON.stringify(previous) === JSON.stringify(current)) return current;
      previous = current;
    } catch { /* retry without guessing */ }
  }
  return undefined;
}

async function evaluateAndTrade(
  sym: string, direction: string, price: number,
  stopDist: number, targetDist: number, sizeMult: number, technicalScore: number,
  reasoning: string, rsiVal: number, atrVal: number, vwapVal: number,
  dayType: string, session: string, trend15: string,
  prevDayHigh: number, prevDayLow: number,
  setupType: string,  // canonical: extreme_rsi_bounce, gap_fill, or_breakout, failed_ib_breakout, ib_extension, trend_continuation, vwap_bounce, range_bounce
) {
  // 2026-05-29: AUTO-PRUNE gate. The "brilliant agent" self-improves: any setupType that
  // accumulates 30+ trades with sub-30% WR AND negative expectancy retires itself mechanically.
  // No human override required. Re-evaluated each fire — if the next 30 trades recover, the
  // gate re-opens automatically. This is the proof the system gets smarter without intervention.
  try {
    const { getSetupTypeHealth } = await import("../lib/pattern-memory");
    const health = await getSetupTypeHealth(setupType, 30);
    if (health.shouldDisable) {
      log(`  AUTO-PRUNED ${setupType}: ${health.matchCount} trades, ${(health.winRate * 100).toFixed(0)}% WR, ${health.expectancy.toFixed(2)}R expectancy — setup mechanically retired (trend: ${health.recentTrend})`);
      return;
    }
  } catch { /* pattern memory is optional — fail open on read errors */ }

  // ── DATA-INTEGRITY GATE (2026-07-29) ──────────────────────────────────────────────────────────
  // Two separate failure modes, both of which produced live signals off prices that did not exist.
  //
  // 1. STALE PRICE. An entry priced off an old quote puts the broker stop in the wrong place, and the
  //    stop is what defines the risk. Checked against the QUOTE's own exchange timestamp (30s), not
  //    the age of our poll — DBN_STALE_MS (90s) governs bars only.
  // 2. POISONED INDICATORS. This is the one the earlier fix missed. A 14-period ATR spans ~70 minutes,
  //    so a feed discontinuity keeps distorting ATR/RSI/VWAP/OR long after the feed is healthy again.
  //    On 2026-07-29 gold's real 5-min ATR was 3.34 while the engine read 8.75-12.68 with RSI pinned
  //    at 94-98 for 20+ minutes; the recovery step then inverts it into a fake OVERSOLD reading, which
  //    is a false LONG on the exact side (gold_long_europe) that is switched ON for live.
  if (!isRealtimePriced(sym)) {
    const age = ((Date.now() - (lastReliableAt.get(sym) ?? 0)) / 1000).toFixed(0);
    log(`  ${sym}: SKIP — quote is ${age}s old (need <${ENTRY_MAX_QUOTE_AGE_MS / 1000}s to price a live stop)`);
    return;
  }
  const barsQuarantined = quarantineBars.get(sym) ?? 0;
  if (barsQuarantined > 0) {
    log(`  ${sym}: SKIP — indicators still carry a feed discontinuity, ${barsQuarantined} clean bar(s) to go`);
    return;
  }
  // 3. UNKNOWN ACCOUNT BALANCE. Every risk limit is a multiple of equity, so sizing anything before
  //    the real balance has landed is guesswork. Explicit rather than relying on maxRisk falling to 0.
  if (riskSizingEquity() <= 0) {
    log(`  ${sym}: SKIP — sizing equity unavailable${IS_DEMO && DEMO_LIVE_CLONE ? " (fresh live heartbeat required for demo clone)" : " (waiting on balance fetch)"}`);
    return;
  }
  if (USES_LIVE_POLICY && (!riskConfigHealthy || !futuresTradingEnabled)) {
    log(`  ${sym}: SKIP — operator trading gate is ${riskConfigHealthy ? "disabled" : "unavailable"}`);
    return;
  }

  // EDGE GATE (registry-driven, per-engine switch). The set of tradable edges lives in
  // ../lib/realtime-edges.ts; each edge has an independent on/off switch for demo and live. Only
  // an edge that BOTH matches this setup AND is switched ON for this engine may trade. This
  // reproduces the previous hardcoded allow-list exactly when no switch is set (current edges
  // default ON for both engines), and lets a NEW edge run on demo while staying OFF on live until
  // it's deliberately promoted. Default-DENY: a setup matching no registered edge is skipped, and
  // the AI grader + auto-prune + stops keep learning/backstopping ON TOP of this baseline.
  const matchedEdge = matchEdge({ sym, setupType, direction: direction as "long" | "short", rsi: rsiVal, session });
  if (!matchedEdge) {
    log(`  ${sym}: SKIP — no registered edge for ${setupType}/${direction} (RSI ${rsiVal.toFixed(0)})`);
    recordDecision({ sym, direction, setupType, confidence: technicalScore, verdict: "rejected", reason: `no registered edge for ${setupType}/${direction} (RSI ${rsiVal.toFixed(0)})`, ...shadowGeometry(direction, price, stopDist, targetDist) });
    return;
  }
  if (IS_LIVE && !LIVE_TRADING_ARMED) {
    log(`  ${sym}: SKIP — real-money engine is not infrastructure-armed (LIVE_TRADING_ARMED=true required)`);
    return;
  }
  if (!isEdgeEnabled(matchedEdge.key, ENGINE_MODE, edgeFlags)) {
    log(`  ${sym}: SKIP — edge "${matchedEdge.name}" is switched OFF for ${MODE_TAG}`);
    recordDecision({ sym, direction, setupType, confidence: technicalScore, verdict: "rejected", reason: `edge "${matchedEdge.name}" disabled for ${ENGINE_MODE}`, ...shadowGeometry(direction, price, stopDist, targetDist) });
    return;
  }
  // ── MACRO-RELEASE BLACKOUT (2026-08-10), metals only, 08:15–08:45 ET, on release days only.
  // Measured first (scripts/gold-edge-validation.ts G_HOURLY=1, 320 London longs / 3yr): the 8-9am
  // buckets are PROFITABLE on ordinary days (PF 1.31/1.18, +$309) — so NO broad blackout; the
  // release volatility ordinarily FEEDS an RSI-reversal edge. But NFP mornings went 0-for-3
  // (−$235), and the real justification is mechanism, not n=3: an 8:30 print can gap gold THROUGH
  // a stop in one second — the one loss an ATR stop cannot bound. Cost of the guard: ~1 skipped
  // trade/month. NFP = first Friday (computed); CPI and other irregular 8:30 releases come from
  // the `macro_blackout_dates` config key so the calendar updates without a deploy.
  if (METALS.has(sym)) {
    const etH = getETHour();
    if (etH >= 8.25 && etH < 8.75) {
      const etDate = getETDateString();
      const dayOfMonth = parseInt(etDate.slice(8), 10);
      const isNFP = getETDayOfWeek() === 5 && dayOfMonth <= 7;
      if (isNFP || macroBlackoutDates.has(etDate)) {
        log(`  ${sym}: SKIP — macro-release blackout (${isNFP ? "NFP" : "release day"} 08:15–08:45 ET)`);
        recordDecision({ sym, direction, setupType, confidence: technicalScore, verdict: "rejected", reason: `macro-release blackout — ${isNFP ? "NFP morning" : "8:30 release day"}, gap-through-stop risk`, ...shadowGeometry(direction, price, stopDist, targetDist) });
        return;
      }
    }
  }
  // VAULT GATE (moved here 2026-08-11 — see onBarClose). Same blocks, now measured: every vault
  // block produces a decision row + shadow counterfactual, so the nightly radar watches it too.
  {
    const vb = vaultBlockReason(sym, session);
    if (vb) {
      log(`  ${sym}: VAULT BLOCK — ${vb}`);
      recordDecision({ sym, direction, setupType, confidence: technicalScore, verdict: "rejected", reason: vb, ...shadowGeometry(direction, price, stopDist, targetDist) });
      return;
    }
  }
  if (matchedEdge.symbolClass === "index") {
    // CORRELATION GUARD (same-cycle): reserve the single index slot synchronously so a 2nd correlated
    // index firing the SAME bar can't double the position. Check-and-set is atomic (no await between),
    // so whichever index commits first wins and the other aborts — regardless of async interleaving.
    if ([...positions.keys()].some((s) => INDEX_SYMS.has(s)) || Date.now() < indexEntryReservedUntil) {
      log(`  ${sym}: SKIP — correlation guard (already holding/entering a correlated equity index)`);
      recordDecision({ sym, direction, setupType, confidence: technicalScore, verdict: "rejected", reason: `correlation guard — one equity-index position at a time`, ...shadowGeometry(direction, price, stopDist, targetDist) });
      return;
    }
    indexEntryReservedUntil = Date.now() + 30_000; // hold the slot ~30s until the fill registers a position
  }

  // 2026-05-29: Compute pattern-memory stats BEFORE the AI call so they feed the AI's decision.
  // The AI grader is now data-driven: historical WR dominates over subjective reasoning.
  let patternStats: { matchCount: number; winRate: number; avgR: number } | null = null;
  try {
    const { predictOutcome } = await import("../lib/pattern-memory");
    const pred = await predictOutcome({
      regime: cachedRegime,
      session, instrument: sym, setupType,
      direction: direction as "long" | "short",
      rsi: rsiVal, vixLevel: currentVIX, vixTrend: currentVIX > 20 ? "rising" : "falling",
      atr: atrVal / price * 1000, priceVsVwap: vwapVal > 0 ? (price - vwapVal) / vwapVal * 100 : 0,
      trend15m: trend15 as "up" | "down" | "flat",
      trendDaily: dayType.includes("trend") ? (direction === "long" ? "up" : "down") : "flat",
      riskReward: targetDist / stopDist,
      dollarTrend, bondTrend,
    });
    patternStats = { matchCount: pred.matchCount, winRate: pred.winRate, avgR: pred.avgPnlR };
    log(`  [PATTERN] ${pred.matchCount} matches, ${(pred.winRate * 100).toFixed(0)}% historical WR`);
    // 2026-06-03: Raised from 10 → 25 matches. 10 trades is variance, not signal — with the AI
    // grader prompt baking the WR rule in already, the redundant low-sample hard-block was
    // killing every fire on the first bad week. Auto-prune (30-match window) handles persistent
    // underperformers; this early hard-block only fires if we have a genuine 25-trade sample
    // of statistical losing.
    // ── DECOUPLED FROM THE GRADER (2026-08-16) ────────────────────────────────────────────────
    // This floor used to ride on the AI switch, on the reasoning that it reads the same
    // pattern-memory WR the grader reads, so disregarding the grader meant disregarding the data.
    // That was correct WHEN IT WAS WRITTEN and is not correct now, for two reasons:
    //
    // 1. THE DATA WAS BROKEN THEN AND IS REPAIRED NOW. When the switches were tied together, pattern
    //    memory stored every breakeven-reaching winner as 0.00R (4f02521) and pooled demo vectors
    //    into live (0941127) — it reported the account's two money-makers as losers. Blocking on
    //    that was indeed "killing +2R winners". Both defects are fixed and the vectors repaired.
    // 2. THE TWO VETOES HAVE NOTHING IN COMMON EXCEPT THEIR INPUT. The grader is an Anthropic round
    //    trip on the critical path — measured at ~9s, i.e. ~7 points of MNQ, against an edge that is
    //    only profitable below ~1.5. This floor is a local DB read: it costs nothing and delays
    //    nothing. Tying a free filter's on/off to an expensive one's meant that switching the grader
    //    off for LATENCY reasons silently removed live's only empirical entry filter as well.
    //
    // So they get their own switches. This is what PHASE-0-LIVE.md §4 requires live to have and
    // currently does not: an actual selection filter, at zero execution cost.
    //
    // HONEST RESIDUAL (from 0941127, not papered over): memory still holds ~13 more
    // trend_continuation records than the RoundTrip ledger and reads a lower win rate. The gate is
    // deliberately extreme — sub-25% WR on a 25+ sample — so an imperfectly reconciled book still
    // clears it easily, and the cost of a false block is a skipped trade, which is free. Asymmetric
    // in favour of being on. Disable with `<live_futures|futures>_pattern_floor=false`.
    if (USES_LIVE_POLICY && patternFloorEnabled && pred.matchCount >= 25 && pred.winRate < 0.25) {
      log(`  BLOCKED by pattern memory: ${(pred.winRate * 100).toFixed(0)}% WR < 25% on ${pred.matchCount} matches — skipping under live policy`);
      recordDecision({ sym, direction, setupType, confidence: technicalScore, verdict: "pattern_blocked", reason: `${(pred.winRate * 100).toFixed(0)}% WR on ${pred.matchCount} matches`, ...shadowGeometry(direction, price, stopDist, targetDist) });
      feedLog("skip", `${sym} ${setupType} ${direction} blocked by pattern memory (${(pred.winRate * 100).toFixed(0)}% WR)`);
      return;
    }
  } catch { /* pattern memory is optional */ }

  // The entry decision is deterministic and local. AI grading is advisory telemetry only and runs
  // after order handling, because measured grader latency consumed more movement than MNQ can afford.
  const finalScore = technicalScore;

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

  // 2026-05-29 evening: pushed both lower so the engines FIRE more — pattern memory + auto-prune
  // are the empirical filters now. Demo is paper (no margin constraint), so we test the upper bound
  // of how much we can fire and let the auto-prune mechanic retire whatever doesn't earn its keep.
  // Live stays disciplined-but-aggressive: 55 lets validated setups (trend continuation, VWAP reclaim)
  // through that the prior 60 cutoff was blocking. Auto-prune retires anything that bleeds.
  const MIN_CONFIDENCE = USES_LIVE_POLICY ? 55 : 50;
  if (finalScore < MIN_CONFIDENCE) {
    log(`  SKIPPED: Final confidence ${finalScore}% below ${MIN_CONFIDENCE}% threshold (${MODE_TAG})`);
    return;
  }

  // Orchestrator pause gate. Live-policy engines fail closed when this safety state cannot be read.
  try {
    const pause = await checkEntriesPaused();
    if (pause.paused) {
      log(`  PAUSED by orchestrator: ${pause.reason} — skipping ${sym} ${direction}`);
      feedLog("cooldown", `Entries paused — ${pause.reason}`);
      return;
    }
  } catch (error) {
    if (USES_LIVE_POLICY) {
      log(`  ${sym}: SKIP — orchestrator pause state unavailable: ${error}`);
      return;
    }
  }

  // Execution gates — limits from DB config (Agent Hub manages these)
  const currentTotalContracts = [...positions.values()].reduce((s, p) => s + p.quantity, 0);
  const canExec = sizeMult > 0 && !positions.has(sym) && positions.size < riskConfig.maxConcurrentPositions
    && currentTotalContracts < riskConfig.maxTotalContracts
    && dailyTradeCount < riskConfig.maxTradesPerDay && dailyPnl >= -riskSizingEquity() * (riskConfig.dailyLossLimitPct / 100)
    && Date.now() >= tiltPauseUntil && !stoppedSymbols.has(sym) && !entryExecutionInFlight
    && activePendingOrderSubmission === null && !pendingOrderReservationInFlight && closingLocks.size === 0;

  if (canExec) {
    // Pattern memory hard block was already evaluated up front.
    log(`  EXECUTING: ${direction.toUpperCase()} ${sym} @ $${price.toFixed(2)} | Confidence: ${finalScore}% | ${MODE_TAG}`);
    entryExecutionInFlight = true;
    try {
      await executeTrade(sym, direction as "long" | "short", price, stopDist, targetDist, sizeMult, finalScore,
        `[${finalScore}% confidence] Edge: ${matchedEdge.key}. ${reasoning}. Deterministic entry; AI is post-trade advisory only.`,
        { rsi: rsiVal, vwap: vwapVal, trend15m: trend15, dayType, session, setupType });
    } finally {
      entryExecutionInFlight = false;
    }
    if (aiReviewEnabled) {
      void getAIConfirmation({
        sym, direction, reasoning, price,
        rsi: rsiVal, atr: atrVal, vwap: vwapVal,
        dayType, session, trend15, prevDayHigh, prevDayLow,
        patternStats,
      }).then((review) => {
        log(`  [AI POST-TRADE] ${review.agree ? "agrees" : "disagrees"} (${review.confidence}%): ${review.reasoning}`);
      }).catch(() => { /* advisory telemetry never affects trading */ });
    }
  } else {
    // Approved but can't enter — usually because we're already holding this symbol (one position per
    // symbol), or a daily/tilt limit. This is a NON-EVENT (the engine is just holding); we deliberately
    // don't log it to the feed so the activity list stays "1 confirmed per real trade", not a wall of re-grades.
    log(`  HELD/SKIP: ${direction.toUpperCase()} ${sym} — ${positions.has(sym) ? "already in a position (one per symbol)" : dailyTradeCount >= riskConfig.maxTradesPerDay ? "daily limit" : "tilt/position limit"}`);
  }
}

// ── Trade Execution ─────────────────────────────────────

// Phase-0 execution-quality capture (intended vs actual fill, slippage, latency). Fully isolated — never throws into trading.
async function logExecutionQuality(e: { mode: string; sym: string; side: string; intended: number; fill: number; qty: number; latencyMs: number; status: string; edgeKey?: string }) {
  try {
    await prisma.$executeRawUnsafe(`CREATE TABLE IF NOT EXISTS execution_quality (id serial PRIMARY KEY, ts timestamptz DEFAULT now(), mode text, symbol text, side text, intended double precision, fill double precision, slippage double precision, qty int, latency_ms int, status text)`);
    await prisma.$executeRawUnsafe(`ALTER TABLE execution_quality ADD COLUMN IF NOT EXISTS edge_key text, ADD COLUMN IF NOT EXISTS strategy_version text`);
    const slip = e.side === "Buy" ? (e.fill - e.intended) : (e.intended - e.fill);   // + = adverse (paid up)
    await prisma.$executeRawUnsafe(`INSERT INTO execution_quality(mode,symbol,side,intended,fill,slippage,qty,latency_ms,status,edge_key,strategy_version) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`, e.mode, e.sym, e.side, e.intended, e.fill, slip, e.qty, e.latencyMs, e.status, e.edgeKey ?? null, STRATEGY_VERSION);
    log(`[EXEC-Q] ${e.sym} ${e.side} intended ${e.intended.toFixed(2)} fill ${e.fill.toFixed(2)} slip ${slip.toFixed(2)} lat ${e.latencyMs}ms ${e.status}`);
  } catch { /* telemetry must never affect trading */ }
}

async function executeTrade(sym: string, direction: "long" | "short", price: number, stopDist: number, targetDist: number, sizeMult: number, confidenceScore: number, reasoning: string, setupContext?: { rsi: number; vwap: number; trend15m: string; dayType: string; session: string; setupType: string }) {
  const contract = contracts.get(sym);
  if (!contract) return;
  const executionEdgeKey = reasoning.match(/Edge:\s*([a-z0-9_]+)/i)?.[1];

  // Demo always executes (24/7 learning). Live mirrors during RTH if enabled.

  const mult = CONTRACT_MULTIPLIERS[sym] || 5;
  // Use simulated equity for sizing (demo simulates $1K). Fall back to actual if not set.
  const equity = riskSizingEquity();
  const riskPct = riskConfig.riskPerTradePct / 100;
  const maxRisk = equity * riskPct * sizeMult;
  const riskPer = stopDist * mult; // Dollar risk per 1 contract

  // Preserve the strategy's validated stop geometry. If one contract does not fit the risk budget,
  // skip the trade rather than silently converting it into a different, untested strategy.
  if (riskPer > maxRisk) {
    log(`${sym}: SKIP — validated 1-contract risk $${riskPer.toFixed(0)} exceeds max $${maxRisk.toFixed(0)} (${(riskPct * 100)}% of $${equity.toFixed(0)}). Stop geometry unchanged.`);
    return;
  }

  // ⚠️ IF YOU CHANGE THE SIZING BELOW, UPDATE plannedQtyFor() TOO — it mirrors this block to tell the
  // admin panel what size the engine intends, and a silent divergence there means the panel lies.
  // EVERY micro (MGC/MNQ/MES) now grows with the account, not just gold — so risk stays ~1%/trade
  // instead of being frozen at 1 micro forever, and the step-up happens because the equity was
  // earned rather than because someone raised a flag after a good week. Full-size contracts keep the
  // configured cap. At today's ~$5.2k equity microContractCap() = 1 for all three, so this is
  // behaviour-identical to the previous line until the account reaches $10,000.
  // The growth ladder and configured maximum are both ceilings. This lets equity-earned scale-ups
  // happen automatically while preserving the operator's ability to reduce maximum size instantly.
  let perTradeCap = contractCapFor(sym, equity, setupContext?.session);
  if (perTradeCap < 1) {
    log(`${sym}: SKIP — no aggregate contract capacity remains (limit ${riskConfig.maxTotalContracts})`);
    return;
  }
  // ── OVERNIGHT MARGIN GOVERNOR ────────────────────────────────────────────────────────────────
  // The per-trade cap of 4 only works during RTH, where the exchange charges DAY-TRADE margin
  // (~$50-100/micro). Outside RTH it charges INITIAL margin — MGC $2,242.90 — so on a ~$5,227
  // account 2 contracts is 86% of equity and 3 is flatly impossible. The London gold long
  // (03:00-09:00 ET, gold_long_europe=ON on live) is an overnight session, so it is governed here.
  //
  // WHY THIS IS NOW A MARGIN CHECK AND NOT JUST A CONTRACT COUNT (2026-07-29): risk-based sizing
  // targets 3% of equity and never looks at margin at all, so a contract count is the only thing
  // standing between it and an order the account cannot margin. A fixed count also silently stops
  // being true when equity moves — and it nearly bit today: correcting the inflated ATR tightened
  // gold's stop from 15.7 to 7.5 points, which takes the SAME $150 of risk from 1 contract to 2 and
  // doubles initial margin from 43% to 86% of equity. Same risk, double the margin. Gating on
  // equity-relative margin means a drawdown reduces size by itself instead of relying on a number
  // that was only ever correct for one balance.
  //
  // FAIL-SAFE: an ABSENT session clamps too. setupContext is optional here, and a missing session
  // must never quietly authorise a size the account cannot margin — see the 2026-06-30 naked-stop
  // incident for why "the broker will just reject it" is not a safety mechanism.
  const execSession = setupContext?.session;
  const isOvernightEntry = !execSession || !RTH_SESSIONS.has(execSession);
  if (isOvernightEntry) {
    const marginCap = overnightMarginCap(sym, equity);
    const overnightCap = Math.min(perTradeCap, OVERNIGHT_CONTRACT_CAP, marginCap);
    if (overnightCap < 1) {
      const per = OVERNIGHT_INITIAL_MARGIN[sym];
      log(`${sym}: SKIP — overnight (session ${execSession ?? "unknown"}), and equity $${equity.toFixed(0)} cannot margin even 1 contract at ${per ? `$${per.toFixed(0)} initial` : "an UNKNOWN initial margin"} (cap ${(OVERNIGHT_MARGIN_UTILISATION_CAP * 100).toFixed(0)}% of equity)`);
      return;
    }
    if (overnightCap < perTradeCap) {
      const per = OVERNIGHT_INITIAL_MARGIN[sym] ?? 0;
      const use = per * overnightCap;
      log(`${sym}: OVERNIGHT CAP — session ${execSession ?? "unknown"} uses initial margin, capping ${perTradeCap} → ${overnightCap} contract(s) (${overnightCap}x $${per.toFixed(0)} = $${use.toFixed(0)}, ${((use / equity) * 100).toFixed(0)}% of $${equity.toFixed(0)} equity; ceiling ${(OVERNIGHT_MARGIN_UTILISATION_CAP * 100).toFixed(0)}%)`);
      perTradeCap = overnightCap;
    }
  }
  let qty = Math.min(perTradeCap, Math.floor(maxRisk / riskPer));
  if (qty < 1) { log(`${sym}: SKIP — calculated qty 0`); return; }
  // Hard ceiling: never risk more than 15% of equity on a single entry
  const totalRisk = riskPer * qty;
  if (totalRisk > equity * 0.15) {
    const hardCapQty = Math.floor((equity * 0.15) / riskPer);
    if (hardCapQty < 1) {
      log(`${sym}: SKIP — one contract would exceed the 15% single-entry hard ceiling`);
      return;
    }
    qty = Math.min(qty, hardCapQty);
    log(`${sym}: HARD CAP — risk $${totalRisk.toFixed(0)} exceeds 15% equity, capped to ${qty} contracts`);
  }
  const rr = targetDist / stopDist;
  if (rr < 2.0) { log(`${sym}: R:R ${rr.toFixed(1)} too low (need 2.0+)`); return; }

  // Snap to the contract tick — un-rounded prices are rejected by the broker as "Illegal Price",
  // which would leave the just-filled entry running with no protection.
  // Provisional, anchored to the SIGNAL price. Both are RE-ANCHORED to the actual fill below once it
  // is known — see the note there. Kept here so the pre-fill logging still has sane numbers.
  let stopPrice = roundToTick(sym, direction === "long" ? price - stopDist : price + stopDist);
  let targetPrice = roundToTick(sym, direction === "long" ? price + targetDist : price - targetDist);
  const side = direction === "long" ? "Buy" : "Sell";
  const closeSide = direction === "long" ? "Sell" : "Buy";

  log(`\n${"=".repeat(50)}`);
  log(`TRADE: ${side} ${qty}x ${sym} @ $${price.toFixed(2)}`);
  log(`  Stop: $${stopPrice.toFixed(2)} | Target: $${targetPrice.toFixed(2)} | R:R: ${rr.toFixed(1)} | Risk: $${(riskPer * qty).toFixed(0)}`);
  log(`  ${reasoning}`);
  log(`${"=".repeat(50)}\n`);

  try {
    // Account identity is fixed for the process and already resolved at auth. Fetching /account/list
    // before every entry added a full broker round trip to the decision→order path, which is paid in
    // slippage on a market order. Fall back to the fetch only if auth never populated it.
    let acct: { id: number; name: string };
    if (accountId && accountName) {
      acct = { id: accountId, name: accountName };
    } else {
      const accounts = await apiFetch("/account/list") as { id: number; name: string }[];
      acct = accounts.find(a => a.id === accountId) || accounts[0];
    }

    // ── MAX-CHASE GUARD (2026-07-30) ─────────────────────────────────────────────────────────
    // Slippage is not symmetric noise — it has a tail. Across 60 live fills MNQ's median was 7.13
    // points but the worst were 42.1 and 54.4, and it is that tail that drags the mean to 11.74 and
    // the edge from PF ~1.0 to 0.72. Those extremes happen when price has ALREADY run away between
    // the signal and the submission; we then chase it with a market order and buy the top of the move.
    //
    // So: re-read the freshest executable Databento top of book and if the
    // market has already moved MORE THAN 10% OF THE STOP DISTANCE against us, don't chase. 10% of the
    // stop is 10% of the trade's risk, which is the most execution should ever be allowed to cost.
    // A skipped trade is free; a chased one pays the whole tail. Favourable moves are never blocked.
    // Orders cross the book, so buys are anchored to the ask and sells to the bid.
    // Midpoint remains appropriate for bar construction but is not an executable price.
    let freshPrice = getActionableEntryPrice(sym, direction);
    if (freshPrice <= 0) {
      log(`  ${sym}: SKIP — no fresh executable quote aligned to broker contract ${contract.name}`);
      return;
    }
    const maxChase = stopDist * EXEC_COST_CAP_FRACTION;
    const chaseExceeded = (candidatePrice: number) => {
      if (candidatePrice <= 0 || stopDist <= 0) return false;
      const adverse = direction === "long" ? candidatePrice - price : price - candidatePrice;
      if (adverse > maxChase) {
        log(`  ${sym}: SKIP — price already ran ${adverse.toFixed(2)} pts against us since the signal (max chase ${maxChase.toFixed(2)} = ${(EXEC_COST_CAP_FRACTION * 100).toFixed(0)}% of the ${stopDist.toFixed(1)}-pt stop). Not buying the move.`);
        feedLog("skip", `${sym} ${direction} skipped — ran ${adverse.toFixed(1)} pts before entry (chase guard)`);
        return true;
      }
      return false;
    };
    if (chaseExceeded(freshPrice)) return;

    // The local position map is not authoritative enough to prove this contract is flat. Capture a
    // stable broker snapshot before submitting so an indeterminate new order can never adopt and
    // bracket a manual, stale, or externally-created position as if it were its own fill.
    const brokerBeforeEntry = await getBrokerPositionSnapshot(contract.id, 3);
    if (brokerBeforeEntry === undefined) {
      log(`  ${sym}: SKIP — broker position state unavailable before entry`);
      notify(`⚠️ ${MODE_TAG} ${sym}: entry blocked because broker position state could not be verified flat.`);
      return;
    }
    if (brokerBeforeEntry !== null) {
      log(`  ${sym}: SKIP — broker already holds ${brokerBeforeEntry.netPos} contract(s) not represented by this entry`);
      notify(`⚠️ ${MODE_TAG} ${sym}: entry blocked because broker already holds ${brokerBeforeEntry.netPos}. Reconcile positions first.`);
      return;
    }

    // The stable-flat check intentionally waits for two matching broker reads. Price can move while
    // that safety check runs, so refresh the executable quote and enforce the chase ceiling again
    // immediately before constructing and submitting the order.
    freshPrice = getActionableEntryPrice(sym, direction);
    if (freshPrice <= 0) {
      log(`  ${sym}: SKIP — executable quote became stale or changed contract during broker-flat verification`);
      return;
    }
    if (chaseExceeded(freshPrice)) return;

    // resolveContracts may run while the broker-flat check is awaiting network responses. Never
    // submit with the stale object captured above if the active broker month changed underneath us.
    const submissionContract = contracts.get(sym);
    if (!submissionContract || submissionContract.id !== contract.id || submissionContract.name !== contract.name) {
      log(`  ${sym}: SKIP — broker contract changed during entry verification (${contract.name} → ${submissionContract?.name ?? "unresolved"})`);
      return;
    }

    // Authenticate before the final operator check. The generic apiFetch helper may authenticate or
    // sleep-and-retry before it sends, which would leave a window for a kill switch to arrive and then
    // still be followed by an entry. Entries deliberately use one prepared token and never retry.
    const entryToken = await authenticate();
    const operatorGateAllowed = await refreshOperatorTradingGate();
    if (USES_LIVE_POLICY && (!riskConfigHealthy || !operatorGateAllowed || !futuresTradingEnabled)) {
      log(`  ${sym}: SKIP — operator kill switch engaged before order submission`);
      return;
    }
    freshPrice = getActionableEntryPrice(sym, direction);
    if (freshPrice <= 0 || chaseExceeded(freshPrice)) {
      if (freshPrice <= 0) log(`  ${sym}: SKIP — executable quote became stale or changed contract during final operator check`);
      return;
    }
    const finalContract = contracts.get(sym);
    if (!finalContract || finalContract.id !== contract.id || finalContract.name !== contract.name) {
      log(`  ${sym}: SKIP — broker contract changed during final operator check (${contract.name} → ${finalContract?.name ?? "unresolved"})`);
      return;
    }

    // ── ENTRY ORDER: MARKETABLE LIMIT vs MARKET ──────────────────────────────────────────────
    // The chase guard above only refuses to chase a move that ALREADY happened. It cannot bound what
    // the market hands us once a MARKET order is submitted — and that unbounded part is where the
    // median 7.13-pt MNQ slippage lives, i.e. the difference between PF 0.72 and PF 1.01.
    //
    // A marketable limit caps it: priced EXEC_COST_CAP_FRACTION of the stop through the signal, so it
    // still crosses the spread and fills immediately in normal conditions, but can never fill worse
    // than the ceiling. IOC (not Day) so an unfilled order CANCELS instead of resting — a stale limit
    // sitting on the book would fill minutes later on a signal that has expired, which is a worse
    // failure than not trading. verifyOrderFill already maps Canceled → "rejected", and already sizes
    // protective orders to the ACTUAL (possibly partial) fill, so both outcomes are handled.
    //
    // THE TRADE-OFF, stated honestly: this converts some fills into no-trades. On a real move the
    // book can be through the cap before we arrive and we simply miss the entry. That is a genuine
    // cost — it is not free, it is cheaper — and whether it nets positive depends on whether the
    // trades we miss were better or worse than average. Only real fills answer that, which is why
    // this is DEMO-ON / LIVE-OFF until demo has the sample.
    const useLimit = entryLimitEnabled && stopDist > 0;
    const limitAnchor = freshPrice;
    const tick = TICK_SIZES[sym] || finalContract.tickSize || 0.25;
    // Ticks first (what the EDGE can afford), then the fraction-of-stop as a secondary ceiling (what
    // the TRADE can afford). The tighter of the two wins — see ENTRY_LIMIT_TICKS_DEFAULT.
    const entryCap = Math.min(entryLimitTicks * tick, maxChase);
    // Round the cap OUTWARD (up for a buy, down for a sell) so tick-snapping can only ever loosen the
    // limit by <1 tick, never tighten it into a non-marketable price and manufacture a miss.
    const rawLimit = side === "Buy" ? limitAnchor + entryCap : limitAnchor - entryCap;
    const limitPrice = side === "Buy"
      ? Number((Math.ceil(rawLimit / tick) * tick).toFixed((String(tick).split(".")[1] || "").length))
      : Number((Math.floor(rawLimit / tick) * tick).toFixed((String(tick).split(".")[1] || "").length));

    // A client order id lets us recover the broker order even if the HTTP request is accepted but its
    // response is lost. Tradovate supports clOrdId on placeorder and returns it on Order entities.
    const entryClientOrderId = `FRT-${ENGINE_MODE}-${sym}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const entryBody = JSON.stringify(
      useLimit
        ? {
            accountSpec: acct.name, accountId, action: side, symbol: contract.id,
            clOrdId: entryClientOrderId, orderQty: qty, orderType: "Limit", price: limitPrice, timeInForce: "IOC", isAutomated: true,
          }
        : {
            accountSpec: acct.name, accountId, action: side, symbol: contract.id,
            clOrdId: entryClientOrderId, orderQty: qty, orderType: "Market", timeInForce: "Day", isAutomated: true,
          }
    );
    const submitTs = Date.now();
    await reservePendingOrderSubmission({
      clOrdId: entryClientOrderId,
      label: `${sym} entry`,
      kind: "entry",
      symbol: sym,
      contractId: contract.id,
      createdAt: new Date().toISOString(),
      phase: "reserved",
      ownerId: ORDER_OWNER_ID,
    });
    // The operator gate, active Railway generation, durable ownership, and reserved→sent transition
    // are one serialized database decision. Once it commits, only synchronous market/contract checks
    // remain before the request starts.
    const entryAuthorized = await authorizePendingEntryAndMarkSent(entryClientOrderId);
    const atSendPrice = getActionableEntryPrice(sym, direction);
    const atSendContract = contracts.get(sym);
    if (
      !entryAuthorized
      || (USES_LIVE_POLICY && !riskConfigHealthy)
      || atSendPrice <= 0
      || chaseExceeded(atSendPrice)
      || !atSendContract
      || atSendContract.id !== contract.id
      || atSendContract.name !== contract.name
    ) {
      await clearPendingOrderSubmission(entryClientOrderId);
      log(`  ${sym}: SKIP — final safety state changed before the durable order was sent`);
      return;
    }
    // Start the network request synchronously after the gate, quote, chase, and contract checks. There
    // is intentionally no awaited authentication, retry delay, or other yield in this critical section.
    const entryResponsePromise = fetch(`${ORDER_API}/order/placeorder`, {
      method: "POST",
      body: entryBody,
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${entryToken}` },
      signal: AbortSignal.timeout(15_000),
    });
    let entryOrderId: number | null = null;
    let fillResult: Awaited<ReturnType<typeof verifyOrderFill>> | null = null;
    try {
      entryOrderId = await resolveSubmittedOrder(entryResponsePromise, entryClientOrderId, `${sym} entry`);
    } catch (error) {
      if (error instanceof DefinitiveOrderSubmissionError) await clearPendingOrderSubmission(entryClientOrderId);
      throw error;
    }
    if (useLimit) log(`  ENTRY as marketable LIMIT ${limitPrice} (signal ${price.toFixed(2)}, cap ${entryCap.toFixed(2)} pts = ${(entryCap / tick).toFixed(0)} ticks / $${(entryCap * (CONTRACT_MULTIPLIERS[sym] || 5)).toFixed(2)} per contract), IOC`);

    // Confirm the entry filled BEFORE resting protective orders or tracking a position.
    // Only skip on a positively-confirmed rejection (no fill); unknown → fall back to
    // current behavior (track at estimated price) so we never abandon a real fill.
    if (!fillResult && entryOrderId) fillResult = await verifyOrderFill(entryOrderId, qty);
    if (!fillResult) {
      log(`  🚨 ${sym}: entry could not be resolved to either an order or a broker position`);
      notify(`🚨 ${MODE_TAG} ${sym}: entry reconciliation exhausted without a safe result. Check broker now.`, "general");
      return;
    }
    if (fillResult.status === "unknown") {
      // Stop a still-working order before reconciling. A returned order id is not proof of a fill,
      // and placing opposite-side brackets against an unknown entry can create a reverse position.
      if (!entryOrderId) throw new Error(`${sym} entry is unknown without an order id`);
      await cancelOrderUntilTerminal(entryOrderId, `${sym} entry`);

      const brokerPosition = await getBrokerPositionSnapshot(contract.id);
      const resolution = reconcileBrokerPosition(direction as "long" | "short", 0, brokerPosition);
      if (resolution.status === "increased") {
        fillResult = {
          status: "filled",
          price: resolution.netPrice > 0 ? resolution.netPrice : price,
          qty: resolution.quantity,
        };
        log(`  ${sym}: indeterminate entry reconciled from broker position (${fillResult.qty}x @ $${fillResult.price.toFixed(2)})`);
      } else if (resolution.status === "flat") {
        await clearPendingOrderSubmission(entryClientOrderId);
        log(`  ${sym}: indeterminate entry reconciled FLAT — no brackets placed, no position tracked`);
        void logExecutionQuality({ mode: ENGINE_MODE, sym, side, intended: price, fill: price, qty: 0, latencyMs: Date.now() - submitTs, status: "unknown_flat" });
        return;
      } else {
        log(`  🚨 ${sym}: entry state unresolved after broker reconciliation — no opposite-side orders placed; sync will adopt any real position`);
        notify(`🚨 ${MODE_TAG} ${sym}: entry state unresolved. No brackets were placed to avoid a reverse position. Check broker now.`, "general");
        void logExecutionQuality({ mode: ENGINE_MODE, sym, side, intended: price, fill: price, qty: 0, latencyMs: Date.now() - submitTs, status: "unknown_unresolved" });
        return;
      }
    }
    if (fillResult.status === "rejected") {
      await clearPendingOrderSubmission(entryClientOrderId);
      // An IOC that found no liquidity inside the cap is a MISS, not a broker rejection. It is the
      // designed outcome (a skipped trade is free), so it is logged and counted, never alerted on —
      // paging on a normal no-fill would train the alert to be ignored.
      if (useLimit && fillResult.reason === "Canceled") {
        log(`  ${sym}: NO FILL — nothing available inside the ${entryCap.toFixed(2)}-pt entry cap (limit ${limitPrice}). Skipped, no position, no cost.`);
        feedLog("skip", `${sym} ${direction} no fill — market outside the ${entryCap.toFixed(1)}-pt entry cap`);
        // Recorded so the miss RATE is measurable — that is the whole cost side of this change.
        // fill = intended (slippage 0, not a fake price) and qty = 0, so a miss can never distort a
        // slippage average; `status='no_fill_cap'` + `qty=0` is what identifies these rows.
        void logExecutionQuality({ mode: ENGINE_MODE, sym, side, intended: price, fill: price, qty: 0, latencyMs: Date.now() - submitTs, status: "no_fill_cap" });
        return;
      }
      log(`  ORDER REJECTED (${fillResult.reason}) — no fill, NOT opening ${sym} position (no orphan orders)`);
      notify(`⚠️ ${MODE_TAG} ${sym} entry REJECTED (${fillResult.reason}) — no position opened`);
      feedLog("skip", `${sym} ${direction} entry rejected (${fillResult.reason}) — no position`);
      return;
    }
    const fillConfirmed = fillResult.status === "filled";
    const entryPrice = fillConfirmed ? fillResult.price : price; // real fill price when known
    const fillQty = fillConfirmed ? fillResult.qty : qty;        // size protective orders to ACTUAL fill, never larger
    await recordDecision({
      sym, direction, setupType: setupContext?.setupType ?? "unknown", confidence: confidenceScore,
      verdict: "confirmed", aiConfidence: 0, reason: reasoning,
    });
    feedLog("trade", `**${MODE_TAG} ${direction.toUpperCase()} ${sym}** filled ${fillQty}x @ $${entryPrice.toFixed(2)} | ${confidenceScore}% confidence`);

    // ── RE-ANCHOR THE BRACKET TO THE ACTUAL FILL (2026-07-30) ────────────────────────────────
    // The stop was priced off the SIGNAL price, which is computed before the order exists. Any
    // slippage therefore landed on top of the intended risk instead of being absorbed by it: today's
    // MNQ filled 17.63 points above signal, so a 77.1-point stop became ~95 points of real exposure
    // — $189 against a $154 budget, 23% over, silently. Risk is defined as distance from where we
    // ACTUALLY got in, so anchor both legs there. Point distance (and therefore R:R) is unchanged;
    // only the absolute levels shift with the fill. Falls back to the signal anchor when the fill
    // price is unconfirmed, which is the old behaviour.
    if (fillConfirmed && entryPrice > 0) {
      stopPrice = roundToTick(sym, direction === "long" ? entryPrice - stopDist : entryPrice + stopDist);
      targetPrice = roundToTick(sym, direction === "long" ? entryPrice + targetDist : entryPrice - targetDist);
    }
    // EXECUTION TELEMETRY (Phase 0) — fire-and-forget; isolated so it can never affect the order
    void logExecutionQuality({ mode: ENGINE_MODE, sym, side, intended: price, fill: entryPrice, qty: fillQty, latencyMs: Date.now() - submitTs, status: fillResult.status, edgeKey: executionEdgeKey });

    // Protective STOP — retry once; for a real position this is non-negotiable.
    // Track and persist the confirmed fill BEFORE placing protection. A stop can fill immediately;
    // if it does, closePosition needs this state to account for the round trip, daily trade limit,
    // and realized P&L instead of silently losing the trade because the broker is already flat.
    positions.set(sym, {
      symbol: sym, contractId: contract.id, direction, quantity: fillQty,
      entryPrice, stopLoss: stopPrice, target: targetPrice,
      trailStop: null, reachedBreakeven: false,
      stopOrderId: null, targetOrderId: null, entryTime: Date.now(),
      entryStopLoss: stopPrice,
      scaledOut: false, originalQty: fillQty, consecutiveStops: 0,
      pyramided: false,
      entryRsi: setupContext?.rsi ?? 50,
      entryVwap: setupContext?.vwap ?? 0,
      entryTrend15m: setupContext?.trend15m ?? "flat",
      entryDayType: setupContext?.dayType ?? "unknown",
      entrySession: setupContext?.session ?? getSessionName(),
      entrySetupType: setupContext?.setupType ?? "unknown",
      emergencyWarningTick: 0,
    });
    dailyTradeCount++;
    await savePositionsForOrderRecovery();
    try {
      await prisma.autoTradeLog.create({ data: {
        symbol: `FUT:${sym}`,
        action: `${TRADE_ACTION_PREFIX}_${direction}`,
        qty: fillQty,
        price: entryPrice,
        reason: `[FUTURES ${sym}] ${reasoning}. Stop: $${stopPrice.toFixed(2)}, Target: $${targetPrice.toFixed(2)}. R:R ${rr.toFixed(1)}. Risk: $${(riskPer * fillQty).toFixed(0)}. Size: ${sizeMult.toFixed(1)}x. Fill: confirmed`,
        aiScore: confidenceScore,
        aiSignal: direction,
        orderId: entryOrderId ? String(entryOrderId) : null,
      }});
    } catch {}

    let stopOrderId: number | null = null;
    let stopVerified = false;
    for (let a = 0; a < 2 && stopOrderId === null; a++) {
      try {
        const submittedStopId = await submitRecoverableOrder({
          accountSpec: acct.name, accountId, action: closeSide, symbol: contract.id,
          orderQty: fillQty, orderType: "Stop", stopPrice, timeInForce: "GTC", isAutomated: true,
        }, `${sym} initial stop`, { kind: "stop", symbol: sym, contractId: contract.id });
        const tracked = positions.get(sym);
        if (tracked) tracked.stopOrderId = submittedStopId;
        await savePositionsForOrderRecovery();
        // placeorder returns an id even for orders the broker then REJECTS — confirm it's actually
        // live before trusting it as protection, else the flatten-safety below never fires.
        const protectionStatus = await protectionOrderStatus(submittedStopId);
        if (protectionStatus === "rejected") {
          if (tracked) tracked.stopOrderId = null;
          await savePositions();
          log(`  ${sym}: stop order #${submittedStopId} REJECTED by broker (attempt ${a + 1}) — retrying`);
          if (a === 0) await new Promise(r => setTimeout(r, 800));
          continue;
        }
        if (protectionStatus === "filled") {
          log(`  ${sym}: protective stop #${submittedStopId} filled immediately; entry is no longer open`);
          notify(`${MODE_TAG} ${sym}: protective stop filled immediately after entry. Recording the completed trade now.`);
          await closePosition(sym, stopPrice, "stop_loss", true);
          if (!positions.has(sym)) await clearPendingOrderSubmission(activePendingOrderSubmission?.clOrdId || "");
          return;
        }
        if (protectionStatus === "unknown") {
          const brokerPosition = await getBrokerPositionSnapshot(contract.id, 3);
          if (brokerPosition === null) {
            log(`  ${sym}: stop status unknown but broker is flat; recording the completed trade`);
            await closePosition(sym, stopPrice, "protection_flat", true);
            if (!positions.has(sym)) await clearPendingOrderSubmission(activePendingOrderSubmission?.clOrdId || "");
            return;
          }
          if (brokerPosition === undefined || Math.sign(brokerPosition.netPos) !== (direction === "long" ? 1 : -1)) {
            log(`  🚨 ${sym}: stop status and broker position are both unresolved; no additional opposite-side orders placed`);
            notify(`🚨 ${MODE_TAG} ${sym}: protection state unresolved after a confirmed entry. Check broker immediately.`, "general");
            return;
          }
          log(`  🚨 ${sym}: stop #${submittedStopId} status unverified while position remains open; flattening fail-closed`);
          notify(`🚨 ${MODE_TAG} ${sym}: broker stop could not be verified. Flattening the entry now.`, "general");
          await closePosition(sym, brokerPosition.netPrice || entryPrice, "protection_unverified");
          return;
        }
        stopOrderId = submittedStopId;
        stopVerified = true;
        await clearPendingOrderSubmission(activePendingOrderSubmission?.clOrdId || "");
      } catch { if (a === 0) await new Promise(r => setTimeout(r, 800)); }
    }

    // SAFETY: never hold a CONFIRMED position without a protective stop. If the stop couldn't be
    // placed, flatten the just-filled entry immediately rather than run naked.
    if (stopOrderId === null && fillConfirmed) {
      log(`  🚨 STOP PLACEMENT FAILED for ${sym} — flattening ${fillQty}x entry to avoid a naked position`);
      notify(`🚨 ${MODE_TAG} ${sym}: stop order FAILED — flattening entry (no naked position)`);
      await closePosition(sym, entryPrice, "stop_placement_failed");
      return;
    }
    if (stopOrderId === null) {
      // Fill UNCONFIRMED + stop failed: can't safely flatten (may hold nothing). Track so the
      // software hard-stop manages it, but alert loudly.
      log(`  ⚠️ ${sym}: stop placement failed, fill unconfirmed — tracking with SOFTWARE stop only`);
      notify(`⚠️ ${MODE_TAG} ${sym}: no broker stop (fill unconfirmed) — software stop active, watch it`);
    }

    let targetOrderId: number | null = null;
    if (stopVerified) {
      try {
        targetOrderId = await submitRecoverableOrder({
          accountSpec: acct.name, accountId, action: closeSide, symbol: contract.id,
          orderQty: fillQty, orderType: "Limit", price: targetPrice, timeInForce: "GTC", isAutomated: true,
        }, `${sym} target`, { kind: "target", symbol: sym, contractId: contract.id });
        const tracked = positions.get(sym);
        if (tracked) tracked.targetOrderId = targetOrderId;
        await savePositionsForOrderRecovery();
        await clearPendingOrderSubmission(activePendingOrderSubmission?.clOrdId || "");
      } catch (error) {
        if (activePendingOrderSubmission?.kind === "target" && activePendingOrderSubmission.phase === "rejected") {
          await clearPendingOrderSubmission(activePendingOrderSubmission.clOrdId);
        }
      }
    }

    const trackedPosition = positions.get(sym);
    if (trackedPosition) {
      trackedPosition.stopOrderId = stopOrderId;
      trackedPosition.targetOrderId = targetOrderId;
    }
    log(`Order #${entryOrderId ?? "reconciled-position"} ${fillConfirmed ? `FILLED @ $${entryPrice.toFixed(2)}` : "placed (fill unconfirmed — tracking at est)"} | Stop #${stopOrderId} | Target #${targetOrderId}`);
    notify(`${side} ${fillQty}x ${sym} @ $${entryPrice.toFixed(2)}${fillConfirmed ? "" : " (est)"} | Stop: $${stopPrice.toFixed(2)} | Target: $${targetPrice.toFixed(2)} | R:R ${rr.toFixed(1)}`);
    await savePositions();

    // Brain: update dashboard after trade entry (throttled)
    throttledBrainUpdate(`trade-entry-${sym}`);
  } catch (err) { log(`TRADE FAILED: ${err}`); }

}

// ── Heartbeat (tells dashboard the engine is alive) ─────

async function writeHeartbeat() {
  try {
    await refreshLiveMirrorEquity();
    const sizingEquity = riskSizingEquity();
    const payload = JSON.stringify({
      timestamp: new Date().toISOString(),
      startedAt: ENGINE_STARTED_AT,
      strategyVersion: STRATEGY_VERSION,
      deploymentId: process.env.RAILWAY_DEPLOYMENT_ID || null,
      ready: engineReady,
      registeredEdges: REALTIME_EDGES.length,
      enabledEdges: REALTIME_EDGES
        .filter((edge) => isEdgeEnabled(edge.key, ENGINE_MODE, edgeFlags))
        .map((edge) => edge.key),
      tickCount,
      mode: ENGINE_MODE,
      liveTradingArmed: IS_LIVE ? LIVE_TRADING_ARMED : false,
      operatorTradingEnabled: futuresTradingEnabled,
      riskConfigHealthy,
      positions: positions.size,
      dailyPnl: Math.round(dailyPnl),
      dailyTrades: dailyTradeCount,
      session: getSessionName(),
      mdHealth: wsConnected ? "websocket" : mdCircuitOpen ? "circuit_open" : mdConsecutiveFailures > 0 ? `degraded(${mdConsecutiveFailures})` : lastMdSource,
      // "Today's plan" telemetry — what the engine sees and what size it intends per symbol, so the
      // admin panel renders the ENGINE's numbers instead of recomputing them in the web app.
      equity: Math.round(tradovateEquity),
      sizingEquity: Math.round(sizingEquity),
      liveMirror: IS_DEMO && DEMO_LIVE_CLONE,
      liveMirrorFresh: IS_DEMO && DEMO_LIVE_CLONE ? sizingEquity > 0 : undefined,
      policy: USES_LIVE_POLICY ? "live" : "research",
      riskPerTrade: Math.round(sizingEquity * (riskConfig.riskPerTradePct / 100)),
      dailyLossLimit: Math.round(sizingEquity * (riskConfig.dailyLossLimitPct / 100)),
      maxTradesPerDay: riskConfig.maxTradesPerDay,
      maxContractsPerTrade: riskConfig.maxContractsPerTrade,
      symbols: Object.fromEntries([...planSnapshots.entries()]),
    });
    const heartbeatWritten = await prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT 1 AS locked FROM pg_advisory_xact_lock(hashtext(${HEARTBEAT_KEY}))`;
      const current = await tx.agentConfig.findUnique({ where: { key: HEARTBEAT_KEY } });
      const existing = current?.value
        ? JSON.parse(current.value) as { timestamp?: string; startedAt?: string; deploymentId?: string | null }
        : null;
      const existingOwner = existing?.startedAt
        ? `${existing.deploymentId || "local"}:${existing.startedAt}`
        : "";
      const existingAge = Date.now() - Date.parse(existing?.timestamp || "");
      if (existingOwner && existingOwner !== ORDER_OWNER_ID
        && Number.isFinite(existingAge) && existingAge < 90_000) {
        return false;
      }
      await tx.agentConfig.upsert({
        where: { key: HEARTBEAT_KEY },
        update: { value: payload },
        create: { key: HEARTBEAT_KEY, value: payload },
      });
      return true;
    });
    if (!heartbeatWritten) {
      futuresTradingEnabled = false;
      log(`[HEARTBEAT] Prior ${MODE_TAG} generation still owns the lease; this process remains entry-disabled`);
    }
    // Persist the tilt/trade-count circuit breaker so a deploy cannot silently re-arm an engine that
    // stopped itself. Written every heartbeat (cheap upsert) rather than only on change, so it can
    // never be missed. Restored on startup — see the [STARTUP] Tilt state block.
    await prisma.agentConfig.upsert({
      where: { key: `futures_tilt_state_${ENGINE_MODE}` },
      update: { value: JSON.stringify({ date: getETDateString(), consecutiveStops, pauseUntil: tiltPauseUntil === Infinity ? "Infinity" : tiltPauseUntil, trades: dailyTradeCount }) },
      create: { key: `futures_tilt_state_${ENGINE_MODE}`, value: JSON.stringify({ date: getETDateString(), consecutiveStops, pauseUntil: tiltPauseUntil === Infinity ? "Infinity" : tiltPauseUntil, trades: dailyTradeCount }) },
    }).catch(() => {});

    // Also persist position state (trailing stops, breakeven flags) every heartbeat
    if (positions.size > 0) await savePositions();
  } catch (error) {
    futuresTradingEnabled = false;
    log(`[HEARTBEAT] Write failed; entries disabled: ${error instanceof Error ? error.message : String(error)}`);
  }
}

// ── Position Sync ───────────────────────────────────────

async function syncPositions() {
  if (syncInFlight) return; // another reconcile is mid-flight — don't overlap (would double-cancel/double-log)
  syncInFlight = true;
  try {
    const tvPos = await apiFetch("/position/list") as { contractId: number; netPos: number; netPrice: number; timestamp: string }[];

    // Step 0 — SOFTWARE OCO (one-cancels-the-other): the instant one bracket leg fills, cancel its
    // sibling, so a leftover resting order can NEVER later re-open a naked position (the Jul 16-17
    // incident). We key off the tracked order IDs — a broker "Filled" status is authoritative (unlike
    // a transient empty /position/list read), so this fires the SAME tick with no miss-guard needed,
    // closing the ~25-50s window the position-based sweep (Step 1) leaves open. We deliberately do NOT
    // use Tradovate's native OSO bracket: our own code documents it as unreliable, and a hard exchange
    // link fights the in-place stop trailing/breakeven logic (which moves the stop while the trade is
    // live). This only ever CANCELS a sibling once its partner is confirmed FILLED — never touches a
    // pair that's still both working — and degrades safely to Step 1 if the order list is unavailable.
    let orderList: { id: number; contractId: number; ordStatus: string }[] = [];
    try { orderList = await apiFetch("/order/list") as typeof orderList; } catch {}
    if (orderList.length > 0) {
      // status lookup is contractId-scoped: a stale/reused order id must never act on another contract's order.
      const statusOf = (id: number | null, contractId: number) => (id == null ? null : orderList.find(o => o.id === id && o.contractId === contractId)?.ordStatus ?? null);
      // ONLY a true "Filled" confirms the leg executed and the position closed. "Completed"/"Cancelled"
      // are terminal states a MODIFIED stop (trailing/breakeven cancel-replace) also passes through, so
      // treating them as a fill would wrongly kill the sibling of a still-open position → naked risk.
      const isFilled = (id: number | null, contractId: number) => statusOf(id, contractId) === "Filled";
      const isResting = (id: number | null, contractId: number) => { const s = statusOf(id, contractId); return s === "Working" || s === "Accepted"; };
      for (const [sym, pos] of positions) {
        if (closingLocks.get(sym)) continue; // a close is already tearing this position down
        if (stopMoveLocks.get(sym)) continue; // a trail/breakeven modify is mid-flight — its stop id may be transiently terminal
        if (isFilled(pos.stopOrderId, pos.contractId) && isResting(pos.targetOrderId, pos.contractId)) {
          try { await apiFetch("/order/cancelorder", { method: "POST", body: JSON.stringify({ orderId: pos.targetOrderId }) }); log(`OCO: ${sym} stop filled → cancelled orphan target #${pos.targetOrderId}`); } catch (e) { log(`OCO: ${sym} failed to cancel orphan target #${pos.targetOrderId}: ${e}`); }
          pos.targetOrderId = null;
        } else if (isFilled(pos.targetOrderId, pos.contractId) && isResting(pos.stopOrderId, pos.contractId)) {
          try { await apiFetch("/order/cancelorder", { method: "POST", body: JSON.stringify({ orderId: pos.stopOrderId }) }); log(`OCO: ${sym} target filled → cancelled orphan stop #${pos.stopOrderId}`); } catch (e) { log(`OCO: ${sym} failed to cancel orphan stop #${pos.stopOrderId}: ${e}`); }
          pos.stopOrderId = null;
        }
      }
    }

    // Step 1: Remove engine positions that no longer exist on Tradovate
    for (const [sym, pos] of [...positions]) {
      if (tvPos.find(p => p.contractId === pos.contractId && p.netPos !== 0)) {
        syncMissCount.delete(sym); // confirmed still open on the broker → reset the miss counter
        continue;
      }
      {
        // Position NOT found on the broker — either a REAL close (its bracket filled) or a transient/empty read.
        // Skip if closePosition is already handling this symbol
        if (closingLocks.get(sym)) {
          log(`SYNC: ${sym} — close already in progress, skipping`);
          continue;
        }
        // GUARD (never assume): require 2 CONSECUTIVE "missing" reads before we reconcile-close and cancel
        // orders. A single transient/empty /position/list read must NOT false-close a real, open position
        // and rip out its protective stop. A genuine close stays missing and reconciles on the next cycle.
        const misses = (syncMissCount.get(sym) || 0) + 1;
        syncMissCount.set(sym, misses);
        if (misses < 2) { log(`SYNC: ${sym} absent from broker (miss ${misses}/2) — deferring reconcile one cycle`); continue; }
        syncMissCount.delete(sym);
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
          throttledBrainUpdate(`synced-close-${sym}`);
        }

        positions.delete(sym);
    syncMissCount.delete(sym); // clear reconcile miss-counter when a position leaves the book
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
            action: direction === "long" ? `${TRADE_ACTION_PREFIX}_long` : `${TRADE_ACTION_PREFIX}_short`,
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
        entryStopLoss: stopLoss,
        pyramided: false,
        entryRsi: 50, entryVwap: 0, entryTrend15m: "flat", entryDayType: "unknown", entrySession: getSessionName(),
        entrySetupType: "unknown",
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

    // Step 4: Cancel orphaned working orders with no matching position (engine or Tradovate)
    try {
      const allOrders = await apiFetch("/order/list") as { id: number; contractId: number; ordStatus: string }[];
      const working = allOrders.filter(o => o.ordStatus === "Working" || o.ordStatus === "Accepted");
      const activeContractIds = new Set<number>();
      for (const [, pos] of positions) activeContractIds.add(pos.contractId);
      for (const tp of tvPos) { if (tp.netPos !== 0) activeContractIds.add(tp.contractId); }
      const orphans = working.filter(o => !activeContractIds.has(o.contractId));
      for (const o of orphans) {
        try { await apiFetch("/order/cancelorder", { method: "POST", body: JSON.stringify({ orderId: o.id }) }); } catch (e) { log(`[SYNC] Failed to cancel orphan #${o.id}: ${e}`); }
      }
      if (orphans.length > 0) log(`[SYNC] Swept ${orphans.length} orphaned orders with no matching position`);
    } catch {}

    await savePositions();
  } catch (err) { log(`[SYNC] Position sync failed: ${err}`); }
  finally { syncInFlight = false; }
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

  // Fallback 1: DATABENTO HISTORICAL — the contract we actually trade, and already paid for.
  // Added 2026-07-29. Tradovate MD is not subscribed on this account, so preload ALWAYS fell straight
  // through to Yahoo — and Yahoo prices a DIFFERENT CONTRACT MONTH. On this restart it seeded gold at
  // "Last: $4068.40 | PDH:$4095.70 PDL:$4011.10" while Databento had gold at 4008.50: the whole
  // 549-bar buffer was ~60 points off, which is why the current price sat BELOW its own previous-day
  // low. Every indicator built on that buffer — ATR, VWAP, prev-day levels, opening range — was wrong,
  // and ATR drives stop distance and therefore position size.
  // DBN_MAP sends MGC→GC.v.0 / MNQ→NQ.v.0 / MES→ES.v.0 (continuous front-month), i.e. the same series
  // the live sidecar quotes, so preloaded bars and live ticks finally agree on one contract.
  // Fail-safe: returns [] without an API key or on any error, so the Yahoo path below still exists.
  if (bars.length === 0) {
    try {
      const { getDatabentoIntradayBars } = await import("../lib/databento");
      const dbnBars = await getDatabentoIntradayBars(sym, "5m", "5d");
      if (dbnBars.length > 0) {
        // NOTE: parseOhlcv in lib/databento.ts already emits `t` in SECONDS (it divides by 1000), which
        // is the same unit the Tradovate/Yahoo preload paths use here. Do NOT divide again.
        bars = dbnBars.map((b) => ({ t: b.t, o: b.o, h: b.h, l: b.l, c: b.c, v: b.v }));
        log(`  ${sym}: preloaded ${bars.length} bars from DATABENTO (correct contract)`);
      }
    } catch (err) {
      log(`  ${sym}: Databento preload failed: ${err instanceof Error ? err.message : err}`);
    }
  }

  // NO YAHOO PRELOAD (2026-07-29). This used to fill the buffer with up to 200 bars of a DIFFERENT
  // CONTRACT MONTH on every restart — the worst version of the bug, because it hit before the first
  // tick and poisoned ATR/RSI/VWAP/opening-range from bar zero. Starting with NO history is strictly
  // better: atr() returns 0 below 15 bars and onBarClose bails on `rawATR <= 0`, so the engine simply
  // waits, warms up on real ticks, and trades once it genuinely knows the instrument.
  if (bars.length === 0) {
    log(`  ${sym}: no Databento/Tradovate history — starting cold, will warm up on live ticks (no Yahoo substitute)`);
    return;
  }

  // Load into bar builder
  b.bars5m = bars.slice(-200);
  b.lastPrice = bars[bars.length - 1].c;

  // Bucket by the engine's ET ACCOUNTING DAY, not UTC (fixed 2026-08-19). toISOString() breaks the
  // day at UTC midnight = ~19:00/20:00 ET, which is inside eth_evening and hours before the real
  // 02:00 ET roll. A restart in that window (routine: evening redeploys, London hours) put part of
  // TODAY into prevDayBars — corrupting PDH/PDL/prevDayClose — and truncated sessionBars, which is
  // what VWAP is computed from. Every downstream level was wrong for the rest of the day.
  const todayStr = etAccountingDay(Date.now());
  const prevDayBars = bars.filter(bar => etAccountingDay(bar.t * 1000) < todayStr);
  const todayBars = bars.filter(bar => etAccountingDay(bar.t * 1000) === todayStr);

  if (prevDayBars.length > 0) {
    b.prevDayHigh = Math.max(...prevDayBars.map(x => x.h));
    b.prevDayLow = Math.min(...prevDayBars.map(x => x.l));
    b.prevDayClose = prevDayBars[prevDayBars.length - 1].c;
  }

  b.sessionBars = todayBars;
  b.barCount = todayBars.length;

  // OPENING RANGE = first 60 min of RTH, clock-gated — the same rule the live builder uses.
  // This used to take todayBars.slice(0,12), i.e. the first 12 bars after the 02:00 ET roll, which
  // is the LONDON hour, and it never set orBarCount — so the live builder (which only ever widens
  // the range with Math.max/min) merged the real 09:30 range into that stale overnight one for the
  // whole day. orSize feeds dayType, which gates setups, so this corrupted more than or_breakout.
  const rthBars = todayBars.filter(x => etHourOf(x.t * 1000) >= 9.5);
  const orBars = rthBars.slice(0, 12);
  b.orBarCount = orBars.length;
  b.openingRangeHigh = orBars.length ? Math.max(...orBars.map(x => x.h)) : 0;
  b.openingRangeLow = orBars.length ? Math.min(...orBars.map(x => x.l)) : 0;

  log(`  ${sym}: Loaded ${bars.length} bars | Last: $${b.lastPrice.toFixed(2)} | PDH:$${b.prevDayHigh.toFixed(2)} PDL:$${b.prevDayLow.toFixed(2)} | Today: ${todayBars.length} bars`);
}

async function preloadBars() {
  log("Pre-loading historical bars (Databento primary → Tradovate; no Yahoo substitute)...");

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

// 0 = NOT YET KNOWN, and that is deliberate (2026-07-29). This used to default to an optimistic
// $50,000, which the real balance only replaced ~60s after startup. Every risk limit is a multiple of
// this number, so during that window they were all ~10x too loose on the live account: risk/trade
// $1,500 instead of $157 (3% of $50k vs 3% of $5,227), aggregate drawdown kill $7,500 instead of
// $784, hard-loss backstop $2,500 instead of $261 — and because preload supplies 830 bars, ATR is
// live immediately, so a setup really could fire inside that minute. At 0 the sizing maths makes
// maxRisk 0, so the adaptive-stop path SKIPs the trade until the true balance lands. Never guess an
// account balance upward; not trading for one minute costs nothing, mis-sizing 10x does not.
let tradovateEquity = 0;
let lastTradovateEquityAt = 0;
let startOfDayBalance = 0; // Set at session reset, used for daily loss limit
let marginDriftAlerted = false; // OVERNIGHT_INITIAL_MARGIN self-audit — alert once, not every cycle

async function updateTradovateEquity() {
  try {
    const cashBalances = await apiFetch(`/cashBalance/getCashBalanceSnapshot?accountId=${accountId}`) as Record<string, number>;
    const fetchedEquity = Number(cashBalances?.totalCashValue);
    if (Number.isFinite(fetchedEquity) && fetchedEquity >= 0) {
      tradovateEquity = fetchedEquity;
      lastTradovateEquityAt = Date.now();
      updateTradingSymbols();
      log(`[EQUITY] Tradovate account equity: $${tradovateEquity.toLocaleString()}`);

      // SELF-AUDIT the overnight margin table against what the broker ACTUALLY charges. That table
      // now gates overnight size, and a hardcoded margin figure has already gone stale here once —
      // a comment claimed MGC was ~$1,000-1,150 when the real requirement was $2,242.90, i.e. we
      // would have authorised roughly double what the account could margin. Only the UNDER-estimate
      // direction is flagged: during RTH the exchange charges day-trade margin, so the broker
      // legitimately reports far LESS than this table, and warning on that would be pure noise.
      const brokerIM = Number(cashBalances.initialMargin ?? 0);
      if (brokerIM > 0 && positions.size > 0) {
        let expected = 0;
        let known = true;
        for (const [s, p] of positions) {
          const per = OVERNIGHT_INITIAL_MARGIN[s];
          if (!per) { known = false; break; }
          expected += per * p.quantity;
        }
        if (known && expected > 0 && brokerIM > expected * 1.2 && !marginDriftAlerted) {
          marginDriftAlerted = true;   // once per process — an alert that repeats every 5 min gets ignored
          const detail = [...positions.entries()].map(([s, p]) => `${p.quantity}x ${s}`).join(" + ");
          log(`⚠️ MARGIN TABLE STALE — broker charges $${brokerIM.toFixed(0)} initial for ${detail}, OVERNIGHT_INITIAL_MARGIN expects only $${expected.toFixed(0)}. Overnight sizing is UNDER-estimating margin; update the table.`);
          notify(`⚠️ Overnight margin table is under-estimating: broker $${brokerIM.toFixed(0)} vs assumed $${expected.toFixed(0)} for ${detail}. Overnight size may exceed what the account can margin.`, "general");
        }
      }
      // One-time Slack alert when the $4k ACH clears — the live account jumps from sub-$3k to funded.
      // Fires once (persisted flag), LIVE only. This is also the threshold that arms evening gold.
      if (IS_LIVE && tradovateEquity >= LIVE_EVENING_GOLD_MIN_EQUITY) {
        try {
          const flag = await prisma.agentConfig.findUnique({ where: { key: "live_ach_clear_notified" } });
          if (flag?.value !== "true") {
            await prisma.agentConfig.upsert({
              where: { key: "live_ach_clear_notified" },
              update: { value: "true" },
              create: { key: "live_ach_clear_notified", value: "true" },
            });
            await sendNotification(
              `💰 Funds cleared — live futures account is now $${Math.round(tradovateEquity).toLocaleString()}. Evening GOLD trading is now ARMED (auto-enabled above $${LIVE_EVENING_GOLD_MIN_EQUITY.toLocaleString()}). Consider resetting the track-record inception date for a clean official start.`,
              "futures",
            );
            log(`[ACH] Balance crossed $${LIVE_EVENING_GOLD_MIN_EQUITY} ($${tradovateEquity.toLocaleString()}) — sent funded alert; evening gold armed`);
          }
        } catch { /* best-effort alert */ }
      }
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
// Cross-asset context for PATTERN MEMORY only (2026-08-11). SetupVector always had dollarTrend /
// bondTrend fields, but every vector was stamped "flat" — two dead inputs the learner could never
// use. Sourced from Yahoo alongside VIX (indicative indices, NEVER on the price/order path; same
// rule as ^VIX). Trend = last vs a ~6h-old anchor, "flat" inside ±0.15% — coarse on purpose.
let dollarTrend: "rising" | "falling" | "flat" = "flat";
let bondTrend: "rising" | "falling" | "flat" = "flat";
let dxyAnchor = 0, dxyAnchorAt = 0, tnxAnchor = 0, tnxAnchorAt = 0;

async function updateVIX() {
  try {
    const yfTimeout = <T>(p: Promise<T>): Promise<T | null> =>
      Promise.race([p, new Promise<null>(r => setTimeout(() => r(null), 10_000))]);
    const [vixQ, vix3mQ, dxyQ, tnxQ] = await Promise.all([
      yfTimeout(getYfEngine().quote("^VIX")).catch(() => null),
      yfTimeout(getYfEngine().quote("^VIX3M")).catch(() => null),
      yfTimeout(getYfEngine().quote("DX-Y.NYB")).catch(() => null),   // dollar index — context only
      yfTimeout(getYfEngine().quote("^TNX")).catch(() => null),       // 10Y yield — context only
    ]);
    if (vixQ?.regularMarketPrice) currentVIX = vixQ.regularMarketPrice;
    if (vix3mQ?.regularMarketPrice) vix3m = vix3mQ.regularMarketPrice;
    const trendOf = (px: number | undefined, anchor: number, anchorAt: number): ["rising"|"falling"|"flat", number, number] => {
      if (!px || px <= 0) return ["flat", anchor, anchorAt];
      if (!anchor || Date.now() - anchorAt > 6 * 3600_000) return ["flat", px, Date.now()];   // (re)anchor
      const chg = (px - anchor) / anchor;
      return [chg > 0.0015 ? "rising" : chg < -0.0015 ? "falling" : "flat", anchor, anchorAt];
    };
    [dollarTrend, dxyAnchor, dxyAnchorAt] = trendOf(dxyQ?.regularMarketPrice, dxyAnchor, dxyAnchorAt);
    // NOTE: bondTrend tracks the YIELD direction (^TNX rising = bond PRICES falling). The vector
    // field is named bondTrend but stamped with yield direction — documented so nobody "fixes" it
    // silently; what matters for pattern matching is only that it is CONSISTENT.
    [bondTrend, tnxAnchor, tnxAnchorAt] = trendOf(tnxQ?.regularMarketPrice, tnxAnchor, tnxAnchorAt);

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
  let inFlight = false;
  return setInterval(() => {
    if (inFlight) return;
    inFlight = true;
    Promise.resolve(fn()).catch((err) => {
      log(`[SAFE-INTERVAL] ${label} threw: ${err}`);
    }).finally(() => {
      inFlight = false;
    });
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
  const port = parseInt(process.env.PORT || "3001", 10);
  const startTime = Date.now();

  const server = createServer((_req: unknown, res: { writeHead: (code: number, headers: Record<string, string>) => void; end: (body: string) => void }) => {
    const now = Date.now();
    const uptimeSeconds = Math.round((now - startTime) / 1000);
    const lastTickAge = tickCount > 0 ? Math.round((now - lastTickCheckTime) / 1000) : -1;
    const healthy = engineReady && riskConfigHealthy;

    const status = {
      mode: ENGINE_MODE,
      status: healthy ? "healthy" : "degraded",
      strategyVersion: STRATEGY_VERSION,
      startedAt: ENGINE_STARTED_AT,
      uptime: uptimeSeconds,
      tickCount,
      lastTickAgeSec: lastTickAge,
      positions: positions.size,
      dailyPnl: Math.round(dailyPnl),
      dailyTrades: dailyTradeCount,
      session: getSessionName(),
      md: wsConnected ? "websocket" : mdCircuitOpen ? "circuit_open" : mdConsecutiveFailures > 0 ? `degraded(${mdConsecutiveFailures})` : lastMdSource,
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
  log(`Mode: ${IS_LIVE ? "LIVE real money" : DEMO_LIVE_CLONE ? "DEMO live-account clone" : "DEMO research"} | Policy: ${USES_LIVE_POLICY ? "live sessions/risk/gates" : "24/7 research"} | Data: Databento live_quotes → Tradovate (1s), NO Yahoo price fallback | Orders: ${IS_LIVE ? "LIVE" : "DEMO"} Tradovate`);

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
  await recoverPendingOrderSubmissionOnStartup();
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
    // Prevent checkSessionReset() from re-firing and overwriting the restored SOD.
    // Without this, lastResetDate is "" on restart → session reset fires on next tick →
    // overwrites SOD with current equity → Today P&L loses pre-restart trades.
    // Only set if past the threshold — before the roll hour, we WANT the session reset to fire.
    // MUST use the same constant as checkSessionReset(): if these two ever disagree, a restart in the
    // gap either re-fires the reset mid-session (wiping the SOD baseline and losing the day's P&L) or
    // suppresses a reset that was still owed. They are one decision, so they read one number.
    const startupETH = getETHour();
    if (startupETH >= SESSION_RESET_ET_HOUR) lastResetDate = getETDateString();
    if (startupETH >= 15.833) lastEODDate = getETDateString();
    log(`[STARTUP] Loss-limit baseline restored: SOD $${startOfDayBalance.toFixed(2)}, intraday P&L $${dailyPnl.toFixed(2)}`);

    // RESTORE THE TILT PAUSE TOO (2026-07-30). dailyPnl survived a restart but the tilt state did
    // NOT — consecutiveStops and tiltPauseUntil are plain module vars, so every deploy silently
    // re-armed an engine that had deliberately stopped itself. Observed live today: after two −1R
    // stops the engine set Tilt:PAUSED(2 stops), a deploy reset it to Tilt:ok, and it took two more
    // trades inside the same session. A circuit breaker a routine deploy can clear is not a circuit
    // breaker. dailyTradeCount is restored for the same reason — it gates maxTradesPerDay.
    const tiltRaw = await prisma.agentConfig.findUnique({ where: { key: `futures_tilt_state_${ENGINE_MODE}` } });
    if (tiltRaw?.value) {
      const t = JSON.parse(tiltRaw.value) as { date?: string; consecutiveStops?: number; pauseUntil?: number | string; trades?: number };
      if (t.date === getETDateString()) {   // only same-session state; a new day resets legitimately
        consecutiveStops = t.consecutiveStops ?? 0;
        // SESSION_DONE is stored as the STRING "Infinity" — JSON.stringify turns real Infinity into
        // null, which would silently downgrade a rest-of-session halt into no pause at all.
        tiltPauseUntil = t.pauseUntil === "Infinity" ? Infinity : (typeof t.pauseUntil === "number" ? t.pauseUntil : 0);
        dailyTradeCount = t.trades ?? 0;
        const left = tiltPauseUntil === Infinity ? "rest of session"
          : tiltPauseUntil > Date.now() ? `${Math.ceil((tiltPauseUntil - Date.now()) / 60_000)} min` : "expired";
        log(`[STARTUP] Tilt state restored: ${consecutiveStops} consecutive stops, pause ${left}, ${dailyTradeCount} trades today`);
      }
    }
  } catch {}
  await updateVIX();
  log(`VIX: ${currentVIX.toFixed(1)}`);
  await updateEconomicCalendar();
  await updateCrossAssetSignals();
  await updateEarningsWeekFilter();
  await updateSectorRotation();

  // Engine mode set by ENGINE_MODE env var. Demo: 24/7 learning. Live: RTH prime only.

  // Start Tradovate WebSocket for real-time MD (requires CME data subscription)
  // Falls back to Databento live_quotes polling if WebSocket fails — same contract either way
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
            log("[WS-MD] First quote received — real-time streaming confirmed, Databento polling paused");
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
          log("[WS-MD] Disconnected — Databento polling resumed");
        },
        onError: (err) => {
          wsConnected = false;
          if (err.includes("inaccessible") || err.includes("UnknownSymbol")) {
            log("[WS-MD] CME market data not accessible via API — Databento live_quotes is the real-time source. Contact Tradovate support.");
          } else {
            log("[WS-MD] Error: " + err);
          }
          tradovateWS?.destroy();
          tradovateWS = null;
        },
      });
      tradovateWS.connect();
      log("[WS-MD] WebSocket connecting... (Databento polling active meanwhile)");
    }
  } catch (err) {
    log(`[WS-MD] Failed to start WebSocket: ${err} — Databento polling active`);
  }

  // Start Databento/Tradovate polling (pauses automatically when the WebSocket is active)
  pollIntervalRef = safeInterval(pollPrices, POLL_INTERVAL_MS, "pollPrices");
  safeInterval(checkSessionReset, 60_000, "checkSessionReset");
  safeInterval(syncPositions, 30_000, "syncPositions");
  // No live position sync needed — each engine manages its own positions
  safeInterval(writeHeartbeat, 60_000, "writeHeartbeat");
  safeInterval(updateVIX, 300_000, "updateVIX");
  safeInterval(updateTradovateEquity, 600_000, "updateTradovateEquity"); // every 10min
  safeInterval(loadRiskConfig, 300_000, "loadRiskConfig"); // refresh risk rules from DB every 5min
  safeInterval(async () => { await refreshOperatorTradingGate(); }, 15_000, "operatorTradingGate");
  safeInterval(resolveContracts, 300_000, "resolveContracts"); // fail-closed symbols retry automatically
  safeInterval(sweepPhantomCloseRows, 1800_000, "sweepPhantoms"); // auto-clean phantom close-rows every 30min
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
    // MD status must not read "ok" while a symbol is unpriced — it did exactly that for the 20+
    // minutes gold was being quoted off the wrong contract, which is how this went unnoticed.
    const unpricedNow = SYMBOLS.filter(s => !isRealtimePriced(s));
    const mdStatus = mdCircuitOpen ? "CIRCUIT_OPEN"
      : mdConsecutiveFailures > 0 ? `degraded(${mdConsecutiveFailures})`
      : unpricedNow.length > 0 ? `UNPRICED:${unpricedNow.join("/")}`
      : "ok";
    const tiltStatus = tiltPauseUntil === Infinity ? "SESSION_DONE" : Date.now() < tiltPauseUntil ? `PAUSED(${consecutiveStops} stops)` : "ok";
    const prices = SYMBOLS.map(s => {
      const b = barBuilders.get(s);
      // Flag the two states that must never be mistaken for a tradable price: no fresh quote (!) and
      // indicators still carrying a feed discontinuity (q<n>).
      const q = quarantineBars.get(s) ?? 0;
      const mark = `${!isRealtimePriced(s) ? "!" : ""}${q > 0 ? `q${q}` : ""}`;
      return `${s}:$${b?.lastPrice?.toFixed(2) || "—"}/${b?.bars5m.length || 0}b${mark}`;
    }).join(" ");
    const macroStatus = macroBlockReason || "clear";
    log(`STATUS: ${session.toUpperCase()} | ${vix.label} | ${crossAssetSummary || "No macro"} | Macro:${macroStatus} | Ticks:${tickCount} | Pos:${positions.size}/${riskConfig.maxConcurrentPositions} | P&L:$${dailyPnl.toFixed(0)} | ${dailyTradeCount}/${riskConfig.maxTradesPerDay} | MD:${mdStatus} | Tilt:${tiltStatus} | ${prices}`);
  }, 120_000, "statusLog");

  // First poll immediately
  await pollPrices();
  engineReady = true;
  await writeHeartbeat();
  log("Engine ready — scanning for setups on every 5-min bar close...");
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
