"use client";

import { Chip, type ChipTone } from "@/components/ui/chip";
import { DataTable, Row, Td, Th } from "@/components/ui/data-table";
import { Empty, Note, Panel, PanelBody, PanelHeader } from "@/components/ui/panel";
import { money, pnl0, tone } from "@/lib/format";

// "Edges — promotion gate" (E6): one verdict per edge — LIVE-CANDIDATE / GATHERING / FAILING — with
// every gate's value against its target, and the stage-readiness line. Read-only: a verdict here is a
// document, never a switch; going live is a separate typed decision on a separate account.

export interface PromotionGate { gate: string; ok: boolean; value: string; target: string; note?: string }
export interface PromotionVerdictView { edge: string; status: "LIVE-CANDIDATE" | "GATHERING" | "FAILING"; strong: boolean; gates: PromotionGate[]; failedGates: string[]; resolved: number; spanDays: number; exception: string | null }
export interface StageReadinessView { stage: string; readiness: { ok: boolean; reasons: string[]; resolved: number; net: number; profitFactor: number | null; maxDrawdownUsd: number } }
export interface LeaderRowView { label: string; metrics: { n: number; net: number; profitFactor: number | null; maxDrawdownPct: number; avgR: number | null; expectancyUsd: number | null; hitRate: number | null; tStat: number | null } }

const statusTone = (s: PromotionVerdictView["status"]): ChipTone => (s === "LIVE-CANDIDATE" ? "green" : s === "FAILING" ? "red" : "amber");
const f2 = (x: number | null | undefined) => (x == null ? "—" : x.toFixed(2));
const pf = (x: number | null, n: number) => (x == null ? (n ? "∞" : "—") : x.toFixed(2));

export function FuturesPromotionPanel({ promotion, stageReadiness, leaderboard, error }: {
  promotion: PromotionVerdictView[] | null; stageReadiness: StageReadinessView | null; leaderboard: { byEdgeRoot: LeaderRowView[] } | null; error: string | null;
}) {
  return (
    <Panel>
      <PanelHeader title="Edges — promotion gate" aside={<span>demo record → live candidate: sample · span · net after slip · PF ≥ 1.4 · DD ≤ 8% · t ≥ 2 · no concentration · 3 regimes · errors ≤ 2% · no anomaly</span>} />
      <PanelBody className="space-y-3">
        {error && <Note><strong className="text-down">Review read failed:</strong> {error}</Note>}
        {stageReadiness && (
          <Note>
            <strong>Stage {stageReadiness.stage} → next:</strong>{" "}
            {stageReadiness.readiness.ok ? <span className="text-up">EARNED — advance from the stage control (type STAGE)</span> : stageReadiness.readiness.reasons.join(" · ")}
            {" "}· {stageReadiness.readiness.resolved} resolved at this stage · net <span className={tone(stageReadiness.readiness.net)}>{pnl0(stageReadiness.readiness.net)}</span> · max DD {money(stageReadiness.readiness.maxDrawdownUsd)}
          </Note>
        )}
        {!promotion?.length ? <Empty>No verdicts yet — the review runs from the guardian.</Empty> : (
          <div className="grid gap-3 lg:grid-cols-2">
            {promotion.map((v) => (
              <div key={v.edge} className="rounded-md border border-border">
                <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border px-3 py-2">
                  <span className="text-[13px] font-semibold">{v.edge}</span>
                  <span className="flex items-center gap-2 text-xs text-muted-foreground">{v.resolved} resolved · {v.spanDays.toFixed(0)} days<Chip tone={statusTone(v.status)}>{v.status}{v.strong ? " · strong" : ""}</Chip></span>
                </div>
                <DataTable dense>
                  <thead><tr><Th>Gate</Th><Th>ok</Th><Th>Value</Th><Th>Target</Th></tr></thead>
                  <tbody>{v.gates.map((g) => (
                    <Row key={g.gate}><Td strong>{g.gate}</Td><Td><Chip tone={g.ok ? "green" : "red"}>{g.ok ? "ok" : "no"}</Chip></Td><Td>{g.value}</Td><Td muted>{g.target}</Td></Row>
                  ))}</tbody>
                </DataTable>
                {v.exception && <p className="px-3 py-2 text-xs text-muted-foreground">{v.exception}</p>}
              </div>
            ))}
          </div>
        )}
        {leaderboard && leaderboard.byEdgeRoot.length > 0 && (
          <DataTable dense>
            <thead><tr><Th>Edge · market</Th><Th num>n</Th><Th num>Net</Th><Th num>PF</Th><Th num>Max DD %</Th><Th num>Avg R</Th><Th num>Exp $</Th><Th num>Hit</Th><Th num>t</Th></tr></thead>
            <tbody>{leaderboard.byEdgeRoot.map((r) => (
              <Row key={r.label}><Td strong>{r.label}</Td><Td num>{r.metrics.n}</Td><Td num className={tone(r.metrics.net)}>{pnl0(r.metrics.net)}</Td><Td num>{pf(r.metrics.profitFactor, r.metrics.n)}</Td><Td num>{r.metrics.maxDrawdownPct.toFixed(1)}</Td><Td num>{f2(r.metrics.avgR)}</Td><Td num>{r.metrics.expectancyUsd == null ? "—" : pnl0(r.metrics.expectancyUsd)}</Td><Td num>{r.metrics.hitRate == null ? "—" : `${(r.metrics.hitRate * 100).toFixed(0)}%`}</Td><Td num>{f2(r.metrics.tStat)}</Td></Row>
            ))}</tbody>
          </DataTable>
        )}
        <Note>The judged series is P&amp;L after modeled fees and slippage; roll chains count once. Regimes are stamped from E7 — until then that gate reads &quot;not yet measurable&quot; and counts as failed, so no edge can read LIVE-CANDIDATE yet. Daily reviews land in the vault at <code>Performance/futures-desk-daily.md</code> after 17:05 ET; the weekly leaderboard in <code>Performance/futures-desk-weekly.md</code> on Monday&apos;s first guardian run.</Note>
      </PanelBody>
    </Panel>
  );
}
