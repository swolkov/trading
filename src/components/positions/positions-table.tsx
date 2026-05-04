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

  // Load AI context for each position
  useEffect(() => {
    async function loadContexts() {
      try {
        const [tradesRes, reportsRes, ideasRes] = await Promise.all([
          fetch("/api/agent/logs?limit=50").then((r) => r.json()),
          fetch("/api/ai/reports?limit=20").then((r) => r.json()),
          fetch("/api/ai/ideas").then((r) => r.json()),
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
      } catch {
        // ignore
      }
    }
    if (positions && positions.length > 0) loadContexts();
  }, [positions]);

  async function closePosition(symbol: string, qty: string) {
    setClosing(symbol);
    try {
      await fetch("/api/orders", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ symbol, qty, side: "sell", type: "market", time_in_force: "day" }),
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
          body: JSON.stringify({ symbol: pos.symbol, qty: pos.qty, side: "sell", type: "market", time_in_force: "day" }),
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
        No open positions. Go to the Trade page to place your first order.
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
                  <span className="text-sm text-muted-foreground">{pos.qty} shares</span>
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
                    onClick={() => closePosition(pos.symbol, pos.qty)}
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

              {/* AI Reasoning */}
              {(trade?.reason || research?.summary) && (
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
