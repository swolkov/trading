"use client";

interface Bucket { price: number; buyVol: number; sellVol: number; total: number; }

export function VolumeProfile({ data, currentPrice, height = 280 }: { data: Bucket[]; currentPrice?: number | null; height?: number }) {
  if (!data || data.length === 0) {
    return <div className="text-[10px] text-muted-foreground/40 py-4 text-center">No volume data</div>;
  }
  const maxTotal = Math.max(...data.map((b) => b.total)) || 1;
  // Find Point of Control (highest-volume price)
  const pocBucket = data.reduce((best, b) => (b.total > best.total ? b : best), data[0]);

  const sorted = [...data].sort((a, b) => b.price - a.price); // descending price for visual top→bottom

  return (
    <div className="text-[10px] tabular-nums" style={{ height, overflow: "hidden" }}>
      <div className="flex justify-between text-muted-foreground/60 px-1 pb-1 border-b border-border/40">
        <span>Volume Profile · last 24h</span>
        <span>POC: ${pocBucket.price.toFixed(2)}</span>
      </div>
      <div className="space-y-[1px] mt-1 overflow-y-auto" style={{ maxHeight: height - 24 }}>
        {sorted.map((b, i) => {
          const widthBuy = (b.buyVol / maxTotal) * 100;
          const widthSell = (b.sellVol / maxTotal) * 100;
          const isPOC = b === pocBucket;
          const isCurrent = currentPrice && Math.abs(b.price - currentPrice) < (sorted[0].price - sorted[sorted.length - 1].price) / sorted.length;
          return (
            <div key={i} className={`flex items-center gap-1 px-1 ${isCurrent ? "bg-emerald-500/[0.06]" : ""}`} style={{ height: 8 }}>
              <span className={`shrink-0 text-right font-mono ${isPOC ? "text-emerald-400 font-bold" : "text-muted-foreground/60"}`} style={{ width: 48, fontSize: 9 }}>
                {b.price.toFixed(2)}
              </span>
              <div className="flex-1 flex items-center" style={{ height: 6 }}>
                {/* Buy volume bar (right of center) */}
                <div className="flex-1 flex justify-end overflow-hidden">
                  <div className="h-full bg-red-500/40" style={{ width: `${widthSell}%` }} />
                </div>
                <div className="w-px h-full bg-muted-foreground/30" />
                <div className="flex-1 overflow-hidden">
                  <div className="h-full bg-emerald-500/40" style={{ width: `${widthBuy}%` }} />
                </div>
              </div>
              <span className="shrink-0 text-right font-mono text-muted-foreground/50" style={{ width: 32, fontSize: 9 }}>
                {b.total >= 1000 ? `${(b.total / 1000).toFixed(1)}k` : b.total}
              </span>
            </div>
          );
        })}
      </div>
      <div className="flex justify-between text-[9px] text-muted-foreground/40 px-1 pt-1 border-t border-border/40">
        <span>← Sell</span>
        <span>Buy →</span>
      </div>
    </div>
  );
}
