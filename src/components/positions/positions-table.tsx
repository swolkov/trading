"use client";

import { usePositions } from "@/hooks/use-positions";
import { formatCurrency, formatPercent, pnlColor } from "@/lib/utils";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";

export function PositionsTable() {
  const { data: positions, isLoading } = usePositions();

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
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>Symbol</TableHead>
          <TableHead className="text-right">Qty</TableHead>
          <TableHead className="text-right">Avg Entry</TableHead>
          <TableHead className="text-right">Current Price</TableHead>
          <TableHead className="text-right">Market Value</TableHead>
          <TableHead className="text-right">Cost Basis</TableHead>
          <TableHead className="text-right">Unrealized P&L</TableHead>
          <TableHead className="text-right">P&L %</TableHead>
          <TableHead className="text-right">Today</TableHead>
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
            <TableCell className="text-right">
              {formatCurrency(pos.cost_basis)}
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
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}
