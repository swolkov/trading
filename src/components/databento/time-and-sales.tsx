"use client";

interface Trade { ts: number; price: number; size: number; side: "B" | "S" | "?"; }

function formatTime(ts: number) {
  const d = new Date(ts);
  return d.toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false, timeZone: "America/New_York" });
}

export function TimeAndSales({ trades, height = 280 }: { trades: Trade[]; height?: number }) {
  if (!trades || trades.length === 0) {
    return <div className="text-[10px] text-muted-foreground/40 py-4 text-center">No trade data</div>;
  }

  // Compute size buckets for emphasis: top 10% large, 10-50% medium, rest small
  const sizes = [...trades].map((t) => t.size).sort((a, b) => a - b);
  const p90 = sizes[Math.floor(sizes.length * 0.9)] || 1;
  const p50 = sizes[Math.floor(sizes.length * 0.5)] || 1;

  return (
    <div className="text-[10px] tabular-nums" style={{ height, overflow: "hidden" }}>
      <div className="flex justify-between text-muted-foreground/60 px-1 pb-1 border-b border-border/40">
        <span>Time &amp; Sales · last 100 trades</span>
        <span>Time (ET) · Price · Size</span>
      </div>
      <div className="overflow-y-auto font-mono" style={{ maxHeight: height - 24 }}>
        {trades.map((t, i) => {
          const isLarge = t.size >= p90;
          const isMed = t.size >= p50;
          const isBuy = t.side === "B";
          const isSell = t.side === "S";
          const sideColor = isBuy ? "text-emerald-400" : isSell ? "text-red-400" : "text-muted-foreground";
          const bgIntensity = isLarge ? (isBuy ? "bg-emerald-500/[0.10]" : isSell ? "bg-red-500/[0.10]" : "") : isMed ? (isBuy ? "bg-emerald-500/[0.04]" : isSell ? "bg-red-500/[0.04]" : "") : "";
          return (
            <div key={`${t.ts}-${i}`} className={`flex justify-between px-1 py-[1px] ${bgIntensity}`}>
              <span className="text-muted-foreground/60" style={{ fontSize: 9 }}>{formatTime(t.ts)}</span>
              <span className={`${sideColor} font-semibold`}>{t.price.toFixed(2)}</span>
              <span className={`${sideColor} ${isLarge ? "font-bold" : ""}`} style={{ width: 36, textAlign: "right" }}>{t.size}</span>
            </div>
          );
        })}
      </div>
    </div>
  );
}
