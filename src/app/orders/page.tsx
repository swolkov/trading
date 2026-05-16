"use client";

import { OrdersTable } from "@/components/orders/orders-table";

export default function OrdersPage() {
  return (
    <div className="space-y-5 animate-fade-up">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-bold tracking-tight">Orders</h1>
          <p className="text-[11px] text-muted-foreground/50">Futures order history — Tradovate</p>
        </div>
      </div>

      <OrdersTable />
    </div>
  );
}
