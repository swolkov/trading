"use client";

import { useState } from "react";
import { usePositions } from "@/hooks/use-positions";
import { formatCurrency, formatPercent, pnlColor } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";

export function PositionsTable() {
  const { data: positions, isLoading, mutate } = usePositions();
  const [closing, setClosing] = useState<string | null>(null);
  const [closingAll, setClosingAll] = useState(false);

  async function closePosition(symbol: string, qty: string) {
    setClosing(symbol);
    try {
      await fetch("/api/orders", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          symbol,
          qty,
          side: "sell",
          type: "market",
          time_in_force: "day",
        }),
      });
      // Wait a moment for the order to fill, then refresh
      setTimeout(() => mutate(), 2000);
    } catch {
      // ignore
    }
    setClosing(null);
  }

  async function closeAllPositions() {
    if (!positions || positions.length === 0) return;
    setClosingAll(true);
    for (const pos of positions) {
      try {
        await fetch("/api/orders", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            symbol: pos.symbol,
            qty: pos.qty,
            side: "sell",
            type: "market",
            time_in_force: "day",
          }),
        });
      } catch {
        // ignore
      }
    }
    setTimeout(() => {
      mutate();
      setClosingAll(false);
    }, 3000);
  }

  if (isLoading) {
    return <div className="text-sm text-muted-foreground">Loading positions...</div>;
  }

  if (!positions || positions.length === 0) {
    return (
      <div className="text-sm text-muted-foreground py-8 text-center">
        No open positions. Go to the Trade page to place your first order.
      </div>
    );
  }

  return (
    <div>
      <div className="flex justify-end mb-3">
        <Button
          variant="outline"
          size="sm"
          className="text-red-500 border-red-500/30 hover:bg-red-500/10"
          onClick={closeAllPositions}
          disabled={closingAll}
        >
          {closingAll ? "Closing all..." : `Close All ${positions.length} Positions`}
        </Button>
      </div>
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Symbol</TableHead>
            <TableHead className="text-right">Qty</TableHead>
            <TableHead className="text-right">Avg Entry</TableHead>
            <TableHead className="text-right">Current Price</TableHead>
            <TableHead className="text-right">Market Value</TableHead>
            <TableHead className="text-right">Unrealized P&L</TableHead>
            <TableHead className="text-right">P&L %</TableHead>
            <TableHead className="text-right">Today</TableHead>
            <TableHead></TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {positions.map((pos) => (
            <TableRow key={pos.symbol}>
              <TableCell className="font-medium">{pos.symbol}</TableCell>
              <TableCell className="text-right">{pos.qty}</TableCell>
              <TableCell className="text-right">
                {formatCurrency(pos.avg_entry_price)}
              </TableCell>
              <TableCell className="text-right">
                {formatCurrency(pos.current_price)}
              </TableCell>
              <TableCell className="text-right">
                {formatCurrency(pos.market_value)}
              </TableCell>
              <TableCell className={`text-right ${pnlColor(pos.unrealized_pl)}`}>
                {formatCurrency(pos.unrealized_pl)}
              </TableCell>
              <TableCell className={`text-right ${pnlColor(pos.unrealized_plpc)}`}>
                {formatPercent(pos.unrealized_plpc)}
              </TableCell>
              <TableCell className={`text-right ${pnlColor(pos.change_today)}`}>
                {formatPercent(pos.change_today)}
              </TableCell>
              <TableCell>
                <Button
                  variant="outline"
                  size="sm"
                  className="text-red-500 border-red-500/30 hover:bg-red-500/10"
                  onClick={() => closePosition(pos.symbol, pos.qty)}
                  disabled={closing === pos.symbol}
                >
                  {closing === pos.symbol ? "Closing..." : "Close"}
                </Button>
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}
