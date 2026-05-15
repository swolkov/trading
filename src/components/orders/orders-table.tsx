"use client";

import { useState } from "react";
import useSWR from "swr";
import { useOrders } from "@/hooks/use-orders";
import { formatCurrency, formatDate } from "@/lib/utils";
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
  switch (status) {
    case "filled":
      return <Badge className="bg-emerald-600">Filled</Badge>;
    case "partially_filled":
      return <Badge className="bg-amber-600">Partial</Badge>;
    case "new":
    case "accepted":
      return <Badge variant="secondary">Open</Badge>;
    case "canceled":
    case "expired":
      return <Badge variant="outline">{status}</Badge>;
    case "rejected":
      return <Badge className="bg-red-600">Rejected</Badge>;
    default:
      return <Badge variant="outline">{status}</Badge>;
  }
}

function assetBadge(type: "options" | "stocks" | "futures") {
  switch (type) {
    case "options":
      return <span className="px-1.5 py-0.5 rounded text-[10px] bg-purple-500/15 text-purple-400">OPT</span>;
    case "futures":
      return <span className="px-1.5 py-0.5 rounded text-[10px] bg-amber-500/15 text-amber-400">FUT</span>;
    case "stocks":
      return <span className="px-1.5 py-0.5 rounded text-[10px] bg-blue-500/15 text-blue-400">STK</span>;
  }
}

interface UnifiedOrder {
  id: string;
  symbol: string;
  displaySymbol: string;
  side: string;
  type: string;
  qty: string;
  filledQty: string;
  price: string;
  status: string;
  time: string;
  assetType: "options" | "stocks" | "futures";
  source: "alpaca" | "tradovate";
  cancelable: boolean;
}

function OrdersTableInner({
  status,
  assetFilter,
}: {
  status: "open" | "closed" | "all";
  assetFilter: AssetFilter;
}) {
  const { data: alpacaOrders, isLoading: alpacaLoading, mutate } = useOrders(status);
  const { data: futuresData, isLoading: futuresLoading } = useSWR(
    "/api/futures/positions",
    fetcher,
    { refreshInterval: 15000 }
  );
  const [canceling, setCanceling] = useState<string | null>(null);

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
  const unified: UnifiedOrder[] = [];

  // Alpaca orders
  if (alpacaOrders) {
    for (const o of alpacaOrders) {
      const isOpt = isOptionSymbol(o.symbol);
      unified.push({
        id: o.id,
        symbol: o.symbol,
        displaySymbol: isOpt ? parseOptionDisplay(o.symbol) : o.symbol,
        side: o.side,
        type: o.type,
        qty: o.qty,
        filledQty: o.filled_qty,
        price: o.filled_avg_price
          ? formatCurrency(o.filled_avg_price)
          : o.limit_price
          ? formatCurrency(o.limit_price)
          : "Market",
        status: o.status,
        time: o.filled_at || o.submitted_at,
        assetType: isOpt ? "options" : "stocks",
        source: "alpaca",
        cancelable: ["new", "accepted", "partially_filled"].includes(o.status),
      });
    }
  }

  // Tradovate fills
  if (futuresData?.fills && assetFilter !== "options" && assetFilter !== "stocks") {
    const futuresFills = futuresData.fills || [];
    // Only include if status filter matches (fills are always "filled")
    if (status === "closed" || status === "all") {
      for (const f of futuresFills) {
        unified.push({
          id: `fut-${f.id}`,
          symbol: f.symbol,
          displaySymbol: f.symbol,
          side: f.action?.toLowerCase() || "buy",
          type: "market",
          qty: String(f.qty),
          filledQty: String(f.qty),
          price: f.price ? `$${f.price.toFixed(2)}` : "—",
          status: "filled",
          time: f.time,
          assetType: "futures",
          source: "tradovate",
          cancelable: false,
        });
      }
    }
  }

  // Filter by asset type
  const filtered = assetFilter === "all"
    ? unified
    : unified.filter((o) => o.assetType === assetFilter);

  // Sort by time descending
  filtered.sort((a, b) => new Date(b.time).getTime() - new Date(a.time).getTime());

  if (isLoading) {
    return <div className="text-sm text-muted-foreground py-4">Loading orders...</div>;
  }

  if (filtered.length === 0) {
    return (
      <div className="text-sm text-muted-foreground py-8 text-center">
        No orders found.
      </div>
    );
  }

  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>Symbol</TableHead>
          <TableHead>Asset</TableHead>
          <TableHead>Side</TableHead>
          <TableHead>Type</TableHead>
          <TableHead className="text-right">Qty</TableHead>
          <TableHead className="text-right">Filled</TableHead>
          <TableHead className="text-right">Price</TableHead>
          <TableHead>Status</TableHead>
          <TableHead>Time</TableHead>
          {status === "open" && <TableHead></TableHead>}
        </TableRow>
      </TableHeader>
      <TableBody>
        {filtered.map((order) => (
          <TableRow key={order.id}>
            <TableCell className="font-medium">{order.displaySymbol}</TableCell>
            <TableCell>{assetBadge(order.assetType)}</TableCell>
            <TableCell>
              <span
                className={
                  order.side === "buy" ? "text-emerald-500" : "text-red-500"
                }
              >
                {order.side.toUpperCase()}
              </span>
            </TableCell>
            <TableCell>{order.type}</TableCell>
            <TableCell className="text-right">{order.qty}</TableCell>
            <TableCell className="text-right">{order.filledQty}</TableCell>
            <TableCell className="text-right">{order.price}</TableCell>
            <TableCell>{statusBadge(order.status)}</TableCell>
            <TableCell className="text-xs text-muted-foreground">
              {formatDate(order.time)}
            </TableCell>
            {status === "open" && (
              <TableCell>
                {order.cancelable && (
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => handleCancel(order.id)}
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
  );
}

export function OrdersTable() {
  const [assetFilter, setAssetFilter] = useState<AssetFilter>("all");

  return (
    <div className="space-y-3">
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
          <OrdersTableInner status="open" assetFilter={assetFilter} />
        </TabsContent>
        <TabsContent value="closed">
          <OrdersTableInner status="closed" assetFilter={assetFilter} />
        </TabsContent>
        <TabsContent value="all">
          <OrdersTableInner status="all" assetFilter={assetFilter} />
        </TabsContent>
      </Tabs>
    </div>
  );
}
