"use client";

import { Chip } from "@/components/ui/chip";
import { DataTable, Row, Td, Th } from "@/components/ui/data-table";
import { Empty, Panel, PanelBody, PanelHeader } from "@/components/ui/panel";
import { ago, money, pnl0, tone, when } from "@/lib/format";

// The futures DEMO desk's three trade tables — open positions, ledger, alert inbox — shared by
// the Futures Desk page and the Orders page (which shows every platform side by side), so the
// two can never disagree about a row. Data comes from GET /api/futures/desk in both places.

export interface FuturesTrade {
  id: number; opened_at: string; edge: string; root: string; contract: string; side: string; qty: number;
  entry_price: number; stop_price: number; status: string; exit_price: number | null; closed_at: string | null;
  exit_reason: string | null; pnl_usd: number | null; risk_usd: number; note: string | null;
}
export interface FuturesSignal {
  id: number; received_at: string; edge: string; root: string; action: string; side: string; price: number;
  stop: number | null; status: string; reason: string | null; trade_id: number | null;
}
export const signalTone = (s: string) => (s === "executed" ? "green" : s === "queued" ? "amber" : s === "refused" || s === "error" || s === "expired" ? "red" : "grey");

export function FuturesOpenTable({ open, maxPositions }: { open: FuturesTrade[]; maxPositions: number }) {
  return (
    <Panel>
      <PanelHeader title="Open positions" aside={<span>{open.length} of {maxPositions}</span>} />
      {open.length === 0 ? <PanelBody><Empty>Flat. The next registered alert opens here.</Empty></PanelBody> : (
        <DataTable dense>
          <thead><tr><Th>Contract</Th><Th>Edge</Th><Th num>Qty</Th><Th num>Entry</Th><Th num>Stop</Th><Th num>Risk</Th><Th>Opened</Th></tr></thead>
          <tbody>{open.map((t) => (
            <Row key={t.id}><Td strong>{t.side === "long" ? "▲" : "▼"} {t.contract}</Td><Td muted>{t.edge}</Td><Td num>{t.qty}</Td><Td num>{t.entry_price}</Td><Td num>{t.stop_price}</Td><Td num>{money(t.risk_usd)}</Td><Td muted>{ago(t.opened_at)}</Td></Row>
          ))}</tbody>
        </DataTable>
      )}
    </Panel>
  );
}

export function FuturesLedgerTable({ ledger, record }: { ledger: FuturesTrade[]; record: { trades: number; wins: number; pnl: number } }) {
  return (
    <Panel>
      <PanelHeader title="Ledger" aside={<>{record.trades} closed · {record.wins} wins · <span className={tone(record.pnl)}>{pnl0(record.pnl)}</span></>} />
      {ledger.length === 0 ? <PanelBody><Empty>No desk trades yet.</Empty></PanelBody> : (
        <DataTable dense maxH="24rem">
          <thead><tr><Th>Opened</Th><Th>Contract</Th><Th>Edge</Th><Th num>Qty</Th><Th num>Entry</Th><Th num>Exit</Th><Th>Reason</Th><Th num>P&amp;L</Th><Th num>R</Th></tr></thead>
          <tbody>{ledger.map((t) => (
            <Row key={t.id}>
              <Td muted>{when(t.opened_at)}</Td><Td strong>{t.side === "long" ? "▲" : "▼"} {t.contract}</Td><Td muted>{t.edge}</Td><Td num>{t.qty}</Td><Td num>{t.entry_price}</Td>
              <Td num>{t.exit_price ?? "—"}</Td><Td muted>{t.status === "open" ? "open" : t.exit_reason ?? t.status}</Td>
              <Td num className={tone(t.pnl_usd ?? 0)}>{t.pnl_usd != null ? pnl0(t.pnl_usd) : "—"}</Td><Td num>{t.pnl_usd != null && t.risk_usd > 0 ? (t.pnl_usd / t.risk_usd).toFixed(2) : "—"}</Td>
            </Row>
          ))}</tbody>
        </DataTable>
      )}
    </Panel>
  );
}

export function FuturesAlertInbox({ signals, emptyHint }: { signals: FuturesSignal[]; emptyHint: string }) {
  return (
    <Panel>
      <PanelHeader title="Alert inbox" aside={<span>every alert TradingView sent, and what the desk did with it</span>} />
      {signals.length === 0 ? <PanelBody><Empty>{emptyHint}</Empty></PanelBody> : (
        <DataTable dense maxH="20rem">
          <thead><tr><Th>Received</Th><Th>Edge</Th><Th>Market</Th><Th>Action</Th><Th num>Price</Th><Th num>Stop</Th><Th>Status</Th><Th>Why</Th></tr></thead>
          <tbody>{signals.map((g) => (
            <Row key={g.id}><Td muted>{when(g.received_at)}</Td><Td>{g.edge}</Td><Td strong>{g.root}</Td><Td>{g.action} {g.side}</Td><Td num>{g.price}</Td><Td num>{g.stop ?? "—"}</Td><Td><Chip tone={signalTone(g.status)}>{g.status}</Chip></Td><Td muted>{g.reason ?? ""}</Td></Row>
          ))}</tbody>
        </DataTable>
      )}
    </Panel>
  );
}
