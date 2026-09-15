"use client";

import { useState } from "react";
import useSWR from "swr";
import { Chip } from "@/components/ui/chip";
import { DataTable, Row, Th, Td } from "@/components/ui/data-table";
import { Empty, Note, Panel, PanelBody, PanelHeader, Stat } from "@/components/ui/panel";
import { ago, money } from "@/lib/format";
import type { OptionsScoreReport } from "@/lib/options-score-report";

// DOES THE 0–100 SCORE RANK? (D7) — the paper ranker's measurement. Every researched structure is scored and settled forward
// on later broker bars as a settlement proxy; the score earns a say in sizing (the A+ rung) only when the ≥80 bucket beats
// the <70 bucket at t ≥ 2 with thirty rows each. Until then it is a number on the card and nothing more.
const fetcher = (u: string) => fetch(u).then((r) => r.json());
const btn = "inline-flex h-8 items-center justify-center rounded-md border px-3 text-xs font-semibold transition-colors disabled:cursor-not-allowed disabled:opacity-40";

export function OptionsScorePanel() {
  const { data, mutate } = useSWR<OptionsScoreReport>("/api/options/score", fetcher, { refreshInterval: 120_000 });
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const promote = async () => {
    setBusy(true); setMsg(null);
    try { const r = await fetch("/api/options/live-desk", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "promote-score", confirm }) }); const j = await r.json(); setMsg(j.ok ? "Promoted." : j.error ?? "Failed."); await mutate(); }
    catch (e) { setMsg(String(e)); } finally { setBusy(false); setConfirm(""); }
  };
  if (!data) return <Panel><PanelHeader title="Does the 0–100 score rank?" /><PanelBody><Empty>Loading…</Empty></PanelBody></Panel>;
  return (
    <Panel>
      <PanelHeader title="Does the 0–100 score rank?" aside={<Chip tone={data.promoted ? "green" : data.verdict.green ? "amber" : "grey"}>{data.promoted ? "Promoted · live input" : data.verdict.green ? "Promotable — not yet promoted" : "Paper ranker · not promoted"}</Chip>} />
      <PanelBody className="space-y-3">
        <div className="grid gap-3 sm:grid-cols-4">
          <Stat label="Scored structures" value={String(data.scored)} sub={`${data.runs} research runs since ${data.registeredAt} · ${data.version}`} />
          <Stat label="Resolved / pending" value={`${data.resolved} / ${data.pending}`} sub={`${data.bySource.breakouts} breakouts · ${data.bySource.watch} trend-watch (built, refused: no breakout)`} />
          <Stat label="Welch t (≥80 vs <70)" value={data.verdict.welchT == null ? "—" : data.verdict.welchT.toFixed(2)} sub={`needs ≥ 2 with ${30} resolved per bucket`} />
          <Stat label="Verdict" value={data.verdict.green ? "GREEN" : "not yet"} sub={data.verdict.reasons[0] ?? "every gate passed"} />
        </div>
        <DataTable><thead><tr><Th>Bucket</Th><Th num>n</Th><Th num>Mean</Th><Th num>Net</Th><Th num>Hit</Th><Th num>t</Th></tr></thead><tbody>
          {data.buckets.map((b) => <Row key={b.name}><Td>{b.name}</Td><Td num>{b.n}</Td><Td num>{b.mean == null ? "—" : money(b.mean)}</Td><Td num>{money(b.net)}</Td><Td num>{b.hit == null ? "—" : `${Math.round(b.hit * 100)}%`}</Td><Td num>{b.t == null ? "—" : b.t.toFixed(2)}</Td></Row>)}
        </tbody></DataTable>
        <Note>
          Settlement proxy: each scored structure is settled at min(expiry − 7 days, 10 sessions after the signal) as intrinsic value minus the debit and the fee reserve — no fills, no slippage, no stop, no trail. It ranks the score; it does not estimate the desk&apos;s P&amp;L. Rule (pre-registered {data.registeredAt}): {data.verdict.rule}. Three buckets are compared, so a single t ≥ 2 is weaker than it looks; the verdict also needs the top mean above the bottom. Promotion unlocks the A+ rung (score ≥ 80, $225 / 15%) on the next ARM; the score is never itself an entry gate.
        </Note>
        {data.verdict.reasons.length > 0 && <Note>Not promotable: {data.verdict.reasons.join(" · ")}</Note>}
        {!data.promoted && (
          <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
            <input value={confirm} onChange={(e) => setConfirm(e.target.value)} placeholder="type PROMOTE" aria-label="Type PROMOTE" className="h-8 w-full rounded-md border border-input bg-background px-2.5 text-[13px] sm:w-36" />
            <button disabled={busy || confirm !== "PROMOTE" || !data.verdict.green} onClick={promote} className={`${btn} border-up/50 bg-up/10 text-up hover:bg-up/20`}>{busy ? "…" : "Promote the score — A+ unlocks on the next ARM"}</button>
            {msg && <span className="text-xs text-muted-foreground">{msg}</span>}
          </div>
        )}
        {data.latestScored.length > 0 && (
          <details><summary className="cursor-pointer text-xs text-muted-foreground">Latest run&apos;s top scores ({data.latestScoredAt ? ago(data.latestScoredAt) : "—"})</summary>
            <ul className="mt-2 space-y-1 text-xs">{data.latestScored.map((c) => <li key={c.key}>{c.score} · {c.symbol} {c.kind.replaceAll("_", " ")} {c.strikes.join("/")} {c.expiry}{c.refusedBy ? ` · ${c.refusedBy}` : ""}{c.missing.length ? ` · missing: ${c.missing.join(", ")}` : ""}</li>)}</ul></details>
        )}
        {data.recentResolved.length > 0 && (
          <details><summary className="cursor-pointer text-xs text-muted-foreground">Recently settled ({data.recentResolved.length})</summary>
            <ul className="mt-2 space-y-1 text-xs">{data.recentResolved.map((r) => <li key={`${r.key}:${r.signalDay}`}>{r.score} ({r.bucket}) · {r.symbol} {r.kind.replaceAll("_", " ")} {r.strikes.join("/")} · signal {r.signalDay} → settled {r.settledOn} at {r.settleClose}: {money(r.pnlUsd)}</li>)}</ul></details>
        )}
        {data.cards.length > 0 && (
          <details><summary className="cursor-pointer text-xs text-muted-foreground">Trade cards (last {data.cards.length}: research top-5 per run, live entries and refusals)</summary>
            <pre className="mt-2 max-h-80 overflow-auto whitespace-pre-wrap text-[11px] text-muted-foreground">{data.cards.map((c) => `${c.at.slice(0, 16).replace("T", " ")}Z [${c.source}] ${c.card.text}`).join("\n\n")}</pre></details>
        )}
      </PanelBody>
    </Panel>
  );
}
