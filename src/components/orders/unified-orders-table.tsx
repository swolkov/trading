"use client";

import { useState } from "react";
import useSWR from "swr";

interface Order {
  category: "futures" | "kraken" | "meme";
  mode: "live" | "demo";
  symbol: string;
  action: string;
  size: number | null;
  pnl: number | null;
  time: string;
  reason?: string | null;
}
interface Data {
  orders: Order[];
  summary?: { total: number; futures: { count: number; pnl: number }; kraken: { count: number }; meme: { count: number; pnl: number } };
}

const fetcher = (u: string) => fetch(u).then((r) => r.json()).catch(() => null);
const money = (n: number) => `${n >= 0 ? "+" : "−"}$${Math.abs(n).toLocaleString(undefined, { maximumFractionDigits: 0 })}`;
const col = (n: number) => (n > 0 ? "text-emerald-400" : n < 0 ? "text-red-400" : "text-muted-foreground");

const CAT_STYLE: Record<Order["category"], string> = {
  futures: "text-amber-400/80 bg-amber-500/[0.08]",
  kraken: "text-purple-400/80 bg-purple-500/[0.08]",
  meme: "text-fuchsia-400/80 bg-fuchsia-500/[0.08]",
};

export function UnifiedOrdersTable() {
  const { data } = useSWR<Data>("/api/orders/all", fetcher, { refreshInterval: 30000 });
  const [cat, setCat] = useState<"all" | Order["category"]>("all");

  if (!data?.orders) return <div className="text-sm text-muted-foreground/60 py-6">Loading orders…</div>;
  const rows = data.orders.filter((o) => cat === "all" || o.category === cat);
  const s = data.summary;

  return (
    <div className="space-y-4">
      {/* Summary strip */}
      {s && (
        <div className="grid grid-cols-2 md:grid-cols-4 gap-2">
          <Stat label="All orders" value={String(s.total)} />
          <Stat label="Futures P&L" value={money(s.futures.pnl)} cls={col(s.futures.pnl)} sub={`${s.futures.count} trades`} />
          <Stat label="Kraken" value={`${s.kraken.count} trades`} sub="accumulator" />
          <Stat label="Meme P&L" value={money(s.meme.pnl)} cls={col(s.meme.pnl)} sub={`${s.meme.count} trades`} />
        </div>
      )}

      {/* Category filter */}
      <div className="flex gap-1.5 text-[11px] font-semibold">
        {(["all", "futures", "kraken", "meme"] as const).map((c) => (
          <button
            key={c}
            onClick={() => setCat(c)}
            className={`px-2.5 py-1 rounded-md border capitalize ${cat === c ? "bg-white/[0.08] text-foreground border-border" : "text-muted-foreground/50 border-transparent hover:text-muted-foreground"}`}
          >
            {c}
          </button>
        ))}
      </div>

      {/* Table */}
      {rows.length === 0 ? (
        <p className="text-sm text-muted-foreground/55 py-6">No orders in this category yet.</p>
      ) : (
        <div className="rounded-xl border border-border bg-card overflow-hidden">
          <div className="max-h-[65vh] overflow-y-auto">
            <table className="w-full text-[12px]">
              <thead className="sticky top-0 bg-card border-b border-border text-[10px] uppercase tracking-wider text-muted-foreground/45">
                <tr>
                  <th className="text-left font-medium px-3 py-2">When</th>
                  <th className="text-left font-medium px-2 py-2">Book</th>
                  <th className="text-left font-medium px-2 py-2">Symbol</th>
                  <th className="text-left font-medium px-2 py-2">Action</th>
                  <th className="text-right font-medium px-2 py-2">Size</th>
                  <th className="text-right font-medium px-3 py-2">P&L</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((o, i) => (
                  <tr key={i} className="border-b border-border/40 hover:bg-white/[0.02]">
                    <td className="px-3 py-1.5 text-muted-foreground/60 tabular-nums whitespace-nowrap">
                      {new Date(o.time).toLocaleDateString(undefined, { month: "short", day: "numeric" })} {new Date(o.time).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })}
                    </td>
                    <td className="px-2 py-1.5">
                      <span className={`text-[9px] font-bold uppercase tracking-wider px-1.5 py-0.5 rounded ${CAT_STYLE[o.category]}`}>{o.category}</span>
                      {o.category === "futures" && (
                        <span className={`ml-1 text-[8px] font-bold uppercase ${o.mode === "live" ? "text-red-400/70" : "text-emerald-400/70"}`}>{o.mode}</span>
                      )}
                    </td>
                    <td className="px-2 py-1.5 font-semibold">{o.symbol}</td>
                    <td className="px-2 py-1.5 text-muted-foreground/70 capitalize" title={o.reason ?? undefined}>
                      {o.action}{o.reason && o.category === "meme" ? ` (${o.reason})` : ""}
                    </td>
                    <td className="px-2 py-1.5 text-right tabular-nums text-muted-foreground/70">
                      {o.size != null ? (o.category === "futures" ? `${o.size}x` : `$${o.size}`) : "—"}
                    </td>
                    <td className={`px-3 py-1.5 text-right tabular-nums font-semibold ${o.pnl != null ? col(o.pnl) : "text-muted-foreground/40"}`}>
                      {o.pnl != null ? money(o.pnl) : "—"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
      <p className="text-[10px] text-muted-foreground/40">Lifetime order log across all live systems — Futures (demo + live), Kraken, Meme Lab. Kraken is a trend/accumulator book, so its P&L is account-level, not per-trade.</p>
    </div>
  );
}

function Stat({ label, value, cls = "", sub }: { label: string; value: string; cls?: string; sub?: string }) {
  return (
    <div className="rounded-lg border border-border bg-card px-3 py-2">
      <p className={`text-base font-black tabular-nums ${cls}`}>{value}</p>
      <p className="text-[9px] uppercase tracking-wider text-muted-foreground/45">{label}{sub ? ` · ${sub}` : ""}</p>
    </div>
  );
}
