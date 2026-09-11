"use client";

import { UnifiedOrdersTable } from "@/components/orders/unified-orders-table";
import { PageHeader } from "@/components/ui/panel";

export default function OrdersPage() {
  return (
    <div className="space-y-5">
      <PageHeader title="Orders" sub="Every trade on both platforms. Live is real Kraken fills; Paper is the Kraken shadow experiment; Options is the Robinhood paper book." />
      <UnifiedOrdersTable />
    </div>
  );
}
