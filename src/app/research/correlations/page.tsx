"use client";

import useSWR from "swr";
import { useState } from "react";
import { Card, CardContent } from "@/components/ui/card";

interface Response {
  windowDays: number;
  symbols: string[];
  matrix: number[][];
  meta: { symbol: string; bars: number; first: string | null; last: string | null }[];
  error?: string;
}

const fetcher = (u: string) => fetch(u).then((r) => r.json());

function corrColor(c: number): string {
  // Strong positive = emerald; strong negative = red; near zero = gray
  if (isNaN(c)) return "bg-muted/20 text-muted-foreground/40";
  const abs = Math.abs(c);
  if (c > 0) {
    if (abs > 0.7) return "bg-emerald-500/40 text-foreground";
    if (abs > 0.4) return "bg-emerald-500/25 text-foreground";
    if (abs > 0.2) return "bg-emerald-500/10 text-foreground/80";
    return "bg-muted/30 text-muted-foreground";
  } else {
    if (abs > 0.7) return "bg-red-500/40 text-foreground";
    if (abs > 0.4) return "bg-red-500/25 text-foreground";
    if (abs > 0.2) return "bg-red-500/10 text-foreground/80";
    return "bg-muted/30 text-muted-foreground";
  }
}

function interpret(c: number): string {
  if (isNaN(c)) return "no data";
  const abs = Math.abs(c);
  if (abs > 0.85) return c > 0 ? "near-identical" : "near-mirror";
  if (abs > 0.7) return c > 0 ? "strongly positive" : "strongly negative";
  if (abs > 0.4) return c > 0 ? "moderately positive" : "moderately negative";
  if (abs > 0.2) return c > 0 ? "weakly positive" : "weakly negative";
  return "uncorrelated";
}

export default function CorrelationsPage() {
  const [days, setDays] = useState(90);
  const { data, isLoading } = useSWR<Response>(`/api/research/correlations?days=${days}`, fetcher, { refreshInterval: 0 });

  return (
    <div className="max-w-5xl mx-auto space-y-4">
      <div>
        <h1 className="text-xl font-bold tracking-tight">Cross-Asset Correlations</h1>
        <p className="text-[11px] text-muted-foreground/50 mt-1">
          Pairwise Pearson correlation of daily log-returns. From Databento historical data already pulled to <code className="bg-muted/40 px-1 rounded font-mono">data/</code>. Confirms whether positions are independent or correlated.
        </p>
      </div>

      <div className="flex items-center gap-2 text-xs">
        <span className="text-muted-foreground/60">Window:</span>
        {[30, 60, 90, 180, 365].map((d) => (
          <button
            key={d}
            onClick={() => setDays(d)}
            className={`px-2 py-0.5 rounded border ${days === d ? "border-emerald-500 text-emerald-400 bg-emerald-500/[0.06]" : "border-border text-muted-foreground hover:text-foreground"}`}
          >
            {d}d
          </button>
        ))}
      </div>

      {isLoading && <Card><CardContent className="py-4 text-xs text-muted-foreground">Computing correlations…</CardContent></Card>}
      {data?.error && <Card><CardContent className="py-4 text-xs text-red-400">{data.error}</CardContent></Card>}

      {data && data.symbols && data.symbols.length > 0 && (
        <>
          {/* Matrix */}
          <Card>
            <CardContent className="py-3 overflow-x-auto">
              <table className="text-[11px] tabular-nums font-mono">
                <thead>
                  <tr>
                    <th className="px-2 py-1.5 text-left text-muted-foreground/60">—</th>
                    {data.symbols.map((s) => <th key={s} className="px-2 py-1.5 text-left text-muted-foreground/60">{s}</th>)}
                  </tr>
                </thead>
                <tbody>
                  {data.symbols.map((rowSym, i) => (
                    <tr key={rowSym}>
                      <th className="px-2 py-1 text-left text-muted-foreground/60">{rowSym}</th>
                      {data.symbols.map((colSym, j) => {
                        const c = data.matrix[i][j];
                        return (
                          <td key={colSym} className={`px-2 py-1 text-center ${corrColor(c)}`} title={interpret(c)}>
                            {isNaN(c) ? "—" : c.toFixed(2)}
                          </td>
                        );
                      })}
                    </tr>
                  ))}
                </tbody>
              </table>
              <div className="flex items-center gap-3 mt-3 text-[10px] text-muted-foreground/50">
                <span>Color scale:</span>
                <span className="inline-block px-2 py-0.5 rounded bg-emerald-500/40">+0.7+</span>
                <span className="inline-block px-2 py-0.5 rounded bg-emerald-500/25">+0.4</span>
                <span className="inline-block px-2 py-0.5 rounded bg-muted/30">0</span>
                <span className="inline-block px-2 py-0.5 rounded bg-red-500/25">−0.4</span>
                <span className="inline-block px-2 py-0.5 rounded bg-red-500/40">−0.7+</span>
              </div>
            </CardContent>
          </Card>

          {/* Insights */}
          <Card>
            <CardContent className="py-3 space-y-1.5 text-[11px]">
              <div className="text-[10px] uppercase tracking-wider text-muted-foreground/60 mb-1">Plain English</div>
              {data.symbols.flatMap((a, i) => data.symbols.slice(i + 1).map((b, jOffset) => {
                const j = i + 1 + jOffset;
                const c = data.matrix[i][j];
                if (isNaN(c)) return null;
                return (
                  <div key={`${a}-${b}`} className="flex items-baseline gap-2">
                    <span className="font-mono w-16 text-muted-foreground/70">{a} × {b}</span>
                    <span className={`tabular-nums font-semibold ${c > 0.4 ? "text-emerald-400" : c < -0.4 ? "text-red-400" : "text-muted-foreground"}`}>{c >= 0 ? "+" : ""}{c.toFixed(2)}</span>
                    <span className="text-muted-foreground/60">— {interpret(c)}</span>
                  </div>
                );
              })).filter(Boolean)}
            </CardContent>
          </Card>

          {/* Data meta */}
          <details className="text-[11px]">
            <summary className="cursor-pointer text-muted-foreground/60 hover:text-foreground">Data sources & sample sizes</summary>
            <Card className="mt-2"><CardContent className="py-2 text-[11px] text-muted-foreground space-y-0.5">
              {data.meta.map((m) => (
                <div key={m.symbol} className="font-mono">
                  {m.symbol.padEnd(4)}: {m.bars} daily bars ({m.first} → {m.last})
                </div>
              ))}
            </CardContent></Card>
          </details>
        </>
      )}
    </div>
  );
}
