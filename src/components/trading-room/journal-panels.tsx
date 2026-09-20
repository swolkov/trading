"use client";

import { useState } from "react";
import useSWR from "swr";
import { Chip, type ChipTone } from "@/components/ui/chip";
import { DataTable, Row, Td, Th } from "@/components/ui/data-table";
import { Empty, Note, Panel, PanelBody, PanelHeader, Stat } from "@/components/ui/panel";
import { hold, pnl0, tone, when } from "@/lib/format";
import type { JournalRow, Scoreboard } from "@/lib/trading-room-journal";
import type { LedgerDay, LedgerTrade } from "@/lib/trading-room-ledger";
import { sessionBucket } from "@/lib/trading-room-journal";
import type { RoomSymbol } from "@/lib/trading-room-rules";

// THE JOURNAL ON THE PAGE. Spencer's real round trips from his Tradovate fills, stamped by the room,
// and the pre-registered 40-trade scoreboard. The only input is his: a one-word tag and a one-line why.

export interface JournalData { rows: JournalRow[]; scoreboard: Scoreboard; rules: { minTrades: number; recheckAt: number }; ledger?: { rows: number; byDay: LedgerDay[]; trades: LedgerTrade[]; since: string | null }; error?: string }
const fetcher = (u: string) => fetch(u).then((r) => r.json());
const px = (sym: RoomSymbol, x: number) => (sym === "MGC" ? x.toFixed(1) : x.toFixed(2));
const r1 = (x: number | null) => (x == null ? "—" : `${x >= 0 ? "+" : "−"}${Math.abs(x).toFixed(2)}R`);

export function JournalSection() {
  const { data, mutate } = useSWR<JournalData>("/api/trade/journal", fetcher, { refreshInterval: 60_000 });
  if (!data) return <Panel><PanelBody><Empty>Loading the journal…</Empty></PanelBody></Panel>;
  if (data.error) return <Panel tone="amber"><PanelBody><Note>Journal did not load: {data.error}</Note></PanelBody></Panel>;
  return (
    <div className="space-y-3">
      {data.ledger && <LedgerPanel byDay={data.ledger.byDay} trades={data.ledger.trades} />}
      <ScoreboardPanel sb={data.scoreboard} minTrades={data.rules.minTrades} />
      <JournalTable rows={data.rows} onSaved={() => mutate()} />
    </div>
  );
}

export function LedgerPanel({ byDay, trades }: { byDay: LedgerDay[]; trades: LedgerTrade[] }) {
  const total = byDay.reduce((a, d) => ({ trades: a.trades + d.trades, gross: a.gross + d.grossUsd, win: a.win + d.winUsd, fees: a.fees + d.feesUsd, other: a.other + d.otherUsd, net: a.net + d.netUsd }), { trades: 0, gross: 0, win: 0, fees: 0, other: 0, net: 0 });
  const tradingDays = byDay.filter((d) => d.trades > 0).length;
  const recent = [...byDay].reverse().slice(0, 30);
  return (
    <Panel>
      <PanelHeader title="Broker ledger · what Tradovate says you made" aside={<span>realized P&amp;L and fees per trade, from the broker&apos;s own cash log · by trade date</span>} />
      <PanelBody>
        <div className="grid grid-cols-2 gap-4 md:grid-cols-5">
          <Stat label="Net after fees" value={pnl0(total.net)} valueCls={tone(total.net)} sub={`${tradingDays} trading day${tradingDays === 1 ? "" : "s"}`} />
          <Stat label="Gross on trades" value={pnl0(total.gross)} valueCls={tone(total.gross)} sub={`${total.trades} paired trades`} />
          <Stat label="Fees" value={pnl0(total.fees)} valueCls={tone(total.fees)} sub={total.trades ? `${(Math.abs(total.fees) / total.trades).toFixed(2)} per paired trade` : undefined} />
          <Stat label="Other" value={pnl0(total.other)} valueCls={tone(total.other)} sub="liquidations · subscriptions" />
          <Stat label="Fees vs. what you won" value={total.win > 0 ? `${Math.round(100 * Math.abs(total.fees) / total.win)}%` : "—"} sub={total.win > 0 ? `${pnl0(total.fees)} of ${pnl0(total.win)} in winning trades` : undefined} />
        </div>
        {recent.length === 0 ? <Empty>No ledger rows yet. The room reads the broker&apos;s cash log every 5 minutes.</Empty> : (
          <DataTable dense maxH="260px" className="mt-3">
            <thead><tr><Th>Trade date</Th><Th num>Trades</Th><Th num>W / L</Th><Th num>Gross</Th><Th num>Fees</Th><Th num>Other</Th><Th num>Net</Th><Th num>Best / worst</Th><Th num>Running</Th></tr></thead>
            <tbody>{recent.map((d) => (
              <Row key={d.day}>
                <Td strong>{d.day}</Td><Td num>{d.trades}</Td><Td num muted>{d.wins} / {d.losses}</Td>
                <Td num className={tone(d.grossUsd)}>{pnl0(d.grossUsd)}</Td><Td num className={tone(d.feesUsd)}>{pnl0(d.feesUsd)}</Td><Td num muted>{d.otherUsd ? pnl0(d.otherUsd) : "—"}</Td>
                <Td num className={tone(d.netUsd)}>{pnl0(d.netUsd)}</Td><Td num muted>{pnl0(d.bestUsd)} / {pnl0(d.worstUsd)}</Td><Td num className={tone(d.cumNetUsd)}>{pnl0(d.cumNetUsd)}</Td>
              </Row>
            ))}</tbody>
          </DataTable>
        )}
        <Note className="mt-3">A &quot;paired trade&quot; is the broker&apos;s own match of an entry fill to an exit fill, so one round trip at 20 contracts can show as several pairs. The journal below rebuilds full round trips from fills the room has seen; fills from before the room existed are gone from the broker&apos;s API, so those days show here only.</Note>
        <LedgerTradesTable trades={trades} />
      </PanelBody>
    </Panel>
  );
}

// Every trade the broker recorded, newest first — the only per-trade record for days before the room existed.
function LedgerTradesTable({ trades }: { trades: LedgerTrade[] }) {
  if (!trades.length) return null;
  const rows = [...trades].reverse();
  return (
    <div className="mt-4">
      <p className="mb-1 text-[11px] uppercase tracking-wide text-muted-foreground">Every trade · {trades.length} · newest first</p>
      <DataTable dense maxH="420px">
        <thead><tr><Th>Closed (ET)</Th><Th>Session</Th><Th num>Pairs</Th><Th num>Trade P&amp;L</Th><Th num>Best / worst pair</Th><Th num>Running</Th></tr></thead>
        <tbody>{rows.map((t) => (
          <Row key={t.id}>
            <Td muted title={t.exitTs}>{when(t.exitTs)}</Td>
            <Td muted>{sessionBucket(Date.parse(t.exitTs))}</Td>
            <Td num muted>{t.pairs}</Td>
            <Td num className={tone(t.grossUsd)} strong>{pnl0(t.grossUsd)}</Td>
            <Td num muted>{t.pairs > 1 ? `${pnl0(t.bestPairUsd)} / ${pnl0(t.worstPairUsd)}` : "—"}</Td>
            <Td num className={tone(t.runningGrossUsd)}>{pnl0(t.runningGrossUsd)}</Td>
          </Row>
        ))}</tbody>
      </DataTable>
      <Note className="mt-2">Gross, before fees (fees post per fill, not per trade: ~$2.06 a contract round trip). Market, size and entry price are not in the broker&apos;s ledger — those come from fills, which the journal keeps from the first trade it sees live.</Note>
    </div>
  );
}

function ScoreboardPanel({ sb, minTrades }: { sb: Scoreboard; minTrades: number }) {
  const status: ChipTone = sb.verdict.status === "pass" ? "green" : sb.verdict.status === "fail" ? "red" : "amber";
  const pf = (x: number | null) => (x == null ? "—" : Number.isFinite(x) ? x.toFixed(2) : "∞");
  return (
    <Panel>
      <PanelHeader title="Scoreboard · the 40-trade test" aside={<Chip tone={status} dot={sb.verdict.status !== "collecting"}>{sb.verdict.status === "collecting" ? `collecting · ${sb.closed} of ${minTrades}` : sb.verdict.status === "pass" ? "edge holds" : "not yet"}</Chip>} />
      <PanelBody>
        <div className="grid grid-cols-2 gap-4 md:grid-cols-4 xl:grid-cols-7">
          <Stat label="Closed trades" value={String(sb.closed)} sub={sb.n > sb.closed ? `${sb.n - sb.closed} open` : undefined} />
          <Stat label="Net after fees" value={pnl0(sb.netUsd)} valueCls={tone(sb.netUsd)} />
          <Stat label="Mean R" value={sb.meanR == null ? "—" : r1(sb.meanR)} valueCls={tone(sb.meanR)} sub={sb.tStat != null ? `t ${sb.tStat.toFixed(2)}` : undefined} />
          <Stat label="Profit factor" value={pf(sb.profitFactor)} sub={`without top two: ${pf(sb.profitFactorWithoutTopTwo)}`} />
          <Stat label="Win rate" value={sb.winRate == null ? "—" : `${(sb.winRate * 100).toFixed(0)}%`} />
          <Stat label="P(mean R > 0)" value={sb.bootstrapPMeanPositive == null ? "—" : `${(sb.bootstrapPMeanPositive * 100).toFixed(0)}%`} sub="bootstrap" />
          <Stat label="Avg contracts" value={sb.avgContracts == null ? "—" : sb.avgContracts.toFixed(1)} sub={`${sb.withStop} of ${sb.closed} with a stop seen`} />
        </div>
        <div className="mt-3 grid grid-cols-1 gap-3 lg:grid-cols-3">
          <div>
            <p className="mb-1 text-[11px] uppercase tracking-wide text-muted-foreground">The test</p>
            <ul className="space-y-1 text-[13px]">
              {sb.verdict.checks.map((c) => (
                <li key={c.name} className="flex items-start gap-2">
                  <Chip tone={c.ok == null ? "grey" : c.ok ? "green" : "red"}>{c.ok == null ? "—" : c.ok ? "ok" : "no"}</Chip>
                  <span><span className="text-foreground">{c.name}</span> <span className="text-muted-foreground">· {c.detail}</span></span>
                </li>
              ))}
            </ul>
          </div>
          <div>
            <p className="mb-1 text-[11px] uppercase tracking-wide text-muted-foreground">By session (entry)</p>
            {sb.bySession.length === 0 ? <Empty>—</Empty> : (
              <ul className="space-y-0.5 text-[13px] tabular-nums">{sb.bySession.map((s) => <li key={s.session} className="flex justify-between"><span>{s.session}</span><span><span className={tone(s.netUsd)}>{pnl0(s.netUsd)}</span> <span className="text-muted-foreground">· {s.n} · {r1(s.meanR)}</span></span></li>)}</ul>
            )}
          </div>
          <div>
            <p className="mb-1 text-[11px] uppercase tracking-wide text-muted-foreground">By market · around prints</p>
            <ul className="space-y-0.5 text-[13px] tabular-nums">
              {sb.bySymbol.map((s) => <li key={s.symbol} className="flex justify-between"><span>{s.symbol}</span><span><span className={tone(s.netUsd)}>{pnl0(s.netUsd)}</span> <span className="text-muted-foreground">· {s.n} · {r1(s.meanR)}</span></span></li>)}
              <li className="flex justify-between border-t border-border pt-1"><span>±30 min of a print</span><span><span className={tone(sb.eventWindow.inside.netUsd)}>{pnl0(sb.eventWindow.inside.netUsd)}</span> <span className="text-muted-foreground">· {sb.eventWindow.inside.n}</span></span></li>
              <li className="flex justify-between"><span>away from prints</span><span><span className={tone(sb.eventWindow.outside.netUsd)}>{pnl0(sb.eventWindow.outside.netUsd)}</span> <span className="text-muted-foreground">· {sb.eventWindow.outside.n}</span></span></li>
            </ul>
          </div>
        </div>
        <Note className="mt-3">Pre-registered Sep 19 2026, re-checked at 50. R = your stop when the room saw a stop order on the position; otherwise a proxy of 2× the 5-minute ATR at entry (the row says which). Fees modeled at $2.06 per contract round trip (measured on your account: $1.03 a side).</Note>
      </PanelBody>
    </Panel>
  );
}

export function JournalTable({ rows, onSaved }: { rows: JournalRow[]; onSaved: () => void }) {
  return (
    <Panel>
      <PanelHeader title="Journal" aside={<span>every round trip from your Tradovate fills · newest first</span>} />
      {rows.length === 0 ? <PanelBody><Empty>No trades yet. Fills are read every 5 minutes, round the clock; a round trip appears here the moment it closes (open positions show as open).</Empty></PanelBody> : (
        <DataTable dense maxH="520px">
          <thead><tr><Th>Entry</Th><Th>Market</Th><Th num>Qty</Th><Th num>Entry → exit</Th><Th num>Net</Th><Th num>R</Th><Th num>MFE / MAE</Th><Th num>Hold</Th><Th>Session</Th><Th>Near</Th><Th>Tag · why</Th></tr></thead>
          <tbody>{rows.map((r) => <JournalRowView key={r.id} r={r} onSaved={onSaved} />)}</tbody>
        </DataTable>
      )}
    </Panel>
  );
}

function JournalRowView({ r, onSaved }: { r: JournalRow; onSaved: () => void }) {
  const [tag, setTag] = useState(r.setupTag ?? "");
  const [why, setWhy] = useState(r.why ?? "");
  const [busy, setBusy] = useState(false);
  const dirty = tag !== (r.setupTag ?? "") || why !== (r.why ?? "");
  async function save() {
    setBusy(true);
    try { await fetch("/api/trade/journal", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "note", id: r.id, setupTag: tag, why }) }); onSaved(); }
    finally { setBusy(false); }
  }
  return (
    <Row>
      <Td muted title={r.entryTs}>{when(r.entryTs)}{r.eventFlag && <Chip tone="amber" className="ml-1.5" title={`entered within 30 min of ${r.eventFlag}`}>print</Chip>}</Td>
      <Td strong>{r.symbol} <span className={`font-medium ${r.side === "long" ? "text-up" : "text-down"}`}>{r.side}</span>{r.open && <Chip tone="blue" className="ml-1.5">open</Chip>}</Td>
      <Td num>{r.qty}</Td>
      <Td num>{px(r.symbol, r.entryPx)} → {px(r.symbol, r.exitPx)}{r.stopPx != null && <span className="ml-1 text-[11px] text-muted-foreground" title="stop the room saw on the position">stop {px(r.symbol, r.stopPx)}</span>}</Td>
      <Td num className={tone(r.netUsd)}>{pnl0(r.netUsd)}</Td>
      <Td num className={tone(r.netR)} title={r.riskSource === "stop" ? `R = $${Math.round(r.riskUsd ?? 0)} at your stop` : r.riskSource === "atr-proxy" ? `R = $${Math.round(r.riskUsd ?? 0)} proxy (2× 5m ATR)` : "no R"}>{r1(r.netR)}{r.riskSource === "atr-proxy" && <span className="text-muted-foreground">*</span>}</Td>
      <Td num muted>{r.mfeR == null ? "—" : `+${r.mfeR.toFixed(1)}`} / {r.maeR == null ? "—" : `−${r.maeR.toFixed(1)}`}</Td>
      <Td num muted>{hold(r.holdMin)}</Td>
      <Td muted>{r.session}</Td>
      <Td muted title={r.distAtr != null ? `${r.distAtr >= 0 ? "+" : ""}${r.distAtr.toFixed(2)} ATR from ${r.nearestLevel}` : ""}>{r.nearestLevel ?? "—"}</Td>
      <Td>
        <div className="flex items-center gap-1">
          <input value={tag} onChange={(e) => setTag(e.target.value)} placeholder="tag" className="h-6 w-20 rounded border border-border bg-background px-1.5 text-xs" />
          <input value={why} onChange={(e) => setWhy(e.target.value)} placeholder="why, one line" className="h-6 w-44 rounded border border-border bg-background px-1.5 text-xs" />
          {dirty && <button onClick={save} disabled={busy} className="h-6 rounded bg-primary px-2 text-[11px] font-semibold text-primary-foreground disabled:opacity-50">{busy ? "…" : "save"}</button>}
        </div>
      </Td>
    </Row>
  );
}

