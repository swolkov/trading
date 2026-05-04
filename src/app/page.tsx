"use client";

import { PortfolioSummary } from "@/components/dashboard/portfolio-summary";
import { PositionsMini } from "@/components/dashboard/positions-mini";

export default function DashboardPage() {
  return (
    <div className="space-y-6">
      <h2 className="text-2xl font-bold tracking-tight">Dashboard</h2>
      <PortfolioSummary />
      <PositionsMini />
    </div>
  );
}
