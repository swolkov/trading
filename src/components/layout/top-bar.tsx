"use client";

import useSWR from "swr";
import { Chip } from "@/components/ui/chip";
import { ago, money } from "@/lib/format";

const fetcher = (url: string) => fetch(url).then((r) => r.json());

// Top bar: the money at a glance. Tradovate LIVE is the account Spencer trades by hand (read by the
// room every 5 minutes); Robinhood is the REAL options account (its
// snapshot is pushed by the collector after each close, shown with its age); the futures
// desk is the Tradovate DEMO, paper by design. Every read is an existing read-only endpoint
// and each fails safe to "unknown" — nothing here can place an order. The Kraken account
// value and the margin executor's arm chip were removed with the crypto desk (Sep 19 2026).
export function TopBar() {
  const { data: opt, isLoading } = useSWR<{ account?: { totalValue: number; optionLevel: string; at: string } | null; live?: { at: string } | null; execution?: { canPlaceOrders: boolean; armed?: boolean } }>("/api/options/live", fetcher, { refreshInterval: 120000 });
  const { data: fut } = useSWR<{ enabled?: boolean; broker?: { netLiq: number } | null; open?: unknown[]; error?: string }>("/api/futures/desk", fetcher, { refreshInterval: 120000 });
  const { data: room } = useSWR<{ live?: { ok: boolean; netLiq: number | null; realizedPnl: number | null; positions: { contract: string; netPos: number }[] } | null }>("/api/trade", fetcher, { refreshInterval: 60000 });
  const optionsArmed = Boolean(opt?.execution?.canPlaceOrders);
  const live = room?.live?.ok ? room.live : null;

  return (
    <header className="flex h-12 shrink-0 items-center gap-3 border-b border-border bg-sidebar pl-14 pr-4 md:px-5">
      <div className="flex min-w-0 flex-1 items-center gap-4 overflow-x-auto md:gap-6">
        {isLoading ? (
          <>
            <div className="skeleton h-3.5 w-28" />
            <div className="skeleton h-3 w-20" />
          </>
        ) : (
          <>
            <div className="flex items-baseline gap-1.5 whitespace-nowrap" title="Your live Tradovate account — the one you trade by hand. Read-only; nothing here places orders.">
              <span className="text-[11px] uppercase tracking-wide text-down/90">Tradovate live</span>
              <span className="text-[13px] font-semibold tabular-nums">{live?.netLiq != null ? money(live.netLiq) : "—"}</span>
              {live && <span className="text-[11px] text-muted-foreground">{live.positions.length ? live.positions.map((p) => `${p.contract} ${p.netPos > 0 ? "+" : ""}${p.netPos}`).join(" · ") : "flat"}{live.realizedPnl ? ` · today ${live.realizedPnl > 0 ? "+" : "−"}$${Math.abs(Math.round(live.realizedPnl))}` : ""}</span>}
            </div>
            <div className="flex items-baseline gap-1.5 whitespace-nowrap" title="Robinhood options account, as the desk session last saw it. This is the real-money account.">
              <span className="text-[11px] uppercase tracking-wide text-muted-foreground">Robinhood</span>
              <span className="text-[13px] font-semibold tabular-nums">{opt?.account ? money(opt.account.totalValue) : "—"}</span>
              {opt?.account && <span className="text-[11px] text-muted-foreground" title="Age of the saved broker snapshot">{ago(opt.live?.at ?? opt.account.at)}</span>}
            </div>
            <div className="hidden items-baseline gap-1.5 whitespace-nowrap md:flex" title="Tradovate DEMO equity, from the guardian's last read. Paper only — sizing uses a fixed $50k basis, not this number.">
              <span className="text-[11px] uppercase tracking-wide text-paper/80">Futures demo</span>
              <span className="text-[13px] font-semibold tabular-nums">{fut?.broker ? money(fut.broker.netLiq) : "—"}</span>
              {fut && !fut.error && <span className="text-[11px] text-muted-foreground">{fut.open?.length ?? 0} open · {fut.enabled ? "desk enabled" : "desk disabled"}</span>}
            </div>
          </>
        )}
      </div>
      <Chip tone={optionsArmed ? "red" : opt?.execution?.armed ? "amber" : "grey"} dot={optionsArmed}
        title={optionsArmed ? "The options live desk can place real orders (one contract, inside the approved cap)" : opt?.execution?.armed ? "Armed, but the broker adapter is unverified — the desk refuses to place" : "The options live desk is not placing real orders"}>
        {optionsArmed ? "Options desk armed" : opt?.execution?.armed ? "Armed · unverified" : "Options desk disarmed"}
      </Chip>
    </header>
  );
}
