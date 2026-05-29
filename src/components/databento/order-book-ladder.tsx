"use client";

import useSWR from "swr";
import { Wifi, WifiOff } from "lucide-react";

interface Level { price: number; size: number; }
interface BookResponse {
  symbol: string;
  available: boolean;
  bids?: Level[];
  asks?: Level[];
  levels?: number;
  ts?: number | null;
  ageSeconds?: number;
  stale?: boolean;
  message?: string;
  error?: string;
}

const fetcher = (u: string) => fetch(u).then((r) => r.json());

export function OrderBookLadder({ symbol, height = 420 }: { symbol: string; height?: number }) {
  const { data, isLoading } = useSWR<BookResponse>(
    `/api/databento/book?symbol=${symbol}`,
    fetcher,
    { refreshInterval: 1_500 }, // poll every 1.5s — sidecar writes every 2s
  );

  if (isLoading) {
    return <div className="text-[10px] text-muted-foreground/40 py-4 text-center" style={{ height }}>Loading order book…</div>;
  }

  if (!data || !data.available) {
    return (
      <div className="text-[10px] text-muted-foreground/40 py-4 px-2" style={{ height }}>
        <div className="flex items-center gap-1.5 mb-2 text-amber-400">
          <WifiOff className="w-3 h-3" />
          <span className="font-semibold">Depth ladder unavailable</span>
        </div>
        <div className="text-muted-foreground/60">{data?.message ?? "No data yet."}</div>
      </div>
    );
  }

  const bids = (data.bids ?? []).slice(0, 10).sort((a, b) => b.price - a.price);
  const asks = (data.asks ?? []).slice(0, 10).sort((a, b) => a.price - b.price);
  const maxSize = Math.max(...[...bids, ...asks].map((l) => l.size), 1);

  // Show asks DESCENDING (highest at top), then bids DESCENDING (highest at top, just below ask)
  const sortedAsks = [...asks].sort((a, b) => b.price - a.price);
  const sortedBids = [...bids].sort((a, b) => b.price - a.price);

  return (
    <div className="text-[10px] tabular-nums font-mono" style={{ height, overflow: "hidden" }}>
      <div className="flex justify-between text-muted-foreground/60 px-1 pb-1 border-b border-border/40">
        <span className="flex items-center gap-1">
          Order Book · 10 levels {data.stale ? <WifiOff className="w-3 h-3 text-amber-400" /> : <Wifi className="w-3 h-3 text-emerald-400" />}
        </span>
        <span className="text-muted-foreground/50">{data.ageSeconds}s ago</span>
      </div>
      <div className="grid grid-cols-2 text-[9px] uppercase tracking-wider text-muted-foreground/50 px-1 py-1 border-b border-border/40">
        <span>Bid</span>
        <span className="text-right">Ask</span>
      </div>

      {/* Asks (top half, descending so lowest ask is right above mid line) */}
      <div className="space-y-[1px]" style={{ maxHeight: (height - 60) / 2, overflow: "hidden" }}>
        {sortedAsks.map((l, i) => {
          const w = (l.size / maxSize) * 100;
          return (
            <div key={`ask-${i}`} className="flex items-center px-1 relative" style={{ height: 14 }}>
              <div className="absolute right-0 top-0 bottom-0 bg-red-500/10" style={{ width: `${w}%` }} />
              <span className="relative z-10 flex-1 text-left text-muted-foreground/40">{l.size.toLocaleString()}</span>
              <span className="relative z-10 flex-1 text-right text-red-400 font-semibold">{l.price.toFixed(2)}</span>
            </div>
          );
        })}
      </div>

      {/* Spread line */}
      {bids.length > 0 && asks.length > 0 && (
        <div className="flex items-center justify-center gap-2 text-[9px] text-muted-foreground/60 border-y border-border/40 my-1 py-0.5">
          <span>spread:</span>
          <span className="font-semibold text-foreground">{(asks[0].price - bids[0].price).toFixed(2)}</span>
        </div>
      )}

      {/* Bids (bottom half, descending so highest bid is right below mid line) */}
      <div className="space-y-[1px]" style={{ maxHeight: (height - 60) / 2, overflow: "hidden" }}>
        {sortedBids.map((l, i) => {
          const w = (l.size / maxSize) * 100;
          return (
            <div key={`bid-${i}`} className="flex items-center px-1 relative" style={{ height: 14 }}>
              <div className="absolute left-0 top-0 bottom-0 bg-emerald-500/10" style={{ width: `${w}%` }} />
              <span className="relative z-10 flex-1 text-left text-emerald-400 font-semibold">{l.price.toFixed(2)}</span>
              <span className="relative z-10 flex-1 text-right text-muted-foreground/40">{l.size.toLocaleString()}</span>
            </div>
          );
        })}
      </div>
    </div>
  );
}
