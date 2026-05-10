"use client";

import { useState, useEffect, useCallback } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";

interface FuturesStatus {
  connected: boolean;
  accountId?: string;
  message?: string;
}

interface FuturesResult {
  trades: { symbol: string; action: string; contracts: number; price: number; stopLoss: number; target: number; reasoning: string; success: boolean }[];
  managed: number;
  details: string[];
}

interface FuturesTrade {
  symbol: string;
  action: string;
  qty: number;
  price: number | null;
  pnl: number | null;
  reason: string;
  time: string;
}

const CONTRACTS = [
  { symbol: "MES", name: "Micro E-mini S&P 500", multiplier: "$5/pt", margin: "$1,320", when: "Always" },
  { symbol: "MNQ", name: "Micro E-mini Nasdaq 100", multiplier: "$2/pt", margin: "$1,630", when: "Trending only" },
  { symbol: "MYM", name: "Micro E-mini Dow", multiplier: "$0.50/pt", margin: "$880", when: "Always" },
  { symbol: "M2K", name: "Micro E-mini Russell 2000", multiplier: "$5/pt", margin: "$730", when: "Trending only" },
];

const STRATEGIES = [
  {
    name: "Opening Range Breakout",
    priority: 1,
    when: "First 30 min after open",
    direction: "Long or Short",
    description: "Price breaks above/below the first 15-min range with 1.2x+ volume. Most reliable early-session setup.",
    rules: ["Wait for first 15 min to establish range", "Enter on break with volume confirmation", "Stop: 1.5 ATR", "Target: 1.5x the opening range"],
  },
  {
    name: "VWAP Mean Reversion",
    priority: 2,
    when: "Midday/afternoon, choppy markets",
    direction: "Fade to VWAP",
    description: "Price hits VWAP upper/lower band + RSI extreme. Fade back toward VWAP for a high-probability mean reversion.",
    rules: ["Price at VWAP +/- 1 std dev", "RSI > 70 (short) or RSI < 30 (long)", "Target: VWAP itself", "Only in choppy/neutral regime"],
  },
  {
    name: "Trend Continuation",
    priority: 3,
    when: "Bull or bear regime",
    direction: "With trend",
    description: "Pullback to EMA9 in an established trend. RSI neutral (40-60). The bread and butter of trending markets.",
    rules: ["EMA9 > EMA21 (long) or EMA9 < EMA21 (short)", "Price pulls back to EMA9", "RSI between 40-60 (not extreme)", "Target: 3x ATR (wider in trends)"],
  },
  {
    name: "Key Level Bounce",
    priority: 4,
    when: "Anytime",
    direction: "Bounce",
    description: "Price tests previous day high/low with RSI confirmation. High-probability reversal at known levels.",
    rules: ["Price within 0.1% of previous day high or low", "RSI confirms (< 35 at support, > 65 at resistance)", "Stop: 2x ATR", "Target: 2.5x ATR"],
  },
  {
    name: "EMA Crossover",
    priority: 5,
    when: "Anytime (fallback)",
    direction: "Cross direction",
    description: "EMA9 crosses EMA21 with price above/below VWAP and volume confirmation. Lowest priority, used when nothing else sets up.",
    rules: ["EMA9 crosses EMA21", "Price must be on same side of VWAP", "Volume > average", "Stop: 1.5 ATR, Target: 2.5 ATR"],
  },
];

const RISK_RULES = [
  { rule: "0.2% of equity risked per trade", detail: "$1M paper = $2,000 risk. When live with $100k = $200 risk. Same percentages." },
  { rule: "Bracket orders on every entry", detail: "Stop loss + take profit placed atomically with entry at the exchange. No relying on cron checks." },
  { rule: "1% daily loss limit", detail: "If down 1% of equity in a day, agent stops trading. Protects against tilt." },
  { rule: "Max 6 trades per day", detail: "Quality over quantity. 2-3 good trades beats 10 mediocre ones." },
  { rule: "15-min trend confirmation", detail: "Won't go against the 15-min trend. If 5-min says long but 15-min says down, confidence is reduced." },
  { rule: "Skip first/last 15 min of RTH", detail: "Opening and closing are too choppy. Avoids getting chopped up in noise." },
  { rule: "Close choppy positions before EOD", detail: "In choppy markets, closes all positions before 4 PM. Only holds overnight in strong trends." },
  { rule: "AI confirmation (optional boost)", detail: "Asks Claude for a quick agree/disagree. Adjusts confidence +5% or -15% based on response." },
];

function pnlColor(val: number) {
  return val > 0 ? "text-emerald-400" : val < 0 ? "text-red-400" : "text-muted-foreground";
}

export default function FuturesPage() {
  const [status, setStatus] = useState<FuturesStatus | null>(null);
  const [result, setResult] = useState<FuturesResult | null>(null);
  const [trades, setTrades] = useState<FuturesTrade[]>([]);
  const [running, setRunning] = useState(false);

  const loadData = useCallback(async () => {
    const [statusRes, tradesRes] = await Promise.all([
      fetch("/api/futures").then((r) => r.json()).catch(() => ({ connected: false, message: "Connection check failed" })),
      fetch("/api/agent/activity?filter=futures").then((r) => r.json()).catch(() => []),
    ]);
    setStatus(statusRes);
    if (Array.isArray(tradesRes)) setTrades(tradesRes.filter((t: FuturesTrade) => t.symbol?.startsWith("FUT:")));
  }, []);

  useEffect(() => {
    loadData();
    const interval = setInterval(loadData, 30000);
    return () => clearInterval(interval);
  }, [loadData]);

  const runAgent = async () => {
    setRunning(true);
    try {
      const res = await fetch("/api/futures", { method: "POST" });
      setResult(await res.json());
    } catch (err) {
      setResult({ trades: [], managed: 0, details: [`Error: ${err}`] });
    }
    setRunning(false);
    loadData();
  };

  // Stats from trade history
  const closedTrades = trades.filter((t) => t.pnl != null);
  const wins = closedTrades.filter((t) => (t.pnl || 0) > 0);
  const totalPnl = closedTrades.reduce((s, t) => s + (t.pnl || 0), 0);

  return (
    <div className="space-y-6 animate-fade-up">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold">Futures Trading</h1>
          <p className="text-sm text-muted-foreground">Expert micro futures system via Interactive Brokers</p>
        </div>
        <Button onClick={runAgent} disabled={running || !status?.connected} size="sm">
          {running ? "Running..." : "Run Futures Agent"}
        </Button>
      </div>

      {/* Connection + Stats Row */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <Card>
          <CardContent className="pt-4 pb-3">
            <p className="text-[10px] text-muted-foreground/60 uppercase tracking-wider">IBKR Status</p>
            <div className="flex items-center gap-2 mt-1">
              <span className={`w-2 h-2 rounded-full ${status?.connected ? "bg-emerald-500 animate-pulse" : "bg-red-500"}`} />
              <span className={`text-sm font-bold ${status?.connected ? "text-emerald-400" : "text-red-400"}`}>
                {status?.connected ? "Connected" : "Disconnected"}
              </span>
            </div>
            <p className="text-[10px] text-muted-foreground/50 mt-0.5">{status?.accountId || "Paper trading"}</p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="pt-4 pb-3">
            <p className="text-[10px] text-muted-foreground/60 uppercase tracking-wider">Futures P&L</p>
            <p className={`text-2xl font-bold mt-1 ${pnlColor(totalPnl)}`}>
              {totalPnl >= 0 ? "+" : "-"}${Math.abs(totalPnl).toFixed(0)}
            </p>
            <p className="text-[10px] text-muted-foreground/50">{closedTrades.length} closed trades</p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="pt-4 pb-3">
            <p className="text-[10px] text-muted-foreground/60 uppercase tracking-wider">Win Rate</p>
            <p className="text-2xl font-bold mt-1">
              {closedTrades.length > 0 ? `${((wins.length / closedTrades.length) * 100).toFixed(0)}%` : "—"}
            </p>
            <p className="text-[10px] text-muted-foreground/50">{wins.length}W / {closedTrades.length - wins.length}L</p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="pt-4 pb-3">
            <p className="text-[10px] text-muted-foreground/60 uppercase tracking-wider">Schedule</p>
            <p className="text-sm font-bold mt-1">Every 30 min</p>
            <p className="text-[10px] text-muted-foreground/50">24hrs weekdays (futures hours)</p>
          </CardContent>
        </Card>
      </div>

      {/* Strategy Framework */}
      <Card>
        <CardHeader>
          <CardTitle className="text-sm">Strategy Framework — 5 Expert Setups</CardTitle>
          <p className="text-xs text-muted-foreground">Prioritized from highest to lowest. Agent checks in order, takes the first valid setup.</p>
        </CardHeader>
        <CardContent>
          <div className="space-y-3">
            {STRATEGIES.map((s, i) => (
              <div key={i} className="bg-white/[0.03] border border-white/[0.06] rounded-lg p-3">
                <div className="flex items-center justify-between mb-1">
                  <div className="flex items-center gap-2">
                    <span className="text-[10px] bg-blue-500/15 text-blue-400 px-1.5 py-0.5 rounded font-bold">#{s.priority}</span>
                    <span className="text-sm font-bold">{s.name}</span>
                  </div>
                  <span className="text-[10px] text-muted-foreground">{s.when}</span>
                </div>
                <p className="text-xs text-muted-foreground mb-2">{s.description}</p>
                <div className="flex flex-wrap gap-2">
                  {s.rules.map((r, j) => (
                    <span key={j} className="text-[10px] bg-white/5 px-2 py-0.5 rounded">{r}</span>
                  ))}
                </div>
              </div>
            ))}
          </div>
        </CardContent>
      </Card>

      {/* Risk Rules */}
      <Card>
        <CardHeader>
          <CardTitle className="text-sm">Risk Management</CardTitle>
          <p className="text-xs text-muted-foreground">Equity-based — same percentages paper and live</p>
        </CardHeader>
        <CardContent>
          <div className="grid md:grid-cols-2 gap-2">
            {RISK_RULES.map((r, i) => (
              <div key={i} className="flex items-start gap-2 text-xs">
                <span className="text-emerald-400 mt-0.5 shrink-0">{i + 1}.</span>
                <div>
                  <span className="font-medium">{r.rule}</span>
                  <p className="text-[10px] text-muted-foreground/60">{r.detail}</p>
                </div>
              </div>
            ))}
          </div>
        </CardContent>
      </Card>

      {/* Contracts */}
      <Card>
        <CardHeader>
          <CardTitle className="text-sm">Micro Futures Contracts</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
            {CONTRACTS.map((c) => (
              <div key={c.symbol} className="bg-white/[0.03] border border-white/[0.06] rounded-lg p-3 space-y-1">
                <p className="text-sm font-bold text-emerald-400">{c.symbol}</p>
                <p className="text-[11px] text-muted-foreground">{c.name}</p>
                <div className="flex justify-between text-[10px] text-muted-foreground/60">
                  <span>{c.multiplier}</span>
                  <span>{c.margin}</span>
                </div>
                <p className="text-[10px] text-blue-400">{c.when}</p>
              </div>
            ))}
          </div>
        </CardContent>
      </Card>

      {/* Trade History */}
      {trades.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle className="text-sm">Futures Trade History</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="overflow-x-auto">
              <table className="w-full text-xs">
                <thead>
                  <tr className="text-muted-foreground/60 border-b border-white/10">
                    <th className="text-left py-2 font-medium">Symbol</th>
                    <th className="text-left py-2 font-medium">Action</th>
                    <th className="text-right py-2 font-medium">Qty</th>
                    <th className="text-right py-2 font-medium">Price</th>
                    <th className="text-right py-2 font-medium">P&L</th>
                    <th className="text-left py-2 font-medium">Reason</th>
                    <th className="text-right py-2 font-medium">Time</th>
                  </tr>
                </thead>
                <tbody>
                  {trades.slice(0, 30).map((t, i) => (
                    <tr key={i} className="border-b border-white/[0.04]">
                      <td className="py-2 font-medium">{t.symbol.replace("FUT:", "")}</td>
                      <td className="py-2">
                        <span className={`px-1.5 py-0.5 rounded text-[10px] ${
                          t.action.includes("long") ? "bg-emerald-500/15 text-emerald-400" :
                          t.action.includes("short") ? "bg-red-500/15 text-red-400" :
                          "bg-white/10"
                        }`}>{t.action.replace("futures_", "").toUpperCase()}</span>
                      </td>
                      <td className="py-2 text-right">{t.qty}</td>
                      <td className="py-2 text-right">{t.price ? `$${t.price.toFixed(2)}` : "—"}</td>
                      <td className={`py-2 text-right font-bold ${t.pnl != null ? pnlColor(t.pnl) : ""}`}>
                        {t.pnl != null ? `${t.pnl >= 0 ? "+" : ""}$${t.pnl.toFixed(0)}` : "Open"}
                      </td>
                      <td className="py-2 text-muted-foreground max-w-[200px] truncate">{t.reason?.slice(0, 80)}</td>
                      <td className="py-2 text-right text-muted-foreground">
                        {new Date(t.time).toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </CardContent>
        </Card>
      )}

      {/* Agent Output */}
      {result && (
        <Card>
          <CardHeader>
            <CardTitle className="text-sm">Last Agent Run</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="bg-black/30 rounded-lg p-3 max-h-96 overflow-y-auto font-mono text-[11px] text-muted-foreground space-y-0.5">
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

      {/* Setup Instructions (when not connected) */}
      {!status?.connected && (
        <Card className="border-yellow-500/20">
          <CardHeader>
            <CardTitle className="text-sm">Connect IBKR Gateway</CardTitle>
          </CardHeader>
          <CardContent className="text-xs space-y-2 text-muted-foreground">
            <p>The gateway is deployed on Railway. To activate:</p>
            <div className="space-y-1 ml-4">
              <p>1. Visit <span className="text-blue-400">trading-production-fbc9.up.railway.app</span> in your browser</p>
              <p>2. Log in with your IBKR paper trading credentials</p>
              <p>3. Once authenticated, the futures agent will start trading automatically</p>
              <p>4. Re-authenticate daily (~24hr session)</p>
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
