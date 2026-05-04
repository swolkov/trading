"use client";

import { PositionsTable } from "@/components/positions/positions-table";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

export default function PositionsPage() {
  return (
    <div className="space-y-6">
      <h2 className="text-2xl font-bold tracking-tight">Positions</h2>
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
