"use client";

import useSWR from "swr";
import { useState } from "react";

interface Fill {
  symbol: string;
  action: string;
  price: number;
  vol: number;
  notional: number;
  fee: number;
  leveraged: boolean;
  time: string;
}
interface Data { orders: Fill[]; summary?: { total: number; totalFees: number; totalNotional: number } }

const fetcher = (u: string) => fetch(u).then((r) => r.json()).catch(() => null);
const money = (n: number) => `${n >= 0 ? "+" : "−"}$${Math.abs(n).toLocaleString(undefined, { maximumFractionDigits: 0 })}`;
const usd = (n: number) => `$${n.toLocaleString(undefined, { maximumFractionDigits: 2 })}`;
const col = (n: number) => (n > 0 ? "text-emerald-400" : n < 0 ? "text-red-400" : "text-muted-foreground");

// Every real Kraken fill (spot + margin), newest first — the raw-fills log for the margin era.
// Replaced the retired trend-bot event log. All Kraken money is real (no demo book).
export function UnifiedOrdersTable() {
  const { data } = useSWR<Data>("/api/orders/all", fetcher, { refreshInterval: 30000 });
  // Kraken account value AND deposited capital — same source the dashboard uses.
  const { data: krk } = useSWR<{ connected?: boolean; totalValue?: number; totalInvested?: number }>("/api/kraken-agent", fetcher, { refreshInterval: 60000 });
  // Filter: your leveraged MARGIN trades vs SPOT (the old trend bot's DCA + hand-buys). Lets
  // you isolate your actual margin trading from the retired bot's noise. Default all.
  const [filter, setFilter] = useState<"all" | "margin" | "spot">("all");

  if (!data?.orders) return <div className="text-sm text-muted-foreground/60 py-6">Loading fills…</div>;

  const allRows = data.orders;
  const rows = filter === "all" ? allRows : allRows.filter((o) => (filter === "margin" ? o.leveraged : !o.leveraged));
  const krkVal = krk?.connected ? krk?.totalValue ?? null : null;
  // P&L must be balance-based (value − deposits), never a sum of the row log.
  const krkPnl = krkVal != null && krk?.totalInvested != null ? krkVal - krk.totalInvested : null;
  const totalFees = rows.reduce((s, o) => s + (o.fee || 0), 0);

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-[10px] font-bold uppercase tracking-wider px-2 py-1 rounded text-red-400/80 bg-red-500/[0.08]">
          🔴 Live · real money
        </span>
        <span className="text-[10px] text-muted-foreground/45">{rows.length} fills</span>
        <div className="flex items-center gap-1 ml-auto">
          {([
            { k: "all", label: "All" },
            { k: "margin", label: "My margin" },
            { k: "spot", label: "Spot / bot" },
          ] as { k: "all" | "margin" | "spot"; label: string }[]).map((f) => (
            <button
              key={f.k}
              onClick={() => setFilter(f.k)}
              className={`text-[10px] px-2 py-1 rounded transition-colors ${filter === f.k ? "bg-white/[0.10] text-foreground font-semibold" : "text-muted-foreground/50 hover:text-foreground/70"}`}
            >
              {f.label}
            </button>
          ))}
        </div>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
        <Stat
          label="Kraken account P&L"
          value={krkPnl != null ? money(krkPnl) : "—"}
          cls={krkPnl != null ? col(krkPnl) : ""}
          sub={krkVal != null && krk?.totalInvested != null
            ? `$${krk.totalInvested.toLocaleString(undefined, { maximumFractionDigits: 0 })} in → $${krkVal.toLocaleString(undefined, { maximumFractionDigits: 0 })} now`
            : krk === undefined ? "loading…" : "account unreachable"}
        />
        <Stat label="Fills" value={`${rows.length}`} sub="real Kraken executions" />
        <Stat label="Fees paid" value={`−$${totalFees.toLocaleString(undefined, { maximumFractionDigits: 0 })}`} cls="text-red-400/80" sub="on these fills" />
      </div>

      <p className="text-[10px] text-muted-foreground/45 -mt-1">
        This is the raw execution log — a single fill has no profit/loss on its own. Your <span className="text-foreground/60">up/down</span> is the <span className="text-foreground/60">Kraken account P&amp;L</span> above (real overall), and per-trade round-trip P&amp;L is on the <span className="text-foreground/60">Margin Cockpit</span>.
      </p>

      {rows.length === 0 ? (
        <p className="text-sm text-muted-foreground/55 py-6">No fills yet.</p>
      ) : (
        <div className="rounded-xl border border-border bg-card overflow-hidden">
          <div className="max-h-[65vh] overflow-y-auto">
            <table className="w-full text-[12px]">
              <thead className="sticky top-0 bg-card border-b border-border text-[10px] uppercase tracking-wider text-muted-foreground/45">
                <tr>
                  <th className="text-left font-medium px-3 py-2">When</th>
                  <th className="text-left font-medium px-2 py-2">Coin</th>
                  <th className="text-left font-medium px-2 py-2">Side</th>
                  <th className="text-right font-medium px-2 py-2">Price</th>
                  <th className="text-right font-medium px-2 py-2">Size</th>
                  <th className="text-right font-medium px-2 py-2">Value</th>
                  <th className="text-right font-medium px-3 py-2">Fee</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((o, i) => (
                  <tr key={i} className="border-b border-border/40 hover:bg-white/[0.02]">
                    <td className="px-3 py-1.5 text-muted-foreground/60 tabular-nums whitespace-nowrap">
                      {new Date(o.time).toLocaleDateString(undefined, { month: "short", day: "numeric" })} {new Date(o.time).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })}
                    </td>
                    <td className="px-2 py-1.5 font-semibold">
                      {o.symbol}
                      {o.leveraged && <span className="ml-1 text-[8px] uppercase text-purple-400/70 align-top">margin</span>}
                    </td>
                    <td className={`px-2 py-1.5 font-medium capitalize ${o.action === "buy" ? "text-emerald-400" : "text-red-400"}`}>
                      {o.action}
                    </td>
                    <td className="px-2 py-1.5 text-right tabular-nums text-muted-foreground/70">{o.price != null ? usd(o.price) : "—"}</td>
                    <td className="px-2 py-1.5 text-right tabular-nums text-muted-foreground/60">{o.vol != null ? o.vol.toLocaleString(undefined, { maximumFractionDigits: 6 }) : "—"}</td>
                    <td className="px-2 py-1.5 text-right tabular-nums text-muted-foreground/70">{o.notional != null ? usd(o.notional) : "—"}</td>
                    <td className="px-3 py-1.5 text-right tabular-nums text-red-400/60">{o.fee ? `−${usd(o.fee)}` : "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
      <p className="text-[10px] text-muted-foreground/40">
        Every real Kraken fill (spot + margin), from Kraken&apos;s own trade history. The account P&L above is balance-based
        (value − deposits), never a sum of these rows. Round-trip P&L and win rate are on the Margin Cockpit; this is the raw log.
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
