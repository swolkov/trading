"use client";

import { UnifiedOrdersTable } from "@/components/orders/unified-orders-table";

export default function OrdersPage() {
  return (
    <div className="space-y-5 animate-fade-up">
      <div>
        <h1 className="text-xl font-bold tracking-tight">Orders</h1>
        <p className="text-[11px] text-muted-foreground/50">Lifetime trade log — Futures (demo + live), Kraken, Meme Lab</p>
      </div>
      <UnifiedOrdersTable />
    </div>
  );
}
