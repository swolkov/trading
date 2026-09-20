"use client";

import { UnifiedOrdersTable } from "@/components/orders/unified-orders-table";
import { PageHeader } from "@/components/ui/panel";

export default function OrdersPage() {
  return (
    <div className="space-y-5">
      <PageHeader title="Orders" sub="Every platform, broken down: your live Tradovate account (hand trades, read-only); the Tradovate futures demo ledger and alerts; the real Robinhood account's positions and orders." />
      <UnifiedOrdersTable />
    </div>
  );
}
