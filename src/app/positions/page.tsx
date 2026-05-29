"use client";

import { PositionsTable } from "@/components/positions/positions-table";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

export default function PositionsPage() {
  return (
    <div className="space-y-6">
      <div><h1 className="text-xl font-bold tracking-tight">Positions</h1><p className="text-[11px] text-muted-foreground/50">Open positions across all brokers</p></div>
      <Card>
        <CardHeader>
          <CardTitle>Open Positions</CardTitle>
        </CardHeader>
        <CardContent>
          <PositionsTable />
        </CardContent>
      </Card>
    </div>
  );
}
