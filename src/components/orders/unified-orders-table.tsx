"use client";

import useSWR from "swr";

interface Order {
  category: "kraken";
  mode: "live";
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

// Kraken-only order log since the Aug 2026 futures retirement. All Kraken money is
// real (no demo book), so there is no demo/live view toggle any more.
export function UnifiedOrdersTable() {
  const { data } = useSWR<Data>("/api/orders/all", fetcher, { refreshInterval: 30000 });
  // Kraken account value AND deposited capital — same source the dashboard uses.
  const { data: krk } = useSWR<{ connected?: boolean; totalValue?: number; totalInvested?: number }>("/api/kraken-agent", fetcher, { refreshInterval: 60000 });

  if (!data?.orders) return <div className="text-sm text-muted-foreground/60 py-6">Loading orders…</div>;

  const rows = data.orders;
  const krkVal = krk?.connected ? krk?.totalValue ?? null : null;
  // P&L must be balance-based (value − deposits), never a sum of the row log.
  const krkPnl = krkVal != null && krk?.totalInvested != null ? krkVal - krk.totalInvested : null;

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2">
        <span className="text-[10px] font-bold uppercase tracking-wider px-2 py-1 rounded text-red-400/80 bg-red-500/[0.08]">
          🔴 Live · real money
        </span>
        <span className="text-[10px] text-muted-foreground/45">{rows.length} orders · lifetime</span>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
        <Stat
          label="Kraken account P&L"
          value={krkPnl != null ? money(krkPnl) : "—"}
          cls={krkPnl != null ? col(krkPnl) : ""}
          sub={krkVal != null && krk?.totalInvested != null
            ? `$${krk.totalInvested.toLocaleString(undefined, { maximumFractionDigits: 0 })} deposited → $${krkVal.toLocaleString(undefined, { maximumFractionDigits: 0 })} now`
            : "account unreachable"}
        />
        <Stat label="Bot orders" value={`${rows.length}`} sub="trend-bot buys and sells, lifetime" />
      </div>

      {rows.length === 0 ? (
        <p className="text-sm text-muted-foreground/55 py-6">No orders yet.</p>
      ) : (
        <div className="rounded-xl border border-border bg-card overflow-hidden">
          <div className="max-h-[65vh] overflow-y-auto">
            <table className="w-full text-[12px]">
              <thead className="sticky top-0 bg-card border-b border-border text-[10px] uppercase tracking-wider text-muted-foreground/45">
                <tr>
                  <th className="text-left font-medium px-3 py-2">When</th>
                  <th className="text-left font-medium px-2 py-2">Symbol</th>
                  <th className="text-left font-medium px-2 py-2">Action</th>
                  <th className="text-right font-medium px-3 py-2">Size</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((o, i) => (
                  <tr key={i} className="border-b border-border/40 hover:bg-white/[0.02]">
                    <td className="px-3 py-1.5 text-muted-foreground/60 tabular-nums whitespace-nowrap">
                      {new Date(o.time).toLocaleDateString(undefined, { month: "short", day: "numeric" })} {new Date(o.time).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })}
                    </td>
                    <td className="px-2 py-1.5 font-semibold">{o.symbol}</td>
                    <td className="px-2 py-1.5 text-muted-foreground/70 capitalize" title={o.reason ?? undefined}>
                      {o.action}
                    </td>
                    <td className="px-3 py-1.5 text-right tabular-nums text-muted-foreground/70">
                      {o.size != null ? `$${o.size}` : "—"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
      <p className="text-[10px] text-muted-foreground/40">
        Trend-bot event log. The P&L above is balance-based (account value − deposits, from Kraken&apos;s own ledger) —
        never a sum of these rows. Manual margin trades appear on the Margin Cockpit scoreboard, not here.
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
