"use client";

import { useState } from "react";
import useSWR from "swr";
import { Chip, verdictTone } from "@/components/ui/chip";
import { DataTable, Row, Td, Th } from "@/components/ui/data-table";
import { Empty, Explainer, Note, PageHeader, Panel, PanelBody, PanelHeader, Stat } from "@/components/ui/panel";
import { ago, money, pnl0, tone, when } from "@/lib/format";

// ============ FUTURES DESK — Tradovate DEMO ============
// The futures edge lab. TradingView evaluates each registered rule on real-time CME data and
// fires an alert; the desk sizes it off a fixed $50k basis and places it on the Tradovate demo
// account with the stop attached. ONE job for this page: "what has each rule earned, and is the
// desk healthy?" — the scoreboard per edge, what is open and its stop, the ledger, the alert
// inbox, the enable switch, and the exact TradingView setup. The old engine dashboard was
// retired with the engine (Aug 31 2026); it is in git history at 51baca4.

const fetcher = (u: string) => fetch(u).then((r) => r.json());

interface Card { key: string; name: string; timeframe: string; roots: string[]; evidence: string; resolved: number; open: number; wins: number; net: number; meanR: number | null; tStat: number | null; days: number; verdict: string }
interface Trade { id: number; opened_at: string; edge: string; root: string; contract: string; side: string; qty: number; entry_price: number; stop_price: number; status: string; exit_price: number | null; closed_at: string | null; exit_reason: string | null; pnl_usd: number | null; risk_usd: number; note: string | null }
interface Signal { id: number; received_at: string; edge: string; root: string; action: string; side: string; price: number; stop: number | null; status: string; reason: string | null; trade_id: number | null }
interface Status {
  enabled: boolean; disabledReason: string | null; configured: boolean;
  limits: { sizingBasisUsd: number; riskPct: number; maxContracts: number; maxPositions: number; maxEntriesPerDay: number; dailyLossPausePct: number; drawdownDisablePct: number };
  state: { equity?: number; equityHigh?: number; dayStartEquity?: number; dayKey?: string };
  entriesToday: number;
  guardian: { at: string | null; fresh: boolean; lastError: string | null };
  broker: { balance: number; netLiq: number; positions: { contractId: number; netPos: number; netPrice: number }[]; workingOrders: number } | null;
  brokerError: string | null; open: Trade[]; ledger: Trade[]; signals: Signal[]; cards: Card[];
  record: { trades: number; wins: number; pnl: number }; webhookPath: string; error?: string;
}

const btn = "inline-flex h-8 items-center justify-center rounded-md border px-3 text-xs font-semibold transition-colors disabled:cursor-not-allowed disabled:opacity-40";
const btnDanger = `${btn} border-down/50 bg-down/10 text-down hover:bg-down/20`;
const btnGo = `${btn} border-up/50 bg-up/10 text-up hover:bg-up/20`;
const statusTone = (s: string) => (s === "executed" ? "green" : s === "queued" ? "amber" : s === "refused" || s === "error" || s === "expired" ? "red" : "grey");

export default function FuturesDeskPage() {
  const { data, mutate } = useSWR<Status>("/api/futures/desk", fetcher, { refreshInterval: 30_000 });
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  async function post(body: Record<string, unknown>) {
    setBusy(true); setMsg(null);
    try {
      const r = await fetch("/api/futures/desk/enable", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      const j = await r.json();
      setMsg(j.error ?? (j.enabled ? "ENABLED — the next registered alert trades on the demo" : "disabled"));
      setConfirm(""); await mutate();
    } catch (e) { setMsg(String(e)); }
    setBusy(false);
  }

  if (!data) return <div className="p-6 text-[13px] text-muted-foreground">Loading the futures desk…</div>;
  if (data.error) return <div className="p-6 text-[13px] text-down">The desk read failed: {data.error}</div>;
  const L = data.limits, s = data.state;
  const day = data.entriesToday;
  const dayPnl = s.equity != null && s.dayStartEquity != null ? s.equity - s.dayStartEquity : 0;
  const ddFromHigh = s.equity != null && s.equityHigh ? (s.equity / s.equityHigh - 1) * 100 : 0;
  const canEnable = confirm === "ENABLE" && data.configured && data.guardian.fresh && !data.brokerError;
  const origin = typeof window !== "undefined" ? window.location.origin : "";

  return (
    <div className="space-y-4 p-4 md:p-6">
      <PageHeader
        title="Futures Desk"
        sub={<>Tradovate <strong>DEMO</strong> · paper only · sized off a fixed {money(L.sizingBasisUsd)} at {L.riskPct}% a trade · rules evaluated on TradingView, executed here with the stop attached. Nothing on this page can reach a live account.</>}
        right={
          <>
            <Chip tone={data.enabled ? "green" : "grey"} dot={data.enabled} size="md">{data.enabled ? "ENABLED" : "disabled"}</Chip>
            <Chip tone={data.guardian.fresh ? "green" : "red"} size="md" title="The desk guardian runs every 5 minutes. Stale = no entries.">guardian {data.guardian.at ? ago(data.guardian.at) : "never"}</Chip>
          </>
        }
      />

      {!data.configured && <Panel tone="red"><PanelBody><Note>Not configured on this deployment — TRADOVATE_* or TRADINGVIEW_WEBHOOK_SECRET is missing.</Note></PanelBody></Panel>}
      {data.brokerError && <Panel tone="red"><PanelBody><Note><strong className="text-down">Tradovate did not answer</strong> — {data.brokerError}. Positions unknown, not zero.</Note></PanelBody></Panel>}
      {data.guardian.lastError && <Panel tone="amber"><PanelBody><Note>Last guardian error: {data.guardian.lastError}</Note></PanelBody></Panel>}
      {data.disabledReason && <Panel tone="red"><PanelBody><Note><strong className="text-down">Disabled by the guardian:</strong> {data.disabledReason}. Enabling again clears it — a person&apos;s decision, not a retry.</Note></PanelBody></Panel>}

      <Panel>
        <PanelHeader title="Demo account" aside={<span>{data.broker ? `${data.broker.positions.length} broker position(s) · ${data.broker.workingOrders} working order(s)` : "broker not read"}</span>} />
        <PanelBody className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <Stat label="Equity" value={s.equity != null ? money(s.equity) : data.broker ? money(data.broker.netLiq) : "—"} size="lg" sub={<>high {s.equityHigh != null ? money(s.equityHigh) : "—"} · {ddFromHigh.toFixed(1)}% from high · desk disables at −{L.drawdownDisablePct}%</>} />
          <Stat label="Today" value={pnl0(dayPnl)} valueCls={tone(dayPnl)} sub={<>entries {day}/{L.maxEntriesPerDay} · pauses at −{L.dailyLossPausePct}% of basis</>} />
          <Stat label="Sizing" value={`${money(L.sizingBasisUsd * L.riskPct / 100)} / trade`} sub={<>{L.riskPct}% of {money(L.sizingBasisUsd)} · micros only · max {L.maxContracts} contracts · {L.maxPositions} positions</>} />
          <Stat label="Record" value={`${data.record.trades} closed`} sub={<>{data.record.wins} wins · <span className={tone(data.record.pnl)}>{pnl0(data.record.pnl)}</span> after modeled fees</>} />
        </PanelBody>
      </Panel>

      {/* SCOREBOARD — the point of the desk */}
      <Panel>
        <PanelHeader title="Edges — one verdict each" aside={<span>same bar as the crypto and options books: 30 resolved · net positive · t ≥ 2 · 7+ days</span>} />
        <PanelBody className="grid gap-3 lg:grid-cols-2">
          {data.cards.map((c) => (
            <div key={c.key} className="rounded-md border border-border p-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div><span className="text-[13px] font-semibold">{c.name}</span> <span className="text-xs text-muted-foreground">· {c.timeframe} · {c.roots.join(" ")}</span></div>
                <Chip tone={verdictTone(c.verdict)}>{c.verdict}</Chip>
              </div>
              <div className="mt-2 grid grid-cols-2 gap-2 sm:grid-cols-4">
                <Stat label="Resolved" value={String(c.resolved)} sub={<>{c.open} open</>} />
                <Stat label="Net" value={pnl0(c.net)} valueCls={tone(c.net)} sub={<>{c.wins} wins</>} />
                <Stat label="Mean R" value={c.meanR != null ? c.meanR.toFixed(2) : "—"} />
                <Stat label="t-stat" value={c.tStat != null ? c.tStat.toFixed(2) : "—"} sub={<>{c.days} days</>} />
              </div>
              <p className="mt-2 text-xs text-muted-foreground">{c.evidence}</p>
            </div>
          ))}
        </PanelBody>
      </Panel>

      <div className="grid gap-4 lg:grid-cols-2">
        <Panel>
          <PanelHeader title="Enable switch" />
          <PanelBody className="space-y-2.5">
            {data.enabled ? (
              <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:gap-3">
                <button disabled={busy} onClick={() => post({ action: "disable" })} className={`${btnDanger} w-full sm:w-auto`}>{busy ? "…" : "Disable — stop new entries"}</button>
                <Note>Open positions stay under the guardian. Exit alerts and stops still act.</Note>
              </div>
            ) : (
              <div className="space-y-2">
                <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
                  <input value={confirm} onChange={(e) => setConfirm(e.target.value)} placeholder="type ENABLE" aria-label="Type ENABLE" className="h-8 w-full rounded-md border border-input bg-background px-2.5 text-[13px] sm:w-32" />
                  <button disabled={busy || !canEnable} onClick={() => post({ action: "enable", confirm })} className={`${btnGo} w-full sm:w-auto`}>{busy ? "…" : "Enable the demo desk"}</button>
                </div>
                <Note>Needs: broker answering and the guardian run in the last 15 minutes. Demo money only — the ceremony is so the record never starts by accident.</Note>
              </div>
            )}
            {msg && <Note>{msg}</Note>}
          </PanelBody>
        </Panel>

        <Panel>
          <PanelHeader title="Open positions" aside={<span>{data.open.length} of {L.maxPositions}</span>} />
          {data.open.length === 0 ? <PanelBody><Empty>Flat. The next registered alert opens here.</Empty></PanelBody> : (
            <DataTable dense>
              <thead><tr><Th>Contract</Th><Th>Edge</Th><Th num>Qty</Th><Th num>Entry</Th><Th num>Stop</Th><Th num>Risk</Th><Th>Opened</Th></tr></thead>
              <tbody>{data.open.map((t) => (
                <Row key={t.id}><Td strong>{t.side === "long" ? "▲" : "▼"} {t.contract}</Td><Td muted>{t.edge}</Td><Td num>{t.qty}</Td><Td num>{t.entry_price}</Td><Td num>{t.stop_price}</Td><Td num>{money(t.risk_usd)}</Td><Td muted>{ago(t.opened_at)}</Td></Row>
              ))}</tbody>
            </DataTable>
          )}
        </Panel>
      </div>

      <Panel>
        <PanelHeader title="Ledger" aside={<>{data.record.trades} closed · {data.record.wins} wins · <span className={tone(data.record.pnl)}>{pnl0(data.record.pnl)}</span></>} />
        {data.ledger.length === 0 ? <PanelBody><Empty>No desk trades yet.</Empty></PanelBody> : (
          <DataTable dense maxH="24rem">
            <thead><tr><Th>Opened</Th><Th>Contract</Th><Th>Edge</Th><Th num>Qty</Th><Th num>Entry</Th><Th num>Exit</Th><Th>Reason</Th><Th num>P&amp;L</Th><Th num>R</Th></tr></thead>
            <tbody>{data.ledger.map((t) => (
              <Row key={t.id}>
                <Td muted>{when(t.opened_at)}</Td><Td strong>{t.side === "long" ? "▲" : "▼"} {t.contract}</Td><Td muted>{t.edge}</Td><Td num>{t.qty}</Td><Td num>{t.entry_price}</Td>
                <Td num>{t.exit_price ?? "—"}</Td><Td muted>{t.status === "open" ? "open" : t.exit_reason ?? t.status}</Td>
                <Td num className={tone(t.pnl_usd ?? 0)}>{t.pnl_usd != null ? pnl0(t.pnl_usd) : "—"}</Td><Td num>{t.pnl_usd != null && t.risk_usd > 0 ? (t.pnl_usd / t.risk_usd).toFixed(2) : "—"}</Td>
              </Row>
            ))}</tbody>
          </DataTable>
        )}
      </Panel>

      <Panel>
        <PanelHeader title="Alert inbox" aside={<span>every alert TradingView sent, and what the desk did with it</span>} />
        {data.signals.length === 0 ? <PanelBody><Empty>No alerts received yet. Set up the TradingView alerts below.</Empty></PanelBody> : (
          <DataTable dense maxH="20rem">
            <thead><tr><Th>Received</Th><Th>Edge</Th><Th>Market</Th><Th>Action</Th><Th num>Price</Th><Th num>Stop</Th><Th>Status</Th><Th>Why</Th></tr></thead>
            <tbody>{data.signals.map((g) => (
              <Row key={g.id}><Td muted>{when(g.received_at)}</Td><Td>{g.edge}</Td><Td strong>{g.root}</Td><Td>{g.action} {g.side}</Td><Td num>{g.price}</Td><Td num>{g.stop ?? "—"}</Td><Td><Chip tone={statusTone(g.status)}>{g.status}</Chip></Td><Td muted>{g.reason ?? ""}</Td></Row>
            ))}</tbody>
          </DataTable>
        )}
      </Panel>

      <Explainer title="TradingView setup — the exact alerts, and what the desk does with them">
        <ul>
          <li><strong>Webhook URL:</strong> <code>{origin}{data.webhookPath}</code>. TradingView Essential or higher (webhooks need a paid plan) plus the CME real-time data add-on, so the rule sees the same prices the broker fills at.</li>
          <li><strong>One chart per market, the Pine script from <code>pine/</code> in the repo</strong>, one alert per chart set to &quot;Any alert() function call&quot;, message left as the script writes it. Index daily MR: ES1!, NQ1!, YM1! on 1D. Donchian: ES1!, NQ1!, YM1!, GC1!, SI1!, HG1! on 60. The secret goes into each script&apos;s input once.</li>
          <li><strong>What arrives:</strong> edge, market root, entry/exit, side, price, stop, the bar time. Only registered edges trade; an unknown edge or a missing stop is refused and shown in the inbox above.</li>
          <li><strong>What the desk does:</strong> sizes contracts = floor({L.riskPct}% × {money(L.sizingBasisUsd)} ÷ risk per micro), refuses below one contract, places a market entry with the stop in the same request (never naked), then the guardian: keeps a stop working, enforces the rule&apos;s time stop, rolls the month before expiry, settles closes from the broker&apos;s fills, and sends alerts that landed in the 17:00–18:00 ET break at the reopen.</li>
          <li><strong>The $50k:</strong> sizing is a % of a fixed basis, not of the demo&apos;s balance, so the record is comparable day to day. Reset the demo to $50,000 in the Tradovate app whenever you want the equity curve to match.</li>
          <li><strong>What decides:</strong> the same gate as every other desk — 30 resolved per edge, net positive after modeled fees, t ≥ 2, over 7+ days. Until then the verdict says TOO EARLY, and that is the honest state.</li>
        </ul>
      </Explainer>
    </div>
  );
}
