"use client";

import { useState, useMemo } from "react";
import useSWR from "swr";
import { useOrders } from "@/hooks/use-orders";
import { formatCurrency, formatDate, pnlColor } from "@/lib/utils";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";

type AssetFilter = "all" | "options" | "stocks" | "futures";

const fetcher = (url: string) => fetch(url).then((r) => r.json());

function isOptionSymbol(symbol: string) {
  return /^[A-Z]+\d{6}[CP]\d+$/.test(symbol);
}

function parseOptionDisplay(symbol: string) {
  const match = symbol.match(/^([A-Z]+)(\d{6})([CP])(\d+)$/);
  if (!match) return symbol;
  const underlying = match[1];
  const dateStr = match[2];
  const type = match[3] === "C" ? "C" : "P";
  const strike = (parseInt(match[4]) / 1000).toFixed(0);
  const exp = `${dateStr.slice(2, 4)}/${dateStr.slice(4, 6)}`;
  return `${underlying} ${exp} ${strike}${type}`;
}

function statusBadge(status: string) {
  const s = status.toLowerCase();
  if (s === "filled") return <Badge className="bg-emerald-600 text-[10px]">Filled</Badge>;
  if (s === "partially_filled") return <Badge className="bg-amber-600 text-[10px]">Partial</Badge>;
  if (s === "new" || s === "accepted" || s === "working") return <Badge variant="secondary" className="text-[10px]">Open</Badge>;
  if (s === "canceled" || s === "cancelled" || s === "expired") return <Badge variant="outline" className="text-[10px]">{status}</Badge>;
  if (s === "rejected") return <Badge className="bg-red-600 text-[10px]">Rejected</Badge>;
  return <Badge variant="outline" className="text-[10px]">{status}</Badge>;
}

function assetBadge(type: "options" | "stocks" | "futures") {
  switch (type) {
    case "options":
      return <span className="px-1.5 py-0.5 rounded text-[9px] bg-purple-500/15 text-purple-400 font-bold">OPT</span>;
    case "futures":
      return <span className="px-1.5 py-0.5 rounded text-[9px] bg-amber-500/15 text-amber-400 font-bold">FUT</span>;
    case "stocks":
      return <span className="px-1.5 py-0.5 rounded text-[9px] bg-blue-500/15 text-blue-400 font-bold">STK</span>;
  }
}

function actionBadge(action: string) {
  const a = action.toLowerCase();
  if (a.includes("long") || a.includes("buy")) return <span className="px-1.5 py-0.5 rounded text-[9px] bg-emerald-500/15 text-emerald-400 font-bold">{action.toUpperCase()}</span>;
  if (a.includes("short") || a.includes("sell")) return <span className="px-1.5 py-0.5 rounded text-[9px] bg-red-500/15 text-red-400 font-bold">{action.toUpperCase()}</span>;
  if (a.includes("stop")) return <span className="px-1.5 py-0.5 rounded text-[9px] bg-red-500/15 text-red-400 font-bold">{action.toUpperCase()}</span>;
  if (a.includes("take profit") || a.includes("target")) return <span className="px-1.5 py-0.5 rounded text-[9px] bg-emerald-500/15 text-emerald-400 font-bold">{action.toUpperCase()}</span>;
  if (a.includes("scale")) return <span className="px-1.5 py-0.5 rounded text-[9px] bg-blue-500/15 text-blue-400 font-bold">{action.toUpperCase()}</span>;
  if (a.includes("trail")) return <span className="px-1.5 py-0.5 rounded text-[9px] bg-purple-500/15 text-purple-400 font-bold">{action.toUpperCase()}</span>;
  if (a.includes("close") || a.includes("breakeven")) return <span className="px-1.5 py-0.5 rounded text-[9px] bg-amber-500/15 text-amber-400 font-bold">{action.toUpperCase()}</span>;
  return <span className="text-[10px] text-muted-foreground">{action}</span>;
}

export interface UnifiedOrder {
  id: string;
  symbol: string;
  displaySymbol: string;
  side: string;
  action: string;
  type: string;
  qty: string;
  filledQty: string;
  price: string;
  pnl: number | null;
  aiScore: number | null;
  reason: string | null;
  status: string;
  time: string;
  assetType: "options" | "stocks" | "futures";
  source: "alpaca" | "tradovate";
  cancelable: boolean;
}

export interface OrdersSummary {
  totalShown: number;
  openCount: number;
  filledCount: number;
  todayPnl: number;
  todayFills: number;
}

function OrdersTableInner({
  status,
  assetFilter,
  onSummary,
}: {
  status: "open" | "closed" | "all";
  assetFilter: AssetFilter;
  onSummary?: (summary: OrdersSummary) => void;
}) {
  const { data: alpacaOrders, isLoading: alpacaLoading, mutate } = useOrders(status);
  const { data: futuresData, isLoading: futuresLoading } = useSWR(
    "/api/futures/positions",
    fetcher,
    { refreshInterval: 15000 }
  );
  const [canceling, setCanceling] = useState<string | null>(null);
  const [expandedRow, setExpandedRow] = useState<string | null>(null);

  async function handleCancel(orderId: string) {
    setCanceling(orderId);
    try {
      await fetch(`/api/orders?orderId=${orderId}`, { method: "DELETE" });
      mutate();
    } finally {
      setCanceling(null);
    }
  }

  const isLoading = alpacaLoading || futuresLoading;

  // Build unified order list
  const unified = useMemo(() => {
    const items: UnifiedOrder[] = [];

    // Alpaca orders
    if (alpacaOrders) {
      for (const o of alpacaOrders) {
        const isOpt = isOptionSymbol(o.symbol);
        items.push({
          id: o.id,
          symbol: o.symbol,
          displaySymbol: isOpt ? parseOptionDisplay(o.symbol) : o.symbol,
          side: o.side,
          action: o.side,
          type: o.type,
          qty: o.qty,
          filledQty: o.filled_qty,
          price: o.filled_avg_price
            ? formatCurrency(o.filled_avg_price)
            : o.limit_price
            ? formatCurrency(o.limit_price)
            : "Market",
          pnl: null,
          aiScore: null,
          reason: null,
          status: o.status,
          time: o.filled_at || o.submitted_at,
          assetType: isOpt ? "options" : "stocks",
          source: "alpaca",
          cancelable: ["new", "accepted", "partially_filled"].includes(o.status),
        });
      }
    }

    // Tradovate: open orders (pending stops, limits)
    if (futuresData?.orders && (assetFilter === "all" || assetFilter === "futures")) {
      if (status === "open" || status === "all") {
        for (const o of futuresData.orders) {
          const isOpen = ["Working", "Accepted", "new"].some((s) => (o.status || "").includes(s));
          if (status === "open" && !isOpen) continue;
          items.push({
            id: `fut-ord-${o.id}`,
            symbol: "Futures",
            displaySymbol: `Order #${o.id}`,
            side: o.action?.toLowerCase() || "buy",
            action: o.action || "order",
            type: o.type || "stop",
            qty: String(o.qty),
            filledQty: "0",
            price: "—",
            pnl: null,
            aiScore: null,
            reason: null,
            status: o.status || "open",
            time: new Date().toISOString(),
            assetType: "futures",
            source: "tradovate",
            cancelable: false,
          });
        }
      }
    }

    // Tradovate: enriched trade activity (P&L, action types, reasoning, AI score)
    if (futuresData?.activity && (assetFilter === "all" || assetFilter === "futures")) {
      if (status === "closed" || status === "all") {
        for (const a of futuresData.activity) {
          const rawAction = a.action || "";
          const actionLabel = rawAction.replace("futures_", "").replace(/_/g, " ");
          const isBuy = rawAction.includes("long") || rawAction.includes("buy");
          items.push({
            id: `fut-${a.id}`,
            symbol: a.symbol,
            displaySymbol: a.symbol,
            side: isBuy ? "buy" : "sell",
            action: actionLabel,
            type: actionLabel,
            qty: String(a.qty),
            filledQty: String(a.qty),
            price: a.price ? `$${a.price.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}` : "—",
            pnl: a.pnl,
            aiScore: a.aiScore,
            reason: a.reason,
            status: "filled",
            time: a.time,
            assetType: "futures",
            source: "tradovate",
            cancelable: false,
          });
        }
      }
    }

    return items;
  }, [alpacaOrders, futuresData, assetFilter, status]);

  // Filter by asset type
  const filtered = useMemo(() => {
    const items = assetFilter === "all" ? unified : unified.filter((o) => o.assetType === assetFilter);
    items.sort((a, b) => new Date(b.time).getTime() - new Date(a.time).getTime());
    return items;
  }, [unified, assetFilter]);

  // Compute summary for parent
  useMemo(() => {
    if (!onSummary) return;
    const today = new Date().toISOString().slice(0, 10);
    const todayItems = filtered.filter((o) => o.time.slice(0, 10) === today);
    onSummary({
      totalShown: filtered.length,
      openCount: filtered.filter((o) => !["filled", "canceled", "cancelled", "expired", "rejected"].includes(o.status.toLowerCase())).length,
      filledCount: filtered.filter((o) => o.status.toLowerCase() === "filled").length,
      todayPnl: todayItems.reduce((s, o) => s + (o.pnl || 0), 0),
      todayFills: todayItems.filter((o) => o.status.toLowerCase() === "filled").length,
    });
  }, [filtered, onSummary]);

  if (isLoading) {
    return (
      <div className="space-y-2 py-4">
        {Array.from({ length: 5 }).map((_, i) => (
          <div key={i} className="flex items-center gap-4 px-2">
            <div className="skeleton h-4 w-16 rounded" />
            <div className="skeleton h-3 w-8 rounded" />
            <div className="skeleton h-3 w-10 rounded" />
            <div className="skeleton h-3 w-16 rounded" />
            <div className="skeleton h-3 w-12 rounded" />
            <div className="ml-auto skeleton h-3 w-20 rounded" />
          </div>
        ))}
      </div>
    );
  }

  if (filtered.length === 0) {
    return (
      <div className="text-sm text-muted-foreground py-10 text-center">
        <p>No orders found.</p>
        <p className="text-[11px] text-muted-foreground/30 mt-1">
          {assetFilter !== "all" ? `Try the "All" filter to see orders from other asset classes.` : "Orders from Alpaca and Tradovate will appear here."}
        </p>
      </div>
    );
  }

  return (
    <div className="overflow-x-auto">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead className="w-[120px]">Symbol</TableHead>
            <TableHead>Asset</TableHead>
            <TableHead>Action</TableHead>
            <TableHead className="text-right">Qty</TableHead>
            <TableHead className="text-right">Price</TableHead>
            <TableHead className="text-right">P&L</TableHead>
            <TableHead>Status</TableHead>
            <TableHead>Time</TableHead>
            <TableHead className="hidden lg:table-cell">Details</TableHead>
            {status === "open" && <TableHead></TableHead>}
          </TableRow>
        </TableHeader>
        <TableBody>
          {filtered.map((order) => (
            <TableRow
              key={order.id}
              className="group cursor-pointer"
              onClick={() => setExpandedRow(expandedRow === order.id ? null : order.id)}
            >
              <TableCell>
                <div className="flex items-center gap-1.5">
                  <span className="font-bold text-sm">{order.displaySymbol}</span>
                </div>
              </TableCell>
              <TableCell>{assetBadge(order.assetType)}</TableCell>
              <TableCell>
                {order.source === "tradovate" && order.status === "filled" ? (
                  actionBadge(order.action)
                ) : (
                  <span className={order.side === "buy" ? "text-emerald-500 font-medium" : "text-red-500 font-medium"}>
                    {order.side.toUpperCase()}
                  </span>
                )}
              </TableCell>
              <TableCell className="text-right tabular-nums">{order.qty}</TableCell>
              <TableCell className="text-right tabular-nums">{order.price}</TableCell>
              <TableCell className="text-right tabular-nums">
                {order.pnl != null ? (
                  <span className={`font-bold ${pnlColor(order.pnl)}`}>
                    {order.pnl >= 0 ? "+" : ""}${order.pnl.toFixed(0)}
                  </span>
                ) : (
                  <span className="text-muted-foreground/30">—</span>
                )}
              </TableCell>
              <TableCell>{statusBadge(order.status)}</TableCell>
              <TableCell className="text-[11px] text-muted-foreground tabular-nums whitespace-nowrap">
                {formatDate(order.time)}
              </TableCell>
              <TableCell className="hidden lg:table-cell">
                <div className="flex items-center gap-2">
                  {order.aiScore != null && (
                    <span className="text-[9px] px-1.5 py-0.5 rounded bg-blue-500/10 text-blue-400 font-bold tabular-nums">
                      AI {order.aiScore}%
                    </span>
                  )}
                  {order.source === "tradovate" && (
                    <span className="text-[9px] text-amber-400/50">TDV</span>
                  )}
                  {order.source === "alpaca" && (
                    <span className="text-[9px] text-blue-400/50">ALP</span>
                  )}
                </div>
              </TableCell>
              {status === "open" && (
                <TableCell>
                  {order.cancelable && (
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={(e) => { e.stopPropagation(); handleCancel(order.id); }}
                      disabled={canceling === order.id}
                    >
                      {canceling === order.id ? "..." : "Cancel"}
                    </Button>
                  )}
                </TableCell>
              )}
            </TableRow>
          ))}
        </TableBody>
      </Table>

      {/* Expanded reason row — shown below the table for the selected order */}
      {expandedRow && (() => {
        const order = filtered.find((o) => o.id === expandedRow);
        if (!order?.reason) return null;
        return (
          <div className="px-4 py-3 border-t border-white/[0.06] bg-white/[0.02]">
            <div className="flex items-center gap-2 mb-1">
              <span className="text-[10px] text-muted-foreground/50 uppercase tracking-wider font-medium">Trade Reasoning</span>
              <span className="font-bold text-xs">{order.displaySymbol}</span>
              {order.aiScore != null && (
                <span className="text-[10px] px-1.5 py-0.5 rounded bg-blue-500/10 text-blue-400 font-bold">AI {order.aiScore}%</span>
              )}
            </div>
            <p className="text-xs text-muted-foreground/70 leading-relaxed">{order.reason}</p>
          </div>
        );
      })()}
    </div>
  );
}

export function OrdersTable() {
  const [assetFilter, setAssetFilter] = useState<AssetFilter>("all");
  const [summary, setSummary] = useState<OrdersSummary | null>(null);

  return (
    <div className="space-y-4">
      {/* Summary stats */}
      {summary && (
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          <div className="rounded-lg border border-white/[0.06] bg-white/[0.02] px-3 py-2">
            <p className="text-[9px] text-muted-foreground/40 uppercase">Showing</p>
            <p className="text-lg font-black tabular-nums">{summary.totalShown}</p>
          </div>
          <div className="rounded-lg border border-white/[0.06] bg-white/[0.02] px-3 py-2">
            <p className="text-[9px] text-muted-foreground/40 uppercase">Open</p>
            <p className="text-lg font-black tabular-nums">{summary.openCount}</p>
          </div>
          <div className="rounded-lg border border-white/[0.06] bg-white/[0.02] px-3 py-2">
            <p className="text-[9px] text-muted-foreground/40 uppercase">Today&apos;s Fills</p>
            <p className="text-lg font-black tabular-nums">{summary.todayFills}</p>
          </div>
          <div className="rounded-lg border border-white/[0.06] bg-white/[0.02] px-3 py-2">
            <p className="text-[9px] text-muted-foreground/40 uppercase">Today&apos;s P&L</p>
            <p className={`text-lg font-black tabular-nums ${pnlColor(summary.todayPnl)}`}>
              {summary.todayPnl !== 0 ? `${summary.todayPnl >= 0 ? "+" : ""}$${summary.todayPnl.toFixed(0)}` : "—"}
            </p>
          </div>
        </div>
      )}

      {/* Asset type filter */}
      <div className="flex gap-1.5">
        {(["all", "options", "stocks", "futures"] as const).map((f) => (
          <button
            key={f}
            onClick={() => setAssetFilter(f)}
            className={`px-3 py-1.5 rounded-full text-xs font-medium transition-all ${
              assetFilter === f
                ? "bg-primary/20 text-primary ring-1 ring-primary/40"
                : "bg-white/[0.04] text-muted-foreground hover:bg-white/[0.08]"
            }`}
          >
            {f === "all" ? "All" : f === "options" ? "Options" : f === "stocks" ? "Stocks" : "Futures"}
          </button>
        ))}
      </div>

      <Tabs defaultValue="all">
        <TabsList>
          <TabsTrigger value="open">Open</TabsTrigger>
          <TabsTrigger value="closed">Filled</TabsTrigger>
          <TabsTrigger value="all">All</TabsTrigger>
        </TabsList>
        <TabsContent value="open">
          <OrdersTableInner status="open" assetFilter={assetFilter} onSummary={setSummary} />
        </TabsContent>
        <TabsContent value="closed">
          <OrdersTableInner status="closed" assetFilter={assetFilter} onSummary={setSummary} />
        </TabsContent>
        <TabsContent value="all">
          <OrdersTableInner status="all" assetFilter={assetFilter} onSummary={setSummary} />
        </TabsContent>
      </Tabs>
    </div>
  );
}
