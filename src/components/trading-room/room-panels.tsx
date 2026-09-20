"use client";

import { Chip } from "@/components/ui/chip";
import { DataTable, Row, Td, Th } from "@/components/ui/data-table";
import { Empty, Note, Panel, PanelBody, PanelHeader, Stat } from "@/components/ui/panel";
import { ago, money, pnl0, tone, when } from "@/lib/format";
import type { FeedEvent, LevelSet, RoomEvent, RoomSymbol, SizingLine } from "@/lib/trading-room-rules";
import { FEED_LABEL, INSTRUMENTS, MORNING_END_HOUR, ORB_MINUTES, etParts } from "@/lib/trading-room-rules";

// THE TRADING ROOM'S PANELS. One instrument card (levels + size), the news clock, the tape, and
// the live account — all read-only views of GET /api/trade. Nothing here can place an order.

const px = (sym: RoomSymbol, x: number | null | undefined) => x == null ? "—" : sym === "MGC" ? x.toFixed(1) : x.toFixed(2);
const pts = (sym: RoomSymbol, x: number) => `${x >= 0 ? "+" : "−"}${Math.abs(x).toFixed(sym === "MGC" ? 1 : 2)}`;

export function InstrumentCard({ sym, lv, sizing }: { sym: RoomSymbol; lv: LevelSet | null; sizing: SizingLine | null }) {
  const spec = INSTRUMENTS[sym];
  if (!lv) return <Panel><PanelHeader title={`${sym} · ${spec.label}`} /><PanelBody><Empty>No card yet — the room builds it every 5 minutes, round the clock Sunday evening through Friday.</Empty></PanelBody></Panel>;
  const chg = lv.last != null && lv.priorDay ? lv.last - lv.priorDay.close : null;
  const rows = [...lv.distances].sort((a, b) => b.price - a.price);
  return (
    <Panel>
      <PanelHeader title={<>{sym} <span className="font-normal text-muted-foreground">· {spec.label}</span></>}
        aside={<span className="flex items-center gap-2"><Chip tone={lv.source === "chart" ? "green" : "grey"} title={lv.lastAt ? `last bar ${when(lv.lastAt)}` : ""}>{lv.source === "chart" ? "from your chart" : "Yahoo · ~10 min delayed"}</Chip><span>{lv.last != null ? px(sym, lv.last) : "—"}{chg != null && <span className={`ml-1.5 ${tone(chg)}`}>{pts(sym, chg)}</span>}</span></span>} />
      <DataTable dense>
        <thead><tr><Th>Level</Th><Th num>Price</Th><Th num>From last</Th><Th num>In ATR</Th></tr></thead>
        <tbody>
          {rows.map((r) => (
            <Row key={r.level}>
              <Td strong={r.level.startsWith("OR")}>{r.level}</Td>
              <Td num>{px(sym, r.price)}</Td>
              <Td num className={tone(r.pts)}>{pts(sym, r.pts)}</Td>
              <Td num muted>{r.atrs != null ? `${r.atrs >= 0 ? "+" : "−"}${Math.abs(r.atrs).toFixed(2)}` : "—"}</Td>
            </Row>
          ))}
          {lv.openingRange && !lv.openingRange.complete && <Row><Td muted>OR{ORB_MINUTES}</Td><Td num muted>forming</Td><Td num muted>—</Td><Td num muted>—</Td></Row>}
        </tbody>
      </DataTable>
      <PanelBody>
        <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
          <Stat label="ATR daily" value={lv.atrDaily != null ? px(sym, lv.atrDaily) : "—"} sub="14 exchange days" />
          <Stat label="ATR 5-min" value={lv.atr5m != null ? px(sym, lv.atr5m) : "—"} sub="last 14 bars" />
          <Stat label="Overnight" value={lv.overnight ? `${px(sym, lv.overnight.low)}–${px(sym, lv.overnight.high)}` : "—"} sub={lv.overnight?.complete ? "complete" : "still forming"} />
          <Stat label="RTH" value={`${fmtHour(spec.rthOpen)}–${fmtHour(spec.rthClose)}`} sub={sym === "MGC" ? "COMEX open, not 9:30" : "cash open"} />
        </div>
        {sizing && (
          <div className="mt-3 rounded-lg border border-border bg-muted/30 px-3 py-2 text-[13px]">
            <span className="text-muted-foreground">Your size: </span><strong>{sizing.contracts} {sym}</strong> = <strong>{money(sizing.perPointUsd)}</strong> a point →{" "}
            {sizing.choices.map((c, i) => <span key={c.name}>{i > 0 && " · "}{c.name} stop {px(sym, c.stopPts)} pts = <strong>{money(c.riskUsd)}</strong></span>)}
          </div>
        )}
        {lv.note && <Note className="mt-2">{lv.note}</Note>}
      </PanelBody>
    </Panel>
  );
}
const fmtHour = (h: number) => `${Math.floor(h)}:${String(Math.round((h % 1) * 60)).padStart(2, "0")}`;

export function EventsPanel({ events, nowMs }: { events: RoomEvent[]; nowMs: number }) {
  const today = etParts(nowMs).dayKey;
  return (
    <Panel>
      <PanelHeader title="News clock" aside={<span>ET · next 7 days</span>} />
      {events.length === 0 ? <PanelBody><Empty>No scheduled prints in the next week.</Empty></PanelBody> : (
        <DataTable dense>
          <thead><tr><Th>When</Th><Th>Print</Th><Th>What to do</Th></tr></thead>
          <tbody>
            {events.map((e) => {
              const p = etParts(e.atMs); const past = e.atMs < nowMs; const isToday = p.dayKey === today;
              return (
                <Row key={`${e.name}@${e.atMs}`} className={past ? "opacity-50" : ""}>
                  <Td num strong={isToday}>{isToday ? "Today" : p.dayKey.slice(5)} {p.hhmm}{e.approx ? "*" : ""}</Td>
                  <Td><Chip tone={e.tier === 1 ? "red" : e.tier === 2 ? "amber" : "grey"} className="mr-1.5">tier {e.tier}</Chip>{e.name}</Td>
                  <Td muted>{e.note}</Td>
                </Row>
              );
            })}
          </tbody>
        </DataTable>
      )}
      <PanelBody><Note>Cash open 09:30 · COMEX gold open 08:20 · 10:00 data window · morning edge ends {fmtHour(MORNING_END_HOUR)} (time of day is the one robust intraday effect on these markets) · CME break 17:00–18:00. * = date from the standing schedule, confirm the time.</Note></PanelBody>
    </Panel>
  );
}

export function TapePanel({ feed }: { feed: FeedEvent[] }) {
  return (
    <Panel>
      <PanelHeader title="The tape" aside={<span>level breaks the chart reported · 5-min closes · RTH only</span>} />
      {feed.length === 0 ? <PanelBody><Empty>Nothing yet. Once the Pine study is on your charts with the alert set, every level break lands here and in Slack.</Empty></PanelBody> : (
        <DataTable dense maxH="360px">
          <thead><tr><Th>Time</Th><Th>Market</Th><Th>What</Th><Th num>Price</Th><Th num>Level</Th><Th num>Vol</Th></tr></thead>
          <tbody>
            {feed.map((e) => (
              <Row key={`${e.symbol}${e.kind}${e.at}`}>
                <Td num muted title={e.at}>{etParts(Date.parse(e.at)).hhmm}</Td>
                <Td strong>{e.symbol}</Td>
                <Td>{FEED_LABEL[e.kind]}</Td>
                <Td num>{px(e.symbol, e.price)}</Td>
                <Td num muted>{e.level != null ? px(e.symbol, e.level) : "—"}</Td>
                <Td num muted>{e.volRatio != null ? `${e.volRatio.toFixed(1)}×` : "—"}</Td>
              </Row>
            ))}
          </tbody>
        </DataTable>
      )}
    </Panel>
  );
}

export interface LiveView { at: string; ok: boolean; error?: string; balance: number | null; netLiq: number | null; realizedPnl: number | null; unrealizedPnl: number | null; positions: { contract: string; netPos: number; netPrice: number }[]; fillsToday: number }
export function LiveAccountPanel({ live }: { live: LiveView | null }) {
  return (
    <Panel tone={live && !live.ok ? "amber" : undefined}>
      <PanelHeader title="Tradovate · live account" aside={<Chip tone={live?.ok ? "red" : "grey"} dot={!!live?.ok}>{live?.ok ? `read ${ago(live.at)}` : live?.error ? "broker not read" : "not read yet"}</Chip>} />
      <PanelBody>
        <div className="grid grid-cols-2 gap-4 md:grid-cols-4">
          <Stat label="Net liquidation" value={live?.netLiq != null ? money(live.netLiq) : "—"} />
          <Stat label="Realized today" value={live?.realizedPnl != null ? pnl0(live.realizedPnl) : "—"} valueCls={tone(live?.realizedPnl)} sub={live?.unrealizedPnl != null ? `open ${pnl0(live.unrealizedPnl)}` : undefined} />
          <Stat label="Open positions" value={live ? String(live.positions.length) : "—"} sub={live?.positions.length ? live.positions.map((p) => `${p.contract} ${p.netPos > 0 ? "+" : ""}${p.netPos} @ ${p.netPrice}`).join(" · ") : "flat"} />
          <Stat label="Fills seen today" value={live ? String(live.fillsToday) : "—"} sub="stored for the journal" />
        </div>
        <Note className="mt-3">Read-only. The room reads this account every 5 minutes, round the clock, and keeps every fill; it has no order path. {live?.error ? `Last error: ${live.error}` : ""}</Note>
      </PanelBody>
    </Panel>
  );
}
