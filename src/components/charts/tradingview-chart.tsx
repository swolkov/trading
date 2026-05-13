"use client";

import { useEffect, useRef, memo } from "react";

// TradingView's free embedded widget doesn't support futures symbols.
// Map to correlated ETFs — same price action, different price levels.
const TV_SYMBOL_MAP: Record<string, string> = {
  MES: "AMEX:SPY",
  MNQ: "NASDAQ:QQQ",
  MYM: "AMEX:DIA",
  M2K: "AMEX:IWM",
  ES: "AMEX:SPY",
  NQ: "NASDAQ:QQQ",
  YM: "AMEX:DIA",
  RTY: "AMEX:IWM",
};

const TV_LABEL_MAP: Record<string, string> = {
  MES: "SPY (S&P 500 ETF)",
  MNQ: "QQQ (Nasdaq 100 ETF)",
  MYM: "DIA (Dow ETF)",
  M2K: "IWM (Russell 2000 ETF)",
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
    // Use explicit width/height instead of autosize — autosize doesn't respect container
    script.textContent = JSON.stringify({
      width: "100%",
      height: height,
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
  }, [symbol, height]);

  const label = TV_LABEL_MAP[symbol];

  return (
    <div className="relative">
      {label && (
        <p className="text-[10px] text-muted-foreground/40 mb-1">
          Showing {label} — TradingView embed doesn&apos;t support futures. Use Lightweight for actual futures data.
        </p>
      )}
      <div
        ref={containerRef}
        className="tradingview-widget-container w-full rounded-lg overflow-hidden"
        style={{ height }}
      />
    </div>
  );
}

export const TradingViewChart = memo(TradingViewChartInner);
