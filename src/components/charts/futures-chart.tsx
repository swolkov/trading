"use client";

import { useEffect, useRef, useState, useCallback } from "react";
import {
  createChart,
  createSeriesMarkers,
  CandlestickSeries,
  LineSeries,
  HistogramSeries,
  type IChartApi,
  type ISeriesApi,
  type ISeriesMarkersPluginApi,
  type CandlestickData,
  type Time,
  type SeriesMarker,
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

interface TradeMarker {
  symbol: string;
  action: string;
  price: number | null;
  pnl: number | null;
  time: string;
  reason: string;
}

interface Position {
  symbol: string;
  direction: "long" | "short";
  entryPrice: number;
  stopLoss: number | null;
  target: number | null;
  unrealizedPnl?: number;
  quantity?: number;
  multiplier?: number;
  aiScore?: number | null;
  setup?: string | null;
}

const TIMEFRAMES = [
  { label: "5m", interval: "5m", intraday: true },
  { label: "15m", interval: "15m", intraday: true },
  { label: "1H", interval: "1h", intraday: true },
  { label: "1D", interval: "1M", intraday: false },
  { label: "3M", interval: "3M", intraday: false },
  { label: "1Y", interval: "1Y", intraday: false },
];

function calcEMA(data: { close: number; time: Time }[], period: number): { time: Time; value: number }[] {
  if (data.length < period) return [];
  const k = 2 / (period + 1);
  const result: { time: Time; value: number }[] = [];
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

// Match futures symbol variants (MES, MESM6, MYMM6, etc.)
function matchesSymbol(tradeSymbol: string, chartSymbol: string): boolean {
  const normalized = tradeSymbol.replace("FUT:", "");
  return normalized === chartSymbol || normalized.startsWith(chartSymbol);
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
  // Price lines for position
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const priceLinesRef = useRef<any[]>([]);
  const markersRef = useRef<ISeriesMarkersPluginApi<Time> | null>(null);
  const barsRef = useRef<CandlestickData<Time>[]>([]);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const vwapRef = useRef<ISeriesApi<any> | null>(null);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const vwapUpperRef = useRef<ISeriesApi<any> | null>(null);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const vwapLowerRef = useRef<ISeriesApi<any> | null>(null);
  const [activeIdx, setActiveIdx] = useState(0);
  const [loading, setLoading] = useState(false);
  const [showEMA, setShowEMA] = useState(true);
  const [showVWAP, setShowVWAP] = useState(true);
  // Honest data-state — no more silent white chart; surfaces provider/env/freshness truthfully.
  const [dataInfo, setDataInfo] = useState<{ state: "loading" | "ok" | "empty" | "error"; msg?: string; count: number; lastTs: number | null; viewMode: string | null; provider?: string | null }>({ state: "loading", count: 0, lastTs: null, viewMode: null, provider: null });
  const [isLive, setIsLive] = useState(true);
  const [lastUpdate, setLastUpdate] = useState<string>("");
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
        autoScale: true,
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

    // VWAP + bands
    const vwap = chart.addSeries(LineSeries, {
      color: "#6366f1", lineWidth: 2, lineStyle: 2, // indigo dashed
      priceLineVisible: false, lastValueVisible: false,
    });
    const vwapUpper = chart.addSeries(LineSeries, {
      color: "rgba(99,102,241,0.25)", lineWidth: 1,
      priceLineVisible: false, lastValueVisible: false,
    });
    const vwapLower = chart.addSeries(LineSeries, {
      color: "rgba(99,102,241,0.25)", lineWidth: 1,
      priceLineVisible: false, lastValueVisible: false,
    });
    vwapRef.current = vwap;
    vwapUpperRef.current = vwapUpper;
    vwapLowerRef.current = vwapLower;

    chart.priceScale("volume").applyOptions({
      scaleMargins: { top: 0.8, bottom: 0 },
    });

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

  // Load bars + trade markers + position lines
  const loadBars = useCallback(async (isRefresh = false) => {
    if (!candleRef.current || !chartRef.current) return;
    const tf = TIMEFRAMES[activeIdx];
    if (!isRefresh) setLoading(true);

    try {
      // Fetch bars + positions/trades in parallel
      const [barsRes, posRes] = await Promise.all([
        fetch(`/api/futures/bars?symbol=${symbol}&interval=${tf.interval}`),
        fetch("/api/futures/positions"),
      ]);

      const barsJson = await barsRes.json();
      const posData = await posRes.json().catch(() => null);

      // API now returns { bars, overlays, meta } for intraday, or { bars, meta } for daily
      const bars: Bar[] = Array.isArray(barsJson) ? barsJson : (barsJson.bars || []);
      const overlays = Array.isArray(barsJson) ? null : barsJson.overlays;
      const meta = (!Array.isArray(barsJson) && barsJson.meta) || null;
      const viewMode: string | null = meta?.viewMode ?? null;
      const provider: string | null = meta?.provider ?? null;

      if (bars.length === 0) {
        // Tell the truth instead of leaving a blank white chart.
        candleRef.current?.setData([]);
        setDataInfo({
          state: barsJson?.error ? "error" : "empty",
          msg: barsJson?.error || `No ${tf.label} bars for ${symbol} — market may be closed, or the data provider returned nothing for this session.`,
          count: 0, lastTs: meta?.lastBarTs ?? null, viewMode, provider,
        });
        return;
      }

      const candleData: CandlestickData<Time>[] = bars.map((bar) => {
        const time = tf.intraday
          ? (typeof bar.t === "number" ? bar.t : Math.floor(new Date(bar.t).getTime() / 1000)) as Time
          : (typeof bar.t === "string" ? bar.t.split("T")[0] : new Date(bar.t * 1000).toISOString().split("T")[0]) as Time;
        return { time, open: bar.o, high: bar.h, low: bar.l, close: bar.c };
      });

      barsRef.current = candleData;
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

      // VWAP + Key Levels
      if (showVWAP && overlays?.vwapSeries && vwapRef.current && vwapUpperRef.current && vwapLowerRef.current) {
        const validVwap = overlays.vwapSeries.filter((v: { vwap: number; upper: number; lower: number }) => v.vwap > 0 && v.upper > 0 && v.lower > 0);
        const vwapData = validVwap.map((v: { t: number; vwap: number }) => ({
          time: (typeof v.t === "number" ? v.t : Math.floor(new Date(v.t).getTime() / 1000)) as Time,
          value: v.vwap,
        }));
        const upperData = validVwap.map((v: { t: number; upper: number }) => ({
          time: (typeof v.t === "number" ? v.t : Math.floor(new Date(v.t).getTime() / 1000)) as Time,
          value: v.upper,
        }));
        const lowerData = validVwap.map((v: { t: number; lower: number }) => ({
          time: (typeof v.t === "number" ? v.t : Math.floor(new Date(v.t).getTime() / 1000)) as Time,
          value: v.lower,
        }));
        vwapRef.current.setData(vwapData);
        vwapUpperRef.current.setData(upperData);
        vwapLowerRef.current.setData(lowerData);
      } else if (vwapRef.current) {
        vwapRef.current.setData([]);
        vwapUpperRef.current?.setData([]);
        vwapLowerRef.current?.setData([]);
      }

      // Key levels as price lines on the candle series
      priceLinesRef.current.forEach((pl) => { try { candleRef.current?.removePriceLine(pl); } catch {} });
      priceLinesRef.current = [];
      if (overlays && tf.intraday) {
        if (overlays.prevDayHigh > 0) {
          priceLinesRef.current.push(candleRef.current!.createPriceLine({
            price: overlays.prevDayHigh, color: "#f59e0b", lineWidth: 1, lineStyle: 2, axisLabelVisible: true, title: "PDH",
          }));
        }
        if (overlays.prevDayLow > 0) {
          priceLinesRef.current.push(candleRef.current!.createPriceLine({
            price: overlays.prevDayLow, color: "#f59e0b", lineWidth: 1, lineStyle: 2, axisLabelVisible: true, title: "PDL",
          }));
        }
        if (overlays.openingRangeHigh > 0) {
          priceLinesRef.current.push(candleRef.current!.createPriceLine({
            price: overlays.openingRangeHigh, color: "#6b7280", lineWidth: 1, lineStyle: 1, axisLabelVisible: false, title: "OR-H",
          }));
        }
        if (overlays.openingRangeLow > 0) {
          priceLinesRef.current.push(candleRef.current!.createPriceLine({
            price: overlays.openingRangeLow, color: "#6b7280", lineWidth: 1, lineStyle: 1, axisLabelVisible: false, title: "OR-L",
          }));
        }
      }

      // ── TRADE MARKERS ──
      if (posData?.activity && tf.intraday) {
        const trades: TradeMarker[] = posData.activity;
        const markers: SeriesMarker<Time>[] = [];

        for (const trade of trades) {
          if (!matchesSymbol(trade.symbol, symbol)) continue;
          if (!trade.price || !trade.time) continue;

          const tradeTime = Math.floor(new Date(trade.time).getTime() / 1000);
          // Snap to nearest bar time
          const barInterval = tf.interval === "5m" ? 300 : tf.interval === "15m" ? 900 : 3600;
          const snappedTime = (Math.floor(tradeTime / barInterval) * barInterval) as Time;

          // Check if this time is in our bar range
          const firstBar = candleData[0]?.time as unknown as number;
          const lastBar = candleData[candleData.length - 1]?.time as unknown as number;
          if ((snappedTime as unknown as number) < firstBar || (snappedTime as unknown as number) > lastBar) continue;

          const isEntry = trade.action.includes("long") || trade.action.includes("short");
          const isWin = trade.pnl != null && trade.pnl > 0;
          const isLoss = trade.pnl != null && trade.pnl < 0;

          if (isEntry) {
            const isLong = trade.action.includes("long");
            markers.push({
              time: snappedTime,
              position: isLong ? "belowBar" : "aboveBar",
              color: isLong ? "#10b981" : "#ef4444",
              shape: isLong ? "arrowUp" : "arrowDown",
              text: `${isLong ? "LONG" : "SHORT"} $${trade.price.toFixed(0)}`,
            });
          } else if (trade.pnl != null) {
            markers.push({
              time: snappedTime,
              position: "aboveBar",
              color: isWin ? "#10b981" : isLoss ? "#ef4444" : "#6b7280",
              shape: "circle",
              text: `${isWin ? "+" : ""}$${trade.pnl.toFixed(0)}`,
            });
          }
        }

        // Sort markers by time (required by lightweight-charts)
        markers.sort((a, b) => (a.time as unknown as number) - (b.time as unknown as number));
        // Clean up old markers plugin
        if (markersRef.current) {
          try { markersRef.current.setMarkers([]); } catch {}
        }
        if (markers.length > 0) {
          markersRef.current = createSeriesMarkers(candleRef.current!, markers);
        }
      }

      // ── POSITION PRICE LINES ──
      // Clear old lines
      for (const line of priceLinesRef.current) {
        try { candleRef.current!.removePriceLine(line); } catch {}
      }
      priceLinesRef.current = [];

      if (posData?.positions) {
        const pos: Position | undefined = posData.positions.find(
          (p: Position) => matchesSymbol(p.symbol, symbol)
        );

        if (pos) {
          // Calculate R:R and risk info for labels
          const stopDist = pos.stopLoss ? Math.abs(pos.entryPrice - pos.stopLoss) : 0;
          const targetDist = pos.target ? Math.abs(pos.target - pos.entryPrice) : 0;
          const rr = stopDist > 0 && targetDist > 0 ? (targetDist / stopDist).toFixed(1) : "?";
          const pnlStr = pos.unrealizedPnl != null ? `${pos.unrealizedPnl >= 0 ? "+" : ""}$${pos.unrealizedPnl.toFixed(0)}` : "";
          const qtyStr = pos.quantity ? `${pos.quantity}x ` : "";
          const aiStr = pos.aiScore ? ` AI:${pos.aiScore}%` : "";

          // Entry line — shows direction, qty, price, R:R, and current P&L
          priceLinesRef.current.push(
            candleRef.current!.createPriceLine({
              price: pos.entryPrice,
              color: "#3b82f6",
              lineWidth: 2,
              lineStyle: 0,
              axisLabelVisible: true,
              title: `${qtyStr}${pos.direction.toUpperCase()} @ ${pos.entryPrice.toFixed(2)}  R:R ${rr}  ${pnlStr}${aiStr}`,
            })
          );

          // Stop loss line — shows price and dollar risk
          const mult = pos.multiplier || 5;
          if (pos.stopLoss) {
            const riskDollars = stopDist * (pos.quantity || 1) * mult;
            priceLinesRef.current.push(
              candleRef.current!.createPriceLine({
                price: pos.stopLoss,
                color: "#ef4444",
                lineWidth: 1,
                lineStyle: 2,
                axisLabelVisible: true,
                title: `STOP ${pos.stopLoss.toFixed(2)}  (-$${riskDollars.toFixed(0)})`,
              })
            );
          }

          // Target line — shows price and potential profit
          if (pos.target) {
            const rewardDollars = targetDist * (pos.quantity || 1) * mult;
            priceLinesRef.current.push(
              candleRef.current!.createPriceLine({
                price: pos.target,
                color: "#10b981",
                lineWidth: 1,
                lineStyle: 2,
                axisLabelVisible: true,
                title: `TARGET ${pos.target.toFixed(2)}  (+$${rewardDollars.toFixed(0)})`,
              })
            );
          }
        }
      }

      if (!isRefresh) {
        chartRef.current?.timeScale().fitContent();
      }

      setDataInfo({ state: "ok", count: bars.length, lastTs: meta?.lastBarTs ?? null, viewMode, provider });
      setLastUpdate(new Date().toLocaleTimeString());
    } catch (err) {
      console.error("Failed to load futures bars:", err);
      setDataInfo({ state: "error", msg: err instanceof Error ? err.message : "Failed to load bars from the data provider.", count: 0, lastTs: null, viewMode: null });
    } finally {
      if (!isRefresh) setLoading(false);
    }
  }, [symbol, activeIdx, showEMA, showVWAP]);

  // Initial load
  useEffect(() => {
    loadBars(false);
  }, [loadBars]);

  // Auto-refresh: poll for new bars every 15s when live
  useEffect(() => {
    if (!isLive) return;
    const interval = setInterval(() => loadBars(true), 15000);
    return () => clearInterval(interval);
  }, [isLive, loadBars]);

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
          <button
            onClick={() => setShowVWAP(!showVWAP)}
            className={`px-2 py-1 rounded text-[10px] font-bold transition-colors ${
              showVWAP
                ? "bg-indigo-500/15 text-indigo-400 border border-indigo-500/30"
                : "text-muted-foreground hover:text-foreground"
            }`}
          >
            VWAP
          </button>
          <button
            onClick={() => setIsLive(!isLive)}
            className={`px-2 py-1 rounded text-[10px] font-bold transition-colors ${
              isLive
                ? "bg-emerald-500/15 text-emerald-400 border border-emerald-500/30"
                : "text-muted-foreground hover:text-foreground"
            }`}
          >
            {isLive ? "LIVE" : "PAUSED"}
          </button>
          {isLive && lastUpdate && (
            <span className="text-[9px] text-muted-foreground/40 tabular-nums flex items-center gap-1">
              <span className="relative flex h-1.5 w-1.5">
                <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-75" />
                <span className="relative inline-flex rounded-full h-1.5 w-1.5 bg-emerald-400" />
              </span>
              {lastUpdate}
            </span>
          )}
          {loading && <span className="text-[10px] text-muted-foreground/50 animate-pulse">Loading...</span>}
        </div>
      </div>

      {/* Honest data-provider + environment status — tells the truth (Databento not yet the live feed). */}
      <div className="flex flex-wrap items-center gap-2 mb-2 text-[10px]">
        {dataInfo.viewMode && (
          <span className={`px-1.5 py-0.5 rounded font-bold tracking-wide ${dataInfo.viewMode === "live" ? "bg-red-500/15 text-red-400 border border-red-500/30" : "bg-amber-500/15 text-amber-400 border border-amber-500/30"}`}>
            {dataInfo.viewMode === "live" ? "LIVE · Phase 0" : "DEMO · research"}
          </span>
        )}
        <span className={`px-1.5 py-0.5 rounded border ${dataInfo.provider === "databento" ? "bg-cyan-500/10 text-cyan-300 border-cyan-500/30" : "bg-white/5 text-muted-foreground border-white/10"}`} title="Chart bars: Databento historical (~7-min delayed) when available, else Tradovate→Yahoo fallback. Engine real-time feed migrates after 4 PM.">
          Data: {dataInfo.provider === "databento" ? "Databento" : dataInfo.provider === "tradovate-yahoo" ? "Tradovate → Yahoo (fallback)" : "…"}
        </span>
        <span className="px-1.5 py-0.5 rounded bg-white/5 text-muted-foreground border border-white/10">Execution: Tradovate</span>
        {dataInfo.state === "ok" && (
          <span className="text-muted-foreground/50 tabular-nums">
            {dataInfo.count} bars{typeof dataInfo.lastTs === "number" ? ` · last ${new Date(dataInfo.lastTs * 1000).toLocaleTimeString()}` : ""}
            {typeof dataInfo.lastTs === "number" && Date.now() - dataInfo.lastTs * 1000 > 15 * 60_000 && <span className="text-amber-400"> · ⚠ stale</span>}
          </span>
        )}
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
      <div className="relative">
        <div ref={containerRef} className="w-full rounded-lg overflow-hidden" />
        {(dataInfo.state === "empty" || dataInfo.state === "error") && (
          <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
            <div className={`px-3 py-2 rounded-md text-[11px] text-center max-w-sm ${dataInfo.state === "error" ? "bg-red-500/10 text-red-300 border border-red-500/30" : "bg-white/5 text-muted-foreground border border-white/10"}`}>
              <div className="font-bold mb-0.5">{dataInfo.state === "error" ? "Chart data error" : "No bars to display"}</div>
              <div className="text-muted-foreground/70">{dataInfo.msg}</div>
            </div>
          </div>
        )}
      </div>

      {/* Legend */}
      <div className="flex items-center justify-between mt-2">
        <div className="flex gap-4 text-[10px]">
          {showEMA && (
            <>
              <span className="flex items-center gap-1.5">
                <span className="w-3 h-[2px] bg-blue-500 rounded" /> EMA 9
              </span>
              <span className="flex items-center gap-1.5">
                <span className="w-3 h-[2px] bg-amber-500 rounded" /> EMA 21
              </span>
            </>
          )}
          <span className="flex items-center gap-1.5">
            <span className="text-emerald-400">&#x25B2;</span> Long entry
          </span>
          <span className="flex items-center gap-1.5">
            <span className="text-red-400">&#x25BC;</span> Short entry
          </span>
          <span className="flex items-center gap-1.5">
            <span className="w-2 h-2 rounded-full bg-emerald-500 inline-block" /> Win
          </span>
          <span className="flex items-center gap-1.5">
            <span className="w-2 h-2 rounded-full bg-red-500 inline-block" /> Loss
          </span>
        </div>
        <span className="text-[9px] text-muted-foreground/30">
          Auto-refresh every 15s
        </span>
      </div>
    </div>
  );
}
