"use client";

import { useState } from "react";
import useSWR from "swr";
import { DataTable, Row, Td, Th } from "@/components/ui/data-table";
import { Chip } from "@/components/ui/chip";
import { Empty, Note, Panel, PanelBody, PanelHeader, Stat } from "@/components/ui/panel";
import { ago, money, when } from "@/lib/format";

// THE OPTIONS LIVE DESK — real money, sized by the ladder under the armed ceiling (rungs are read
// live from options-risk-ladder.ts, × the drawdown tier; A+ stays locked until the score is promoted). This panel is the switch and the receipt: what the desk last did, whether the broker
// adapter has been verified on a real review, the guardian's heartbeat, and every intent it has
// reserved. The desk runs on Railway (the broker credential lives there); this page only flips
// the switch it reads on every tick.

const fetcher = (u: string) => fetch(u).then((r) => r.json());
interface Intent { refId: string; action: string; state: string; orderId: string | null; updatedAt: string }
interface Owned { id: string; kind: string; underlying: string; expiry: string; entryPrice: number; width: number; cluster?: string | null; legs?: { quantity: number }[]; openedAtMs?: number; peakNet?: number; invalidationPx?: number | null; invalidationTicks?: number }
interface Ladder { rungs: Record<string, { usd: number; pct: number }>; promoted: boolean; ceilingOnArm: number; reserveMaxFrac: number; defaultSlots: number; maxSlots: number; ddHaltFloorUsd: number; ddHaltPct: number; ddTierPcts: number[]; ddTierMults: number[]; slotUnlockClosedTrades: number }
interface DdTier { tier: number; mult: number; label: string; ddPct: number; ddUsd?: number; haltAtUsd?: number; at?: string }
interface IndexView { day: string | null; close: number | null; sma20: number | null; dayPct: number | null; regime: "above" | "below" | "unknown" }
interface MarketView { spy: IndexView; qqq: IndexView; vix: number | null; veto: "on" | "off"; spyIntradayPct: number | "unknown" | "stale"; at: string }
const pct = (x: number | null | "unknown" | "stale" | undefined) => (typeof x === "number" ? `${x >= 0 ? "+" : ""}${x}%` : x === "stale" ? "stale" : "unknown");
const marketLine = (m: MarketView) => `SPY ${m.spy.regime} 20d ${pct(m.spy.dayPct)} · QQQ ${m.qqq.regime} 20d ${pct(m.qqq.dayPct)} · VIX ${m.vix ?? "unknown"} · SPY intraday ${pct(m.spyIntradayPct)} · veto ${m.veto}`;
interface Data {
  at?: string;
  armed: boolean; verified: boolean; maxLossUsd: number | null; feeReserveUsd: number | null;
  ladder: Ladder; ddTier: DdTier | null;
  guardian: { at: string | null; fresh: boolean };
  rules: { premiumStopFrac: number; trailArmMult: number; trailLockFrac: number; exitBeforeDte: number; drawdownHaltUsd: number; maxEntriesPerDay: number; entryKinds: string[] };
  state: { at?: string; mode?: string; lastError?: string; candidate?: string; buyingPower?: number; totalValue?: number; equityHigh?: number; guardianOk?: boolean; market?: MarketView; slots?: number; grade?: string | null; cap?: number; ledger?: { closedTrades: number; divergenceGreen: boolean; reasons: string[] } } | null;
  probe: { at: string; ok: boolean; reason?: string; candidate?: string; fee?: number; buyingPower?: number } | null;
  research: { capturedAt: string; symbols: number; contracts: number; unmatchedQuotes: number; errors: number } | null;
  log: string[]; armLog: string[]; intents: Intent[]; owned: Owned[];
}
const researchLine = (r: Data["research"]) => (r ? `${r.contracts} contracts on ${r.symbols} names, last run ${ago(r.capturedAt)} · ${r.unmatchedQuotes} unmatched quote${r.unmatchedQuotes === 1 ? "" : "s"} · ${r.errors} error line${r.errors === 1 ? "" : "s"}` : "no broker research on file");
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
  const nowMs = Date.parse(data.at ?? "") || 0;   // the server's clock at read time, so render stays pure
  const canTrade = data.armed && data.verified;
  return (
    <>
      <Panel>
        <PanelHeader title="Live desk — real money, every name that clears the screen, inside the approved cap"
          aside={<Chip tone={canTrade ? "red" : data.armed ? "amber" : "grey"} dot={canTrade}>{canTrade ? "Armed · verified" : data.armed ? "Armed · adapter not yet verified" : "Disarmed"}</Chip>} />
        <PanelBody className="space-y-3">
          <div className="grid gap-3 sm:grid-cols-4">
            <Stat label="Ceiling per trade" value={data.maxLossUsd != null ? money(data.maxLossUsd) : "Not set"} sub={`by grade: Normal ${money(data.ladder.rungs.Normal.usd)} · Strong ${money(data.ladder.rungs.Strong.usd)} · A+ ${data.ladder.promoted ? money(data.ladder.rungs["A+"].usd) : "locked"} · fee reserve ${data.feeReserveUsd != null ? money(data.feeReserveUsd) : "unset"}/contract`} />
            <Stat label="Guardian" value={data.guardian.fresh ? "Reporting" : "Not reporting"} sub={data.guardian.at ? `last clean run ${ago(data.guardian.at)}` : "has not run"} />
            <Stat label="Broker adapter" value={data.verified ? "Verified" : "Unverified"} sub={data.probe ? `probe ${ago(data.probe.at)}: ${data.probe.ok ? "ok" : data.probe.reason ?? "failed"}` : "no probe yet"} />
            <Stat label="Account high-water" value={data.state?.totalValue != null ? money(data.state.totalValue) : "—"} sub={data.state?.equityHigh != null ? `high ${money(data.state.equityHigh)} · halt at the larger of −${money(data.rules.drawdownHaltUsd)} and −20%` : ""} />
          </div>
          <div className="grid gap-3 sm:grid-cols-4">
            <Stat label="Most at risk at once" value={data.state?.totalValue != null ? money(Math.min(data.ladder.reserveMaxFrac * data.state.totalValue, (data.maxLossUsd ?? data.ladder.ceilingOnArm) * (data.state?.slots ?? data.ladder.defaultSlots))) : "—"}
              sub={data.state?.totalValue != null
                ? `${data.state?.slots ?? data.ladder.defaultSlots} × ${money(data.maxLossUsd ?? data.ladder.ceilingOnArm)} ceiling, capped by the ${Math.round(data.ladder.reserveMaxFrac * 100)}% reserve — ${Math.round(Math.min(data.ladder.reserveMaxFrac, (data.maxLossUsd ?? data.ladder.ceilingOnArm) * (data.state?.slots ?? data.ladder.defaultSlots) / data.state.totalValue) * 100)}% of the account. Desk halts at −${money(Math.max(data.ladder.ddHaltFloorUsd, data.ladder.ddHaltPct * (data.state?.equityHigh ?? data.state.totalValue)))}.`
                : "no account value on file yet"} />
            <Stat label="Drawdown tier" value={data.ddTier ? `Tier ${data.ddTier.tier} · ×${data.ddTier.mult}` : "—"} sub={data.ddTier ? `${data.ddTier.label} (${data.ddTier.ddPct}% under the high)` : "no guard tick with an account value yet"} />
            <Stat label="Slots" value={data.state?.slots != null ? `${data.owned.length} of ${data.state.slots}` : `${data.owned.length} of 3`} sub={data.state?.ledger ? `${data.state.ledger.closedTrades} closed live trades · divergence ${data.state.ledger.divergenceGreen ? "green" : "red"}${data.state.ledger.closedTrades >= data.ladder.slotUnlockClosedTrades && !data.state.ledger.divergenceGreen ? " → throttled to one slot" : ""}` : "three slots by default; a red divergence check after ten closed trades throttles to one"} />
            <Stat label="Last grade" value={data.state?.grade ?? "—"} sub={data.state?.cap != null ? `cap ${money(data.state.cap)} at the last entry tick · reserve ≤ ${Math.round(data.ladder.reserveMaxFrac * 100)}% of equity` : `reserve ≤ ${Math.round(data.ladder.reserveMaxFrac * 100)}% of equity at risk`} />
          </div>
          <Note>
            Rules in force: debit structures only (long call, long put, call or put debit spread), so the most a trade can lose is what it paid plus fees.
            Size by grade under the ceiling — Normal {money(data.ladder.rungs.Normal.usd)} or {(data.ladder.rungs.Normal.pct * 100).toFixed(1)}% of equity, Strong (breakout, market aligned, spread ≤5%, payoff ≥1.5× risk) {money(data.ladder.rungs.Strong.usd)} or {Math.round(data.ladder.rungs.Strong.pct * 100)}%, A+ {money(data.ladder.rungs["A+"].usd)} or {Math.round(data.ladder.rungs["A+"].pct * 100)}% once the score is promoted — scaled ×{data.ladder.ddTierMults.join(" / ×")} at {data.ladder.ddTierPcts.map((p) => `${p}%`).join(" / ")} under the high. Two contracts only on a Strong-or-better structure that fits twice. One cluster per direction (an index ETF beside a semis or megacap name counts as one tech bet); everything at risk stays under {Math.round(data.ladder.reserveMaxFrac * 100)}% of equity.
            Up to {data.ladder.defaultSlots} names at once (options_live_slots, ladder max {data.ladder.maxSlots}), one entry per tick, {data.rules.maxEntriesPerDay} entries a day, never the same name twice in a day; once {data.ladder.slotUnlockClosedTrades} live trades have closed, a red divergence check (unknown intents, fills wide of the limit, fees over the reserve) throttles the desk to one slot. Everything open plus the new trade stays inside {Math.round(data.ladder.reserveMaxFrac * 100)}% of equity, and one direction in one cluster is one bet. Plainly: the dollar rung is a floor (at $900 equity Normal is still $100, 11%); rungs above the armed ceiling are dead until a re-ARM; the halt is the larger of $300 and 20% of the high, so it widens as the account grows; equity for the tier and the reserve is the 17:32 ET account snapshot; the 2-contract review path has not yet been seen against a real broker response. The guardian runs every 5 minutes in the session: it sells at half the premium, has no fixed target — once a position has been worth {data.rules.trailArmMult}× the premium a trail keeps {Math.round(data.rules.trailLockFrac * 100)}% of the best gain seen — closes on a failed breakout (the stock trades back inside the 20-session range it cleared by 0.5%, on two consecutive ticks), banks one contract of a 2-lot at 2× and trails the rest, closes a spread whole at 90% of its width, and gets out {data.rules.exitBeforeDte} days before expiry.
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
          {data.state?.market && <span className="block text-xs text-muted-foreground">Market at the last entry tick: {marketLine(data.state.market)}</span>}
          <span className="block text-xs text-muted-foreground">Research the entry tick screens: {researchLine(data.research)}</span>
          {msg && <Note>{msg}</Note>}
          {data.armLog.length > 0 && <Note>Last · {data.armLog[data.armLog.length - 1]}</Note>}
        </PanelBody>
      </Panel>

      <Panel>
        <PanelHeader title="Desk positions and intents" aside={<span>{data.owned.length} owned · {data.intents.filter((i) => i.state !== "settled").length} unsettled intent(s)</span>} />
        <PanelBody className="space-y-3">
          {data.owned.length === 0 ? <Empty>The desk owns no position.</Empty> : (
            <DataTable dense>
              <thead><tr><Th>Name</Th><Th>Structure</Th><Th num>Qty</Th><Th num>Entry</Th><Th num>Max loss</Th><Th num>Peak</Th><Th num>Stop at</Th><Th num>Invalidates</Th><Th num>DTE</Th><Th>Cluster</Th><Th>Opened</Th></tr></thead>
              <tbody>{data.owned.map((o) => {
                const qty = o.legs?.[0]?.quantity ?? 1;
                const dte = Math.max(0, Math.round((Date.parse(`${o.expiry}T20:00:00Z`) - nowMs) / 86_400_000));
                return (
                  <Row key={o.id}>
                    <Td strong>{o.underlying}</Td>
                    <Td muted>{o.kind.replace(/_/g, " ")}{o.width ? ` · ${o.width}-wide` : ""}</Td>
                    <Td num>{qty}</Td>
                    <Td num>{o.entryPrice.toFixed(2)}</Td>
                    <Td num className="text-down">{money(o.entryPrice * 100 * qty)}</Td>
                    <Td num muted>{o.peakNet != null ? o.peakNet.toFixed(2) : "—"}</Td>
                    <Td num muted title="the guardian sells at half the premium">{(o.entryPrice / 2).toFixed(2)}</Td>
                    <Td num muted title={o.invalidationTicks ? `${o.invalidationTicks} tick(s) beyond the level` : "the underlying back inside the range it broke, two ticks in a row"}>{o.invalidationPx != null ? o.invalidationPx.toFixed(2) : "—"}</Td>
                    <Td num className={dte <= 7 ? "text-warn" : undefined}>{dte}</Td>
                    <Td muted>{o.cluster ?? "—"}</Td>
                    <Td muted>{o.openedAtMs ? ago(new Date(o.openedAtMs).toISOString()) : "—"}</Td>
                  </Row>
                );
              })}</tbody>
            </DataTable>
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
