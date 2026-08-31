"use client";

import { useEffect, useRef } from "react";
import useSWR from "swr";
import {
  createChart,
  CandlestickSeries,
  HistogramSeries,
  type IChartApi,
  type Time,
} from "lightweight-charts";

interface Bar { t: number; o: number; h: number; l: number; c: number; v: number }

export interface PriceLevel { price: number; label: string; color: string }

interface MarginChartProps {
  symbol: string;
  interval: number;      // minutes: 1|3|5|15|30|60|240|1440
  height?: number;
  levels?: PriceLevel[]; // liquidation line, prior-day H/L, 50-day SMA…
  compact?: boolean;     // mini-grid mode: no volume, no time scale labels
}

const fetcher = (u: string) => fetch(u).then((r) => r.json());

export const INTERVAL_LABELS: Record<number, string> = {
  1: "1m", 3: "3m", 5: "5m", 15: "15m", 30: "30m", 60: "1h", 240: "4h", 1440: "1D",
};

export function MarginChart({ symbol, interval, height = 420, levels = [], compact = false }: MarginChartProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);

  const { data } = useSWR<{ bars: Bar[] }>(
    `/api/margin/ohlc?symbol=${encodeURIComponent(symbol)}&interval=${interval}`,
    fetcher,
    // Refresh at roughly one bar's cadence, floor 30s so short frames stay live.
    { refreshInterval: Math.max(30_000, interval * 60_000 / 2) },
  );

  useEffect(() => {
    const el = containerRef.current;
    if (!el || !data?.bars?.length) return;

    const chart = createChart(el, {
      height,
      layout: { background: { color: "transparent" }, textColor: "#71717a", fontSize: compact ? 9 : 11 },
      grid: {
        vertLines: { color: "rgba(255,255,255,0.03)" },
        horzLines: { color: "rgba(255,255,255,0.03)" },
      },
      rightPriceScale: { borderColor: "rgba(255,255,255,0.06)" },
      timeScale: {
        borderColor: "rgba(255,255,255,0.06)",
        timeVisible: interval < 1440,
        visible: !compact,
      },
      crosshair: compact ? { mode: 2 } : undefined,
    });
    chartRef.current = chart;

    const candles = chart.addSeries(CandlestickSeries, {
      upColor: "#10b981",
      downColor: "#ef4444",
      borderUpColor: "#10b981",
      borderDownColor: "#ef4444",
      wickUpColor: "#10b98188",
      wickDownColor: "#ef444488",
      priceLineVisible: !compact,
    });
    candles.setData(data.bars.map((b) => ({
      time: b.t as Time, open: b.o, high: b.h, low: b.l, close: b.c,
    })));

    if (!compact) {
      const vol = chart.addSeries(HistogramSeries, {
        priceFormat: { type: "volume" },
        priceScaleId: "vol",
      });
      chart.priceScale("vol").applyOptions({ scaleMargins: { top: 0.82, bottom: 0 } });
      vol.setData(data.bars.map((b) => ({
        time: b.t as Time,
        value: b.v,
        color: b.c >= b.o ? "rgba(16,185,129,0.35)" : "rgba(239,68,68,0.35)",
      })));
    }

    for (const lvl of levels) {
      if (!(lvl.price > 0)) continue;
      candles.createPriceLine({
        price: lvl.price,
        color: lvl.color,
        lineWidth: 1,
        lineStyle: 2,
        axisLabelVisible: !compact,
        title: compact ? "" : lvl.label,
      });
    }

    chart.timeScale().fitContent();

    const onResize = () => chart.applyOptions({ width: el.clientWidth });
    onResize();
    const ro = new ResizeObserver(onResize);
    ro.observe(el);
    return () => { ro.disconnect(); chart.remove(); chartRef.current = null; };
  }, [data, height, interval, levels, compact]);

  return (
    <div className="relative">
      <div ref={containerRef} style={{ height }} />
      {!data && (
        <div className="absolute inset-0 flex items-center justify-center">
          <div className="animate-spin w-5 h-5 border-2 border-emerald-500 border-t-transparent rounded-full" />
        </div>
      )}
    </div>
  );
}

// Compact per-timeframe read: last-bar close vs N bars ago + a 14-period RSI, so the
// multi-timeframe story is scannable without seven full charts.
export function useTimeframeStats(symbol: string, interval: number): {
  changePct: number | null; rsi: number | null; lastClose: number | null;
} {
  const { data } = useSWR<{ bars: Bar[] }>(
    `/api/margin/ohlc?symbol=${encodeURIComponent(symbol)}&interval=${interval}`,
    fetcher,
    { refreshInterval: Math.max(60_000, interval * 60_000 / 2) },
  );
  const bars = data?.bars;
  if (!bars || bars.length < 30) return { changePct: null, rsi: null, lastClose: null };
  const last = bars[bars.length - 1];
  const back = bars[Math.max(0, bars.length - 21)];   // ~20 bars of context
  const changePct = ((last.c - back.c) / back.c) * 100;

  // Wilder RSI-14 on closes.
  let gain = 0, loss = 0;
  const start = bars.length - 15;
  for (let i = start + 1; i < bars.length; i++) {
    const d = bars[i].c - bars[i - 1].c;
    if (d > 0) gain += d; else loss -= d;
  }
  const rs = loss > 0 ? gain / loss : Infinity;
  const rsi = 100 - 100 / (1 + rs);
  return { changePct, rsi: isFinite(rsi) ? rsi : 100, lastClose: last.c };
}
