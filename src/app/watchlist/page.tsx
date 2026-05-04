"use client";

import { useState, useCallback } from "react";
import { AddSymbol } from "@/components/watchlist/add-symbol";
import { WatchlistTable } from "@/components/watchlist/watchlist-table";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

export default function WatchlistPage() {
  const [refreshKey, setRefreshKey] = useState(0);

  const handleAdded = useCallback(() => {
    setRefreshKey((k) => k + 1);
  }, []);

  return (
    <div className="space-y-6">
      <h2 className="text-2xl font-bold tracking-tight">Watchlist</h2>
      <Card>
        <CardHeader>
          <CardTitle>Track Symbols</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <AddSymbol onAdded={handleAdded} />
          <WatchlistTable key={refreshKey} />
        </CardContent>
      </Card>
    </div>
  );
}
