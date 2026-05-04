"use client";

import Link from "next/link";
import { usePositions } from "@/hooks/use-positions";
import { formatCurrency, pnlColor } from "@/lib/utils";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";

export function PositionsMini() {
  const { data: positions, isLoading } = usePositions();

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between pb-2">
        <CardTitle className="text-sm font-medium">Top Positions</CardTitle>
        <Link
          href="/positions"
          className="text-xs text-muted-foreground hover:underline"
        >
          View all
        </Link>
      </CardHeader>
      <CardContent>
        {isLoading ? (
          <div className="h-32 flex items-center justify-center text-sm text-muted-foreground">
            Loading positions...
          </div>
        ) : !positions || positions.length === 0 ? (
          <div className="h-32 flex items-center justify-center text-sm text-muted-foreground">
            No open positions.{" "}
            <Link href="/trade" className="underline ml-1">
              Place a trade
            </Link>
          </div>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Symbol</TableHead>
                <TableHead className="text-right">Qty</TableHead>
                <TableHead className="text-right">Market Value</TableHead>
                <TableHead className="text-right">P&L</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {positions.slice(0, 5).map((pos) => (
                <TableRow key={pos.symbol}>
                  <TableCell className="font-medium">{pos.symbol}</TableCell>
                  <TableCell className="text-right">{pos.qty}</TableCell>
                  <TableCell className="text-right">
                    {formatCurrency(pos.market_value)}
                  </TableCell>
                  <TableCell
                    className={`text-right ${pnlColor(pos.unrealized_pl)}`}
                  >
                    {formatCurrency(pos.unrealized_pl)}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </CardContent>
    </Card>
  );
}
