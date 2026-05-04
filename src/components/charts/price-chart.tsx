"use client";

import { useEffect, useRef, useState } from "react";
import { createChart, CandlestickSeries, type IChartApi, type ISeriesApi, type CandlestickData, type Time } from "lightweight-charts";

interface PriceChartProps {
  symbol: string;
}

const TIMEFRAMES = [
  { label: "1W", timeframe: "1Hour", days: 7 },
  { label: "1M", timeframe: "1Day", days: 30 },
  { label: "3M", timeframe: "1Day", days: 90 },
  { label: "1Y", timeframe: "1Day", days: 365 },
];

export function PriceChart({ symbol }: PriceChartProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const seriesRef = useRef<ISeriesApi<any> | null>(null);
  const [activeTimeframe, setActiveTimeframe] = useState(2);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!containerRef.current) return;

    const chart = createChart(containerRef.current, {
      layout: {
        background: { color: "transparent" },
        textColor: "#9ca3af",
      },
      grid: {
        vertLines: { color: "rgba(255,255,255,0.05)" },
        horzLines: { color: "rgba(255,255,255,0.05)" },
      },
      width: containerRef.current.clientWidth,
      height: 400,
      timeScale: { borderColor: "rgba(255,255,255,0.1)" },
      rightPriceScale: { borderColor: "rgba(255,255,255,0.1)" },
    });

    const series = chart.addSeries(CandlestickSeries, {
      upColor: "#10b981",
      downColor: "#ef4444",
      borderDownColor: "#ef4444",
      borderUpColor: "#10b981",
      wickDownColor: "#ef4444",
      wickUpColor: "#10b981",
    });

    chartRef.current = chart;
    seriesRef.current = series;

    const handleResize = () => {
      if (containerRef.current) {
        chart.applyOptions({ width: containerRef.current.clientWidth });
      }
    };
    window.addEventListener("resize", handleResize);

    return () => {
      window.removeEventListener("resize", handleResize);
      chart.remove();
    };
  }, []);

  useEffect(() => {
    if (!symbol || !seriesRef.current) return;

    const tf = TIMEFRAMES[activeTimeframe];
    const start = new Date();
    start.setDate(start.getDate() - tf.days);

    setLoading(true);
    fetch(
      `/api/bars/${symbol}?timeframe=${tf.timeframe}&start=${start.toISOString()}`
    )
      .then((r) => r.json())
      .then((bars) => {
        if (Array.isArray(bars) && seriesRef.current) {
          const data: CandlestickData<Time>[] = bars.map((bar: { t: string; o: number; h: number; l: number; c: number }) => ({
            time: (bar.t.split("T")[0]) as Time,
            open: bar.o,
            high: bar.h,
            low: bar.l,
            close: bar.c,
          }));
          seriesRef.current.setData(data);
          chartRef.current?.timeScale().fitContent();
        }
      })
      .finally(() => setLoading(false));
  }, [symbol, activeTimeframe]);

  return (
    <div>
      <div className="flex gap-2 mb-3">
        {TIMEFRAMES.map((tf, i) => (
          <button
            key={tf.label}
            onClick={() => setActiveTimeframe(i)}
            className={`px-3 py-1 rounded text-xs font-medium transition-colors ${
              i === activeTimeframe
                ? "bg-primary text-primary-foreground"
                : "bg-muted text-muted-foreground hover:bg-accent"
            }`}
          >
            {tf.label}
          </button>
        ))}
        {loading && (
          <span className="text-xs text-muted-foreground self-center ml-2">
            Loading...
          </span>
        )}
      </div>
      <div ref={containerRef} className="w-full" />
    </div>
  );
}
