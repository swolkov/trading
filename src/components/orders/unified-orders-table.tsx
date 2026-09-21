"use client";

import useSWR from "swr";
import { useState } from "react";
import { OptionOrdersTable, OptionPositionsTable, type LiveOrder, type LivePosition } from "@/components/options/account-tables";
import { JournalTable, LedgerPanel, type JournalData } from "@/components/trading-room/journal-panels";
import { LiveAccountPanel, type LiveView } from "@/components/trading-room/room-panels";
import { Empty, Note, Panel, PanelBody } from "@/components/ui/panel";
import { ago, usd0 } from "@/lib/format";
import Link from "next/link";

const fetcher = (u: string) => fetch(u).then((r) => r.json()).catch(() => null);

function Segmented<T extends string>({ value, onChange, options }: { value: T; onChange: (v: T) => void; options: { k: T; label: string; tone?: "red" | "paper" }[] }) {
  return (
    <div className="inline-flex items-center gap-0.5 rounded-lg border border-border bg-card p-0.5">
      {options.map((o) => {
        const active = o.k === value;
        const activeCls = o.tone === "red" ? "bg-down/15 text-down" : o.tone === "paper" ? "bg-paper/15 text-paper" : "bg-accent text-foreground";
        return (
          <button key={o.k} onClick={() => onChange(o.k)} className={`h-7 rounded-md px-3 text-xs font-semibold transition-colors ${active ? activeCls : "text-muted-foreground hover:text-foreground"}`}>
            {o.label}
          </button>
        );
      })}
    </div>
  );
}

// THE ONE PLACE FOR EVERY TRADE, BROKEN DOWN BY PLATFORM. Each platform is its own segment
// with its own money state in the label — Spencer's LIVE Tradovate account (his hand trades,
// read by the Trading Room) and the real Robinhood account (a broker snapshot). The paper
// futures desk was retired Sep 21 2026. The tables are the same components the platform
// pages render, so this page and those pages can never disagree about a row. The Kraken
// segment was retired with the crypto desk (Sep 19 2026).
type Platform = "live" | "robinhood";
export function UnifiedOrdersTable() {
  const [platform, setPlatform] = useState<Platform>("live");
  return (
    <div className="space-y-4">
      <Segmented value={platform} onChange={setPlatform} options={[
        { k: "live", label: "Tradovate · futures · live, by hand", tone: "red" },
        { k: "robinhood", label: "Robinhood · options · real account" },
      ]} />
      {platform === "live" ? <LiveFuturesOrders /> : <RobinhoodOrders />}
    </div>
  );
}

// Tradovate LIVE — the account Spencer trades by hand. Nothing on this site places orders there;
// the room only reads: balance and positions, the broker's own cash ledger (realized P&L and fees
// per trade date) and every round trip rebuilt from fills, the same rows the Trading Room shows.
interface RoomLite { live: LiveView | null }
function LiveFuturesOrders() {
  const { data: room } = useSWR<RoomLite>("/api/trade", fetcher, { refreshInterval: 60_000 });
  const { data, mutate } = useSWR<JournalData>("/api/trade/journal", fetcher, { refreshInterval: 60_000 });
  if (data === undefined || room === undefined) return <Panel><PanelBody><Empty>Loading the live account…</Empty></PanelBody></Panel>;
  if (!data || data.error) return <Panel><PanelBody><Empty>The live account did not answer{data?.error ? `: ${data.error}` : ""}.</Empty></PanelBody></Panel>;
  return (
    <div className="space-y-4">
      <Note>
        Your real account, read-only. The site never places, changes or cancels an order here. Levels, the card and the scoreboard are on <Link href="/trade" className="text-primary hover:underline">Trading Room</Link>.
      </Note>
      <LiveAccountPanel live={room?.live ?? null} />
      {data.ledger && <LedgerPanel byDay={data.ledger.byDay} trades={data.ledger.trades} />}
      <JournalTable rows={data.rows} onSaved={() => mutate()} />
    </div>
  );
}

// Robinhood — the REAL account's positions and orders, as the collector last pushed them.
interface RobinhoodLive {
  live: { positions: LivePosition[]; orders: LiveOrder[]; at: string; minutesAgo: number } | null;
  execution?: { canPlaceOrders: boolean; maxLossUsd: number | null; why: string };
}
function RobinhoodOrders() {
  const { data } = useSWR<RobinhoodLive>("/api/options/live", fetcher, { refreshInterval: 60000 });
  if (data === undefined) return <Panel><PanelBody><Empty>Loading the Robinhood snapshot…</Empty></PanelBody></Panel>;
  const live = data?.live ?? null;
  return (
    <div className="space-y-4">
      <Note>
        Real account, read from a broker snapshot{live ? ` taken ${ago(live.at)}` : ""}. {data?.execution?.canPlaceOrders ? "Live order placement is active." : "The app places no orders here yet"}
        {data?.execution?.maxLossUsd != null ? ` — approved maximum loss per trade ${usd0(data.execution.maxLossUsd)}, fees included.` : "."} Account, buying power and the research desk are on <Link href="/options" className="text-primary hover:underline">Live Account</Link>.
      </Note>
      <OptionPositionsTable positions={live?.positions ?? []} at={live?.at ?? null} />
      <OptionOrdersTable orders={live?.orders ?? []} at={live?.at ?? null} />
    </div>
  );
}

