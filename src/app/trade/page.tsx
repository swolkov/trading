"use client";

import useSWR from "swr";
import { Chip } from "@/components/ui/chip";
import { PageHeader } from "@/components/ui/panel";
import { ago } from "@/lib/format";
import { ROOM_SYMBOLS, etParts, type FeedEvent, type LevelSet, type RoomEvent, type RoomSettings, type SizingLine } from "@/lib/trading-room-rules";
import { EventsPanel, InstrumentCard, LiveAccountPanel, TapePanel, type LiveView } from "@/components/trading-room/room-panels";
import { SettingsPanel, SetupPanel } from "@/components/trading-room/room-setup";
import { JournalSection } from "@/components/trading-room/journal-panels";
import { DayRulesStrip } from "@/components/trading-room/day-rules-strip";

// THE TRADING ROOM — Spencer trades MES / MNQ / MGC by hand on his live Tradovate account; this page
// shows him what the chart shows (the level set), what his own rule allows (size), what is on the
// clock (news), and what the chart reported (the tape). Read-only by construction: the one write is
// the sizing rule. Nothing on this page, and nothing behind it, can place an order.

interface RoomData {
  at: string; settings: RoomSettings;
  card: { at: string; levels: Record<string, LevelSet>; events: RoomEvent[]; errors: string[] } | null;
  sizing: Record<string, SizingLine | null>;
  live: LiveView | null;
  feed: FeedEvent[];
  state: { cardPostedDay?: string; lastTickAt?: string; lastError?: string };
  error?: string;
}
const fetcher = (u: string) => fetch(u).then((r) => r.json());

export default function TradingRoomPage() {
  const { data, mutate, isLoading } = useSWR<RoomData>("/api/trade", fetcher, { refreshInterval: 60_000 });
  // The clock comes from the server's response time (refreshed every minute by SWR), so the render stays pure.
  const nowMs = data?.at ? Date.parse(data.at) : 0;
  const now = etParts(nowMs || 0);
  const weekday = nowMs > 0 && now.weekday >= 1 && now.weekday <= 5;
  const morning = weekday && now.hourFrac >= 9.5 && now.hourFrac < 10.5;
  const rth = weekday && now.hourFrac >= 9.5 && now.hourFrac < 16;
  const webhookUrl = typeof window !== "undefined" ? `${window.location.origin}/api/webhook/trading-room` : "/api/webhook/trading-room";

  async function refresh() { await fetch("/api/trade", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "refresh" }) }); mutate(); }

  if (isLoading || !data) return <div className="flex h-64 items-center justify-center"><div className="h-6 w-6 animate-spin rounded-full border-2 border-primary border-t-transparent" /></div>;

  return (
    <div className="space-y-5">
      <PageHeader
        title="Trading Room"
        sub="MES · MNQ · MGC — you trade on Tradovate live; this room shows the levels, your size, the news clock and the tape. Nothing here places an order."
        right={(
          <>
            <Chip tone={rth ? (morning ? "green" : "amber") : "grey"} dot={rth}>{rth ? (morning ? "Morning window" : "Afternoon · past the morning edge") : "Outside RTH"}</Chip>
            <Chip tone={data.card ? "grey" : "amber"} title={data.card?.at}>{data.card ? `card ${ago(data.card.at)}` : "no card yet"}</Chip>
            <button onClick={refresh} className="h-6 rounded-md border border-border px-2 text-xs font-semibold hover:bg-accent">Refresh now</button>
          </>
        )}
      />

      <DayRulesStrip />

      {data.error && <div className="rounded-lg border border-down/40 bg-down/10 px-3 py-2 text-[13px] text-down">{data.error}</div>}
      {data.card?.errors.length ? <div className="rounded-lg border border-warn/40 bg-warn/10 px-3 py-2 text-xs text-warn">{data.card.errors.join(" · ")}</div> : null}

      <div className="grid grid-cols-1 gap-3 xl:grid-cols-3">
        {ROOM_SYMBOLS.map((sym) => <InstrumentCard key={sym} sym={sym} lv={data.card?.levels[sym] ?? null} sizing={data.sizing[sym] ?? null} />)}
      </div>

      <SettingsPanel key={JSON.stringify(data.settings)} settings={data.settings} onSaved={() => mutate()} />

      <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
        <EventsPanel events={data.card?.events ?? []} nowMs={nowMs} />
        <TapePanel feed={data.feed} />
      </div>

      <JournalSection />
      <LiveAccountPanel live={data.live} />
      <SetupPanel webhookUrl={webhookUrl} />
    </div>
  );
}
