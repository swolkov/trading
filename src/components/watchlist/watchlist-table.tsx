"use client";

import { useEffect, useState, useCallback } from "react";
import { useQuote } from "@/hooks/use-quote";
import { formatCurrency } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";

interface WatchlistItem {
  id: number;
  symbol: string;
  addedAt: string;
}

function WatchlistRow({
  item,
  onRemove,
}: {
  item: WatchlistItem;
  onRemove: (symbol: string) => void;
}) {
  const { data: quote } = useQuote(item.symbol);
  const midPrice = quote ? (quote.bp + quote.ap) / 2 : null;

  return (
    <TableRow>
      <TableCell className="font-medium">{item.symbol}</TableCell>
      <TableCell className="text-right">
        {midPrice ? formatCurrency(midPrice) : "..."}
      </TableCell>
      <TableCell className="text-right">
        {quote ? formatCurrency(quote.bp) : "..."}
      </TableCell>
      <TableCell className="text-right">
        {quote ? formatCurrency(quote.ap) : "..."}
      </TableCell>
      <TableCell className="text-right">
        {quote ? (quote.ap - quote.bp).toFixed(2) : "..."}
      </TableCell>
      <TableCell>
        <Button
          variant="outline"
          size="sm"
          onClick={() => onRemove(item.symbol)}
        >
          Remove
        </Button>
      </TableCell>
    </TableRow>
  );
}

export function WatchlistTable() {
  const [items, setItems] = useState<WatchlistItem[]>([]);
  const [loading, setLoading] = useState(true);

  const fetchItems = useCallback(async () => {
    const res = await fetch("/api/watchlist");
    const data = await res.json();
    if (Array.isArray(data)) setItems(data);
    setLoading(false);
  }, []);

  useEffect(() => {
    fetchItems();
  }, [fetchItems]);

  async function handleRemove(symbol: string) {
    await fetch(`/api/watchlist?symbol=${symbol}`, { method: "DELETE" });
    fetchItems();
  }

  if (loading) {
    return <div className="text-sm text-muted-foreground py-4">Loading watchlist...</div>;
  }

  if (items.length === 0) {
    return (
      <div className="text-sm text-muted-foreground py-8 text-center">
        Your watchlist is empty. Add symbols above to start tracking.
      </div>
    );
  }

  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>Symbol</TableHead>
          <TableHead className="text-right">Price</TableHead>
          <TableHead className="text-right">Bid</TableHead>
          <TableHead className="text-right">Ask</TableHead>
          <TableHead className="text-right">Spread</TableHead>
          <TableHead></TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {items.map((item) => (
          <WatchlistRow key={item.symbol} item={item} onRemove={handleRemove} />
        ))}
      </TableBody>
    </Table>
  );
}
