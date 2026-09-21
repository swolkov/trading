"use client";

import { useState } from "react";
import useSWR from "swr";
import { Chip } from "@/components/ui/chip";
import { DataTable, Row, Td, Th } from "@/components/ui/data-table";
import { Empty, Note, PageHeader, Panel, PanelBody, PanelHeader, Stat } from "@/components/ui/panel";
import { ReplayPanel } from "@/components/trading-room/replay-panel";
import { hold, pnl0, tone, when } from "@/lib/format";
import type { JournalRow, Scoreboard } from "@/lib/trading-room-journal";

// THE TRADE LIBRARY: every round trip he has made on the live account, each replayable on its own
// 1-minute chart with his fills, the levels as they stood, and the stop. The newest opens by itself.

interface JournalData { rows: JournalRow[]; scoreboard: Scoreboard; error?: string }
const fetcher = (u: string) => fetch(u).then((r) => r.json());
const px = (sym: string, x: number) => (sym === "MGC" ? x.toFixed(1) : x.toFixed(2));

export default function TradeLibraryPage() {
  const { data } = useSWR<JournalData>("/api/trade/journal", fetcher, { refreshInterval: 60_000 });
  const [picked, setPicked] = useState<string | null>(null);
  const rows = data?.rows ?? [];
  // The newest trade opens by itself until one is picked; "closed" is a pick of nothing.
  const selected = picked === null ? rows[0]?.id ?? null : picked === "" ? null : picked;
  const setSelected = (id: string | null) => setPicked(id ?? "");
  const closed = rows.filter((r) => !r.open);
  const net = closed.reduce((a, r) => a + r.netUsd, 0);
  const wins = closed.filter((r) => r.netUsd > 0).length;
  return (
    <div className="space-y-5">
      <PageHeader title="Trade Library" sub="Every trade on your live Tradovate account, replayable: the 1-minute chart around it, your fills, the levels as they stood at entry, and the stop the room saw. Each one is also posted to Slack the moment it closes." />
      {!data ? <Panel><PanelBody><Empty>Loading…</Empty></PanelBody></Panel> : data.error ? <Panel tone="amber"><PanelBody><Note>{data.error}</Note></PanelBody></Panel> : (
        <>
          <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
            <Panel><PanelBody><Stat size="lg" label="Trades" value={String(closed.length)} sub={rows.length > closed.length ? `${rows.length - closed.length} open` : "since the room began, Sep 21 2026"} /></PanelBody></Panel>
            <Panel><PanelBody><Stat size="lg" label="Net after fees" value={pnl0(net)} valueCls={tone(net)} /></PanelBody></Panel>
            <Panel><PanelBody><Stat size="lg" label="Win rate" value={closed.length ? `${Math.round((wins / closed.length) * 100)}%` : "—"} sub={closed.length ? `${wins} of ${closed.length}` : undefined} /></PanelBody></Panel>
            <Panel><PanelBody><Stat size="lg" label="40-trade test" value={data.scoreboard.verdict.status === "collecting" ? `${data.scoreboard.closed} of 40` : data.scoreboard.verdict.status} sub="on the Trading Room" /></PanelBody></Panel>
          </div>
          {selected && <ReplayPanel id={selected} onClose={() => setSelected(null)} />}
          <Panel>
            <PanelHeader title="All trades" aside={<span>newest first · click one to replay it</span>} />
            {rows.length === 0 ? <PanelBody><Empty>No trades yet. The first one appears within five minutes of closing.</Empty></PanelBody> : (
              <DataTable dense maxH="520px">
                <thead><tr><Th>Entry</Th><Th>Market</Th><Th num>Qty</Th><Th num>Entry → exit</Th><Th num>Net</Th><Th num>R</Th><Th num>Hold</Th><Th>Session</Th><Th>Near</Th><Th>Tag</Th></tr></thead>
                <tbody>{rows.map((r) => (
                  <Row key={r.id} onClick={() => setSelected(r.id)} className={r.id === selected ? "bg-primary/10" : undefined}>
                    <Td muted>{when(r.entryTs)}</Td>
                    <Td strong>{r.symbol} <span className={r.side === "long" ? "text-up" : "text-down"}>{r.side}</span>{r.open && <Chip tone="blue" className="ml-1.5">open</Chip>}</Td>
                    <Td num>{r.qty}</Td>
                    <Td num>{px(r.symbol, r.entryPx)} → {px(r.symbol, r.exitPx)}</Td>
                    <Td num className={tone(r.netUsd)}>{pnl0(r.netUsd)}</Td>
                    <Td num className={tone(r.netR)}>{r.netR == null ? "—" : `${r.netR >= 0 ? "+" : "−"}${Math.abs(r.netR).toFixed(2)}R${r.riskSource === "atr-proxy" ? "*" : ""}`}</Td>
                    <Td num muted>{hold(r.holdMin)}</Td>
                    <Td muted>{r.session}</Td>
                    <Td muted>{r.nearestLevel ?? "—"}</Td>
                    <Td muted>{r.setupTag ?? "—"}</Td>
                  </Row>
                ))}</tbody>
              </DataTable>
            )}
          </Panel>
          <Note>* R by proxy (2× the 5-minute ATR at entry) because no stop order was seen on the position. Put the stop in the bracket and R is measured off your real risk. Tags and notes are edited on the Trading Room journal.</Note>
        </>
      )}
    </div>
  );
}
