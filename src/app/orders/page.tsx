"use client";

import { UnifiedOrdersTable } from "@/components/orders/unified-orders-table";
import { PageHeader } from "@/components/ui/panel";

export default function OrdersPage() {
  return (
    <div className="space-y-5">
      <PageHeader title="Orders" sub="Every trade in one place. Live is real Kraken fills; Paper is the shadow experiment." />
      <UnifiedOrdersTable />
    </div>
  );
}
