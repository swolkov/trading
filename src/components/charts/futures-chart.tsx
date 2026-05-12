"use client";

import { useEffect, useRef, useState, useCallback } from "react";
import {
  createChart,
  CandlestickSeries,
  LineSeries,
  HistogramSeries,
  type IChartApi,
  type ISeriesApi,
  type CandlestickData,
  type Time,
} from "lightweight-charts";

interface FuturesChartProps {
  symbol: string;
  height?: number;
}

interface Bar {
  t: number | string;
  o: number;
  h: number;
  l: number;
  c: number;
  v: number;
}

const TIMEFRAMES = [
  { label: "5m", interval: "5m", intraday: true },
  { label: "15m", interval: "15m", intraday: true },
  { label: "1H", interval: "1h", intraday: true },
  { label: "1D", interval: "1M", intraday: false },
  { label: "3M", interval: "3M", intraday: false },
  { label: "1Y", interval: "1Y", intraday: false },
];

// Calculate EMA from candle data
function calcEMA(data: { close: number; time: Time }[], period: number): { time: Time; value: number }[] {
  if (data.length < period) return [];
  const k = 2 / (period + 1);
  const result: { time: Time; value: number }[] = [];

  // SMA for first value
  let sum = 0;
  for (let i = 0; i < period; i++) sum += data[i].close;
  let ema = sum / period;
  result.push({ time: data[period - 1].time, value: ema });

  for (let i = period; i < data.length; i++) {
    ema = data[i].close * k + ema * (1 - k);
    result.push({ time: data[i].time, value: ema });
  }
  return result;
}

export function FuturesChart({ symbol, height = 500 }: FuturesChartProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const candleRef = useRef<ISeriesApi<any> | null>(null);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const ema9Ref = useRef<ISeriesApi<any> | null>(null);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const ema21Ref = useRef<ISeriesApi<any> | null>(null);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const volumeRef = useRef<ISeriesApi<any> | null>(null);
  const [activeIdx, setActiveIdx] = useState(0);
  const [loading, setLoading] = useState(false);
  const [showEMA, setShowEMA] = useState(true);
  const [crosshairData, setCrosshairData] = useState<{
    time: string;
    open: number;
    high: number;
    low: number;
    close: number;
    volume: number;
  } | null>(null);

  // Create chart once
  useEffect(() => {
    if (!containerRef.current) return;

    const chart = createChart(containerRef.current, {
      layout: {
        background: { color: "transparent" },
        textColor: "#6b7280",
        fontFamily: "var(--font-geist-mono), monospace",
        fontSize: 11,
      },
      grid: {
        vertLines: { color: "rgba(255,255,255,0.03)" },
        horzLines: { color: "rgba(255,255,255,0.03)" },
      },
      width: containerRef.current.clientWidth,
      height,
      timeScale: {
        borderColor: "rgba(255,255,255,0.06)",
        timeVisible: true,
        secondsVisible: false,
      },
      rightPriceScale: {
        borderColor: "rgba(255,255,255,0.06)",
        scaleMargins: { top: 0.1, bottom: 0.25 },
      },
      crosshair: {
        mode: 0,
        vertLine: { color: "rgba(255,255,255,0.15)", width: 1, style: 2 },
        horzLine: { color: "rgba(255,255,255,0.15)", width: 1, style: 2 },
      },
    });

    const candles = chart.addSeries(CandlestickSeries, {
      upColor: "#10b981",
      downColor: "#ef4444",
      borderDownColor: "#ef4444",
      borderUpColor: "#10b981",
      wickDownColor: "#ef444480",
      wickUpColor: "#10b98180",
    });

    const ema9 = chart.addSeries(LineSeries, {
      color: "#3b82f6",
      lineWidth: 1,
      priceLineVisible: false,
      lastValueVisible: false,
      crosshairMarkerVisible: false,
    });

    const ema21 = chart.addSeries(LineSeries, {
      color: "#f59e0b",
      lineWidth: 1,
      priceLineVisible: false,
      lastValueVisible: false,
      crosshairMarkerVisible: false,
    });

    const volume = chart.addSeries(HistogramSeries, {
      priceFormat: { type: "volume" },
      priceScaleId: "volume",
    });

    chart.priceScale("volume").applyOptions({
      scaleMargins: { top: 0.8, bottom: 0 },
    });

    // Crosshair handler
    chart.subscribeCrosshairMove((param) => {
      if (!param.time || !param.seriesData) {
        setCrosshairData(null);
        return;
      }
      const candleData = param.seriesData.get(candles) as CandlestickData<Time> | undefined;
      if (candleData) {
        const t = param.time;
        const timeStr = typeof t === "number"
          ? new Date(t * 1000).toLocaleString()
          : String(t);
        setCrosshairData({
          time: timeStr,
          open: candleData.open,
          high: candleData.high,
          low: candleData.low,
          close: candleData.close,
          volume: 0,
        });
      }
    });

    chartRef.current = chart;
    candleRef.current = candles;
    ema9Ref.current = ema9;
    ema21Ref.current = ema21;
    volumeRef.current = volume;

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
  }, [height]);

  // Fetch data when symbol or timeframe changes
  const loadBars = useCallback(async () => {
    if (!candleRef.current) return;
    const tf = TIMEFRAMES[activeIdx];
    setLoading(true);

    try {
      const res = await fetch(`/api/futures/bars?symbol=${symbol}&interval=${tf.interval}`);
      const bars: Bar[] = await res.json();
      if (!Array.isArray(bars) || bars.length === 0) return;

      const candleData: CandlestickData<Time>[] = bars.map((bar) => {
        const time = tf.intraday
          ? (typeof bar.t === "number" ? bar.t : Math.floor(new Date(bar.t).getTime() / 1000)) as Time
          : (typeof bar.t === "string" ? bar.t.split("T")[0] : new Date(bar.t * 1000).toISOString().split("T")[0]) as Time;
        return { time, open: bar.o, high: bar.h, low: bar.l, close: bar.c };
      });

      const closeData = candleData.map((c) => ({ close: c.close, time: c.time }));

      candleRef.current!.setData(candleData);

      // Volume
      const volumeData = bars.map((bar, i) => ({
        time: candleData[i].time,
        value: bar.v,
        color: bar.c >= bar.o ? "rgba(16,185,129,0.2)" : "rgba(239,68,68,0.2)",
      }));
      volumeRef.current!.setData(volumeData);

      // EMAs
      if (showEMA) {
        ema9Ref.current!.setData(calcEMA(closeData, 9));
        ema21Ref.current!.setData(calcEMA(closeData, 21));
      } else {
        ema9Ref.current!.setData([]);
        ema21Ref.current!.setData([]);
      }

      chartRef.current?.timeScale().fitContent();
    } catch (err) {
      console.error("Failed to load futures bars:", err);
    } finally {
      setLoading(false);
    }
  }, [symbol, activeIdx, showEMA]);

  useEffect(() => {
    loadBars();
  }, [loadBars]);

  return (
    <div>
      {/* Controls row */}
      <div className="flex items-center justify-between mb-3">
        <div className="flex gap-1">
          {TIMEFRAMES.map((tf, i) => (
            <button
              key={tf.label}
              onClick={() => setActiveIdx(i)}
              className={`px-2.5 py-1 rounded text-[11px] font-bold tracking-wide transition-colors ${
                i === activeIdx
                  ? "bg-emerald-500/15 text-emerald-400 border border-emerald-500/30"
                  : "text-muted-foreground hover:text-foreground hover:bg-white/5"
              }`}
            >
              {tf.label}
            </button>
          ))}
        </div>
        <div className="flex items-center gap-3">
          <button
            onClick={() => setShowEMA(!showEMA)}
            className={`px-2 py-1 rounded text-[10px] font-bold transition-colors ${
              showEMA
                ? "bg-blue-500/15 text-blue-400 border border-blue-500/30"
                : "text-muted-foreground hover:text-foreground"
            }`}
          >
            EMA 9/21
          </button>
          {loading && <span className="text-[10px] text-muted-foreground/50 animate-pulse">Loading...</span>}
        </div>
      </div>

      {/* Crosshair OHLC overlay */}
      {crosshairData && (
        <div className="flex gap-4 mb-2 text-[11px] font-mono">
          <span className="text-muted-foreground/60">{crosshairData.time}</span>
          <span>O <span className="text-foreground">{crosshairData.open.toFixed(2)}</span></span>
          <span>H <span className="text-emerald-400">{crosshairData.high.toFixed(2)}</span></span>
          <span>L <span className="text-red-400">{crosshairData.low.toFixed(2)}</span></span>
          <span>C <span className={crosshairData.close >= crosshairData.open ? "text-emerald-400" : "text-red-400"}>
            {crosshairData.close.toFixed(2)}
          </span></span>
        </div>
      )}

      {/* Chart container */}
      <div ref={containerRef} className="w-full rounded-lg overflow-hidden" />

      {/* Legend */}
      {showEMA && (
        <div className="flex gap-4 mt-2 text-[10px]">
          <span className="flex items-center gap-1.5">
            <span className="w-3 h-[2px] bg-blue-500 rounded" /> EMA 9
          </span>
          <span className="flex items-center gap-1.5">
            <span className="w-3 h-[2px] bg-amber-500 rounded" /> EMA 21
          </span>
        </div>
      )}
    </div>
  );
}
