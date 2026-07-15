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
interface Data { orders: Order[] }

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
  // Follow the same demo/live toggle the rest of the dashboard uses.
  const { data: modeData } = useSWR<{ modes: Record<string, string> }>("/api/trading-mode", fetcher, { refreshInterval: 30000 });
  const isLive = modeData?.modes?.futures === "live";
  const [cat, setCat] = useState<"all" | Order["category"]>("all");

  if (!data?.orders || !modeData) return <div className="text-sm text-muted-foreground/60 py-6">Loading orders…</div>;

  // VIEW SPLIT: live view shows real-money books (live futures + Kraken + Meme); demo view shows demo
  // futures only. Kraken and Meme are real accounts with no demo equivalent, so they never show in demo.
  const viewOrders = data.orders.filter((o) =>
    isLive ? (o.category !== "futures" || o.mode === "live") : (o.category === "futures" && o.mode === "demo"),
  );

  const catsPresent = Array.from(new Set(viewOrders.map((o) => o.category)));
  const tabs: ("all" | Order["category"])[] = catsPresent.length > 1 ? ["all", ...catsPresent] : catsPresent;
  const effectiveCat = tabs.includes(cat) ? cat : (tabs[0] ?? "all");
  const rows = viewOrders.filter((o) => effectiveCat === "all" || o.category === effectiveCat);

  const bookPnl = (c: Order["category"]) => viewOrders.filter((o) => o.category === c).reduce((s, o) => s + (o.pnl ?? 0), 0);
  const bookCount = (c: Order["category"]) => viewOrders.filter((o) => o.category === c).length;

  return (
    <div className="space-y-4">
      {/* View indicator */}
      <div className="flex items-center gap-2">
        <span className={`text-[10px] font-bold uppercase tracking-wider px-2 py-1 rounded ${isLive ? "text-red-400/80 bg-red-500/[0.08]" : "text-emerald-400/80 bg-emerald-500/[0.08]"}`}>
          {isLive ? "🔴 Live · real money" : "🟢 Demo"}
        </span>
        <span className="text-[10px] text-muted-foreground/45">{viewOrders.length} orders · lifetime · toggle demo/live in the top bar</span>
      </div>

      {/* Summary */}
      <div className="grid grid-cols-2 md:grid-cols-3 gap-2">
        {isLive ? (
          <>
            <Stat label="Futures (live) realized" value={money(bookPnl("futures"))} cls={col(bookPnl("futures"))} sub={`${bookCount("futures")} trades`} />
            <Stat label="Kraken" value={`${bookCount("kraken")} trades`} sub="accumulator" />
            <Stat label="Meme realized" value={money(bookPnl("meme"))} cls={col(bookPnl("meme"))} sub={`${bookCount("meme")} trades`} />
          </>
        ) : (
          <Stat label="Futures (demo) realized" value={money(bookPnl("futures"))} cls={col(bookPnl("futures"))} sub={`${bookCount("futures")} trades`} />
        )}
      </div>

      {/* Category filter (only when >1 book present) */}
      {tabs.length > 1 && (
        <div className="flex gap-1.5 text-[11px] font-semibold">
          {tabs.map((c) => (
            <button key={c} onClick={() => setCat(c)}
              className={`px-2.5 py-1 rounded-md border capitalize ${effectiveCat === c ? "bg-white/[0.08] text-foreground border-border" : "text-muted-foreground/50 border-transparent hover:text-muted-foreground"}`}>
              {c}
            </button>
          ))}
        </div>
      )}

      {rows.length === 0 ? (
        <p className="text-sm text-muted-foreground/55 py-6">No orders in this view yet.</p>
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
      <p className="text-[10px] text-muted-foreground/40">
        {isLive
          ? "Live real-money order log — live futures + Kraken + Meme Lab. Realized = sum of logged trade P&L (differs from the balance-based account total on the dashboard). Kraken P&L is account-level, not per-trade."
          : "Demo futures order log (fake money). Kraken and Meme are real-money accounts and only appear in the live view."}
      </p>
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
