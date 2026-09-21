"use client";

import { useEffect, useRef, useState } from "react";
import { ColorType, LineSeries, LineStyle, createChart, type Time, type UTCTimestamp } from "lightweight-charts";
import { Chip } from "@/components/ui/chip";
import { DataTable, Row, Td, Th } from "@/components/ui/data-table";
import { Empty, Note, Panel, PanelBody, PanelHeader, Stat } from "@/components/ui/panel";
import { hold, pnl0, tone, when } from "@/lib/format";
import type { DayGroup, LibraryRow, LibraryStats, Split } from "@/lib/trading-room-library";

// THE TRADE LIBRARY'S PANELS: the review numbers, the equity curve, and the day-grouped table where each
// trade takes a tag, a why and a grade. Everything here is read from the journal; the only writes are his words.

const px = (sym: string | null, x: number | null) => (x == null ? "—" : sym === "MGC" ? x.toFixed(1) : x.toFixed(2));
const r1 = (x: number | null) => (x == null ? "—" : `${x >= 0 ? "+" : "−"}${Math.abs(x).toFixed(2)}R`);
const pct = (x: number | null) => (x == null ? "—" : `${Math.round(x * 100)}%`);

export function StatsStrip({ s }: { s: LibraryStats }) {
  const pf = s.profitFactor == null ? "—" : Number.isFinite(s.profitFactor) ? s.profitFactor.toFixed(2) : "∞";
  return (
    <Panel>
      <PanelHeader title="The numbers a review is made of" aside={<span>closed trades in the current view · net of fees where fees are known</span>} />
      <PanelBody>
        <div className="grid grid-cols-2 gap-4 md:grid-cols-4 xl:grid-cols-8">
          <Stat label="Trades" value={String(s.n)} sub={`${s.wins}W · ${s.losses}L`} />
          <Stat label="Net" value={pnl0(s.netUsd)} valueCls={tone(s.netUsd)} sub={s.feesUsd ? `fees ${pnl0(-s.feesUsd)}` : undefined} />
          <Stat label="Expectancy" value={s.expectancyUsd == null ? "—" : pnl0(s.expectancyUsd)} valueCls={tone(s.expectancyUsd ?? 0)} sub="per trade" />
          <Stat label="Win rate" value={pct(s.winRate)} sub={s.avgWinUsd != null && s.avgLossUsd != null ? `avg ${pnl0(s.avgWinUsd)} / ${pnl0(s.avgLossUsd)}` : undefined} />
          <Stat label="Profit factor" value={pf} sub="won ÷ lost" />
          <Stat label="Mean R" value={r1(s.meanR)} valueCls={tone(s.meanR ?? 0)} sub={s.avgEfficiency != null ? `kept ${pct(s.avgEfficiency)} of the best` : "R needs a stop"} />
          <Stat label="Best / worst" value={s.bestUsd == null ? "—" : `${pnl0(s.bestUsd)} / ${pnl0(s.worstUsd ?? 0)}`} sub={s.avgHoldMin != null ? `avg hold ${hold(s.avgHoldMin)}` : undefined} />
          <Stat label="Max drawdown" value={pnl0(-s.maxDrawdownUsd)} valueCls={s.maxDrawdownUsd ? "text-down" : undefined} sub={`run-up ${pnl0(s.maxRunUpUsd)}`} />
        </div>
        <div className="mt-4 grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-4">
          <SplitList title="By session" rows={s.bySession} />
          <SplitList title="By market" rows={s.bySymbol} />
          <SplitList title="By your tag" rows={s.byTag} empty="tag trades below and this fills in" />
          <SplitList title="By your grade" rows={s.byGrade} empty="grade trades below — A means you followed your rules" />
        </div>
      </PanelBody>
    </Panel>
  );
}

function SplitList({ title, rows, empty = "—" }: { title: string; rows: Split[]; empty?: string }) {
  return (
    <div>
      <p className="mb-1 text-[11px] uppercase tracking-wide text-muted-foreground">{title}</p>
      {rows.length === 0 ? <p className="text-xs text-muted-foreground">{empty}</p> : (
        <ul className="space-y-0.5 text-[13px] tabular-nums">
          {rows.map((r) => <li key={r.key} className="flex justify-between gap-2"><span className="truncate">{r.key}</span><span><span className={tone(r.netUsd)}>{pnl0(r.netUsd)}</span> <span className="text-muted-foreground">· {r.n} · {r.wins}W{r.meanR != null ? ` · ${r1(r.meanR)}` : ""}</span></span></li>)}
        </ul>
      )}
    </div>
  );
}

export function EquityCurve({ points, onPick }: { points: { t: number; cum: number; id: string }[]; onPick: (id: string) => void }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = ref.current; if (!el || points.length < 2) return;
    const chart = createChart(el, {
      height: 160, layout: { background: { type: ColorType.Solid, color: "transparent" }, textColor: "#8c909b", fontSize: 10 },
      grid: { vertLines: { color: "rgba(255,255,255,0.03)" }, horzLines: { color: "rgba(255,255,255,0.05)" } },
      rightPriceScale: { borderColor: "rgba(255,255,255,0.08)" }, timeScale: { borderColor: "rgba(255,255,255,0.08)", timeVisible: true, secondsVisible: false },
      crosshair: { mode: 0 },
    });
    const last = points[points.length - 1].cum;
    const series = chart.addSeries(LineSeries, { color: last >= 0 ? "#4ade80" : "#f87171", lineWidth: 2, priceLineVisible: false, lastValueVisible: true });
    // Equity is a step per trade; the library timestamps them by exit. Two trades in the same second get separated by one.
    let prev = 0;
    const data = points.map((p) => { let t = Math.floor(p.t / 1000); if (t <= prev) t = prev + 1; prev = t; return { time: t as UTCTimestamp, value: p.cum }; });
    series.setData(data);
    series.createPriceLine({ price: 0, color: "rgba(255,255,255,0.25)", lineWidth: 1, lineStyle: LineStyle.Dashed, axisLabelVisible: false });
    chart.subscribeClick((param) => { if (param.time == null) return; const t = Number(param.time as Time); const hit = data.findIndex((d) => Number(d.time) === t); if (hit >= 0) onPick(points[hit].id); });
    chart.timeScale().fitContent();
    const ro = new ResizeObserver(() => chart.applyOptions({ width: el.clientWidth }));
    ro.observe(el); chart.applyOptions({ width: el.clientWidth });
    return () => { ro.disconnect(); chart.remove(); };
  }, [points, onPick]);
  if (points.length < 2) return <Panel><PanelHeader title="Equity curve" /><PanelBody><Empty>Two closed trades draw the first line.</Empty></PanelBody></Panel>;
  return (
    <Panel>
      <PanelHeader title="Equity curve" aside={<span>cumulative net, one step per closed trade · click a point to open that trade</span>} />
      <PanelBody className="p-2"><div ref={ref} className="w-full" /></PanelBody>
    </Panel>
  );
}

export function DayTable({ groups, selected, onSelect, onSaved, onSlack }: { groups: DayGroup[]; selected: string | null; onSelect: (id: string) => void; onSaved: () => void; onSlack: (id: string) => Promise<void> }) {
  if (!groups.length) return <Panel><PanelBody><Empty>No trades in this view.</Empty></PanelBody></Panel>;
  return (
    <Panel>
      <PanelHeader title="Every trade, by day" aside={<span>newest first · click a row to replay it · your tag, why and grade save on Enter</span>} />
      <DataTable dense maxH="640px">
        <thead><tr><Th>Exit</Th><Th>Market</Th><Th num>Qty</Th><Th num>Entry → exit</Th><Th num>Net</Th><Th num>R</Th><Th num>Kept</Th><Th num>Hold</Th><Th>Session</Th><Th>Near</Th><Th>Tag · why · grade</Th><Th></Th></tr></thead>
        <tbody>
          {groups.map((g) => (
            <DayRows key={g.day} g={g} selected={selected} onSelect={onSelect} onSaved={onSaved} onSlack={onSlack} />
          ))}
        </tbody>
      </DataTable>
      <Note className="px-4 py-3">Rows marked <Chip tone="grey">broker record</Chip> are from before the room existed: the broker&apos;s own P&amp;L, gross before fees, no fills and no chart. R* = a proxy of 2× the 5-minute ATR because no stop order was seen; put the stop in the bracket and R is measured off your real risk. &quot;Kept&quot; = net R over the best R the trade reached while open.</Note>
    </Panel>
  );
}

function DayRows({ g, selected, onSelect, onSaved, onSlack }: { g: DayGroup; selected: string | null; onSelect: (id: string) => void; onSaved: () => void; onSlack: (id: string) => Promise<void> }) {
  const label = new Date(`${g.day}T12:00:00Z`).toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" });
  return (
    <>
      <tr className="bg-foreground/[0.03]">
        <td colSpan={12} className="px-4 py-1.5 text-[11px] uppercase tracking-wide text-muted-foreground">
          <span className="text-foreground">{label}</span> · {g.n} trade{g.n === 1 ? "" : "s"} · <span className={tone(g.netUsd)}>{pnl0(g.netUsd)}</span>{g.feesUsd ? ` · fees ${pnl0(-g.feesUsd)}` : ""} · {g.wins}W/{g.n - g.wins}L
        </td>
      </tr>
      {g.rows.map((r) => <LibraryRowView key={r.id} r={r} selected={r.id === selected} onSelect={() => onSelect(r.id)} onSaved={onSaved} onSlack={onSlack} />)}
    </>
  );
}

function LibraryRowView({ r, selected, onSelect, onSaved, onSlack }: { r: LibraryRow; selected: boolean; onSelect: () => void; onSaved: () => void; onSlack: (id: string) => Promise<void> }) {
  const [tag, setTag] = useState(r.setupTag ?? "");
  const [why, setWhy] = useState(r.why ?? "");
  const [grade, setGrade] = useState(r.grade ?? "");
  const [busy, setBusy] = useState<"save" | "slack" | null>(null);
  const dirty = tag !== (r.setupTag ?? "") || why !== (r.why ?? "") || grade !== (r.grade ?? "");
  async function save() {
    setBusy("save");
    try { await fetch("/api/trade/journal", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "note", id: r.id, setupTag: tag, why, grade }) }); onSaved(); }
    finally { setBusy(null); }
  }
  const stop = (e: React.SyntheticEvent) => e.stopPropagation();
  const record = r.kind === "record";
  return (
    <Row onClick={record ? undefined : onSelect} className={selected ? "bg-primary/10" : undefined}>
      <Td muted title={r.exitTs}>{when(r.exitTs)}</Td>
      <Td strong>{record ? <Chip tone="grey">broker record</Chip> : <>{r.symbol} <span className={r.side === "long" ? "text-up" : "text-down"}>{r.side}</span>{r.open && <Chip tone="blue" className="ml-1.5">open</Chip>}</>}</Td>
      <Td num muted>{record ? `${r.pairs} pairs` : r.qty}</Td>
      <Td num>{record ? "—" : `${px(r.symbol, r.entryPx)} → ${px(r.symbol, r.exitPx)}`}</Td>
      <Td num className={tone(r.netUsd)}>{pnl0(r.netUsd)}{record && <span className="text-muted-foreground"> gross</span>}</Td>
      <Td num className={tone(r.netR ?? 0)}>{r.netR == null ? "—" : `${r1(r.netR)}${r.riskSource === "atr-proxy" ? "*" : ""}`}</Td>
      <Td num muted>{r.efficiency == null ? "—" : pct(r.efficiency)}</Td>
      <Td num muted>{r.holdMin == null ? "—" : hold(r.holdMin)}</Td>
      <Td muted>{r.session}</Td>
      <Td muted title={r.distAtr != null ? `${r.distAtr >= 0 ? "+" : ""}${r.distAtr.toFixed(2)} ATR from ${r.nearestLevel}` : ""}>{r.nearestLevel ?? "—"}</Td>
      <Td>
        {record ? <span className="text-xs text-muted-foreground">—</span> : (
          <div className="flex items-center gap-1" onClick={stop}>
            <input value={tag} onChange={(e) => setTag(e.target.value)} onKeyDown={(e) => e.key === "Enter" && dirty && save()} placeholder="tag" className="h-6 w-20 rounded border border-border bg-background px-1.5 text-xs" />
            <input value={why} onChange={(e) => setWhy(e.target.value)} onKeyDown={(e) => e.key === "Enter" && dirty && save()} placeholder="why, one line" className="h-6 w-44 rounded border border-border bg-background px-1.5 text-xs" />
            <select value={grade} onChange={(e) => setGrade(e.target.value)} className="h-6 rounded border border-border bg-background px-1 text-xs" title="A = followed every rule · F = broke them">
              <option value="">grade</option>{["A", "B", "C", "D", "F"].map((g) => <option key={g} value={g}>{g}</option>)}
            </select>
            {dirty && <button onClick={save} disabled={busy === "save"} className="h-6 rounded bg-primary px-2 text-[11px] font-semibold text-primary-foreground disabled:opacity-50">{busy === "save" ? "…" : "save"}</button>}
          </div>
        )}
      </Td>
      <Td>{!record && !r.open && <button onClick={async (e) => { e.stopPropagation(); setBusy("slack"); try { await onSlack(r.id); } finally { setBusy(null); } }} disabled={busy === "slack"} className="text-[11px] text-muted-foreground hover:text-foreground disabled:opacity-50" title="post this trade's replay to Slack again">{busy === "slack" ? "…" : "→ Slack"}</button>}</Td>
    </Row>
  );
}
