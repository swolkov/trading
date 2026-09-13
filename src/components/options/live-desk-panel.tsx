"use client";

import { useState } from "react";
import useSWR from "swr";
import { Chip } from "@/components/ui/chip";
import { Empty, Note, Panel, PanelBody, PanelHeader, Stat } from "@/components/ui/panel";
import { ago, money, when } from "@/lib/format";

// THE OPTIONS LIVE DESK — real money, one contract at a time, inside the approved $100 cap. This
// panel is the switch and the receipt: what the desk on the Mac last did, whether the broker
// adapter has been verified on a real review, the guardian's heartbeat, and every intent it has
// reserved. The desk runs on the Mac (the broker credential lives there); this page only flips
// the switch it reads on every tick.

const fetcher = (u: string) => fetch(u).then((r) => r.json());
interface Intent { refId: string; action: string; state: string; orderId: string | null; updatedAt: string }
interface Owned { id: string; kind: string; underlying: string; expiry: string; entryPrice: number; width: number }
interface Data {
  armed: boolean; verified: boolean; maxLossUsd: number | null; feeReserveUsd: number | null;
  guardian: { at: string | null; fresh: boolean };
  rules: { premiumStopFrac: number; premiumTargetMult: number; exitBeforeDte: number; drawdownHaltUsd: number; maxEntriesPerDay: number; entryKinds: string[] };
  state: { at?: string; mode?: string; lastError?: string; candidate?: string; buyingPower?: number; totalValue?: number; equityHigh?: number; guardianOk?: boolean } | null;
  probe: { at: string; ok: boolean; reason?: string; candidate?: string; fee?: number; buyingPower?: number } | null;
  log: string[]; armLog: string[]; intents: Intent[]; owned: Owned[];
}
const btn = "inline-flex h-8 items-center justify-center rounded-md border px-3 text-xs font-semibold transition-colors disabled:cursor-not-allowed disabled:opacity-40";
const intentTone = (s: string) => (s === "settled" ? "grey" : s === "accepted" ? "green" : s === "unknown" ? "red" : "amber");

export function OptionsLiveDeskPanel() {
  const { data, mutate } = useSWR<Data>("/api/options/live-desk", fetcher, { refreshInterval: 30_000 });
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const post = async (body: Record<string, unknown>) => {
    setBusy(true); setMsg(null);
    try { const r = await fetch("/api/options/live-desk", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }); const j = await r.json(); setMsg(j.ok ? "Done." : j.error ?? "Failed."); await mutate(); }
    catch (e) { setMsg(String(e)); } finally { setBusy(false); setConfirm(""); }
  };
  if (!data) return <Panel><PanelHeader title="Live desk" /><PanelBody><Empty>Loading…</Empty></PanelBody></Panel>;
  const canTrade = data.armed && data.verified;
  return (
    <>
      <Panel>
        <PanelHeader title="Live desk — real money, one contract, inside the approved cap"
          aside={<Chip tone={canTrade ? "red" : data.armed ? "amber" : "grey"} dot={canTrade}>{canTrade ? "Armed · verified" : data.armed ? "Armed · adapter not yet verified" : "Disarmed"}</Chip>} />
        <PanelBody className="space-y-3">
          <div className="grid gap-3 sm:grid-cols-4">
            <Stat label="Max loss per trade" value={data.maxLossUsd != null ? money(data.maxLossUsd) : "Not set"} sub={`incl. fees · reserve ${data.feeReserveUsd != null ? money(data.feeReserveUsd) : "unset"}`} />
            <Stat label="Guardian" value={data.guardian.fresh ? "Reporting" : "Not reporting"} sub={data.guardian.at ? `last clean run ${ago(data.guardian.at)}` : "has not run"} />
            <Stat label="Broker adapter" value={data.verified ? "Verified" : "Unverified"} sub={data.probe ? `probe ${ago(data.probe.at)}: ${data.probe.ok ? "ok" : data.probe.reason ?? "failed"}` : "no probe yet"} />
            <Stat label="Account high-water" value={data.state?.totalValue != null ? money(data.state.totalValue) : "—"} sub={data.state?.equityHigh != null ? `high ${money(data.state.equityHigh)} · halt at −${money(data.rules.drawdownHaltUsd)}` : ""} />
          </div>
          <Note>
            Rules in force: debit structures only (long call, long put, call or put debit spread), so the most a trade can lose is what it paid plus fees.
            One contract, one position at a time, {data.rules.maxEntriesPerDay} entry a day. The guardian runs every 5 minutes in the session: it sells at half the premium, takes profit at {data.rules.premiumTargetMult}× the premium, and gets out {data.rules.exitBeforeDte} days before expiry.
            Entries come from the research screen&apos;s 20-session breakout rule on real Robinhood quotes fetched at the moment of the order. Before the first order the desk sends a broker review only and must decode fees and buying power from the real response; that is the adapter verification above.
          </Note>
          <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
            {data.armed ? (
              <button disabled={busy} onClick={() => post({ action: "disarm" })} className={`${btn} border-down/50 bg-down/10 text-down hover:bg-down/20`}>{busy ? "…" : "Disarm — stop new entries"}</button>
            ) : (
              <>
                <input value={confirm} onChange={(e) => setConfirm(e.target.value)} placeholder="type ARM" aria-label="Type ARM" className="h-8 w-full rounded-md border border-input bg-background px-2.5 text-[13px] sm:w-32" />
                <button disabled={busy || confirm !== "ARM"} onClick={() => post({ action: "arm", confirm })} className={`${btn} border-down/50 bg-down/10 text-down hover:bg-down/20`}>{busy ? "…" : "Arm the live desk — real money"}</button>
              </>
            )}
            <span className="text-xs text-muted-foreground">{data.state?.at ? `Desk last ran ${ago(data.state.at)} (${data.state.mode})${data.state.candidate ? ` · ${data.state.candidate}` : ""}${data.state.lastError ? ` · ⚠️ ${data.state.lastError}` : ""}` : "The desk has not run yet."}</span>
          </div>
          {msg && <Note>{msg}</Note>}
          {data.armLog.length > 0 && <Note>Last · {data.armLog[data.armLog.length - 1]}</Note>}
        </PanelBody>
      </Panel>

      <Panel>
        <PanelHeader title="Desk positions and intents" aside={<span>{data.owned.length} owned · {data.intents.filter((i) => i.state !== "settled").length} unsettled intent(s)</span>} />
        <PanelBody className="space-y-3">
          {data.owned.length === 0 ? <Empty>The desk owns no position.</Empty> : (
            <ul className="text-[13px]">{data.owned.map((o) => <li key={o.id}>{o.kind} {o.underlying} {o.expiry} · entry {o.entryPrice.toFixed(2)}{o.width ? ` · ${o.width}-wide` : ""}</li>)}</ul>
          )}
          {data.intents.length > 0 && (
            <ul className="space-y-1 text-xs">{data.intents.map((i) => (
              <li key={i.refId} className="flex items-center gap-2"><Chip tone={intentTone(i.state)}>{i.state}</Chip><span>{i.action}</span><span className="text-muted-foreground">{i.orderId ? `order ${i.orderId}` : "no broker order id"}</span><span className="text-muted-foreground" title={when(i.updatedAt)}>{ago(i.updatedAt)}</span></li>
            ))}</ul>
          )}
          {data.log.length > 0 && (
            <details><summary className="cursor-pointer text-xs text-muted-foreground">Desk log (last {data.log.length} lines)</summary>
              <pre className="mt-2 max-h-64 overflow-auto whitespace-pre-wrap text-[11px] text-muted-foreground">{data.log.join("\n")}</pre></details>
          )}
        </PanelBody>
      </Panel>
    </>
  );
}
