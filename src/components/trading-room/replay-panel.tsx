"use client";

import { useEffect, useRef } from "react";
import useSWR from "swr";
import { CandlestickSeries, ColorType, LineStyle, createChart, createSeriesMarkers, type IChartApi, type SeriesMarker, type Time, type UTCTimestamp } from "lightweight-charts";
import { Chip } from "@/components/ui/chip";
import { Empty, Note, Panel, PanelBody, PanelHeader, Stat } from "@/components/ui/panel";
import { hold, pnl0, tone, when } from "@/lib/format";
import type { ReplayView } from "@/lib/trading-room-replay";

// THE REPLAY PANEL: one round trip on its own 1-minute chart — his fills as markers, the level set as it stood
// at entry as dashed lines, entry/exit/stop as solid lines. Opens under the journal row that was clicked.

const fetcher = (u: string) => fetch(u).then((r) => r.json());

export function ReplayPanel({ id, onClose }: { id: string; onClose: () => void }) {
  const { data } = useSWR<ReplayView & { error?: string }>(`/api/trade/journal/replay?id=${encodeURIComponent(id)}`, fetcher);
  return (
    <Panel tone="amber">
      <PanelHeader title={data?.trip ? `Replay · ${data.trip.symbol} ${data.trip.side} ×${data.trip.qty} · ${when(data.trip.entryTs)}` : "Replay"} aside={<button onClick={onClose} className="text-xs text-muted-foreground hover:text-foreground">close</button>} />
      <PanelBody>
        {!data ? <Empty>Loading the replay…</Empty> : data.error ? <Note>{data.error}</Note> : (
          <>
            <div className="mb-3 grid grid-cols-2 gap-4 md:grid-cols-6">
              <Stat label="Net" value={pnl0(data.trip.netUsd)} valueCls={tone(data.trip.netUsd)} sub={data.trip.netR != null ? `${data.trip.netR >= 0 ? "+" : "−"}${Math.abs(data.trip.netR).toFixed(2)}R${data.trip.riskSource === "atr-proxy" ? " (proxy)" : ""}` : undefined} />
              <Stat label="Entry → exit" value={`${data.trip.entryPx} → ${Math.round(data.trip.exitPx * 100) / 100}`} sub={hold((Date.parse(data.trip.exitTs) - Date.parse(data.trip.entryTs)) / 60_000)} />
              <Stat label="Stop seen" value={data.trip.stopPx != null ? String(data.trip.stopPx) : "none"} sub={data.trip.riskUsd != null ? `risk $${Math.round(data.trip.riskUsd)} ${data.trip.riskSource === "stop" ? "at your stop" : "by proxy (2× 5m ATR)"}` : undefined} />
              <Stat label="Best / worst" value={`${data.trip.mfeR != null ? `+${data.trip.mfeR.toFixed(2)}R` : "—"} / ${data.trip.maeR != null ? `−${data.trip.maeR.toFixed(2)}R` : "—"}`} sub="while open" />
              <Stat label="Fills" value={String(data.fills.length)} sub={data.fills.map((f) => `${f.action === "Buy" ? "B" : "S"}${f.qty}@${f.price}`).join(" · ")} />
              <Stat label="Levels" value={String(data.levels.length)} sub={data.levelsAt ? `as they stood at entry` : "none"} />
            </div>
            {data.bars.length ? <ReplayChart view={data} /> : <Empty>{data.note ?? "No bars."}</Empty>}
            {data.bars.length > 0 && data.note && <Note className="mt-2">{data.note}</Note>}
            <div className="mt-2 flex flex-wrap gap-1.5">
              <Chip tone="green">▲ buy fill</Chip><Chip tone="red">▼ sell fill</Chip><Chip tone="grey">dashed = level at entry</Chip><Chip tone="amber">solid = entry · exit · stop</Chip>
            </div>
          </>
        )}
      </PanelBody>
    </Panel>
  );
}

const et = (ms: number, long = false) => new Date(ms).toLocaleString("en-US", { timeZone: "America/New_York", hour12: false, hour: "2-digit", minute: "2-digit", ...(long ? { month: "short", day: "numeric" } : {}) });

function ReplayChart({ view }: { view: ReplayView }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = ref.current; if (!el) return;
    // Fixed colors: the theme tokens are oklch, which the chart library cannot parse.
    const chart: IChartApi = createChart(el, {
      height: 380, layout: { background: { type: ColorType.Solid, color: "transparent" }, textColor: "#dcdee4", fontSize: 11 },
      grid: { vertLines: { color: "rgba(255,255,255,0.04)" }, horzLines: { color: "rgba(255,255,255,0.04)" } },
      rightPriceScale: { borderColor: "rgba(255,255,255,0.1)" },
      // Eastern time on the axis and the crosshair — the library defaults to UTC.
      timeScale: { borderColor: "rgba(255,255,255,0.1)", timeVisible: true, secondsVisible: false, tickMarkFormatter: (t: Time) => et(Number(t) * 1000) },
      localization: { timeFormatter: (t: Time) => et(Number(t) * 1000, true) },
      crosshair: { mode: 0 },
    });
    const series = chart.addSeries(CandlestickSeries, { upColor: "#4ade80", downColor: "#f87171", borderVisible: false, wickUpColor: "#4ade80", wickDownColor: "#f87171" });
    series.setData(view.bars.map((b) => ({ time: Math.floor(b.t / 1000) as UTCTimestamp, open: b.o, high: b.h, low: b.l, close: b.c })));
    // Fills as markers: buys below the bar in green, sells above in red — with size and price.
    const markers: SeriesMarker<Time>[] = view.fills.map((f) => ({
      time: Math.floor(Date.parse(f.ts) / 1000) as UTCTimestamp, position: f.action === "Buy" ? "belowBar" : "aboveBar", shape: f.action === "Buy" ? "arrowUp" : "arrowDown",
      color: f.action === "Buy" ? "#4ade80" : "#f87171", text: `${f.action === "Buy" ? "B" : "S"} ${f.qty} @ ${f.price}`,
    }));
    createSeriesMarkers(series, markers.sort((a, b) => Number(a.time) - Number(b.time)));
    // Levels at entry, dashed and quiet; entry / exit / stop solid.
    for (const l of view.levels) series.createPriceLine({ price: l.price, color: "rgba(255,255,255,0.35)", lineWidth: 1, lineStyle: LineStyle.Dashed, axisLabelVisible: true, title: l.name });
    series.createPriceLine({ price: view.trip.entryPx, color: "#e2b64a", lineWidth: 1, lineStyle: LineStyle.Solid, axisLabelVisible: true, title: "entry" });
    if (!view.trip.open) series.createPriceLine({ price: view.trip.exitPx, color: "#e2b64a", lineWidth: 1, lineStyle: LineStyle.Solid, axisLabelVisible: true, title: "exit" });
    if (view.trip.stopPx != null) series.createPriceLine({ price: view.trip.stopPx, color: "#f87171", lineWidth: 2, lineStyle: LineStyle.Solid, axisLabelVisible: true, title: "stop" });
    chart.timeScale().fitContent();
    const ro = new ResizeObserver(() => chart.applyOptions({ width: el.clientWidth }));
    ro.observe(el);
    chart.applyOptions({ width: el.clientWidth });
    return () => { ro.disconnect(); chart.remove(); };
  }, [view]);
  return <div ref={ref} className="w-full" />;
}
