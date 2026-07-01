"use client";

import useSWR from "swr";

interface Holding { coin: string; amount: number; price: number; value: number; }
interface Status {
  connected: boolean;
  enabled: boolean;
  validateOnly: boolean;
  usd: number;
  holdings: Holding[];
  totalValue: number;
  totalInvested: number;
  buyCount: number;
  config: Record<string, string>;
  error?: string;
}

const fetcher = (u: string) => fetch(u).then((r) => r.json());
const fmt = (n: number) => `$${n.toLocaleString(undefined, { maximumFractionDigits: 2 })}`;

export function AccumulatorPanel() {
  const { data } = useSWR<Status>("/api/kraken-agent", fetcher, { refreshInterval: 60000 });
  if (!data) return null;

  const perBuy = data.config?.kraken_per_buy_usd || "40";
  const coins = data.config?.kraken_coins || "BTC/USD,ETH/USD";
  const pnl = data.totalValue - data.totalInvested;

  return (
    <div className="rounded-lg border border-border bg-card p-5 space-y-3">
      <div className="flex items-center justify-between">
        <h2 className="font-semibold text-sm">Dip Accumulator (buy &amp; hold)</h2>
        <div className="flex items-center gap-1.5">
          {data.connected ? (
            data.enabled ? (
              data.validateOnly
                ? <span className="text-[9px] font-bold uppercase tracking-wider px-1.5 py-0.5 rounded bg-amber-500/15 text-amber-300 border border-amber-500/30">Validate mode</span>
                : <span className="text-[9px] font-bold uppercase tracking-wider px-1.5 py-0.5 rounded bg-emerald-500/15 text-emerald-400 border border-emerald-500/30">Live</span>
            ) : <span className="text-[9px] font-bold uppercase tracking-wider px-1.5 py-0.5 rounded bg-muted text-muted-foreground/60">Off</span>
          ) : (
            <span className="text-[9px] font-bold uppercase tracking-wider px-1.5 py-0.5 rounded bg-red-500/15 text-red-400 border border-red-500/30">Not connected</span>
          )}
        </div>
      </div>

      {!data.connected ? (
        <p className="text-[11px] text-muted-foreground/55 leading-relaxed">
          Funded, built, and ready. Activates once <code className="bg-muted px-1 rounded">KRAKEN_API_KEY</code> / <code className="bg-muted px-1 rounded">KRAKEN_API_SECRET</code> (a fresh trade-only key) are added in the Vercel environment. Buys ${perBuy} of {coins.replace(/\/USD/g, "")} on each dip and holds — never sells.
        </p>
      ) : (
        <>
          <div className="grid grid-cols-4 gap-3 text-center">
            <div><p className="text-[10px] text-muted-foreground/50">Cash</p><p className="text-sm font-bold tabular-nums">{fmt(data.usd)}</p></div>
            <div><p className="text-[10px] text-muted-foreground/50">Invested</p><p className="text-sm font-bold tabular-nums">{fmt(data.totalInvested)}</p></div>
            <div><p className="text-[10px] text-muted-foreground/50">Value</p><p className="text-sm font-bold tabular-nums">{fmt(data.totalValue)}</p></div>
            <div><p className="text-[10px] text-muted-foreground/50">P&amp;L</p><p className={`text-sm font-bold tabular-nums ${pnl >= 0 ? "text-emerald-400" : "text-red-400"}`}>{data.totalInvested ? fmt(pnl) : "—"}</p></div>
          </div>
          {data.holdings.length > 0 && (
            <div className="space-y-1">
              {data.holdings.map((h) => (
                <div key={h.coin} className="flex items-center justify-between text-[11px] px-2 py-1 rounded bg-white/[0.02]">
                  <span className="font-semibold">{h.coin.replace("/USD", "")}</span>
                  <span className="tabular-nums text-muted-foreground/70">{h.amount.toFixed(6)} @ {fmt(h.price)}</span>
                  <span className="tabular-nums font-medium">{fmt(h.value)}</span>
                </div>
              ))}
            </div>
          )}
          <p className="text-[10px] text-muted-foreground/45">Buys: {data.buyCount} · ${perBuy}/dip · {coins.replace(/\/USD/g, "")} · buy &amp; hold (never sells){data.validateOnly ? " · validate mode = no real orders yet" : ""}</p>
        </>
      )}
    </div>
  );
}
