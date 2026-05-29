"use client";

import useSWR from "swr";
import { useState } from "react";
import { Card, CardContent } from "@/components/ui/card";
import { TrendingUp, TrendingDown, Pause } from "lucide-react";

interface PositioningRow {
  date: string;
  openInterest: number;
  oiChange: number;
  close: number | null;
  priceChange: number | null;
  regime: "longs_adding" | "shorts_adding" | "longs_unwinding" | "shorts_covering" | "unchanged" | "unknown";
}
interface Response {
  symbol: string;
  days: number;
  recordsTotal: number;
  series: PositioningRow[];
  error?: string;
}

const fetcher = (u: string) => fetch(u).then((r) => r.json());

const SYMBOLS = ["ES", "NQ", "GC", "MBT", "MET", "BFF", "MXR", "MSL"];

const REGIME_META: Record<string, { label: string; color: string; icon: typeof TrendingUp; tooltip: string }> = {
  longs_adding: { label: "Longs adding", color: "text-emerald-400 bg-emerald-500/[0.08]", icon: TrendingUp, tooltip: "OI rising + price rising — new longs entering" },
  shorts_adding: { label: "Shorts adding", color: "text-red-400 bg-red-500/[0.08]", icon: TrendingDown, tooltip: "OI rising + price falling — new shorts entering" },
  longs_unwinding: { label: "Longs unwinding", color: "text-amber-400 bg-amber-500/[0.08]", icon: TrendingDown, tooltip: "OI falling + price falling — longs exiting" },
  shorts_covering: { label: "Shorts covering", color: "text-blue-400 bg-blue-500/[0.08]", icon: TrendingUp, tooltip: "OI falling + price rising — shorts covering" },
  unchanged: { label: "Flat", color: "text-muted-foreground bg-muted/40", icon: Pause, tooltip: "Minimal change" },
  unknown: { label: "—", color: "text-muted-foreground/40 bg-muted/20", icon: Pause, tooltip: "Insufficient data" },
};

function fmtInt(n: number) { return n.toLocaleString(undefined, { maximumFractionDigits: 0 }); }
function fmtSigned(n: number) { return (n >= 0 ? "+" : "") + fmtInt(n); }

export default function PositioningPage() {
  const [symbol, setSymbol] = useState("ES");
  const [days, setDays] = useState(30);
  const { data, isLoading } = useSWR<Response>(`/api/research/positioning?symbol=${symbol}&days=${days}`, fetcher, { refreshInterval: 0 });

  return (
    <div className="max-w-5xl mx-auto space-y-4">
      <div>
        <h1 className="text-xl font-bold tracking-tight">Open Interest & Positioning</h1>
        <p className="text-[11px] text-muted-foreground/50 mt-1">
          Daily open interest changes from Databento <code className="bg-muted/40 px-1 rounded font-mono">statistics</code> schema, joined to daily price moves.
          OI ↑ + price ↑ = longs adding · OI ↑ + price ↓ = shorts adding · OI ↓ = position unwinding.
        </p>
      </div>

      <div className="flex items-center gap-3 text-xs">
        <span className="text-muted-foreground/60">Symbol:</span>
        {SYMBOLS.map((s) => (
          <button
            key={s}
            onClick={() => setSymbol(s)}
            className={`px-2 py-0.5 rounded border font-mono ${symbol === s ? "border-emerald-500 text-emerald-400 bg-emerald-500/[0.06]" : "border-border text-muted-foreground hover:text-foreground"}`}
          >
            {s}
          </button>
        ))}
        <span className="text-muted-foreground/60 ml-3">Days:</span>
        {[14, 30, 60, 90].map((d) => (
          <button
            key={d}
            onClick={() => setDays(d)}
            className={`px-2 py-0.5 rounded border ${days === d ? "border-emerald-500 text-emerald-400 bg-emerald-500/[0.06]" : "border-border text-muted-foreground hover:text-foreground"}`}
          >
            {d}d
          </button>
        ))}
      </div>

      {isLoading && <Card><CardContent className="py-4 text-xs text-muted-foreground">Pulling Databento statistics…</CardContent></Card>}
      {data?.error && <Card><CardContent className="py-4 text-xs text-red-400">{data.error}</CardContent></Card>}

      {data && data.series && (
        <>
          {/* Summary */}
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
            {(() => {
              const counts = { longs_adding: 0, shorts_adding: 0, longs_unwinding: 0, shorts_covering: 0 };
              for (const r of data.series) {
                if (r.regime in counts) counts[r.regime as keyof typeof counts]++;
              }
              return Object.entries(counts).map(([regime, count]) => {
                const meta = REGIME_META[regime];
                const Icon = meta.icon;
                return (
                  <Card key={regime}>
                    <CardContent className="py-2.5 px-3">
                      <div className={`flex items-center gap-1.5 text-[11px] font-semibold ${meta.color.split(" ")[0]}`}>
                        <Icon className="w-3 h-3" />
                        {meta.label}
                      </div>
                      <div className="text-lg font-bold tabular-nums mt-1">{count}<span className="text-[10px] text-muted-foreground/60 font-normal ml-1">days</span></div>
                    </CardContent>
                  </Card>
                );
              });
            })()}
          </div>

          {/* Daily series table */}
          <Card>
            <CardContent className="py-3 overflow-x-auto">
              <table className="text-[11px] tabular-nums font-mono w-full">
                <thead>
                  <tr className="text-muted-foreground/60 border-b border-border/40">
                    <th className="px-2 py-1.5 text-left">Date</th>
                    <th className="px-2 py-1.5 text-right">Open Interest</th>
                    <th className="px-2 py-1.5 text-right">Δ OI</th>
                    <th className="px-2 py-1.5 text-right">Close</th>
                    <th className="px-2 py-1.5 text-right">Δ Price</th>
                    <th className="px-2 py-1.5 text-left">Regime</th>
                  </tr>
                </thead>
                <tbody>
                  {[...data.series].reverse().map((r) => {
                    const meta = REGIME_META[r.regime];
                    const Icon = meta.icon;
                    return (
                      <tr key={r.date} className="border-b border-border/20 hover:bg-muted/20">
                        <td className="px-2 py-1">{r.date}</td>
                        <td className="px-2 py-1 text-right">{fmtInt(r.openInterest)}</td>
                        <td className={`px-2 py-1 text-right ${r.oiChange > 0 ? "text-emerald-400" : r.oiChange < 0 ? "text-red-400" : "text-muted-foreground"}`}>{fmtSigned(r.oiChange)}</td>
                        <td className="px-2 py-1 text-right">{r.close !== null ? r.close.toLocaleString(undefined, { maximumFractionDigits: 2 }) : "—"}</td>
                        <td className={`px-2 py-1 text-right ${r.priceChange !== null && r.priceChange > 0 ? "text-emerald-400" : r.priceChange !== null && r.priceChange < 0 ? "text-red-400" : "text-muted-foreground"}`}>{r.priceChange !== null ? (r.priceChange >= 0 ? "+" : "") + r.priceChange.toFixed(2) : "—"}</td>
                        <td className="px-2 py-1">
                          <span className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded ${meta.color}`} title={meta.tooltip}>
                            <Icon className="w-2.5 h-2.5" />
                            {meta.label}
                          </span>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
              {data.series.length === 0 && (
                <div className="text-[11px] text-muted-foreground/60 py-4 text-center">
                  No open-interest records in this window. CME may not publish daily OI for {symbol} on this dataset.
                </div>
              )}
            </CardContent>
          </Card>

          <div className="text-[10px] text-muted-foreground/40">
            {data.recordsTotal.toLocaleString()} statistics records pulled from Databento for {symbol} over last {days} days. OI records: {data.series.length}.
          </div>
        </>
      )}
    </div>
  );
}
