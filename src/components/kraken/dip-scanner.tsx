"use client";

import useSWR from "swr";

interface DipRow {
  symbol: string;
  price: number;
  rsi: number | null;
  pctOff7dHigh: number;
  pctOff30dHigh: number;
  chg24h: number;
  signal: "DEEP DIP" | "DIP" | "neutral" | "extended";
  note: string;
}

const fetcher = (u: string) => fetch(u).then((r) => r.json());

const SIGNAL_STYLE: Record<DipRow["signal"], string> = {
  "DEEP DIP": "bg-red-500/15 text-red-300 border border-red-500/30",
  DIP: "bg-amber-500/15 text-amber-300 border border-amber-500/30",
  neutral: "bg-white/[0.04] text-muted-foreground/60",
  extended: "bg-emerald-500/10 text-emerald-300/70 border border-emerald-500/20",
};

function fmtPrice(p: number) {
  return p >= 100 ? `$${p.toFixed(0)}` : p >= 1 ? `$${p.toFixed(2)}` : `$${p.toFixed(4)}`;
}

export function DipScanner() {
  const { data } = useSWR<{ rows: DipRow[]; ts: string | null }>("/api/crypto-dip", fetcher, { refreshInterval: 60000 });
  const rows = data?.rows || [];

  return (
    <div className="rounded-lg border border-border bg-card p-5 space-y-3">
      <div className="flex items-center justify-between">
        <h2 className="font-semibold text-sm">Dip Scanner</h2>
        <span className="text-[10px] text-muted-foreground/45">
          {data?.ts ? `updated ${new Date(data.ts).toLocaleTimeString()}` : "loading…"}
        </span>
      </div>
      <p className="text-[11px] text-muted-foreground/55 leading-relaxed">
        Flags oversold / pulled-back coins. This is <span className="text-foreground/70">information, not a buy signal</span> —
        a dip doesn&apos;t guarantee a bounce (rapid dip-buy/sell-bounce loses after fees). Prices are reference (Alpaca); trading would run on Kraken once funded + connected.
      </p>
      {!rows.length ? (
        <p className="text-[11px] text-muted-foreground/40 py-4 text-center">Loading scan…</p>
      ) : (
        <div className="overflow-hidden rounded-md border border-border/60">
          <table className="w-full text-[11px]">
            <thead>
              <tr className="text-muted-foreground/50 border-b border-border/60">
                <th className="text-left font-medium px-3 py-1.5">Coin</th>
                <th className="text-right font-medium px-2 py-1.5">Price</th>
                <th className="text-right font-medium px-2 py-1.5">24h</th>
                <th className="text-right font-medium px-2 py-1.5">RSI</th>
                <th className="text-right font-medium px-2 py-1.5">vs 7d high</th>
                <th className="text-center font-medium px-3 py-1.5">Signal</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.symbol} className="border-b border-border/30 last:border-0">
                  <td className="px-3 py-1.5 font-semibold">{r.symbol.replace("/USD", "")}</td>
                  <td className="px-2 py-1.5 text-right tabular-nums">{fmtPrice(r.price)}</td>
                  <td className={`px-2 py-1.5 text-right tabular-nums ${r.chg24h >= 0 ? "text-emerald-400" : "text-red-400"}`}>{(r.chg24h * 100).toFixed(1)}%</td>
                  <td className="px-2 py-1.5 text-right tabular-nums">{r.rsi != null ? r.rsi.toFixed(0) : "—"}</td>
                  <td className={`px-2 py-1.5 text-right tabular-nums ${r.pctOff7dHigh <= -0.08 ? "text-red-400" : "text-muted-foreground/70"}`}>{(r.pctOff7dHigh * 100).toFixed(1)}%</td>
                  <td className="px-3 py-1.5 text-center">
                    <span className={`text-[9px] font-bold uppercase tracking-wider px-1.5 py-0.5 rounded ${SIGNAL_STYLE[r.signal]}`}>{r.signal}</span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
