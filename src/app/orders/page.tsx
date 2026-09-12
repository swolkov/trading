"use client";

import { UnifiedOrdersTable } from "@/components/orders/unified-orders-table";
import { PageHeader } from "@/components/ui/panel";

export default function OrdersPage() {
  return (
    <div className="space-y-5">
      <PageHeader title="Orders" sub="Kraken live fills, round trips and paper experiments. Real Robinhood positions and orders are on its Live Account page." />
      <UnifiedOrdersTable />
    </div>
  );
}
