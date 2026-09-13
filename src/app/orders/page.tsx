"use client";

import { UnifiedOrdersTable } from "@/components/orders/unified-orders-table";
import { PageHeader } from "@/components/ui/panel";

export default function OrdersPage() {
  return (
    <div className="space-y-5">
      <PageHeader title="Orders" sub="Every platform, broken down: Kraken real fills, round trips and paper; the Tradovate futures demo ledger and alerts; the real Robinhood account\u2019s positions and orders." />
      <UnifiedOrdersTable />
    </div>
  );
}
