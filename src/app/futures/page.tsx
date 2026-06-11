"use client";

import { useState, useEffect, useCallback, useMemo, useRef } from "react";
import dynamic from "next/dynamic";
import useSWR from "swr";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { ASSET_CLASSES, assetClassesIn, filterByAssetClass, type AssetClass } from "@/lib/asset-classes";
import { DepthTapeView } from "@/components/databento/depth-tape-view";

const modeFetcher = (url: string) => fetch(url).then((r) => r.json());

const FuturesChart = dynamic(
  () =>
    import("@/components/charts/futures-chart").then((mod) => ({
      default: mod.FuturesChart,
    })),
  { ssr: false }
);

// ── Types ──────────────────────────────────────────────

interface FuturesQuote {
  symbol: string;
  yahooSymbol: string;
  name: string;
  multiplier: number;
  tickSize: number;
  margin: number;
  price: number;
  change: number;
  changePercent: number;
  prevClose: number;
  open: number;
  high: number;
  low: number;
  volume: number;
  bid: number;
  ask: number;
  timestamp: string;
}

interface FuturesStatus {
  connected: boolean;
  accountId?: string;
  accountName?: string;
  message?: string;
}

interface FuturesResult {
  trades: { symbol: string; action: string; contracts: number; price: number; stopLoss: number; target: number; reasoning: string; success: boolean }[];
  managed: number;
  details: string[];
}

interface FuturesPosition {
  id: number;
  contractName: string;
  symbol: string;
  direction: "long" | "short";
  quantity: number;
  entryPrice: number;
  currentPrice: number;
  unrealizedPnl: number;
  stopLoss: number | null;
  target: number | null;
  pctToStop: number | null;
  pctToTarget: number | null;
  multiplier: number;
  setup: string | null;
  aiScore: number | null;
  openedAt: string;
}

interface FuturesAccount {
  balance: number;
  netLiq: number;
  realizedPnl: number;
  unrealizedPnl: number;
  marginUsed: number;
}

interface ActivityLog {
  id: string;
  symbol: string;
  action: string;
  qty: number;
  price: number | null;
  pnl: number | null;
  reason: string;
  aiScore: number | null;
  time: string;
}

interface TradovateFill {
  id: number;
  orderId: number;
  symbol: string;
  action: string;
  qty: number;
  price: number;
  time: string;
  tradeDate: { year: number; month: number; day: number };
}

interface FillBasedPnl {
  totalPnl: number;
  tradeCount: number;
  wins: number;
  losses: number;
  roundTrips: { symbol: string; direction: string; qty: number; entryPrice: number; exitPrice: number; pnl: number; entryTime: string; exitTime: string }[];
}

interface PositionsData {
  connected: boolean;
  account: FuturesAccount | null;
  positions: FuturesPosition[];
  orders: { id: number; action: string; type: string; qty: number; status: string }[];
  fills?: TradovateFill[];
  fillCount?: number;
  fillBasedPnl?: FillBasedPnl;
  activity: ActivityLog[];
  engineStatus?: { alive: boolean; lastHeartbeat: string | null; ageMinutes: number };
  startOfDayBalance?: number | null;
  todayTradesPnl?: number | null;
  startingCapital?: number;
  viewMode?: string;
  balanceHistory?: { date: string; startBalance: number | null; endBalance: number | null }[];
  riskMetrics?: { dailyLossLimit: number; maxTradesPerDay: number; riskPerTrade: number; simEquity: number; todayTradeCount: number } | null;
}

interface BacktestSetup {
  setup: string;
  trades: number;
  wins: number;
  losses: number;
  winRate: number;
  avgWin: number;
  avgLoss: number;
  profitFactor: number;
  totalPnl: number;
  maxDrawdown: number;
  avgRMultiple: number;
  avgHoldBars: number;
  sharpe: number;
  verdict: "keep" | "optimize" | "kill";
}

interface BacktestData {
  symbol: string;
  period: string;
  totalBars: number;
  tradingDays: number;
  setups: BacktestSetup[];
  equity: number[];
  summary: {
    totalTrades: number;
    winRate: number;
    profitFactor: number;
    totalPnl: number;
    maxDrawdown: number;
    sharpe: number;
    bestSetup: string;
    worstSetup: string;
  };
}

// ── Constants ──────────────────────────────────────────

// Demo: equity indexes (active 5m strategy) + crypto micros via strategy registry.
// MBT trades NR4 daily edge; MET/BFF/MXR/MSL are observation-only (sidecar streams price, no signal).
const DEMO_CONTRACTS = ["ES", "NQ", "GC", "MBT", "MET", "BFF", "MXR", "MSL"];
// Live: MNQ only — mirrors demo's NQ at 1/10 size (the sole instrument live trades; auto-upgrades to NQ at $60k).
const LIVE_CONTRACTS = ["MNQ"];

const STRATEGIES = [
  { name: "Gap Fill", priority: 1, confidence: "78%", when: "First 30 min", desc: "Fade small gaps (<10pts) targeting prior day close. 78% fill rate on ES." },
  { name: "IB Breakout", priority: 2, confidence: "75%+", when: "After 10:30 AM", desc: "Break above/below 60-min Initial Balance with volume + 15m trend alignment." },
  { name: "Failed IB Breakout", priority: 3, confidence: "73%", when: "After IB break fails", desc: "Price tests IB high/low, returns to range. Fade to IB midpoint." },
  { name: "Trend Continuation", priority: 4, confidence: "72%", when: "Morning/Afternoon", desc: "Pullback to EMA9 in trending market. Best backtest setup (67% WR)." },
  { name: "Extreme RSI Bounce", priority: 5, confidence: "70%", when: "RSI <25 or >75", desc: "Exhaustion reversal on declining volume. Any session, any day type." },
];

const DEMO_RISK_RULES = [
  "8% risk/trade ($4,000) — ES, NQ, GC",
  "Up to 10 contracts/trade, 8 total open",
  "ALL SESSIONS: 24/5 learning (Sun 6PM–Fri 5PM ET)",
  "$7,500 daily loss limit (15% of $50K)",
  "20 trades/day base, 40 with A+ override",
  "AI hard gate — only A/A+ setups (60%+ conf)",
  "Tilt: pause after 2 stops, A+ overrides",
  "Brain learns from every trade — vault syncs",
  "25% drawdown kill ($12,500) → lockdown",
  "No re-entry on stopped symbols",
];
const LIVE_RISK_RULES = [
  "8% risk/trade ($80) — MES, MNQ only",
  "Scale out 50% at 1R, trail rest for runners",
  "TWO WINDOWS: 9:45-11:30 AM + 2:00-3:30 PM",
  "$150 daily loss limit (15% of $1K)",
  "Max 3 MES/trade, 6 trades/day",
  "AI hard gate — only A/A+ setups (80%+ conf)",
  "Tilt: pause after 2 stops, halt after 3",
  "Paper trades outside windows (learning mode)",
  "25% drawdown kill ($250) → lockdown",
  "No re-entry on stopped symbols",
];

// ── Helpers ────────────────────────────────────────────

function pnlColor(val: number) {
  return val > 0 ? "text-emerald-400" : val < 0 ? "text-red-400" : "text-muted-foreground";
}

function formatNum(n: number, decimals = 2) {
  return n.toLocaleString(undefined, { minimumFractionDigits: decimals, maximumFractionDigits: decimals });
}

/** Format a date/time string in Eastern Time (futures market timezone) */
function formatET(iso: string, opts?: { dateOnly?: boolean }) {
  const d = new Date(iso);
  if (opts?.dateOnly) return d.toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric", timeZone: "America/New_York" });
  return d.toLocaleString("en-US", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", timeZone: "America/New_York" });
}

function formatVol(v: number) {
  if (v >= 1_000_000) return `${(v / 1_000_000).toFixed(1)}M`;
  if (v >= 1_000) return `${(v / 1_000).toFixed(1)}K`;
  return String(v);
}

// ── Component ──────────────────────────────────────────

export default function FuturesPage() {
  const [quotes, setQuotes] = useState<FuturesQuote[]>([]);
  const [status, setStatus] = useState<FuturesStatus | null>(null);
  const [posData, setPosData] = useState<PositionsData | null>(null);
  const [result, setResult] = useState<FuturesResult | null>(null);
  const [running, setRunning] = useState(false);
  const [modeSwitching, setModeSwitching] = useState(false);

  // Subscribe to the global mode SWR cache so this page reacts instantly when the top-bar toggles
  // demo↔live (instead of waiting up to 10s for the positions poll to carry the new mode).
  const { data: modeData } = useSWR<{ modes: Record<string, string> }>("/api/trading-mode", modeFetcher, { refreshInterval: 30000 });
  const swrLiveView = modeData?.modes?.futures === "live";
  // isLiveView prefers the SWR signal (authoritative + instant) and falls back to posData while
  // SWR is loading. This eliminates the stale-view-mode window during a toggle.
  const isLiveView = modeData ? swrLiveView : posData?.viewMode === "live";
  const ALL_CONTRACTS = isLiveView ? LIVE_CONTRACTS : DEMO_CONTRACTS;
  const RISK_RULES = isLiveView ? LIVE_RISK_RULES : DEMO_RISK_RULES;
  // Asset class tab filter — only show tabs for classes actually present
  const availableAssetClasses = useMemo(() => assetClassesIn(ALL_CONTRACTS), [ALL_CONTRACTS]);
  const [activeAssetClass, setActiveAssetClass] = useState<AssetClass>(
    availableAssetClasses[0]?.id ?? "equity_index_futures",
  );
  const CONTRACTS = useMemo(
    () => filterByAssetClass(ALL_CONTRACTS, activeAssetClass),
    [ALL_CONTRACTS, activeAssetClass],
  );
  const [selectedContract, setSelectedContract] = useState("ES");
  const [activeTab, setActiveTab] = useState<"chart" | "depth" | "strategy" | "backtest">("chart");
  // Chart mode — Lightweight only (TradingView removed)
  const [backtest, setBacktest] = useState<BacktestData | null>(null);
  const [backtestLoading, setBacktestLoading] = useState(false);
  const [historyPeriod, setHistoryPeriod] = useState<"today" | "week" | "month" | "all">("today");

  // ── Data Loading ─────────────────────────────────────

  const loadQuotes = useCallback(async () => {
    try {
      const res = await fetch("/api/futures/quotes");
      const data = await res.json();
      if (Array.isArray(data)) setQuotes(data);
    } catch { /* ignore */ }
  }, []);

  const loadPositions = useCallback(async () => {
    try {
      const res = await fetch("/api/futures/positions");
      const data = await res.json();
      if (data && !data.error) setPosData(data);
    } catch { /* ignore */ }
  }, []);

  const loadStatus = useCallback(async () => {
    try {
      const statusRes = await fetch("/api/futures").then((r) => r.json()).catch(() => ({ connected: false }));
      setStatus(statusRes);
    } catch { /* ignore */ }
  }, []);

  // Reset selected contract when view mode or asset class changes
  useEffect(() => {
    if (CONTRACTS.length > 0 && !CONTRACTS.includes(selectedContract)) {
      setSelectedContract(CONTRACTS[0]);
    }
  }, [isLiveView, activeAssetClass, CONTRACTS, selectedContract]);

  // If the current asset class becomes unavailable (e.g., live mode has no crypto), snap to first
  useEffect(() => {
    if (!availableAssetClasses.some((ac) => ac.id === activeAssetClass) && availableAssetClasses[0]) {
      setActiveAssetClass(availableAssetClasses[0].id);
    }
  }, [availableAssetClasses, activeAssetClass]);

  useEffect(() => {
    loadQuotes();
    loadStatus();
    loadPositions();
    // Refresh quotes every 15s, positions every 10s, status every 30s
    const quoteInterval = setInterval(loadQuotes, 15000);
    const posInterval = setInterval(loadPositions, 10000);
    const statusInterval = setInterval(loadStatus, 30000);
    return () => { clearInterval(quoteInterval); clearInterval(posInterval); clearInterval(statusInterval); };
  }, [loadQuotes, loadStatus, loadPositions]);

  // When the global view mode flips (demo↔live), refresh all page data immediately and clear
  // stale positions/quotes so we never render the wrong-mode data for the 10s poll window.
  const prevLiveViewRef = useRef<boolean | null>(null);
  useEffect(() => {
    if (modeData === undefined) return; // wait for SWR first load
    if (prevLiveViewRef.current === null) {
      prevLiveViewRef.current = swrLiveView;
      return;
    }
    if (prevLiveViewRef.current !== swrLiveView) {
      prevLiveViewRef.current = swrLiveView;
      // Show transient loading indicator — keep old data visible while new data loads so the
      // panel never goes blank. setResult cleared since it's mode-specific (agent run output).
      setModeSwitching(true);
      setResult(null);
      // Brief delay (~400ms) so the server-side mode write commits before we re-fetch — otherwise
      // we'd race the POST and pull positions for the OLD mode. Matches the same 300ms guard the
      // top-bar uses when revalidating other endpoints.
      const t = setTimeout(() => {
        Promise.all([loadQuotes(), loadPositions(), loadStatus()]).finally(() => {
          setModeSwitching(false);
        });
      }, 400);
      return () => clearTimeout(t);
    }
  }, [swrLiveView, modeData, loadQuotes, loadPositions, loadStatus]);

  const runAgent = async () => {
    setRunning(true);
    try {
      const res = await fetch("/api/futures", { method: "POST" });
      setResult(await res.json());
    } catch (err) {
      setResult({ trades: [], managed: 0, details: [`Error: ${err}`] });
    }
    setRunning(false);
    loadStatus();
    loadPositions();
  };

  // ── Derived data ─────────────────────────────────────

  const selectedQuote = quotes.find((q) => q.symbol === selectedContract);
  const allTrades = posData?.activity || [];
  const fillPnl = posData?.fillBasedPnl;

  // DB trades — clean slate, no exclusions on new account
  const closedTrades = allTrades.filter((t) => t.pnl != null);
  const wins = closedTrades.filter((t) => (t.pnl || 0) > 0);
  const losses = closedTrades.filter((t) => (t.pnl || 0) < 0);

  // Fill-based round trips from Tradovate (source of truth for per-trade stats)
  const filteredFills = {
    tradeCount: (fillPnl?.roundTrips || []).length,
    wins: (fillPnl?.roundTrips || []).filter((rt) => rt.pnl > 0).length,
    losses: (fillPnl?.roundTrips || []).filter((rt) => rt.pnl < 0).length,
    totalPnl: (fillPnl?.roundTrips || []).reduce((s, rt) => s + rt.pnl, 0),
    roundTrips: fillPnl?.roundTrips || [],
  };

  // DB trades have full history (all sessions). Fill-based round trips only cover the current
  // Tradovate session, so using them alone would drop older trades and inflate win rate.
  // Use DB trades for trade count / win rate; fill round trips for per-trade detail only.
  const tradeCount = closedTrades.length || filteredFills.tradeCount;
  const winCount = closedTrades.length > 0 ? wins.length : filteredFills.wins;
  const lossCount = closedTrades.length > 0 ? losses.length : filteredFills.losses;
  // Total P&L: balance - starting capital (mode-aware, no exclusions on new account)
  const STARTING_CAPITAL = posData?.startingCapital ?? 50_000;
  const accountPnl = posData?.account?.balance ? posData.account.balance - STARTING_CAPITAL : null;
  const totalPnl = accountPnl ?? (closedTrades.length > 0 ? closedTrades.reduce((s, t) => s + (t.pnl || 0), 0) : filteredFills.totalPnl);
  const avgWin = wins.length > 0 ? wins.reduce((s, t) => s + (t.pnl || 0), 0) / wins.length : 0;
  const avgLoss = losses.length > 0 ? losses.reduce((s, t) => s + (t.pnl || 0), 0) / losses.length : 0;
  // Best/worst from fill-based round trips (accurate) with DB fallback
  const bestRoundTrip = filteredFills.roundTrips.length > 0
    ? filteredFills.roundTrips.reduce((best, rt) => rt.pnl > best.pnl ? rt : best, filteredFills.roundTrips[0])
    : null;
  const worstRoundTrip = filteredFills.roundTrips.length > 0
    ? filteredFills.roundTrips.reduce((worst, rt) => rt.pnl < worst.pnl ? rt : worst, filteredFills.roundTrips[0])
    : null;
  const bestTrade = bestRoundTrip
    ? { pnl: bestRoundTrip.pnl, symbol: `FUT:${bestRoundTrip.symbol}` }
    : closedTrades.reduce((best, t) => (t.pnl || 0) > (best?.pnl || -Infinity) ? t : best, closedTrades[0]);
  const worstTrade = worstRoundTrip
    ? { pnl: worstRoundTrip.pnl, symbol: `FUT:${worstRoundTrip.symbol}` }
    : closedTrades.reduce((worst, t) => (t.pnl || 0) < (worst?.pnl || Infinity) ? t : worst, closedTrades[0]);

  // ── P&L Calculations — ALL from Tradovate balance, NEVER from DB trade sums ──
  // DB trade P&L values are unreliable (logged $4,575 losses vs actual $2,210).
  // The ONLY source of truth is the Tradovate account balance.
  const now = new Date();
  // Use UTC dates everywhere to match balance snapshot keys
  const todayUTC = now.toISOString().slice(0, 10);
  const todayStart = new Date(todayUTC + "T00:00:00Z");
  const weekStartDate = new Date(todayStart);
  weekStartDate.setUTCDate(weekStartDate.getUTCDate() - weekStartDate.getUTCDay());
  const weekStart = weekStartDate;
  const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));

  // Trade counts (just for display — these come from DB and are approximate)
  const dailyTrades = closedTrades.filter((t) => t.time >= todayStart.toISOString()).length;
  const weeklyTrades = closedTrades.filter((t) => t.time >= weekStart.toISOString()).length;
  const monthlyTrades = closedTrades.filter((t) => t.time >= monthStart.toISOString()).length;

  // Daily P&L: prefer actual trade fill sums (reliable), fallback to balance delta
  const currentBalance = posData?.account?.balance;
  const startOfDayBalance = posData?.startOfDayBalance;
  const tradePnl = posData?.todayTradesPnl;
  const unrealizedPnl = posData?.account?.unrealizedPnl || 0;
  const calendarDayPnl = (startOfDayBalance != null && currentBalance != null)
    ? currentBalance - startOfDayBalance
    : null;
  const dailyPnl = tradePnl != null
    ? tradePnl + unrealizedPnl
    : (calendarDayPnl ?? 0);

  // Balance history for period P&L
  const balanceHistory = posData?.balanceHistory || [];
  // Period P&L from balance history — clean account, no exclusions.
  // Guard: ignore any startBalance < 10% of starting capital — these are corrupted entries from the
  // live account ($994-$1009) accidentally written to the demo vault, which inflated "This Week"
  // to $66k by computing demo_balance($67k) - live_balance($1k) instead of the real delta.
  const computePeriodPnlFromBalance = (periodStartDate: Date): number | null => {
    if (currentBalance == null) return null;
    const minSane = STARTING_CAPITAL * 0.1; // below 10% = corrupted (e.g. live $1K written to demo)
    const maxSane = STARTING_CAPITAL * 20;  // above 20x = corrupted (e.g. demo $50K written to live $1K)
    const periodKey = `${periodStartDate.getUTCFullYear()}-${String(periodStartDate.getUTCMonth() + 1).padStart(2, "0")}-${String(periodStartDate.getUTCDate()).padStart(2, "0")}`;
    const sorted = [...balanceHistory].sort((a, b) => a.date.localeCompare(b.date));
    const startSnapshot = sorted.find((b) => b.date >= periodKey && b.startBalance != null && b.startBalance >= minSane && b.startBalance <= maxSane);
    if (startSnapshot?.startBalance != null) {
      return currentBalance - startSnapshot.startBalance;
    }
    return accountPnl;
  };
  const adjustedWeeklyPnl = computePeriodPnlFromBalance(weekStart) ?? (accountPnl ?? 0);
  const adjustedMonthlyPnl = computePeriodPnlFromBalance(monthStart) ?? (accountPnl ?? 0);

  return (
    <div className="space-y-4 animate-fade-up">
      {/* ── Header ── */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-bold tracking-tight">Futures</h1>
          <p className="text-[11px] text-muted-foreground/50">
            Tradovate {isLiveView ? "micro futures — MES, MNQ" : "futures — ES, NQ, GC"}
            {status?.connected && (
              <span className="text-emerald-400 ml-2">Tradovate Connected</span>
            )}
            {posData?.engineStatus?.alive && (
              <span className="text-blue-400 ml-2 inline-flex items-center gap-1">
                <span className="relative flex h-1.5 w-1.5"><span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-blue-400 opacity-75" /><span className="relative inline-flex rounded-full h-1.5 w-1.5 bg-blue-400" /></span>
                Railway Engine Live
              </span>
            )}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <div className="flex items-center gap-1.5">
            <span className={`w-2 h-2 rounded-full ${status?.connected ? "bg-emerald-500 animate-pulse" : "bg-amber-500"}`} />
            <span className="text-[10px] text-muted-foreground/60">
              {status?.connected ? status.accountName : "Tradovate pending"}
            </span>
          </div>
          <Button onClick={runAgent} disabled={running || !status?.connected} size="sm" variant="outline" className="text-xs h-7">
            {running ? "Running..." : "Run Agent"}
          </Button>
        </div>
      </div>

      {/* ── Architecture truth: Databento data · Tradovate execution · environment ── */}
      <div className="flex flex-wrap items-center gap-2 text-[10px] -mt-1">
        <span className={`px-1.5 py-0.5 rounded font-bold border ${isLiveView ? "bg-red-500/15 text-red-400 border-red-500/30" : "bg-amber-500/15 text-amber-400 border-amber-500/30"}`}>
          {isLiveView ? "LIVE · $1K real money — validating execution, not proven alpha" : "DEMO · RESEARCH LAB — P&L is not proof"}
        </span>
        {modeSwitching && (
          <span className="px-1.5 py-0.5 rounded font-bold border bg-blue-500/15 text-blue-300 border-blue-500/30 inline-flex items-center gap-1">
            <span className="relative flex h-1.5 w-1.5">
              <span className="animate-ping absolute inline-flex h-full w-full rounded-full opacity-75 bg-blue-400" />
              <span className="relative inline-flex rounded-full h-1.5 w-1.5 bg-blue-400" />
            </span>
            Switching view…
          </span>
        )}
        <span className="px-1.5 py-0.5 rounded border bg-cyan-500/10 text-cyan-300 border-cyan-500/30" title="Chart bars from Databento (~7-min historical). The engine's real-time Databento feed activates after 4 PM.">Databento = market data</span>
        <span className={`px-1.5 py-0.5 rounded border ${status?.connected ? "bg-emerald-500/10 text-emerald-300 border-emerald-500/30" : "bg-white/5 text-muted-foreground border-white/10"}`}>Tradovate = execution{status?.connected ? " ✓" : ""}</span>
        <span className="px-1.5 py-0.5 rounded border bg-white/5 text-muted-foreground/70 border-white/10">Spread book = validated edge (research) · directional = unvalidated</span>
      </div>

      {/* ── Asset Class Tabs ── */}
      {availableAssetClasses.length > 1 && (
        <div className="flex items-center justify-between gap-2 border-b border-border">
          <div className="flex items-center gap-1">
            {availableAssetClasses.map((ac) => {
              const active = ac.id === activeAssetClass;
              const count = filterByAssetClass(ALL_CONTRACTS, ac.id).length;
              return (
                <button
                  key={ac.id}
                  onClick={() => setActiveAssetClass(ac.id)}
                  className={`px-3 py-1.5 text-xs font-semibold border-b-2 -mb-px transition-colors ${
                    active
                      ? "border-emerald-500 text-emerald-400"
                      : "border-transparent text-muted-foreground hover:text-foreground"
                  }`}
                >
                  {ac.shortLabel}
                  <span className={`ml-1.5 text-[10px] ${active ? "text-emerald-500/70" : "text-muted-foreground/50"}`}>
                    {count}
                  </span>
                </button>
              );
            })}
          </div>
          <a
            href="/admin/strategies"
            className="text-[10px] text-muted-foreground/60 hover:text-emerald-400 transition-colors px-2 py-1.5"
            title="Configure which strategies trade which symbols"
          >
            Configure strategies →
          </a>
        </div>
      )}

      {/* ── Live Price Tiles ── */}
      {CONTRACTS.length === 0 ? (
        <div className="text-xs text-muted-foreground py-4 text-center">
          No {availableAssetClasses.find((ac) => ac.id === activeAssetClass)?.shortLabel ?? "matching"} contracts in this view.
        </div>
      ) : (
      <div className={`grid ${CONTRACTS.length <= 2 ? "grid-cols-2" : "grid-cols-3"} gap-2`}>
        {CONTRACTS.map((sym) => {
          const q = quotes.find((x) => x.symbol === sym);
          const isSelected = sym === selectedContract;
          const isUp = (q?.change ?? 0) >= 0;
          return (
            <button
              key={sym}
              onClick={() => setSelectedContract(sym)}
              className={`text-left rounded-lg border p-3 transition-all ${
                isSelected
                  ? "border-emerald-500/40 bg-emerald-500/[0.06] shadow-lg shadow-emerald-500/5"
                  : "border-white/[0.06] bg-white/[0.02] hover:border-white/[0.12] hover:bg-white/[0.04]"
              }`}
            >
              <div className="flex items-center justify-between mb-1">
                <span className={`text-sm font-bold ${isSelected ? "text-emerald-400" : ""}`}>{sym}</span>
                {q && (
                  <span className={`text-[10px] font-bold px-1.5 py-0.5 rounded ${
                    isUp ? "bg-emerald-500/15 text-emerald-400" : "bg-red-500/15 text-red-400"
                  }`}>
                    {isUp ? "+" : ""}{q.changePercent.toFixed(2)}%
                  </span>
                )}
              </div>
              {q ? (
                <>
                  <p className={`text-lg font-bold tabular-nums ${isUp ? "text-emerald-400" : "text-red-400"}`}>
                    {formatNum(q.price)}
                  </p>
                  <div className="flex items-center justify-between mt-1">
                    <span className={`text-[10px] tabular-nums ${isUp ? "text-emerald-400/70" : "text-red-400/70"}`}>
                      {isUp ? "+" : ""}{formatNum(q.change)}
                    </span>
                    <span className="text-[9px] text-muted-foreground/40">
                      Vol {formatVol(q.volume)}
                    </span>
                  </div>
                </>
              ) : (
                <div className="h-10 flex items-center">
                  <span className="text-[10px] text-muted-foreground/40 animate-pulse">Loading...</span>
                </div>
              )}
            </button>
          );
        })}
      </div>
      )}

      {/* ── Selected Contract Detail Bar ── */}
      {selectedQuote && (
        <div className="flex flex-wrap gap-x-6 gap-y-1 px-1 text-[11px] text-muted-foreground/60">
          <span>Open <span className="text-foreground/80 font-medium tabular-nums">{formatNum(selectedQuote.open)}</span></span>
          <span>High <span className="text-emerald-400/80 font-medium tabular-nums">{formatNum(selectedQuote.high)}</span></span>
          <span>Low <span className="text-red-400/80 font-medium tabular-nums">{formatNum(selectedQuote.low)}</span></span>
          <span>Prev Close <span className="text-foreground/80 font-medium tabular-nums">{formatNum(selectedQuote.prevClose)}</span></span>
          <span>Bid <span className="text-foreground/60 tabular-nums">{formatNum(selectedQuote.bid)}</span></span>
          <span>Ask <span className="text-foreground/60 tabular-nums">{formatNum(selectedQuote.ask)}</span></span>
          <span>${selectedQuote.multiplier}/pt</span>
          <span>${selectedQuote.margin.toLocaleString()} margin</span>
        </div>
      )}

      {/* ── Main Content Area ── */}
      <div className="grid grid-cols-1 xl:grid-cols-[1fr_320px] gap-4">
        {/* Left: Chart + Tabs */}
        <div className="space-y-3">
          {/* Tab bar */}
          <div className="flex gap-1 border-b border-white/[0.06] pb-2">
            {(["chart", "depth", "strategy", "backtest"] as const).map((tab) => (
              <button
                key={tab}
                onClick={() => {
                  setActiveTab(tab);
                  if (tab === "backtest" && !backtest && !backtestLoading) {
                    setBacktestLoading(true);
                    fetch("/api/futures/backtest")
                      .then((r) => r.json())
                      .then((data) => { if (!data.error) setBacktest(data); })
                      .catch(() => {})
                      .finally(() => setBacktestLoading(false));
                  }
                }}
                className={`px-3 py-1.5 rounded-t text-xs font-medium transition-colors ${
                  activeTab === tab
                    ? "text-foreground border-b-2 border-emerald-500"
                    : "text-muted-foreground/60 hover:text-foreground"
                }`}
              >
                {tab === "chart" ? "Chart" : tab === "depth" ? "Depth · Tape" : tab === "strategy" ? "Strategy" : "Backtest"}
              </button>
            ))}
          </div>

          {/* Chart tab */}
          {activeTab === "chart" && (
            <Card className="border-white/[0.06]">
              <CardContent className="pt-4">
                <FuturesChart symbol={selectedContract} height={560} />
              </CardContent>
            </Card>
          )}

          {/* Depth & Tape tab — Databento volume profile + time and sales */}
          {activeTab === "depth" && (
            <DepthTapeView symbol={selectedContract} />
          )}

          {/* Strategy tab */}
          {activeTab === "strategy" && (
            <Card className="border-white/[0.06]">
              <CardHeader className="pb-2">
                <CardTitle className="text-sm">5 Expert Setups — Priority Order</CardTitle>
              </CardHeader>
              <CardContent>
                <div className="mb-3 text-[10px] rounded-md bg-amber-500/10 text-amber-300/90 border border-amber-500/25 px-2.5 py-1.5">
                  ⚠️ These directional setups are <b>unvalidated / research-only</b> — most were rejected in testing (see EDGE-HIERARCHY). The only validated edge is the <b>spread book</b> (paper-forward, not deployable on the $1K). Demo P&L is not proof.
                </div>
                <div className="space-y-2">
                  {STRATEGIES.map((s) => (
                    <div key={s.priority} className="flex items-start gap-3 bg-white/[0.02] border border-white/[0.04] rounded-lg p-3">
                      <span className="text-[10px] bg-blue-500/15 text-blue-400 px-1.5 py-0.5 rounded font-bold shrink-0">#{s.priority}</span>
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center justify-between">
                          <span className="text-sm font-bold">{s.name}</span>
                          <span className="text-[10px] text-emerald-400 font-bold">{s.confidence}</span>
                        </div>
                        <p className="text-[11px] text-muted-foreground/60 mt-0.5">{s.desc}</p>
                        <span className="text-[9px] text-muted-foreground/40">{s.when}</span>
                      </div>
                    </div>
                  ))}
                </div>
                <div className="mt-4 pt-3 border-t border-white/[0.06]">
                  <p className="text-[10px] text-muted-foreground/40 uppercase tracking-wider mb-2 font-bold">Risk Rules</p>
                  <div className="grid grid-cols-2 gap-1.5">
                    {RISK_RULES.map((r, i) => (
                      <span key={i} className="text-[10px] text-muted-foreground/60 flex items-center gap-1.5">
                        <span className="text-emerald-400/60">{i + 1}.</span> {r}
                      </span>
                    ))}
                  </div>
                </div>
              </CardContent>
            </Card>
          )}

          {/* Backtest tab */}
          {activeTab === "backtest" && (
            <Card className="border-white/[0.06]">
              <CardContent className="pt-4">
                <div className="mb-3 text-[10px] rounded-md bg-white/5 text-muted-foreground/70 border border-white/10 px-2.5 py-1.5">
                  Backtest = historical ES 5-min (in-sample). A passing backtest is <b>not</b> a validated edge — that needs forward validation (paper-forward). Research only, not proven alpha.
                </div>
                {backtestLoading ? (
                  <div className="text-center py-12">
                    <p className="text-sm text-muted-foreground/60 animate-pulse">Running backtest on ~55 days of ES 5-min data...</p>
                    <p className="text-[10px] text-muted-foreground/30 mt-1">This takes 10-30 seconds</p>
                  </div>
                ) : backtest ? (
                  <div className="space-y-4">
                    {/* Summary */}
                    <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
                      <div className="bg-white/[0.03] rounded-lg p-3">
                        <p className="text-[9px] text-muted-foreground/40 uppercase">Total P&L</p>
                        <p className={`text-xl font-bold tabular-nums ${pnlColor(backtest.summary.totalPnl)}`}>
                          {backtest.summary.totalPnl >= 0 ? "+" : ""}{backtest.summary.totalPnl.toFixed(1)} pts
                        </p>
                      </div>
                      <div className="bg-white/[0.03] rounded-lg p-3">
                        <p className="text-[9px] text-muted-foreground/40 uppercase">Win Rate</p>
                        <p className="text-xl font-bold">{(backtest.summary.winRate * 100).toFixed(0)}%</p>
                        <p className="text-[9px] text-muted-foreground/30">{backtest.summary.totalTrades} trades</p>
                      </div>
                      <div className="bg-white/[0.03] rounded-lg p-3">
                        <p className="text-[9px] text-muted-foreground/40 uppercase">Profit Factor</p>
                        <p className={`text-xl font-bold ${backtest.summary.profitFactor >= 1.5 ? "text-emerald-400" : backtest.summary.profitFactor >= 1.0 ? "text-amber-400" : "text-red-400"}`}>
                          {backtest.summary.profitFactor.toFixed(2)}
                        </p>
                      </div>
                      <div className="bg-white/[0.03] rounded-lg p-3">
                        <p className="text-[9px] text-muted-foreground/40 uppercase">Sharpe</p>
                        <p className={`text-xl font-bold ${backtest.summary.sharpe >= 1.0 ? "text-emerald-400" : backtest.summary.sharpe >= 0.5 ? "text-amber-400" : "text-red-400"}`}>
                          {backtest.summary.sharpe.toFixed(2)}
                        </p>
                      </div>
                    </div>

                    <div className="text-[10px] text-muted-foreground/40">
                      {backtest.symbol} | {backtest.period} | {backtest.tradingDays} trading days | {backtest.totalBars.toLocaleString()} bars
                    </div>

                    {/* Per-setup breakdown */}
                    <div>
                      <p className="text-xs font-bold mb-2">Per-Setup Performance</p>
                      <div className="space-y-2">
                        {backtest.setups.map((s) => (
                          <div key={s.setup} className={`bg-white/[0.02] border rounded-lg p-3 ${
                            s.verdict === "keep" ? "border-emerald-500/30" :
                            s.verdict === "optimize" ? "border-amber-500/30" :
                            "border-red-500/30"
                          }`}>
                            <div className="flex items-center justify-between mb-2">
                              <div className="flex items-center gap-2">
                                <span className="text-sm font-bold">{s.setup.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase())}</span>
                                <span className={`text-[9px] font-bold px-1.5 py-0.5 rounded ${
                                  s.verdict === "keep" ? "bg-emerald-500/15 text-emerald-400" :
                                  s.verdict === "optimize" ? "bg-amber-500/15 text-amber-400" :
                                  "bg-red-500/15 text-red-400"
                                }`}>
                                  {s.verdict.toUpperCase()}
                                </span>
                              </div>
                              <span className={`text-sm font-bold tabular-nums ${pnlColor(s.totalPnl)}`}>
                                {s.totalPnl >= 0 ? "+" : ""}{s.totalPnl.toFixed(1)} pts
                              </span>
                            </div>
                            {s.trades > 0 ? (
                              <div className="grid grid-cols-4 md:grid-cols-8 gap-2 text-[10px]">
                                <div>
                                  <p className="text-muted-foreground/40">Trades</p>
                                  <p className="font-bold">{s.trades}</p>
                                </div>
                                <div>
                                  <p className="text-muted-foreground/40">Win Rate</p>
                                  <p className="font-bold">{(s.winRate * 100).toFixed(0)}%</p>
                                </div>
                                <div>
                                  <p className="text-muted-foreground/40">W/L</p>
                                  <p className="font-bold">{s.wins}/{s.losses}</p>
                                </div>
                                <div>
                                  <p className="text-muted-foreground/40">PF</p>
                                  <p className={`font-bold ${s.profitFactor >= 1.5 ? "text-emerald-400" : s.profitFactor >= 1.0 ? "text-amber-400" : "text-red-400"}`}>
                                    {s.profitFactor.toFixed(2)}
                                  </p>
                                </div>
                                <div>
                                  <p className="text-muted-foreground/40">Avg Win</p>
                                  <p className="text-emerald-400 font-bold">{s.avgWin.toFixed(1)}</p>
                                </div>
                                <div>
                                  <p className="text-muted-foreground/40">Avg Loss</p>
                                  <p className="text-red-400 font-bold">{s.avgLoss.toFixed(1)}</p>
                                </div>
                                <div>
                                  <p className="text-muted-foreground/40">Avg R</p>
                                  <p className="font-bold">{s.avgRMultiple.toFixed(2)}R</p>
                                </div>
                                <div>
                                  <p className="text-muted-foreground/40">Sharpe</p>
                                  <p className="font-bold">{s.sharpe.toFixed(2)}</p>
                                </div>
                              </div>
                            ) : (
                              <p className="text-[10px] text-muted-foreground/30">No trades triggered in test period</p>
                            )}
                          </div>
                        ))}
                      </div>
                    </div>

                    {/* Equity curve (simple text representation) */}
                    {backtest.equity.length > 0 && (
                      <div>
                        <p className="text-xs font-bold mb-2">Equity Curve (cumulative points)</p>
                        <div className="bg-black/30 rounded-lg p-3 h-24 flex items-end gap-px">
                          {(() => {
                            // Sample equity to ~80 bars for display
                            const eq = backtest.equity;
                            const step = Math.max(1, Math.floor(eq.length / 80));
                            const sampled = eq.filter((_, i) => i % step === 0);
                            const min = Math.min(...sampled, 0);
                            const max = Math.max(...sampled, 1);
                            const range = max - min || 1;
                            return sampled.map((v, i) => {
                              const height = ((v - min) / range) * 100;
                              return (
                                <div
                                  key={i}
                                  className={`flex-1 min-w-[2px] rounded-t ${v >= 0 ? "bg-emerald-500/60" : "bg-red-500/60"}`}
                                  style={{ height: `${Math.max(2, height)}%` }}
                                />
                              );
                            });
                          })()}
                        </div>
                        <div className="flex justify-between text-[9px] text-muted-foreground/30 mt-1">
                          <span>Trade 1</span>
                          <span>Max DD: {backtest.summary.maxDrawdown.toFixed(1)} pts</span>
                          <span>Trade {backtest.equity.length}</span>
                        </div>
                      </div>
                    )}

                    {/* Re-run button */}
                    <div className="flex justify-end">
                      <Button
                        size="sm"
                        variant="outline"
                        className="text-xs h-7"
                        onClick={() => {
                          setBacktestLoading(true);
                          setBacktest(null);
                          fetch("/api/futures/backtest")
                            .then((r) => r.json())
                            .then((data) => { if (!data.error) setBacktest(data); })
                            .catch(() => {})
                            .finally(() => setBacktestLoading(false));
                        }}
                      >
                        Re-run Backtest
                      </Button>
                    </div>
                  </div>
                ) : (
                  <p className="text-sm text-muted-foreground/40 text-center py-8">Click to run backtest</p>
                )}
              </CardContent>
            </Card>
          )}

          {/* ── Daily Futures Performance ── */}
          <Card className="border-amber-500/10 bg-gradient-to-br from-amber-500/[0.02] to-transparent">
            <CardHeader className="pb-2">
              <div className="flex items-center gap-2">
                <span className="w-1.5 h-1.5 rounded-full bg-amber-400" />
                <CardTitle className="text-[11px] text-amber-400/60 uppercase tracking-wider font-bold">Daily Performance</CardTitle>
              </div>
            </CardHeader>
            <CardContent>
              {(() => {
                // Use pre-filtered round trips (May 13 Railway outage excluded)
                const roundTrips = filteredFills.roundTrips;
                if (roundTrips.length === 0) return <p className="text-[11px] text-muted-foreground/30 text-center py-4">No completed trades yet</p>;

                // Group by exit date (ET timezone for trading days)
                const dayMap: Record<string, { trades: number; wins: number; losses: number; totalPnl: number; label: string }> = {};
                for (const rt of roundTrips) {
                  const d = new Date(rt.exitTime);
                  const dateKey = d.toLocaleDateString("en-CA", { timeZone: "America/New_York" }); // YYYY-MM-DD in ET
                  const label = d.toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric", timeZone: "America/New_York" });
                  if (!dayMap[dateKey]) dayMap[dateKey] = { trades: 0, wins: 0, losses: 0, totalPnl: 0, label };
                  dayMap[dateKey].trades++;
                  if (rt.pnl > 0) dayMap[dateKey].wins++;
                  else dayMap[dateKey].losses++;
                  dayMap[dateKey].totalPnl += rt.pnl;
                }
                const days = Object.entries(dayMap).sort(([a], [b]) => b.localeCompare(a));
                const overallPnl = roundTrips.reduce((s, rt) => s + rt.pnl, 0);

                return (
                  <div className="space-y-3">
                    {/* Summary row */}
                    <div className="flex items-center justify-between text-[10px] text-muted-foreground/50 pb-2 border-b border-white/[0.06]">
                      <span>{roundTrips.length} completed trades across {days.length} days</span>
                      <span className={`font-bold ${pnlColor(overallPnl)}`}>
                        Total: {overallPnl >= 0 ? "+" : "-"}${Math.abs(overallPnl).toFixed(0)}
                      </span>
                    </div>
                    <div className="overflow-x-auto">
                      <table className="w-full text-[11px]">
                        <thead>
                          <tr className="text-[9px] text-muted-foreground/40 border-b border-white/[0.06]">
                            <th className="text-left py-1.5 font-medium">Date</th>
                            <th className="text-center py-1.5 font-medium">Trades</th>
                            <th className="text-center py-1.5 font-medium">W/L</th>
                            <th className="text-center py-1.5 font-medium">Win%</th>
                            <th className="text-right py-1.5 font-medium">P&L</th>
                            <th className="text-right py-1.5 font-medium">Avg</th>
                          </tr>
                        </thead>
                        <tbody>
                          {days.map(([dateKey, d]) => {
                            const winRate = d.trades > 0 ? (d.wins / d.trades * 100) : 0;
                            const avg = d.trades > 0 ? d.totalPnl / d.trades : 0;
                            return (
                              <tr key={dateKey} className="border-b border-white/[0.03] hover:bg-white/[0.02]">
                                <td className="py-1.5 font-medium">{d.label}</td>
                                <td className="text-center py-1.5">{d.trades}</td>
                                <td className="text-center py-1.5">
                                  <span className="text-emerald-400">{d.wins}</span>
                                  <span className="text-muted-foreground/30">/</span>
                                  <span className="text-red-400">{d.losses}</span>
                                </td>
                                <td className="text-center py-1.5">
                                  <span className={winRate >= 50 ? "text-emerald-400" : "text-red-400"}>
                                    {winRate.toFixed(0)}%
                                  </span>
                                </td>
                                <td className={`text-right py-1.5 font-bold tabular-nums ${pnlColor(d.totalPnl)}`}>
                                  {d.totalPnl >= 0 ? "+" : "-"}${Math.abs(d.totalPnl).toFixed(0)}
                                </td>
                                <td className={`text-right py-1.5 tabular-nums ${pnlColor(avg)}`}>
                                  {avg >= 0 ? "+" : "-"}${Math.abs(avg).toFixed(0)}
                                </td>
                              </tr>
                            );
                          })}
                        </tbody>
                      </table>
                    </div>
                  </div>
                );
              })()}
            </CardContent>
          </Card>

          {/* History/Reports removed — use Journal + Orders pages */}
          {false && (() => {
            const periodStart = historyPeriod === "today" ? todayStart
              : historyPeriod === "week" ? weekStart
              : historyPeriod === "month" ? monthStart
              : new Date(0);
            // Use ISO string comparison for consistent UTC filtering
            const periodISO = periodStart.toISOString();
            const periodTrades = allTrades.filter((t) => t.time >= periodISO);
            const periodClosed = periodTrades.filter((t) => t.pnl != null);
            const periodWins = periodClosed.filter((t) => (t.pnl || 0) > 0);
            const periodLosses = periodClosed.filter((t) => (t.pnl || 0) < 0);
            const periodAvgWin = periodWins.length > 0 ? periodWins.reduce((s, t) => s + (t.pnl || 0), 0) / periodWins.length : 0;
            const periodAvgLoss = periodLosses.length > 0 ? periodLosses.reduce((s, t) => s + (t.pnl || 0), 0) / periodLosses.length : 0;

            // Group by day for daily breakdown — use Tradovate balance deltas as source of truth
            const balHist = posData?.balanceHistory || [];
            const balByDate: Record<string, { sod: number | undefined; eod: number | undefined }> = {};
            for (const b of balHist) {
              balByDate[b.date] = { sod: b.startBalance ?? undefined, eod: b.endBalance ?? undefined };
            }
            // Build day map from trades (for trade counts) — UTC dates to match balance snapshots
            const dayMap: Record<string, { pnl: number; trades: number; wins: number; losses: number; date: Date; fromBalance: boolean }> = {};
            for (const t of periodClosed) {
              const d = new Date(t.time);
              const key = d.toISOString().slice(0, 10); // UTC YYYY-MM-DD
              if (!dayMap[key]) dayMap[key] = { pnl: 0, trades: 0, wins: 0, losses: 0, date: d, fromBalance: false };
              dayMap[key].pnl += t.pnl || 0;
              dayMap[key].trades++;
              if ((t.pnl || 0) > 0) dayMap[key].wins++;
              else if ((t.pnl || 0) < 0) dayMap[key].losses++;
            }

            // Override individual day P&L with balance deltas where we have BOTH endpoints
            const sortedBalDates = Object.keys(balByDate).sort();
            for (let i = 0; i < sortedBalDates.length; i++) {
              const date = sortedBalDates[i];
              const bal = balByDate[date];
              const nextDate = sortedBalDates[i + 1];
              const nextBal = nextDate ? balByDate[nextDate] : null;
              let balancePnl: number | null = null;
              if (bal?.eod !== undefined && bal?.sod !== undefined) {
                balancePnl = (bal.eod as number) - (bal.sod as number);
              } else if (nextBal?.sod != null && bal?.sod !== undefined) {
                balancePnl = (nextBal!.sod as number) - (bal.sod as number);
              }
              if (balancePnl != null && dayMap[date]) {
                dayMap[date].pnl = balancePnl as number;
                dayMap[date].fromBalance = true;
              }
            }

            // Today: always from live balance
            if (calendarDayPnl != null && dayMap[todayUTC]) {
              dayMap[todayUTC].pnl = calendarDayPnl as number;
              dayMap[todayUTC].fromBalance = true;
            }

            // CRITICAL: Scale DB-sourced daily P&Ls so they sum to the known balance-based total.
            // DB trade sums are unreliable (double-logging inflates them), but the RELATIVE
            // proportions between days are roughly correct. So we scale to match the true total.
            const knownPeriodPnl = (() => {
              if (historyPeriod === "today") return calendarDayPnl ?? dailyPnl;
              if (historyPeriod === "all") return totalPnl;
              return computePeriodPnlFromBalance(periodStart);
            })();
            if (knownPeriodPnl != null) {
              const dbDays = Object.entries(dayMap).filter(([, d]) => !d.fromBalance);
              const balanceDays = Object.entries(dayMap).filter(([, d]) => d.fromBalance);
              const balanceTotal = balanceDays.reduce((s, [, d]) => s + d.pnl, 0);
              const dbTotal = dbDays.reduce((s, [, d]) => s + d.pnl, 0);
              const remaining = (knownPeriodPnl as number) - balanceTotal;
              // Scale DB-sourced days to fill the gap between known total and balance-sourced days
              if (dbDays.length > 0 && dbTotal !== 0) {
                const scale = remaining / dbTotal;
                for (const [, d] of dbDays) {
                  d.pnl = d.pnl * scale;
                }
              }
            }

            const days = Object.entries(dayMap).sort(([a], [b]) => b.localeCompare(a));

            // Period P&L: use balance-based total (source of truth), never DB sums
            const periodPnl = knownPeriodPnl ?? days.reduce((s, [, d]) => s + d.pnl, 0);

            return (
            <div className="space-y-3">
              {/* Period selector */}
              <div className="flex gap-1">
                {([["today", "Today"], ["week", "This Week"], ["month", "This Month"], ["all", "All Time"]] as const).map(([key, label]) => {
                  const start = key === "today" ? todayStart : key === "week" ? weekStart : key === "month" ? monthStart : new Date(0);
                  const startISO = start.toISOString();
                  const count = allTrades.filter((t) => t.time >= startISO).length;
                  return (
                    <button
                      key={key}
                      onClick={() => setHistoryPeriod(key)}
                      className={`px-3 py-1.5 rounded-lg text-xs font-medium transition-colors ${
                        historyPeriod === key
                          ? "bg-emerald-500/15 text-emerald-400 border border-emerald-500/30"
                          : "bg-white/[0.03] text-muted-foreground/60 hover:bg-white/[0.06] border border-white/[0.06]"
                      }`}
                    >
                      {label} <span className="text-[9px] opacity-60">({count})</span>
                    </button>
                  );
                })}
              </div>

              {/* Period summary stats */}
              <Card className="border-white/[0.06]">
                <CardContent className="pt-4">
                  <div className="grid grid-cols-2 md:grid-cols-6 gap-3">
                    <div>
                      <p className="text-[10px] text-muted-foreground/40">P&L</p>
                      <p className={`text-lg font-bold tabular-nums ${pnlColor(periodPnl)}`}>
                        {periodPnl >= 0 ? "+" : "-"}${Math.abs(periodPnl).toFixed(0)}
                      </p>
                    </div>
                    <div>
                      <p className="text-[10px] text-muted-foreground/40">Win Rate</p>
                      <p className="text-lg font-bold">
                        {periodClosed.length > 0 ? `${((periodWins.length / periodClosed.length) * 100).toFixed(0)}%` : "—"}
                      </p>
                      <p className="text-[9px] text-muted-foreground/30">{periodWins.length}W / {periodLosses.length}L</p>
                    </div>
                    <div>
                      <p className="text-[10px] text-muted-foreground/40">Trades</p>
                      <p className="text-lg font-bold">{periodClosed.length}</p>
                      <p className="text-[9px] text-muted-foreground/30">{periodTrades.length} total entries</p>
                    </div>
                    <div>
                      <p className="text-[10px] text-muted-foreground/40">Avg Win</p>
                      <p className="text-sm font-bold text-emerald-400 tabular-nums">
                        {periodWins.length > 0 ? `+$${periodAvgWin.toFixed(0)}` : "—"}
                      </p>
                    </div>
                    <div>
                      <p className="text-[10px] text-muted-foreground/40">Avg Loss</p>
                      <p className="text-sm font-bold text-red-400 tabular-nums">
                        {periodLosses.length > 0 ? `-$${Math.abs(periodAvgLoss).toFixed(0)}` : "—"}
                      </p>
                    </div>
                    <div>
                      <p className="text-[10px] text-muted-foreground/40">Profit Factor</p>
                      <p className={`text-sm font-bold tabular-nums ${periodLosses.length > 0 && (periodWins.reduce((s, t) => s + (t.pnl || 0), 0) / Math.abs(periodLosses.reduce((s, t) => s + (t.pnl || 0), 0))) >= 1 ? "text-emerald-400" : "text-red-400"}`}>
                        {periodLosses.length > 0
                          ? (periodWins.reduce((s, t) => s + (t.pnl || 0), 0) / Math.abs(periodLosses.reduce((s, t) => s + (t.pnl || 0), 0))).toFixed(2)
                          : "—"}
                      </p>
                    </div>
                  </div>
                </CardContent>
              </Card>

              {/* Daily P&L breakdown */}
              {days.length > 1 && (
                <Card className="border-white/[0.06]">
                  <CardContent className="pt-4">
                    <p className="text-xs font-bold mb-2">Daily Breakdown <span className="text-[9px] font-normal text-muted-foreground/40">(from Tradovate balance)</span></p>
                    <div className="space-y-1">
                      {days.map(([day, data]) => (
                        <div key={day} className="flex items-center justify-between bg-white/[0.02] rounded-lg px-3 py-1.5">
                          <div className="flex items-center gap-3">
                            <span className="text-xs font-medium tabular-nums w-24">
                              {new Date(day + "T12:00:00Z").toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric", timeZone: "America/New_York" })}
                            </span>
                            <span className="text-[10px] text-muted-foreground/40">
                              {data.trades} trades ({data.wins}W / {data.losses}L)
                            </span>
                          </div>
                          <span className={`text-sm font-bold tabular-nums ${pnlColor(data.pnl)}`}>
                            {data.pnl >= 0 ? "+" : "-"}${Math.abs(data.pnl).toFixed(0)}
                          </span>
                        </div>
                      ))}
                    </div>
                  </CardContent>
                </Card>
              )}

              {/* Full trade log */}
              <Card className="border-white/[0.06]">
                <CardContent className="pt-4">
                  <p className="text-xs font-bold mb-2">Trade Log</p>
                  {periodTrades.length > 0 ? (
                    <div className="overflow-x-auto max-h-[500px] overflow-y-auto">
                      <table className="w-full text-xs">
                        <thead className="sticky top-0 bg-card z-10">
                          <tr className="text-muted-foreground/40 border-b border-white/[0.06]">
                            <th className="text-left py-2 font-medium">Time</th>
                            <th className="text-left py-2 font-medium">Symbol</th>
                            <th className="text-left py-2 font-medium">Action</th>
                            <th className="text-right py-2 font-medium">Qty</th>
                            <th className="text-right py-2 font-medium">Price</th>
                            <th className="text-right py-2 font-medium">P&L</th>
                            <th className="text-left py-2 font-medium">Reason</th>
                          </tr>
                        </thead>
                        <tbody>
                          {periodTrades.map((t) => (
                            <tr key={t.id} className="border-b border-white/[0.03] hover:bg-white/[0.02]">
                              <td className="py-2 text-muted-foreground/50 tabular-nums whitespace-nowrap">
                                {formatET(t.time)}
                              </td>
                              <td className="py-2 font-bold">{t.symbol}</td>
                              <td className="py-2">
                                <span className={`px-1.5 py-0.5 rounded text-[10px] font-bold ${
                                  t.action.includes("long") ? "bg-emerald-500/15 text-emerald-400" :
                                  t.action.includes("short") ? "bg-red-500/15 text-red-400" :
                                  t.action.includes("stop") ? "bg-red-500/15 text-red-400" :
                                  t.action.includes("take_profit") ? "bg-emerald-500/15 text-emerald-400" :
                                  t.action.includes("breakeven") ? "bg-amber-500/15 text-amber-400" :
                                  t.action.includes("scale") ? "bg-blue-500/15 text-blue-400" :
                                  t.action.includes("trail") ? "bg-purple-500/15 text-purple-400" :
                                  t.action.includes("close") ? "bg-amber-500/15 text-amber-400" :
                                  "bg-white/10 text-muted-foreground"
                                }`}>{t.action.replace("futures_", "").replace(/_/g, " ").toUpperCase()}</span>
                              </td>
                              <td className="py-2 text-right tabular-nums">{t.qty}</td>
                              <td className="py-2 text-right tabular-nums">{t.price ? `$${formatNum(t.price)}` : "—"}</td>
                              <td className={`py-2 text-right font-bold tabular-nums ${t.pnl != null ? pnlColor(t.pnl) : ""}`}>
                                {t.pnl != null ? `${t.pnl >= 0 ? "+" : ""}$${t.pnl.toFixed(0)}` : "—"}
                              </td>
                              <td className="py-2 text-muted-foreground/60 max-w-[220px]">
                                <span className="block truncate" title={t.reason}>{t.reason?.slice(0, 80)}</span>
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  ) : (
                    <p className="text-sm text-muted-foreground/40 text-center py-8">No trades in this period</p>
                  )}
                </CardContent>
              </Card>
            </div>
            );
          })()}

          {false && (
            <Card className="border-white/[0.06]">
              <CardContent className="pt-4 space-y-6">
                {/* Equity Curve */}
                <div>
                  <p className="text-xs font-bold mb-3">Equity Curve (Cumulative P&L)</p>
                  {closedTrades.length > 0 ? (
                    <>
                      <div className="bg-black/30 rounded-lg p-3 h-32 flex items-end gap-px">
                        {(() => {
                          const sorted = [...closedTrades].sort((a, b) => new Date(a.time).getTime() - new Date(b.time).getTime());
                          let cumPnl = 0;
                          const points = sorted.map((t) => { cumPnl += t.pnl || 0; return cumPnl; });
                          const min = Math.min(...points, 0);
                          const max = Math.max(...points, 1);
                          const range = max - min || 1;
                          return points.map((v, i) => {
                            const height = ((v - min) / range) * 100;
                            return (
                              <div key={i} className={`flex-1 min-w-[3px] rounded-t ${v >= 0 ? "bg-emerald-500/60" : "bg-red-500/60"}`} style={{ height: `${Math.max(3, height)}%` }} />
                            );
                          });
                        })()}
                      </div>
                      <div className="flex justify-between text-[9px] text-muted-foreground/30 mt-1">
                        <span>Trade 1</span>
                        <span>Trade {closedTrades.length}</span>
                      </div>
                    </>
                  ) : (
                    <p className="text-[11px] text-muted-foreground/30 text-center py-8">No closed trades yet</p>
                  )}
                </div>

                {/* Per-Setup Performance */}
                <div>
                  <p className="text-xs font-bold mb-3">Performance by Setup</p>
                  {(() => {
                    // Parse setup type from reason/action
                    const setupMap: Record<string, { wins: number; losses: number; pnl: number; trades: number }> = {};
                    for (const t of closedTrades) {
                      let setup = "Other";
                      const action = t.action || "";
                      const reason = (t.reason || "").toLowerCase();
                      if (action.includes("scale_out")) setup = "Scale Out";
                      else if (action.includes("trail_stop")) setup = "Trail Stop";
                      else if (action.includes("breakeven")) setup = "Breakeven";
                      else if (action.includes("take_profit")) setup = "Take Profit";
                      else if (action.includes("emergency")) setup = "Emergency";
                      else if (reason.includes("gap fill")) setup = "Gap Fill";
                      else if (reason.includes("failed ib")) setup = "Failed IB";
                      else if (reason.includes("or breakout") || reason.includes("ib breakout")) setup = "IB Breakout";
                      else if (reason.includes("trend pullback") || reason.includes("trend continuation")) setup = "Trend Cont.";
                      else if (reason.includes("rsi")) setup = "RSI Bounce";
                      else if (action.includes("stop_loss")) setup = "Stop Loss";
                      if (!setupMap[setup]) setupMap[setup] = { wins: 0, losses: 0, pnl: 0, trades: 0 };
                      setupMap[setup].trades++;
                      setupMap[setup].pnl += t.pnl || 0;
                      if ((t.pnl || 0) > 0) setupMap[setup].wins++;
                      else if ((t.pnl || 0) < 0) setupMap[setup].losses++;
                    }
                    const entries = Object.entries(setupMap).sort(([, a], [, b]) => b.pnl - a.pnl);
                    return entries.length > 0 ? (
                      <div className="space-y-2">
                        {entries.map(([setup, data]) => (
                          <div key={setup} className={`bg-white/[0.02] border rounded-lg p-3 ${data.pnl >= 0 ? "border-emerald-500/20" : "border-red-500/20"}`}>
                            <div className="flex items-center justify-between mb-1">
                              <span className="text-sm font-bold">{setup}</span>
                              <span className={`text-sm font-bold tabular-nums ${pnlColor(data.pnl)}`}>
                                {data.pnl >= 0 ? "+" : "-"}${Math.abs(data.pnl).toFixed(0)}
                              </span>
                            </div>
                            <div className="flex gap-4 text-[10px] text-muted-foreground/60">
                              <span>{data.trades} trades</span>
                              <span>{data.wins}W / {data.losses}L</span>
                              <span>{data.trades > 0 ? `${((data.wins / data.trades) * 100).toFixed(0)}%` : "—"} WR</span>
                              <span>Avg: {data.trades > 0 ? `${data.pnl >= 0 ? "+" : "-"}$${Math.abs(data.pnl / data.trades).toFixed(0)}` : "—"}</span>
                            </div>
                          </div>
                        ))}
                      </div>
                    ) : (
                      <p className="text-[11px] text-muted-foreground/30 text-center py-4">No data yet</p>
                    );
                  })()}
                </div>

                {/* Daily Performance moved to visible card above */}

                {/* Key Stats */}
                <div>
                  <p className="text-xs font-bold mb-3">Key Metrics</p>
                  <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
                    <div className="bg-white/[0.03] rounded-lg p-3">
                      <p className="text-[9px] text-muted-foreground/40 uppercase">Profit Factor</p>
                      <p className={`text-xl font-bold ${avgWin > 0 && avgLoss < 0 ? ((avgWin * winCount) / Math.abs(avgLoss * lossCount) >= 1 ? "text-emerald-400" : "text-red-400") : "text-muted-foreground"}`}>
                        {lossCount > 0 && winCount > 0 ? ((avgWin * winCount) / Math.abs(avgLoss * lossCount)).toFixed(2) : "—"}
                      </p>
                    </div>
                    <div className="bg-white/[0.03] rounded-lg p-3">
                      <p className="text-[9px] text-muted-foreground/40 uppercase">Expectancy</p>
                      <p className={`text-xl font-bold ${tradeCount > 0 && totalPnl / tradeCount >= 0 ? "text-emerald-400" : "text-red-400"}`}>
                        {tradeCount > 0 ? `${totalPnl / tradeCount >= 0 ? "+" : ""}$${(totalPnl / tradeCount).toFixed(0)}` : "—"}
                      </p>
                      <p className="text-[9px] text-muted-foreground/30">per trade</p>
                    </div>
                    <div className="bg-white/[0.03] rounded-lg p-3">
                      <p className="text-[9px] text-muted-foreground/40 uppercase">Max Drawdown</p>
                      <p className="text-xl font-bold text-red-400">
                        {(() => {
                          const sorted = [...closedTrades].sort((a, b) => new Date(a.time).getTime() - new Date(b.time).getTime());
                          let peak = 0, maxDD = 0, cum = 0;
                          for (const t of sorted) { cum += t.pnl || 0; peak = Math.max(peak, cum); maxDD = Math.min(maxDD, cum - peak); }
                          return `$${Math.abs(maxDD).toFixed(0)}`;
                        })()}
                      </p>
                    </div>
                    <div className="bg-white/[0.03] rounded-lg p-3">
                      <p className="text-[9px] text-muted-foreground/40 uppercase">Win/Loss Ratio</p>
                      <p className={`text-xl font-bold ${avgWin > 0 && Math.abs(avgLoss) > 0 && avgWin / Math.abs(avgLoss) >= 1 ? "text-emerald-400" : "text-red-400"}`}>
                        {avgWin > 0 && avgLoss < 0 ? (avgWin / Math.abs(avgLoss)).toFixed(2) : "—"}
                      </p>
                      <p className="text-[9px] text-muted-foreground/30">avg win / avg loss</p>
                    </div>
                  </div>
                </div>
              </CardContent>
            </Card>
          )}
        </div>

        {/* Right sidebar: Account + Positions + Stats + Activity */}
        <div className="space-y-3">
          {/* ── TRADOVATE ACCOUNT ── */}
          {posData?.account && (
            <Card className="border-emerald-500/20 bg-emerald-500/[0.03]">
              <CardHeader className="pb-2">
                <CardTitle className="text-[11px] text-emerald-400/60 uppercase tracking-wider font-bold">Tradovate Account</CardTitle>
              </CardHeader>
              <CardContent>
                <div className="space-y-2">
                  <div className="flex items-baseline justify-between">
                    <div>
                      <p className="text-[10px] text-muted-foreground/40">Net Liquidation</p>
                      <p className="text-xl font-bold tabular-nums">${posData.account.netLiq.toLocaleString()}</p>
                    </div>
                    <div className="text-right">
                      <p className="text-[10px] text-muted-foreground/40">Total P&L</p>
                      <p className={`text-lg font-bold tabular-nums ${pnlColor(totalPnl)}`}>
                        {totalPnl >= 0 ? "+" : ""}${totalPnl.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                      </p>
                    </div>
                  </div>
                  <div className="grid grid-cols-2 gap-2 text-[10px]">
                    <div>
                      <span className="text-muted-foreground/40">Balance</span>
                      <p className="font-bold tabular-nums">${posData.account.balance.toLocaleString()}</p>
                    </div>
                    <div>
                      <span className="text-muted-foreground/40">Unrealized P&L</span>
                      <p className={`font-bold tabular-nums ${pnlColor(posData.account.unrealizedPnl)}`}>
                        {posData.account.unrealizedPnl >= 0 ? "+" : ""}${posData.account.unrealizedPnl.toLocaleString()}
                      </p>
                    </div>
                    <div>
                      <span className="text-muted-foreground/40">Today P&L</span>
                      <p className={`font-bold tabular-nums ${pnlColor(dailyPnl)}`}>
                        {dailyPnl >= 0 ? "+" : ""}${dailyPnl.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                      </p>
                    </div>
                    <div>
                      <span className="text-muted-foreground/40">Margin Used</span>
                      <p className="font-bold tabular-nums">${posData.account.marginUsed.toLocaleString()}</p>
                    </div>
                  </div>
                </div>
              </CardContent>
            </Card>
          )}

          {/* ── LIVE POSITIONS ── */}
          <Card className={`border-white/[0.06] ${posData?.positions?.length ? "border-emerald-500/20" : ""}`}>
            <CardHeader className="pb-2">
              <div className="flex items-center justify-between">
                <CardTitle className="text-[11px] text-muted-foreground/40 uppercase tracking-wider font-bold">
                  Open Positions
                </CardTitle>
                {posData?.positions?.length ? (
                  <span className="relative flex h-2 w-2">
                    <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-75" />
                    <span className="relative inline-flex rounded-full h-2 w-2 bg-emerald-400" />
                  </span>
                ) : null}
              </div>
            </CardHeader>
            <CardContent>
              {posData?.positions && posData.positions.length > 0 ? (
                <div className="space-y-2">
                  {posData.positions.map((pos) => {
                    const isProfit = pos.unrealizedPnl >= 0;
                    return (
                      <div key={pos.id} className="bg-white/[0.03] border border-white/[0.06] rounded-lg p-2.5 space-y-2">
                        {/* Header: symbol + direction + P&L */}
                        <div className="flex items-center justify-between">
                          <div className="flex items-center gap-2">
                            <span className="text-sm font-bold">{pos.symbol}</span>
                            <span className={`text-[9px] font-bold px-1.5 py-0.5 rounded ${
                              pos.direction === "long" ? "bg-emerald-500/15 text-emerald-400" : "bg-red-500/15 text-red-400"
                            }`}>
                              {pos.direction.toUpperCase()} {pos.quantity}x
                            </span>
                          </div>
                          <div className="flex items-center gap-2">
                            <span className={`text-sm font-bold tabular-nums ${pnlColor(pos.unrealizedPnl)}`}>
                              {pos.unrealizedPnl >= 0 ? "+" : ""}${pos.unrealizedPnl.toFixed(0)}
                            </span>
                            <button
                              onClick={async () => {
                                if (!confirm(`Close ${pos.symbol} ${pos.direction} ${pos.quantity}x at market?`)) return;
                                try {
                                  const res = await fetch("/api/futures/close", {
                                    method: "POST",
                                    headers: { "Content-Type": "application/json" },
                                    body: JSON.stringify({ symbol: pos.symbol, mode: isLiveView ? "live" : "paper" }),
                                  });
                                  const data = await res.json();
                                  if (data.closed?.length) alert(`Closed: ${data.closed.join(", ")}`);
                                  else alert(data.error || "Failed to close");
                                } catch (err) {
                                  alert(`Error: ${err}`);
                                }
                              }}
                              className="text-[9px] px-1.5 py-0.5 rounded bg-red-500/15 text-red-400 hover:bg-red-500/30 transition-colors font-medium"
                            >
                              CLOSE
                            </button>
                          </div>
                        </div>

                        {/* Prices row */}
                        <div className="grid grid-cols-3 gap-2 text-[10px]">
                          <div>
                            <p className="text-muted-foreground/40">Entry</p>
                            <p className="font-medium tabular-nums">${formatNum(pos.entryPrice)}</p>
                          </div>
                          <div>
                            <p className="text-muted-foreground/40">Current</p>
                            <p className={`font-medium tabular-nums ${isProfit ? "text-emerald-400" : "text-red-400"}`}>
                              ${formatNum(pos.currentPrice)}
                            </p>
                          </div>
                          <div>
                            <p className="text-muted-foreground/40">AI Score</p>
                            <p className="font-medium">{pos.aiScore ? `${pos.aiScore}%` : "—"}</p>
                          </div>
                        </div>

                        {/* Stop / Target progress bar */}
                        {(pos.stopLoss || pos.target) && (
                          <div className="space-y-1">
                            <div className="flex justify-between text-[9px]">
                              <span className="text-red-400/70">
                                Stop ${pos.stopLoss ? formatNum(pos.stopLoss) : "—"}
                                {pos.pctToStop != null && <span className="ml-1">({pos.pctToStop.toFixed(1)}%)</span>}
                              </span>
                              <span className="text-emerald-400/70">
                                Target ${pos.target ? formatNum(pos.target) : "—"}
                                {pos.pctToTarget != null && <span className="ml-1">({pos.pctToTarget.toFixed(1)}%)</span>}
                              </span>
                            </div>
                            {/* Visual progress between stop and target */}
                            {pos.stopLoss && pos.target && (
                              <div className="h-1.5 bg-white/[0.06] rounded-full overflow-hidden">
                                {(() => {
                                  const range = pos.target - pos.stopLoss;
                                  const progress = range !== 0 ? ((pos.currentPrice - pos.stopLoss) / range) * 100 : 50;
                                  const clampedProgress = Math.max(0, Math.min(100, progress));
                                  return (
                                    <div
                                      className={`h-full rounded-full transition-all ${isProfit ? "bg-emerald-500" : "bg-red-500"}`}
                                      style={{ width: `${clampedProgress}%` }}
                                    />
                                  );
                                })()}
                              </div>
                            )}
                          </div>
                        )}

                        {/* Setup name + time */}
                        <div className="flex justify-between text-[9px] text-muted-foreground/30">
                          {pos.setup && <span>{pos.setup}</span>}
                          <span>{formatET(pos.openedAt)}</span>
                        </div>
                      </div>
                    );
                  })}

                </div>
              ) : (
                <p className="text-[11px] text-muted-foreground/30 text-center py-4">
                  {posData?.connected ? "No open positions" : "Positions will appear once Tradovate is connected"}
                </p>
              )}
            </CardContent>
          </Card>

          {/* ── RISK GAUGE ── */}
          {posData?.riskMetrics && (() => {
            const rm = posData.riskMetrics;
            // Use balance delta for risk gauge — DB trade P&L sums are double-logged and inflated
            const todayPnl = calendarDayPnl ?? dailyPnl;
            const lossUsed = todayPnl < 0 ? Math.abs(todayPnl) : 0;
            const budgetPct = rm.dailyLossLimit > 0 ? Math.min(100, (lossUsed / rm.dailyLossLimit) * 100) : 0;
            const tradePct = rm.maxTradesPerDay > 0 ? (rm.todayTradeCount / rm.maxTradesPerDay) * 100 : 0;
            const budgetColor = budgetPct > 80 ? "bg-red-500" : budgetPct > 50 ? "bg-amber-500" : "bg-emerald-500";
            return (
              <Card className="border-white/[0.06]">
                <CardHeader className="pb-2">
                  <CardTitle className="text-[11px] text-muted-foreground/40 uppercase tracking-wider font-bold">Daily Risk</CardTitle>
                </CardHeader>
                <CardContent className="space-y-3">
                  <div>
                    <div className="flex justify-between text-[10px] text-muted-foreground/50 mb-1">
                      <span>Loss Budget</span>
                      <span>${lossUsed.toFixed(0)} / ${rm.dailyLossLimit.toFixed(0)}</span>
                    </div>
                    <div className="h-2 bg-white/[0.06] rounded-full overflow-hidden">
                      <div className={`h-full ${budgetColor} rounded-full transition-all`} style={{ width: `${budgetPct}%` }} />
                    </div>
                  </div>
                  <div className="grid grid-cols-2 gap-3">
                    <div>
                      <p className="text-[10px] text-muted-foreground/40">Trades Today</p>
                      <p className="text-sm font-bold tabular-nums">{rm.todayTradeCount} / {rm.maxTradesPerDay}</p>
                    </div>
                    <div>
                      <p className="text-[10px] text-muted-foreground/40">Risk / Trade</p>
                      <p className="text-sm font-bold tabular-nums">${rm.riskPerTrade.toFixed(0)}</p>
                      <p className="text-[9px] text-muted-foreground/30">{((rm.riskPerTrade / rm.simEquity) * 100).toFixed(1)}% of ${rm.simEquity >= 1000 ? `$${(rm.simEquity/1000).toFixed(0)}K` : `$${rm.simEquity}`}</p>
                    </div>
                  </div>
                </CardContent>
              </Card>
            );
          })()}

          {/* ── PERFORMANCE STATS ── */}
          <Card className="border-white/[0.06]">
            <CardHeader className="pb-2">
              <CardTitle className="text-[11px] text-muted-foreground/40 uppercase tracking-wider font-bold">Performance</CardTitle>
            </CardHeader>
            <CardContent className="space-y-3">
              {/* Total P&L — from reconciled DB trades */}
              <div>
                <p className="text-[10px] text-muted-foreground/40">Total P&L</p>
                <p className={`text-2xl font-bold tabular-nums ${pnlColor(totalPnl)}`}>
                  {totalPnl >= 0 ? "+" : "-"}${Math.abs(totalPnl).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                </p>
                <p className="text-[9px] text-muted-foreground/30">{tradeCount} trades</p>
              </div>
              {/* Fills + Win Rate */}
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <p className="text-[10px] text-muted-foreground/40">Win Rate</p>
                  <p className="text-lg font-bold">
                    {tradeCount > 0 ? `${((winCount / tradeCount) * 100).toFixed(0)}%` : "—"}
                  </p>
                  <p className="text-[9px] text-muted-foreground/30">{winCount}W / {lossCount}L</p>
                </div>
                <div>
                  <p className="text-[10px] text-muted-foreground/40">Fills</p>
                  <p className="text-lg font-bold">{(posData?.fillCount ?? 0) > 0 ? posData!.fillCount : closedTrades.length}</p>
                  <p className="text-[9px] text-muted-foreground/30">
                    {(posData?.fillCount ?? 0) > 0 ? "from Tradovate" : "DB logged"}
                  </p>
                </div>
              </div>
              {/* Avg Win / Avg Loss */}
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <p className="text-[10px] text-muted-foreground/40">Avg Win</p>
                  <p className="text-sm font-bold text-emerald-400 tabular-nums">
                    {wins.length > 0 ? `+$${avgWin.toFixed(0)}` : "—"}
                  </p>
                </div>
                <div>
                  <p className="text-[10px] text-muted-foreground/40">Avg Loss</p>
                  <p className="text-sm font-bold text-red-400 tabular-nums">
                    {losses.length > 0 ? `-$${Math.abs(avgLoss).toFixed(0)}` : "—"}
                  </p>
                </div>
              </div>
              {/* Best / Worst */}
              {bestTrade && (
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <p className="text-[10px] text-muted-foreground/40">Best Trade</p>
                    <p className="text-[11px] font-bold text-emerald-400 tabular-nums">+${(bestTrade.pnl || 0).toFixed(0)}</p>
                    <p className="text-[9px] text-muted-foreground/30">{bestTrade.symbol}</p>
                  </div>
                  {worstTrade && (
                    <div>
                      <p className="text-[10px] text-muted-foreground/40">Worst Trade</p>
                      <p className={`text-[11px] font-bold tabular-nums ${(worstTrade.pnl || 0) >= 0 ? "text-emerald-400" : "text-red-400"}`}>
                        {(worstTrade.pnl || 0) >= 0 ? "+" : "-"}${Math.abs(worstTrade.pnl || 0).toFixed(0)}
                      </p>
                      <p className="text-[9px] text-muted-foreground/30">{worstTrade.symbol}</p>
                    </div>
                  )}
                </div>
              )}
              {/* Today / Weekly / Monthly — Tradovate realized for today */}
              <div className="pt-2 border-t border-white/[0.06] space-y-2">
                <div className="flex justify-between items-center">
                  <span className="text-[10px] text-muted-foreground/40">Today</span>
                  <div className="text-right">
                    <span className={`text-sm font-bold tabular-nums ${pnlColor(dailyPnl)}`}>
                      {dailyPnl >= 0 ? "+" : "-"}${Math.abs(dailyPnl).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                    </span>
                    <span className="text-[9px] text-muted-foreground/30 ml-1.5">
                      {dailyTrades} trades
                    </span>
                  </div>
                </div>
                <div className="flex justify-between items-center">
                  <span className="text-[10px] text-muted-foreground/40">This Week</span>
                  <div className="text-right">
                    <span className={`text-sm font-bold tabular-nums ${pnlColor(adjustedWeeklyPnl)}`}>
                      {adjustedWeeklyPnl >= 0 ? "+" : "-"}${Math.abs(adjustedWeeklyPnl).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                    </span>
                    <span className="text-[9px] text-muted-foreground/30 ml-1.5">{weeklyTrades} logged</span>
                  </div>
                </div>
                <div className="flex justify-between items-center">
                  <span className="text-[10px] text-muted-foreground/40">This Month</span>
                  <div className="text-right">
                    <span className={`text-sm font-bold tabular-nums ${pnlColor(adjustedMonthlyPnl)}`}>
                      {adjustedMonthlyPnl >= 0 ? "+" : "-"}${Math.abs(adjustedMonthlyPnl).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                    </span>
                    <span className="text-[9px] text-muted-foreground/30 ml-1.5">{monthlyTrades} logged</span>
                  </div>
                </div>
              </div>
            </CardContent>
          </Card>

          {/* ── AGENT ACTIVITY FEED ── */}
          <Card className="border-white/[0.06]">
            <CardHeader className="pb-2">
              <CardTitle className="text-[11px] text-muted-foreground/40 uppercase tracking-wider font-bold">Agent Activity</CardTitle>
            </CardHeader>
            <CardContent>
              {posData?.activity && posData.activity.length > 0 ? (
                <div className="space-y-1.5 max-h-72 overflow-y-auto">
                  {posData.activity.slice(0, 15).map((log) => (
                    <div key={log.id} className="flex items-start gap-2 text-[10px]">
                      <span className={`shrink-0 mt-0.5 w-1.5 h-1.5 rounded-full ${
                        log.action.includes("long") ? "bg-emerald-500" :
                        log.action.includes("short") ? "bg-red-500" :
                        log.action.includes("close") ? "bg-amber-500" :
                        "bg-white/20"
                      }`} />
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-1.5">
                          <span className="font-bold">{log.symbol}</span>
                          <span className={`px-1 py-0.5 rounded text-[8px] font-bold ${
                            log.action.includes("long") ? "bg-emerald-500/15 text-emerald-400" :
                            log.action.includes("short") ? "bg-red-500/15 text-red-400" :
                            "bg-white/10 text-muted-foreground"
                          }`}>
                            {log.action.replace("futures_", "").toUpperCase()}
                          </span>
                          <span className="text-muted-foreground/30 tabular-nums">{log.qty}x</span>
                          {log.pnl != null && (
                            <span className={`font-bold tabular-nums ${pnlColor(log.pnl)}`}>
                              {log.pnl >= 0 ? "+" : ""}${log.pnl.toFixed(0)}
                            </span>
                          )}
                          {log.aiScore && (
                            <span className="text-blue-400/60">{log.aiScore}%</span>
                          )}
                        </div>
                        <p className="text-muted-foreground/30 truncate">{log.reason?.slice(0, 80)}</p>
                        <p className="text-muted-foreground/20 tabular-nums">
                          {formatET(log.time)}
                        </p>
                      </div>
                    </div>
                  ))}
                </div>
              ) : (
                <p className="text-[11px] text-muted-foreground/30 text-center py-3">No agent activity yet</p>
              )}
            </CardContent>
          </Card>

          {/* ── CONTRACT SPECS ── */}
          {selectedQuote && (
            <Card className="border-white/[0.06]">
              <CardHeader className="pb-2">
                <CardTitle className="text-[11px] text-muted-foreground/40 uppercase tracking-wider font-bold">
                  {selectedQuote.symbol} Specs
                </CardTitle>
              </CardHeader>
              <CardContent>
                <div className="space-y-1.5 text-xs">
                  <div className="flex justify-between">
                    <span className="text-muted-foreground/60">Contract</span>
                    <span className="font-medium">{selectedQuote.name}</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-muted-foreground/60">Multiplier</span>
                    <span className="font-medium">${selectedQuote.multiplier}/pt</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-muted-foreground/60">Tick Size</span>
                    <span className="font-medium">{selectedQuote.tickSize}</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-muted-foreground/60">Tick Value</span>
                    <span className="font-medium">${(selectedQuote.tickSize * selectedQuote.multiplier).toFixed(2)}</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-muted-foreground/60">Day Margin</span>
                    <span className="font-medium">${selectedQuote.margin.toLocaleString()}</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-muted-foreground/60">Day Range</span>
                    <span className="font-medium tabular-nums">
                      {formatNum(selectedQuote.low)} — {formatNum(selectedQuote.high)}
                    </span>
                  </div>
                </div>
              </CardContent>
            </Card>
          )}

          {/* ── SETUP REQUIRED ── */}
          {!status?.connected && (
            <Card className="border-amber-500/20 bg-amber-500/[0.03]">
              <CardHeader className="pb-2">
                <CardTitle className="text-[11px] text-amber-400 uppercase tracking-wider font-bold">Setup Required</CardTitle>
              </CardHeader>
              <CardContent className="text-[11px] space-y-2 text-muted-foreground/60">
                <p>Tradovate setup needed:</p>
                <div className="space-y-1 ml-2">
                  <p>1. Subscribe to API ($25/mo)</p>
                  <p>2. Create API keys (CID + SEC)</p>
                  <p>3. Set Vercel env vars</p>
                  <p>4. Redeploy — agent auto-connects</p>
                </div>
                <p className="text-[9px] text-muted-foreground/30 pt-1">Charts + quotes work now via Yahoo Finance. Agent + positions need Tradovate auth.</p>
              </CardContent>
            </Card>
          )}

          {/* ── AGENT OUTPUT ── */}
          {result && (
            <Card className="border-white/[0.06]">
              <CardHeader className="pb-2">
                <CardTitle className="text-[11px] text-muted-foreground/40 uppercase tracking-wider font-bold">Last Agent Run</CardTitle>
              </CardHeader>
              <CardContent>
                <div className="bg-black/30 rounded-lg p-2 max-h-64 overflow-y-auto font-mono text-[10px] text-muted-foreground/60 space-y-0.5">
                  {result.details.map((d, i) => (
                    <div key={i} className={
                      d.includes("TRADE:") || d.includes("ORDER PLACED") ? "text-emerald-400 font-medium" :
                      d.includes("STOP") || d.includes("EMERGENCY") ? "text-red-400" :
                      d.includes("SETUP:") ? "text-blue-400 font-medium" :
                      d.includes("REGIME:") || d.includes("MACRO:") ? "text-purple-400" :
                      ""
                    }>{d}</div>
                  ))}
                </div>
              </CardContent>
            </Card>
          )}
        </div>
      </div>
    </div>
  );
}
