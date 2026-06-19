"use client";

import { useState, useEffect } from "react";
import Link from "next/link";
import { usePositions } from "@/hooks/use-positions";
import { formatCurrency, formatPercent, pnlColor } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";

interface TradeContext {
  symbol: string;
  aiScore: number | null;
  aiSignal: string | null;
  reason: string;
  createdAt: string;
}

interface ResearchContext {
  symbol: string;
  score: number;
  signal: string;
  summary: string;
  priceTarget: number | null;
}

interface IdeaContext {
  symbol: string;
  action: string;
  targetPrice: number | null;
  stopLoss: number | null;
  timeframe: string;
  reasoning: string;
}

interface PositionPlan {
  symbol: string;
  type: "spread_leg" | "standalone_long" | "standalone_short" | "worthless";
  spreadGroup?: string;
  spreadPartner?: string;
  underlying: string;
  optionType: string;
  dte: number;
  expiryDate: string;
  netCredit?: number;
  maxLoss?: number;
  spreadPnl?: number;
  pnlPctOfMax?: number;
  takeProfitAt: string;
  stopLossAt: string;
  expiryCloseAt: string;
  plan: string;
  reasoning: string;
  urgency: "none" | "watch" | "action_soon" | "immediate";
}

function timeframeBadge(tf: string) {
  const colors: Record<string, string> = {
    day_trade: "bg-red-500",
    swing: "bg-amber-500",
    position: "bg-blue-500",
    long_term: "bg-emerald-600",
  };
  const labels: Record<string, string> = {
    day_trade: "Day Trade",
    swing: "Swing (days-weeks)",
    position: "Position (weeks-months)",
    long_term: "Long Term (months+)",
  };
  return (
    <Badge className={colors[tf] || "bg-muted"} variant="secondary">
      {labels[tf] || tf || "Unknown"}
    </Badge>
  );
}

export function PositionsTable() {
  const { data: positions, isLoading, mutate } = usePositions();
  const [closing, setClosing] = useState<string | null>(null);
  const [closingAll, setClosingAll] = useState(false);
  const [tradeContexts, setTradeContexts] = useState<Record<string, TradeContext>>({});
  const [researchContexts, setResearchContexts] = useState<Record<string, ResearchContext>>({});
  const [ideaContexts, setIdeaContexts] = useState<Record<string, IdeaContext>>({});
  const [plans, setPlans] = useState<Record<string, PositionPlan>>({});
  const [expandedPlans, setExpandedPlans] = useState<Set<string>>(new Set());

  // Load AI context for each position
  useEffect(() => {
    async function loadContexts() {
      try {
        const [tradesRes, reportsRes, ideasRes, plansRes] = await Promise.all([
          fetch("/api/agent/logs?limit=50").then((r) => r.json()),
          fetch("/api/ai/reports?limit=20").then((r) => r.json()),
          fetch("/api/ai/ideas").then((r) => r.json()),
          fetch("/api/positions/plan").then((r) => r.json()),
        ]);

        // Map trade logs by symbol (most recent buy)
        const tMap: Record<string, TradeContext> = {};
        if (Array.isArray(tradesRes)) {
          for (const t of tradesRes) {
            if (t.action === "buy" && !tMap[t.symbol]) {
              tMap[t.symbol] = t;
            }
          }
        }
        setTradeContexts(tMap);

        // Map research reports by symbol (most recent)
        const rMap: Record<string, ResearchContext> = {};
        if (Array.isArray(reportsRes)) {
          for (const r of reportsRes) {
            if (!rMap[r.symbol]) rMap[r.symbol] = r;
          }
        }
        setResearchContexts(rMap);

        // Map trade ideas by symbol (most recent active)
        const iMap: Record<string, IdeaContext> = {};
        if (Array.isArray(ideasRes)) {
          for (const i of ideasRes) {
            if (!iMap[i.symbol]) iMap[i.symbol] = i;
          }
        }
        setIdeaContexts(iMap);

        // Map plans by symbol
        const pMap: Record<string, PositionPlan> = {};
        if (Array.isArray(plansRes)) {
          for (const p of plansRes) pMap[p.symbol] = p;
        }
        setPlans(pMap);
      } catch {
        // ignore
      }
    }
    if (positions && positions.length > 0) loadContexts();
  }, [positions]);

  async function closePosition(symbol: string, qty: string, side: string) {
    setClosing(symbol);
    const closeSide = side === "short" ? "buy" : "sell"; // close a short by buying, a long by selling
    try {
      await fetch("/api/orders", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ symbol, qty, side: closeSide, type: "market", time_in_force: "day" }),
      });
      setTimeout(() => mutate(), 2000);
    } catch { /* ignore */ }
    setClosing(null);
  }

  async function closeAllPositions() {
    if (!positions || positions.length === 0) return;
    setClosingAll(true);
    for (const pos of positions) {
      try {
        await fetch("/api/orders", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ symbol: pos.symbol, qty: pos.qty, side: pos.side === "short" ? "buy" : "sell", type: "market", time_in_force: "day" }),
        });
      } catch { /* ignore */ }
    }
    setTimeout(() => { mutate(); setClosingAll(false); }, 3000);
  }

  if (isLoading) {
    return <div className="text-sm text-muted-foreground">Loading positions...</div>;
  }

  if (!positions || positions.length === 0) {
    return (
      <div className="text-sm text-muted-foreground py-8 text-center">
        No open positions. The agents will open positions automatically, or use Manual Trade to place an order yourself.
      </div>
    );
  }

  return (
    <div>
      <div className="flex justify-end mb-3">
        <Button
          variant="outline"
          size="sm"
          className="text-red-500 border-red-500/30 hover:bg-red-500/10"
          onClick={closeAllPositions}
          disabled={closingAll}
        >
          {closingAll ? "Closing all..." : `Close All ${positions.length} Positions`}
        </Button>
      </div>

      <div className="space-y-3">
        {positions.map((pos) => {
          const trade = tradeContexts[pos.symbol];
          const research = researchContexts[pos.symbol];
          const idea = ideaContexts[pos.symbol];
          const plPct = parseFloat(pos.unrealized_plpc) * 100;
          const holdingSince = trade?.createdAt ? new Date(trade.createdAt) : null;
          const holdingDays = holdingSince ? Math.floor((Date.now() - holdingSince.getTime()) / (1000 * 60 * 60 * 24)) : null;

          return (
            <div key={pos.symbol} className="border rounded-lg p-4 space-y-3">
              {/* Top row: symbol, qty, P&L, close button */}
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-3">
                  <Link href={`/research/${pos.symbol}`} className="text-lg font-bold hover:underline">
                    {pos.symbol}
                  </Link>
                  <span className="text-sm text-muted-foreground">{pos.qty} {parseFloat(pos.qty) === 1 ? "unit" : "units"}</span>
                  {idea?.timeframe && timeframeBadge(idea.timeframe)}
                  {trade?.aiScore != null && (
                    <Badge variant="outline" className={trade.aiScore > 50 ? "text-emerald-500 border-emerald-500/30" : "text-amber-500 border-amber-500/30"}>
                      AI Score: {trade.aiScore}
                    </Badge>
                  )}
                  {holdingDays != null && (
                    <span className="text-xs text-muted-foreground">
                      Held {holdingDays === 0 ? "today" : `${holdingDays}d`}
                    </span>
                  )}
                </div>
                <div className="flex items-center gap-3">
                  <div className="text-right">
                    <div className={`text-lg font-bold ${pnlColor(pos.unrealized_pl)}`}>
                      {parseFloat(pos.unrealized_pl) >= 0 ? "+" : ""}{formatCurrency(pos.unrealized_pl)}
                    </div>
                    <div className={`text-xs ${pnlColor(pos.unrealized_plpc)}`}>
                      {plPct >= 0 ? "+" : ""}{plPct.toFixed(2)}%
                    </div>
                  </div>
                  <Button
                    variant="outline"
                    size="sm"
                    className="text-red-500 border-red-500/30 hover:bg-red-500/10"
                    onClick={() => closePosition(pos.symbol, pos.qty, pos.side)}
                    disabled={closing === pos.symbol}
                  >
                    {closing === pos.symbol ? "Closing..." : "Close"}
                  </Button>
                </div>
              </div>

              {/* Price details */}
              <div className="grid grid-cols-2 md:grid-cols-5 gap-3 text-sm">
                <div>
                  <span className="text-xs text-muted-foreground">Entry</span>
                  <p className="font-medium">{formatCurrency(pos.avg_entry_price)}</p>
                </div>
                <div>
                  <span className="text-xs text-muted-foreground">Current</span>
                  <p className="font-medium">{formatCurrency(pos.current_price)}</p>
                </div>
                <div>
                  <span className="text-xs text-muted-foreground">Target</span>
                  <p className="font-medium text-emerald-500">
                    {idea?.targetPrice ? formatCurrency(idea.targetPrice) : research?.priceTarget ? formatCurrency(research.priceTarget) : "N/A"}
                  </p>
                </div>
                <div>
                  <span className="text-xs text-muted-foreground">Stop Loss</span>
                  <p className="font-medium text-red-500">
                    {idea?.stopLoss ? formatCurrency(idea.stopLoss) : "ATR-based"}
                  </p>
                </div>
                <div>
                  <span className="text-xs text-muted-foreground">Market Value</span>
                  <p className="font-medium">{formatCurrency(pos.market_value)}</p>
                </div>
              </div>

              {/* AI Plan Button */}
              {plans[pos.symbol] && (
                <div>
                  <button
                    onClick={() => {
                      const next = new Set(expandedPlans);
                      if (next.has(pos.symbol)) next.delete(pos.symbol);
                      else next.add(pos.symbol);
                      setExpandedPlans(next);
                    }}
                    className="text-xs text-blue-400 hover:text-blue-300 font-medium flex items-center gap-1"
                  >
                    {expandedPlans.has(pos.symbol) ? "Hide" : "Show"} AI Plan
                    <span className={`inline-block transition-transform ${expandedPlans.has(pos.symbol) ? "rotate-180" : ""}`}>▼</span>
                    {plans[pos.symbol].urgency === "immediate" && (
                      <span className="ml-1 px-1.5 py-0.5 rounded text-[9px] bg-red-500/20 text-red-400 font-bold">ACTION NEEDED</span>
                    )}
                    {plans[pos.symbol].urgency === "action_soon" && (
                      <span className="ml-1 px-1.5 py-0.5 rounded text-[9px] bg-yellow-500/20 text-yellow-400 font-bold">WATCH</span>
                    )}
                    {plans[pos.symbol].spreadGroup && (
                      <span className="ml-1 px-1.5 py-0.5 rounded text-[9px] bg-blue-500/15 text-blue-400">SPREAD</span>
                    )}
                  </button>

                  {expandedPlans.has(pos.symbol) && (() => {
                    const p = plans[pos.symbol];
                    return (
                      <div className="mt-2 bg-muted/50 rounded-lg p-3 space-y-2 text-xs">
                        {/* Position type */}
                        <div className="flex items-center gap-2">
                          {p.spreadGroup && <span className="font-bold text-blue-400">{p.spreadGroup}</span>}
                          <span className="text-muted-foreground">{p.dte} DTE — Expires {p.expiryDate}</span>
                        </div>

                        {/* Spread metrics */}
                        {p.netCredit != null && (
                          <div className="grid grid-cols-4 gap-2 py-1 border-y border-white/5">
                            <div>
                              <span className="text-muted-foreground/60">Credit Received</span>
                              <p className="font-medium text-emerald-400">${p.netCredit.toFixed(0)}</p>
                            </div>
                            <div>
                              <span className="text-muted-foreground/60">Max Risk</span>
                              <p className="font-medium text-red-400">${p.maxLoss?.toFixed(0)}</p>
                            </div>
                            <div>
                              <span className="text-muted-foreground/60">Current P&L</span>
                              <p className={`font-medium ${(p.spreadPnl || 0) >= 0 ? "text-emerald-400" : "text-red-400"}`}>
                                {(p.spreadPnl || 0) >= 0 ? "+" : ""}${p.spreadPnl?.toFixed(0)}
                              </p>
                            </div>
                            <div>
                              <span className="text-muted-foreground/60">% of Max Profit</span>
                              <p className="font-medium">{((p.pnlPctOfMax || 0) * 100).toFixed(0)}%</p>
                            </div>
                          </div>
                        )}

                        {/* Exit triggers */}
                        <div className="grid grid-cols-3 gap-2">
                          <div>
                            <span className="text-muted-foreground/60">Take Profit</span>
                            <p className="font-medium text-emerald-400">{p.takeProfitAt}</p>
                          </div>
                          <div>
                            <span className="text-muted-foreground/60">Stop Loss</span>
                            <p className="font-medium text-red-400">{p.stopLossAt}</p>
                          </div>
                          <div>
                            <span className="text-muted-foreground/60">Expiry Close</span>
                            <p className="font-medium">{p.expiryCloseAt}</p>
                          </div>
                        </div>

                        {/* Agent's plan */}
                        <div className={`p-2 rounded ${
                          p.urgency === "immediate" ? "bg-red-500/10 border border-red-500/20" :
                          p.urgency === "action_soon" ? "bg-yellow-500/10 border border-yellow-500/20" :
                          "bg-white/5"
                        }`}>
                          <span className="font-medium text-foreground">Plan: </span>
                          <span>{p.plan}</span>
                        </div>
                        <div className="text-muted-foreground/60">
                          <span className="font-medium">Why: </span>{p.reasoning}
                        </div>
                      </div>
                    );
                  })()}
                </div>
              )}

              {/* Fallback AI Reasoning (if no plan available) */}
              {!plans[pos.symbol] && (trade?.reason || research?.summary) && (
                <div className="text-xs text-muted-foreground bg-muted/50 rounded p-2">
                  <span className="font-medium text-foreground">AI Reasoning: </span>
                  {trade?.reason?.slice(0, 200) || research?.summary?.slice(0, 200)}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
