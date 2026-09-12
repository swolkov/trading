"use client";

import useSWR from "swr";
import { Chip } from "@/components/ui/chip";
import { ago, money, pnl0, tone } from "@/lib/format";

const fetcher = (url: string) => fetch(url).then((r) => r.json());

interface KrakenStatus {
  connected?: boolean;
  totalValue?: number;
  strategyPnl?: number;
  strategyCapital?: number;
}

// Top bar: the whole Kraken account's value, the PARKED spot-coin book's result against
// its deposits (labelled as such — it is not the margin desk's P&L), and the executor's
// real-money state. The arm state comes from /api/margin/mode (a DB read, safe to poll
// on every page); it fails safe to "disarmed" if unreadable.
export function TopBar() {
  const { data: krk, isLoading } = useSWR<KrakenStatus>("/api/kraken-agent", fetcher, { refreshInterval: 60000 });
  const { data: mode } = useSWR<{ armed?: boolean; auto?: boolean }>("/api/margin/mode", fetcher, { refreshInterval: 60000 });
  // The second platform. Robinhood has live execution disabled and its snapshot is pushed by the desk
  // session, so this is "what the agent last saw", with its age on the options page.
  const { data: opt } = useSWR<{ account?: { totalValue: number; optionLevel: string; at: string } | null; live?: { at: string } | null }>("/api/options/live", fetcher, { refreshInterval: 120000 });
  const armed = Boolean(mode?.armed);

  const equity = krk?.connected && (krk.totalValue ?? 0) > 0 ? krk.totalValue! : null;
  const parkedPnl = krk?.connected ? krk.strategyPnl ?? null : null;
  const parkedPct = parkedPnl != null && (krk?.strategyCapital || 0) > 0 ? parkedPnl / (krk!.strategyCapital as number) : null;

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
            <div className="flex items-baseline gap-1.5 whitespace-nowrap" title="Total Kraken account value: USD + coins, at today's prices. This is the real-money account.">
              <span className="text-[11px] uppercase tracking-wide text-muted-foreground">Kraken</span>
              <span className="text-[13px] font-semibold tabular-nums">{equity != null ? money(equity) : "—"}</span>
            </div>
            {equity == null && krk && <Chip tone="red" title="Kraken did not answer the last read; the numbers will fill in on the next one">Kraken did not answer</Chip>}
            {parkedPnl != null && equity != null && (
              <div className="flex items-baseline gap-1.5 whitespace-nowrap" title="The parked BTC/ETH holdings versus what was deposited for them. Not the margin desk — that record is on Orders and Live Desk.">
                <span className="text-[11px] uppercase tracking-wide text-muted-foreground">Parked coins</span>
                <span className={`text-[13px] font-semibold tabular-nums ${tone(parkedPnl)}`}>{pnl0(parkedPnl)}</span>
                {parkedPct != null && (
                  <span className={`text-[11px] tabular-nums ${tone(parkedPnl)}`}>({parkedPct >= 0 ? "+" : ""}{(parkedPct * 100).toFixed(1)}%)</span>
                )}
                <span className="hidden text-[11px] text-muted-foreground sm:inline">vs deposits</span>
              </div>
            )}
            {opt?.account && (
              <div className="hidden items-baseline gap-1.5 whitespace-nowrap md:flex" title="Robinhood Agentic account, as the desk session last saw it. Live execution is not active.">
                <span className="text-[11px] uppercase tracking-wide text-muted-foreground">Robinhood</span>
                <span className="text-[13px] font-semibold tabular-nums">{money(opt.account.totalValue)}</span>
                <span className="text-[11px] text-muted-foreground">live inactive</span>
                <span className="text-[11px] text-muted-foreground" title="Age of the saved broker snapshot">{ago(opt.live?.at ?? opt.account.at)}</span>
              </div>
            )}
          </>
        )}
      </div>
      <Chip tone={armed ? "red" : "grey"} dot={armed} title={armed ? "The margin executor is placing real orders" : "The margin executor is not placing real orders"}>
        {armed ? "Executor armed" : "Executor disarmed"}
      </Chip>
    </header>
  );
}
