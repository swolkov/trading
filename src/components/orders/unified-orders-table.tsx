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
interface PaperTradeRow {
  id: number; time: string; source: string; symbol: string; side: string;
  leverage: number | null; conviction: string | null; entry: number | null;
  exit: number | null; pnl: number | null; unrealized: number | null; status: string; reason: string | null;
}

const fetcher = (u: string) => fetch(u).then((r) => r.json()).catch(() => null);
const money = (n: number) => `${n >= 0 ? "+" : "−"}$${Math.abs(n).toLocaleString(undefined, { maximumFractionDigits: 0 })}`;
const money2 = (n: number) => `${n < 0 ? "−" : "+"}$${Math.abs(n).toFixed(2)}`;
const usd = (n: number) => `$${n.toLocaleString(undefined, { maximumFractionDigits: 2 })}`;
const col = (n: number) => (n > 0 ? "text-emerald-400" : n < 0 ? "text-red-400" : "text-muted-foreground");

// The one place for EVERY trade — a Live | Paper toggle keeps real money and the paper
// experiment clearly separated (never blended into one list, so a paper trade can't be
// mistaken for a real one). Live = real Kraken fills; Paper = the shadow trade log.
export function UnifiedOrdersTable() {
  const { data } = useSWR<Data>("/api/orders/all", fetcher, { refreshInterval: 30000 });
  const { data: krk } = useSWR<{ connected?: boolean; totalValue?: number; totalInvested?: number }>("/api/kraken-agent", fetcher, { refreshInterval: 60000 });
  const { data: paper } = useSWR<{ log?: PaperTradeRow[] }>("/api/margin/scoreboard", fetcher, { refreshInterval: 60000 });
  const [view, setView] = useState<"live" | "paper">("live");

  const paperLog = paper?.log ?? [];

  return (
    <div className="space-y-4">
      {/* Live | Paper toggle */}
      <div className="inline-flex items-center gap-1 rounded-lg border border-border bg-card p-1">
        <button
          onClick={() => setView("live")}
          className={`text-[11px] px-3 py-1 rounded-md transition-colors ${view === "live" ? "bg-red-500/15 text-red-400 font-bold" : "text-muted-foreground/50 hover:text-foreground/70"}`}
        >
          🔴 Live · real money
        </button>
        <button
          onClick={() => setView("paper")}
          className={`text-[11px] px-3 py-1 rounded-md transition-colors ${view === "paper" ? "bg-purple-500/15 text-purple-300 font-bold" : "text-muted-foreground/50 hover:text-foreground/70"}`}
        >
          🧪 Paper · no real money
        </button>
      </div>

      {view === "live" ? <LiveFills data={data} krk={krk} /> : <PaperLogTable log={paperLog} loading={paper === undefined} />}
    </div>
  );
}

function LiveFills({ data, krk }: { data: Data | undefined; krk: { connected?: boolean; totalValue?: number; totalInvested?: number } | undefined }) {
  const [filter, setFilter] = useState<"all" | "margin" | "spot">("all");
  if (!data?.orders) return <div className="text-sm text-muted-foreground/60 py-6">Loading fills…</div>;

  const allRows = data.orders;
  const rows = filter === "all" ? allRows : allRows.filter((o) => (filter === "margin" ? o.leveraged : !o.leveraged));
  const krkVal = krk?.connected ? krk?.totalValue ?? null : null;
  const krkPnl = krkVal != null && krk?.totalInvested != null ? krkVal - krk.totalInvested : null;
  const totalFees = rows.reduce((s, o) => s + (o.fee || 0), 0);

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-[10px] text-muted-foreground/45">{rows.length} real fills</span>
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
        Raw execution log — a single fill has no profit/loss on its own. Your <span className="text-foreground/60">up/down</span> is the <span className="text-foreground/60">Kraken account P&amp;L</span> above (real overall); per-trade round-trip P&amp;L is on the <span className="text-foreground/60">Margin Cockpit</span>.
      </p>

      {rows.length === 0 ? (
        <p className="text-sm text-muted-foreground/55 py-6">No fills yet.</p>
      ) : (
        <div className="rounded-xl border border-border bg-card overflow-hidden">
          <div className="max-h-[60vh] overflow-y-auto">
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
                    <td className={`px-2 py-1.5 font-medium capitalize ${o.action === "buy" ? "text-emerald-400" : "text-red-400"}`}>{o.action}</td>
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
    </div>
  );
}

function PaperLogTable({ log, loading }: { log: PaperTradeRow[]; loading: boolean }) {
  if (loading) return <div className="text-sm text-muted-foreground/60 py-6">Loading paper trades…</div>;
  return (
    <div className="space-y-3">
      <p className="text-[10px] text-purple-300/60">
        🧪 Paper trades — hypothetical, <span className="text-foreground/60">no real money moved</span>. Open trades show a live &ldquo;if closed now&rdquo; P&amp;L. Full scoreboard &amp; edges are on the <span className="text-foreground/60">Paper Trades</span> tab.
      </p>
      {log.length === 0 ? (
        <p className="text-sm text-muted-foreground/55 py-6">No paper trades yet — they open automatically as breakouts fire.</p>
      ) : (
        <div className="rounded-xl border border-border bg-card overflow-hidden">
          <div className="max-h-[60vh] overflow-y-auto">
            <table className="w-full text-[12px]">
              <thead className="sticky top-0 bg-card border-b border-border text-[10px] uppercase tracking-wider text-muted-foreground/45">
                <tr>
                  <th className="text-left font-medium px-3 py-2">When</th>
                  <th className="text-left font-medium px-2 py-2">Strategy</th>
                  <th className="text-left font-medium px-2 py-2">Coin</th>
                  <th className="text-left font-medium px-2 py-2">Side</th>
                  <th className="text-left font-medium px-2 py-2">Conv.</th>
                  <th className="text-right font-medium px-2 py-2">Entry</th>
                  <th className="text-right font-medium px-2 py-2">Exit</th>
                  <th className="text-right font-medium px-2 py-2">P&amp;L</th>
                  <th className="text-left font-medium px-3 py-2">Outcome</th>
                </tr>
              </thead>
              <tbody>
                {log.map((t) => {
                  const open = t.status !== "resolved";
                  const val = open ? t.unrealized : t.pnl;
                  return (
                    <tr key={t.id} className="border-b border-border/40 hover:bg-white/[0.02]">
                      <td className="px-3 py-1.5 text-muted-foreground/60 tabular-nums whitespace-nowrap">
                        {new Date(t.time).toLocaleDateString(undefined, { month: "short", day: "numeric" })} {new Date(t.time).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })}
                      </td>
                      <td className="px-2 py-1.5 text-muted-foreground/70">{t.source}</td>
                      <td className="px-2 py-1.5 font-semibold">{t.symbol.replace("/USD", "")}</td>
                      <td className={`px-2 py-1.5 font-medium ${t.side === "buy" ? "text-emerald-400" : "text-red-400"}`}>
                        {t.side.toUpperCase()}{t.leverage ? ` ${t.leverage}x` : ""}
                      </td>
                      <td className="px-2 py-1.5 text-muted-foreground/60 capitalize">{t.conviction ?? "—"}</td>
                      <td className="px-2 py-1.5 text-right tabular-nums text-muted-foreground/70">{t.entry != null ? usd(t.entry) : "—"}</td>
                      <td className="px-2 py-1.5 text-right tabular-nums text-muted-foreground/70">{t.exit != null ? usd(t.exit) : "—"}</td>
                      <td className="px-2 py-1.5 text-right tabular-nums font-bold">
                        {val != null ? <span className={col(val)}>{money2(val)}{open ? <span className="text-[8px] font-normal opacity-50 ml-0.5">live</span> : null}</span> : <span className="text-muted-foreground/40">—</span>}
                      </td>
                      <td className="px-3 py-1.5 whitespace-nowrap">
                        {open ? <span className="text-amber-400/80">● open</span> : <span className="text-muted-foreground/60">{t.reason ?? "closed"}</span>}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}
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
