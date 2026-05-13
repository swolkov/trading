"use client";

import { useEffect, useRef, memo } from "react";

// Map internal contract symbols to TradingView symbols
// Micro futures aren't available in TradingView's embedded widget,
// so we map to full-size E-mini contracts (identical price action)
const TV_SYMBOL_MAP: Record<string, string> = {
  MES: "CME:ES1!",
  MNQ: "CME:NQ1!",
  MYM: "CBOT:YM1!",
  M2K: "CME:RTY1!",
  ES: "CME:ES1!",
  NQ: "CME:NQ1!",
  YM: "CBOT:YM1!",
  RTY: "CME:RTY1!",
};

interface TradingViewChartProps {
  symbol: string;
  height?: number;
}

function TradingViewChartInner({ symbol, height = 500 }: TradingViewChartProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const scriptRef = useRef<HTMLScriptElement | null>(null);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const tvSymbol = TV_SYMBOL_MAP[symbol] || symbol;

    // Clean up previous widget using DOM methods
    while (container.firstChild) {
      container.removeChild(container.firstChild);
    }

    // Create the widget container div (required by TradingView)
    const widgetDiv = document.createElement("div");
    widgetDiv.className = "tradingview-widget-container__widget";
    widgetDiv.style.height = "100%";
    widgetDiv.style.width = "100%";
    container.appendChild(widgetDiv);

    // Create and configure the TradingView script
    const script = document.createElement("script");
    script.src =
      "https://s3.tradingview.com/external-embedding/embed-widget-advanced-chart.js";
    script.type = "text/javascript";
    script.async = true;

    // TradingView reads config from the script's text content
    script.textContent = JSON.stringify({
      autosize: true,
      symbol: tvSymbol,
      interval: "5",
      timezone: "America/New_York",
      theme: "dark",
      style: "1",
      locale: "en",
      allow_symbol_change: true,
      calendar: false,
      support_host: "https://www.tradingview.com",
      hide_top_toolbar: false,
      hide_side_toolbar: false,
      withdateranges: true,
      details: false,
      hotlist: false,
      studies: ["STD;EMA"],
      backgroundColor: "rgba(0, 0, 0, 0)",
      gridColor: "rgba(255, 255, 255, 0.03)",
    });

    container.appendChild(script);
    scriptRef.current = script;

    return () => {
      // Clean up on unmount / re-render
      while (container.firstChild) {
        container.removeChild(container.firstChild);
      }
      scriptRef.current = null;
    };
  }, [symbol]);

  return (
    <div
      ref={containerRef}
      className="tradingview-widget-container w-full rounded-lg overflow-hidden"
      style={{ height }}
    />
  );
}

export const TradingViewChart = memo(TradingViewChartInner);
