"use client";

import { formatCurrency, pnlColor } from "@/lib/utils";
import { Clock } from "lucide-react";
import useSWR from "swr";
import { useEffect, useState } from "react";

const fetcher = (url: string) => fetch(url).then((r) => r.json());

interface FuturesAccount {
  balance: number;
  netLiq: number;
  realizedPnl: number;
  marginUsed: number;
}

interface FuturesData {
  connected: boolean;
  account: FuturesAccount | null;
  startOfDayBalance?: number | null;
}

interface MarketClock {
  is_open: boolean;
  next_open: string;
  next_close: string;
}

function useMarketClock() {
  const [clock, setClock] = useState<MarketClock | null>(null);
  const [now, setNow] = useState(new Date());

  useEffect(() => {
    const fetchClock = () => {
      fetch("/api/clock").then((r) => r.json()).then((d) => { if (!d.error) setClock(d); }).catch(() => {});
    };
    fetchClock();
    const tickInterval = setInterval(() => setNow(new Date()), 1000);
    // Re-fetch clock data every 5 minutes to handle market open/close transitions
    const clockInterval = setInterval(fetchClock, 300000);
    return () => { clearInterval(tickInterval); clearInterval(clockInterval); };
  }, []);

  if (!clock) return { label: "", isOpen: false, countdown: "" };

  const isOpen = clock.is_open;
  const targetTime = isOpen ? new Date(clock.next_close) : new Date(clock.next_open);
  const diff = Math.max(0, targetTime.getTime() - now.getTime());
  const hours = Math.floor(diff / 3600000);
  const minutes = Math.floor((diff % 3600000) / 60000);
  const seconds = Math.floor((diff % 60000) / 1000);

  const countdown = hours > 0
    ? `${hours}h ${minutes}m`
    : `${minutes}m ${seconds}s`;

  return {
    label: isOpen ? "Market Open" : "Market Closed",
    isOpen,
    countdown: isOpen ? `Closes in ${countdown}` : `Opens in ${countdown}`,
  };
}

export function TopBar() {
  const { data: futuresData, isLoading: futuresLoading } = useSWR<FuturesData>(
    "/api/futures/positions",
    fetcher,
    { refreshInterval: 15000 }
  );
  const marketClock = useMarketClock();
  // Check if live trading is active for visual styling
  const { data: modeData } = useSWR<{ modes: Record<string, string> }>("/api/trading-mode", fetcher, { refreshInterval: 30000 });
  const isAnyLive = Object.values(modeData?.modes || {}).some((m) => m === "live");

  if (futuresLoading) {
    return (
      <header className="h-11 border-b border-border bg-sidebar flex items-center px-3 md:px-5 gap-3 md:gap-6">
        <div className="w-8 md:hidden shrink-0" />
        <div className="skeleton h-3.5 w-28 rounded" />
        <div className="skeleton h-3 w-20 rounded" />
        <div className="ml-auto skeleton h-3 w-32 rounded" />
      </header>
    );
  }

  // Tradovate data only — futures focused
  const equity = futuresData?.account?.netLiq || futuresData?.account?.balance || 0;
  const balance = futuresData?.account?.balance || 0;
  const sod = futuresData?.startOfDayBalance;
  const dailyPnl = (sod != null && balance) ? balance - sod : (futuresData?.account?.realizedPnl || 0);
  const dailyPct = sod && sod > 0 ? dailyPnl / sod : 0;
  const hasFutures = futuresData?.connected && futuresData.account;

  return (
    <header className={`h-11 border-b flex items-center px-3 md:px-5 gap-2 md:gap-5 overflow-x-auto transition-colors ${
      isAnyLive
        ? "border-red-500/20 bg-red-950/20"
        : "border-border bg-sidebar"
    }`}>
      {/* Spacer for mobile hamburger */}
      <div className="w-8 md:hidden shrink-0" />

      {/* Desktop: Futures metrics */}
      <div className="hidden md:flex items-center gap-5">
        <div className="flex items-center gap-1.5">
          <span className="text-[10px] text-muted-foreground/50 uppercase tracking-wider font-medium">Equity</span>
          <span className="text-[13px] font-bold tabular-nums">{formatCurrency(equity)}</span>
        </div>

        <div className="w-px h-4 bg-border" />

        <div className="flex items-center gap-1.5">
          <span className="text-[10px] text-muted-foreground/40 uppercase tracking-wider font-medium">Day</span>
          <span className={`text-[12px] font-bold tabular-nums ${pnlColor(dailyPnl)}`}>
            {dailyPnl >= 0 ? "+" : ""}{formatCurrency(dailyPnl)}
          </span>
          <span className={`text-[10px] font-medium tabular-nums opacity-60 ${pnlColor(dailyPnl)}`}>
            ({dailyPct >= 0 ? "+" : ""}{(dailyPct * 100).toFixed(2)}%)
          </span>
        </div>

        {hasFutures && (
          <>
            <div className="w-px h-4 bg-border" />
            <div className="flex items-center gap-1">
              <span className="w-1.5 h-1.5 rounded-full bg-blue-400" />
              <span className="text-[10px] text-muted-foreground/50 font-medium">Tradovate</span>
            </div>
          </>
        )}
      </div>

      {/* Mobile: compact view */}
      <div className="flex md:hidden items-center gap-2">
        <span className="text-[12px] font-bold tabular-nums">{formatCurrency(equity)}</span>
        <span className={`text-[11px] font-bold tabular-nums ${pnlColor(dailyPnl)}`}>
          {dailyPnl >= 0 ? "+" : ""}{formatCurrency(dailyPnl)}
        </span>
      </div>

      {/* Right side: mode indicator + market clock */}
      <div className="ml-auto flex items-center gap-3 shrink-0">
        {marketClock.label && (
          <div className="hidden md:flex items-center gap-1.5">
            <Clock className="w-3 h-3 text-muted-foreground/40" />
            <span className={`text-[10px] font-medium ${marketClock.isOpen ? "text-emerald-400" : "text-muted-foreground/50"}`}>
              {marketClock.countdown}
            </span>
          </div>
        )}

        {/* Mode indicator */}
        <ViewToggle />
      </div>
    </header>
  );
}

// ── Mode Indicator ──────────────────────────────────────
// Shows which mode the system is in. Not a button — just a status badge.
// Live activation controlled from Agent Hub only.
function ViewToggle() {
  const { data: modeData } = useSWR<{ modes: Record<string, string> }>("/api/trading-mode", fetcher, { refreshInterval: 30000 });
  const isLiveActive = modeData?.modes?.futures === "live";

  return (
    <div className={`flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[9px] font-bold uppercase tracking-wider ${
      isLiveActive
        ? "bg-red-500/15 text-red-400 ring-1 ring-red-500/30"
        : "bg-emerald-500/15 text-emerald-400 ring-1 ring-emerald-500/30"
    }`}>
      {isLiveActive ? (
        <><span className="w-1.5 h-1.5 rounded-full bg-red-400 animate-pulse" /> Live</>
      ) : (
        <><span className="w-1.5 h-1.5 rounded-full bg-emerald-400" /> Demo</>
      )}
    </div>
  );
}
