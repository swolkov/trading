"use client";

import { useState } from "react";
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

function OrdersTableInner({
  status,
}: {
  status: "open" | "closed" | "all";
}) {
  const { data: orders, isLoading, mutate } = useOrders(status);
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

  if (isLoading) {
    return <div className="text-sm text-muted-foreground py-4">Loading orders...</div>;
  }

  if (!orders || orders.length === 0) {
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
          <TableHead>Side</TableHead>
          <TableHead>Type</TableHead>
          <TableHead className="text-right">Qty</TableHead>
          <TableHead className="text-right">Filled</TableHead>
          <TableHead className="text-right">Price</TableHead>
          <TableHead>Status</TableHead>
          <TableHead>Submitted</TableHead>
          {status === "open" && <TableHead></TableHead>}
        </TableRow>
      </TableHeader>
      <TableBody>
        {orders.map((order) => (
          <TableRow key={order.id}>
            <TableCell className="font-medium">{order.symbol}</TableCell>
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
            <TableCell className="text-right">{order.filled_qty}</TableCell>
            <TableCell className="text-right">
              {order.filled_avg_price
                ? formatCurrency(order.filled_avg_price)
                : order.limit_price
                ? formatCurrency(order.limit_price)
                : "Market"}
            </TableCell>
            <TableCell>{statusBadge(order.status)}</TableCell>
            <TableCell className="text-xs text-muted-foreground">
              {formatDate(order.submitted_at)}
            </TableCell>
            {status === "open" && (
              <TableCell>
                {["new", "accepted", "partially_filled"].includes(
                  order.status
                ) && (
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
  return (
    <Tabs defaultValue="all">
      <TabsList>
        <TabsTrigger value="open">Open</TabsTrigger>
        <TabsTrigger value="closed">Filled</TabsTrigger>
        <TabsTrigger value="all">All</TabsTrigger>
      </TabsList>
      <TabsContent value="open">
        <OrdersTableInner status="open" />
      </TabsContent>
      <TabsContent value="closed">
        <OrdersTableInner status="closed" />
      </TabsContent>
      <TabsContent value="all">
        <OrdersTableInner status="all" />
      </TabsContent>
    </Tabs>
  );
}
