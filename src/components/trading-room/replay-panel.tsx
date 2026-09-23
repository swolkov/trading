"use client";

import { useEffect, useRef, useState } from "react";
import useSWR from "swr";
import { CandlestickSeries, ColorType, LineStyle, createChart, createSeriesMarkers, type IChartApi, type ISeriesApi, type ISeriesMarkersPluginApi, type SeriesMarker, type Time, type UTCTimestamp } from "lightweight-charts";
import { Chip } from "@/components/ui/chip";
import { Empty, Note, Panel, PanelBody, PanelHeader, Stat } from "@/components/ui/panel";
import { hold, pnl0, tone, when } from "@/lib/format";
import type { ReplayView } from "@/lib/trading-room-replay";
import { execVerb, pnlAt, usd0 } from "@/lib/trading-room-replay-rules";

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
              <Stat label="Executions" value={String(data.executions.length)} sub={data.executions.map((e) => `${e.action === "Buy" ? "buy" : "sell"} ${e.qty} @ ${e.price}`).join(" · ")} />
              <Stat label="Levels" value={String(data.levels.length)} sub={data.levelsAt ? `as they stood at entry` : "none"} />
            </div>
            {data.bars.length ? <ReplayPlayer view={data} /> : <Empty>{data.note ?? "No bars."}</Empty>}
            {data.bars.length > 0 && data.note && <Note className="mt-2">{data.note}</Note>}
            <ExecutionTable view={data} />
            <div className="mt-2 flex flex-wrap gap-1.5">
              <Chip tone="green">▲ buy fill</Chip><Chip tone="red">▼ sell fill</Chip><Chip tone="grey">dashed = level at entry</Chip><Chip tone="amber">solid = entry · exit · stop</Chip>
            </div>
          </>
        )}
      </PanelBody>
    </Panel>
  );
}

// WHERE YOU STAND at the scrubber: what is on, its open P&L at the last shown close, and what has been banked.
function LiveReadout({ view, untilMs, mark }: { view: ReplayView; untilMs: number; mark: number }) {
  const now = pnlAt(view.trip.side, view.executions, view.pointValue, untilMs, mark);
  const started = view.executions.some((e) => Date.parse(e.ts) < untilMs);
  if (!started) return <span className="num text-muted-foreground">· before your entry</span>;
  const total = now.openUsd + now.bankedUsd;
  return (
    <span className="num">
      · {now.pos > 0 ? <>{view.trip.side} {now.pos} · open <span className={tone(now.openUsd)}>{usd0(now.openUsd)}</span>{now.bankedUsd !== 0 && <> · banked <span className={tone(now.bankedUsd)}>{usd0(now.bankedUsd)}</span></>}</> : <>flat · banked <span className={tone(now.bankedUsd)}>{usd0(now.bankedUsd)}</span></>}
      {now.pos > 0 && now.bankedUsd !== 0 && <> · total <span className={tone(total)}>{usd0(total)}</span></>}
    </span>
  );
}

// EVERY EXECUTION: time, buy or sell, size, price, what it did, and the dollars an exit banked (before fees).
function ExecutionTable({ view }: { view: ReplayView }) {
  if (!view.executions.length) return null;
  const banked = view.executions.reduce((a, e) => a + (e.realizedUsd ?? 0), 0);
  return (
    <div className="mt-3 overflow-x-auto">
      <table className="w-full text-xs">
        <thead><tr className="text-left text-muted-foreground"><th className="py-1 pr-3 font-normal">Time (ET)</th><th className="py-1 pr-3 font-normal">Order</th><th className="py-1 pr-3 text-right font-normal">Price</th><th className="py-1 pr-3 font-normal">What it did</th><th className="py-1 text-right font-normal">P&amp;L</th></tr></thead>
        <tbody>
          {view.executions.map((e, i) => (
            <tr key={i} className="border-t border-border/50">
              <td className="num py-1 pr-3">{et(Date.parse(e.ts))}</td>
              <td className={`py-1 pr-3 font-semibold ${e.action === "Buy" ? "text-up" : "text-down"}`}>{e.action === "Buy" ? "BUY" : "SELL"} {e.qty}</td>
              <td className="num py-1 pr-3 text-right">{e.price}</td>
              <td className="py-1 pr-3 text-muted-foreground">{execVerb(view.trip.side, e)}</td>
              <td className={`num py-1 text-right ${e.realizedUsd == null ? "text-muted-foreground" : tone(e.realizedUsd)}`}>{e.realizedUsd == null ? "—" : usd0(e.realizedUsd)}</td>
            </tr>
          ))}
          {!view.trip.open && (
            <tr className="border-t border-border">
              <td colSpan={4} className="py-1 pr-3 text-muted-foreground">Banked {usd0(banked)} before fees · fees {usd0(-view.trip.feesUsd)} · net</td>
              <td className={`num py-1 text-right font-semibold ${tone(view.trip.netUsd)}`}>{usd0(view.trip.netUsd)}</td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );
}

// PLAY: the bars arrive one at a time (12 a second), fills appear as they happened. Pause, scrub, or jump to the end.
function ReplayPlayer({ view }: { view: ReplayView }) {
  const n = view.bars.length;
  const [upto, setUpto] = useState(n);
  const [playing, setPlaying] = useState(false);
  useEffect(() => {
    if (!playing) return;
    const id = setInterval(() => setUpto((u) => { if (u >= n) { setPlaying(false); return n; } return u + 1; }), 80);
    return () => clearInterval(id);
  }, [playing, n]);
  const start = () => { setUpto(Math.min(n, 5)); setPlaying(true); };
  const shownUntil = upto > 0 ? view.bars[Math.min(upto, n) - 1].t + 60_000 : view.bars[0].t;
  return (
    <div>
      <div className="mb-2 flex flex-wrap items-center gap-2 text-xs">
        <button onClick={playing ? () => setPlaying(false) : start} className="h-7 rounded-md bg-primary px-3 font-semibold text-primary-foreground">{playing ? "Pause" : "▶ Play"}</button>
        <button onClick={() => { setPlaying(false); setUpto(n); }} className="h-7 rounded-md border border-border px-3 text-muted-foreground hover:text-foreground">Show all</button>
        <input type="range" min={1} max={n} value={Math.min(upto, n)} onChange={(e) => { setPlaying(false); setUpto(Number(e.target.value)); }} className="w-56" />
        <span className="num text-muted-foreground">{et(shownUntil)} ET · bar {Math.min(upto, n)} of {n}</span>
        <LiveReadout view={view} untilMs={shownUntil} mark={view.bars[Math.max(0, Math.min(upto, n) - 1)].c} />
      </div>
      <ReplayChart view={view} upto={Math.min(upto, n)} />
    </div>
  );
}

const et = (ms: number, long = false) => new Date(ms).toLocaleString("en-US", { timeZone: "America/New_York", hour12: false, hour: "2-digit", minute: "2-digit", ...(long ? { month: "short", day: "numeric" } : {}) });

function ReplayChart({ view, upto }: { view: ReplayView; upto: number }) {
  const ref = useRef<HTMLDivElement>(null);
  const seriesRef = useRef<ISeriesApi<"Candlestick"> | null>(null);
  const markersRef = useRef<ISeriesMarkersPluginApi<Time> | null>(null);
  const allMarkers = useRef<SeriesMarker<Time>[]>([]);
  // Progressive updates: only the bars and fills up to `upto` are on the chart. The scale stays fixed on the whole trade.
  useEffect(() => {
    const series = seriesRef.current, markers = markersRef.current; if (!series || !markers) return;
    const shown = view.bars.slice(0, upto);
    // Bars past `upto` stay as whitespace so the time axis keeps the whole trade's width while the candles arrive.
    series.setData(view.bars.map((b, i) => (i < upto
      ? { time: Math.floor(b.t / 1000) as UTCTimestamp, open: b.o, high: b.h, low: b.l, close: b.c }
      : { time: Math.floor(b.t / 1000) as UTCTimestamp })));
    const until = shown.length ? shown[shown.length - 1].t + 60_000 : 0;
    markers.setMarkers(allMarkers.current.filter((m) => Number(m.time) * 1000 < until));
  }, [view, upto]);
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
    seriesRef.current = series;
    // Fills as markers: buys below the bar in green, sells above in red — with size and price.
    const markers: SeriesMarker<Time>[] = view.executions.map((f) => ({
      time: Math.floor(Date.parse(f.ts) / 1000) as UTCTimestamp, position: f.action === "Buy" ? "belowBar" : "aboveBar", shape: f.action === "Buy" ? "arrowUp" : "arrowDown",
      color: f.action === "Buy" ? "#4ade80" : "#f87171",
      text: `${f.action === "Buy" ? "BUY" : "SELL"} ${f.qty} @ ${f.price}${f.realizedUsd != null ? ` ${usd0(f.realizedUsd)}` : ""}`,
    }));
    allMarkers.current = markers.sort((a, b) => Number(a.time) - Number(b.time));
    markersRef.current = createSeriesMarkers(series, allMarkers.current);
    // Fix the visible range and the price scale to the whole trade so playback does not jump around.
    const px = [view.trip.entryPx, view.trip.exitPx, ...view.executions.map((e) => e.price)];
    const lo = Math.min(...view.bars.map((b) => b.l), ...px), hi = Math.max(...view.bars.map((b) => b.h), ...px);
    series.applyOptions({ autoscaleInfoProvider: () => ({ priceRange: { minValue: lo - (hi - lo) * 0.05, maxValue: hi + (hi - lo) * 0.05 } }) });
    // Levels at entry, dashed and quiet; entry / exit / stop solid.
    for (const l of view.levels) series.createPriceLine({ price: l.price, color: "rgba(255,255,255,0.35)", lineWidth: 1, lineStyle: LineStyle.Dashed, axisLabelVisible: true, title: l.name });
    series.createPriceLine({ price: view.trip.entryPx, color: "#e2b64a", lineWidth: 1, lineStyle: LineStyle.Solid, axisLabelVisible: true, title: "entry" });
    if (!view.trip.open) series.createPriceLine({ price: view.trip.exitPx, color: "#e2b64a", lineWidth: 1, lineStyle: LineStyle.Solid, axisLabelVisible: true, title: "exit" });
    if (view.trip.stopPx != null) series.createPriceLine({ price: view.trip.stopPx, color: "#f87171", lineWidth: 2, lineStyle: LineStyle.Solid, axisLabelVisible: true, title: "stop" });
    chart.timeScale().fitContent();
    const range = chart.timeScale().getVisibleLogicalRange();
    const ro = new ResizeObserver(() => { chart.applyOptions({ width: el.clientWidth }); if (range) chart.timeScale().setVisibleLogicalRange(range); });
    ro.observe(el);
    chart.applyOptions({ width: el.clientWidth });
    if (range) chart.timeScale().setVisibleLogicalRange({ from: range.from, to: range.to });
    chart.timeScale().applyOptions({ rightOffset: 2, fixLeftEdge: true });
    return () => { ro.disconnect(); chart.remove(); seriesRef.current = null; markersRef.current = null; };
  }, [view]);
  return <div ref={ref} className="w-full" />;
}
