"use client";

import { UnifiedOrdersTable } from "@/components/orders/unified-orders-table";

export default function OrdersPage() {
  return (
    <div className="space-y-5 animate-fade-up">
      <div>
        <h1 className="text-xl font-bold tracking-tight">Order History</h1>
        <p className="text-[11px] text-muted-foreground/50">Every trade in one place — toggle Live (real Kraken fills) or Paper (the shadow experiment)</p>
      </div>
      <UnifiedOrdersTable />
    </div>
  );
}
