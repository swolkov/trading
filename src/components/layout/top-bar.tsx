"use client";

import { formatCurrency, pnlColor } from "@/lib/utils";
import { Clock } from "lucide-react";
import useSWR, { mutate } from "swr";
import { useEffect, useRef, useState } from "react";

const fetcher = (url: string) => fetch(url).then((r) => r.json());

interface FuturesAccount {
  balance: number;
  netLiq: number;
  realizedPnl: number;
  unrealizedPnl: number;
  marginUsed: number;
}

interface FuturesData {
  connected: boolean;
  account: FuturesAccount | null;
  startOfDayBalance?: number | null;
  todayTradesPnl?: number | null;
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

  // Futures equity (primary display in top bar)
  // Fall back to startOfDayBalance when Tradovate is disconnected (avoids showing $0)
  const futuresEquity = futuresData?.account?.netLiq || futuresData?.account?.balance || futuresData?.startOfDayBalance || 0;
  const balance = futuresData?.account?.balance || futuresData?.startOfDayBalance || 0;
  const sod = futuresData?.startOfDayBalance;
  // Primary: sum of today's actual trade P&Ls + any unrealized P&L (most reliable)
  // Fallback: balance - SOD (can be wrong if SOD is stale from engine restart)
  const tradePnl = futuresData?.todayTradesPnl;
  const unrealizedPnl = futuresData?.account?.unrealizedPnl || 0;
  const balanceDelta = (sod != null && balance) ? balance - sod : null;
  const dailyPnl = tradePnl != null
    ? tradePnl + unrealizedPnl
    : (balanceDelta ?? 0);
  const dailyPct = sod && sod > 0 ? dailyPnl / sod : (balance > 0 ? dailyPnl / balance : 0);
  const hasFutures = futuresData?.connected && futuresData.account;
  const equity = futuresEquity;

  return (
    <header className={`h-11 border-b flex items-center transition-colors relative ${
      isAnyLive
        ? "border-red-500/20 bg-red-950/20"
        : "border-border bg-sidebar"
    }`}>
      {/* Scrollable content area */}
      <div className="flex items-center gap-2 md:gap-5 px-3 md:px-5 overflow-x-auto flex-1 h-full">
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
      </div>

      {/* Right side: mode indicator + market clock — OUTSIDE overflow container */}
      <div className="flex items-center gap-3 shrink-0 pr-3 md:pr-5">
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

// ── View Mode Toggle ──────────────────────────────────────
// Switches which account data you VIEW (demo vs live).
// Trade execution is separately gated by agent config on /agents page.
const VIEW_TYPES = [
  { key: "futures", label: "Futures", broker: "Tradovate" },
  { key: "stocks", label: "Stocks & Crypto", broker: "Alpaca" },
] as const;

function ViewToggle() {
  const { data: modeData } = useSWR<{ modes: Record<string, string> }>("/api/trading-mode", fetcher, { refreshInterval: 30000 });
  const modes = modeData?.modes || {};
  // Futures-only: just check futures mode for the pill badge
  const futuresLive = modes["futures"] === "live";
  const anyLive = futuresLive;
  const mixed = false; // No mixed state — futures only

  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState<string | null>(null);
  const popoverRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (popoverRef.current && !popoverRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [open]);

  const switchMode = async (type: string, mode: "paper" | "live") => {
    setLoading(type);
    try {
      // Optimistic update — instantly show new mode before server responds
      await mutate("/api/trading-mode", { modes: { ...modes, [type]: mode } }, false);

      const res = await fetch("/api/trading-mode", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ type, mode }),
      });
      if (res.ok) {
        // Revalidate mode from server (confirms optimistic update)
        await mutate("/api/trading-mode");
        // Revalidate page data with a small delay so server-side cache clears
        setTimeout(() => {
          mutate((key) => typeof key === "string" && key.startsWith("/api/") && key !== "/api/trading-mode", undefined, { revalidate: true });
        }, 300);
      } else {
        // Revert optimistic update on failure
        await mutate("/api/trading-mode");
      }
    } catch {
      // Revert on error
      await mutate("/api/trading-mode");
    } finally {
      setLoading(null);
    }
  };

  const pillColor = mixed
    ? "bg-amber-500/15 text-amber-400 ring-1 ring-amber-500/30"
    : anyLive
      ? "bg-red-500/15 text-red-400 ring-1 ring-red-500/30"
      : "bg-emerald-500/15 text-emerald-400 ring-1 ring-emerald-500/30";

  const pillLabel = mixed ? "Mixed" : anyLive ? "Live" : "Demo";
  const dotColor = mixed ? "bg-amber-400" : anyLive ? "bg-red-400" : "bg-emerald-400";

  return (
    <div className="relative" ref={popoverRef}>
      <button
        onClick={() => setOpen(!open)}
        className={`flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[9px] font-bold uppercase tracking-wider cursor-pointer transition-opacity hover:opacity-80 ${pillColor}`}
      >
        <span className={`w-1.5 h-1.5 rounded-full ${dotColor} ${anyLive ? "animate-pulse" : ""}`} />
        {pillLabel}
      </button>

      {open && (
        <div className="absolute right-0 top-full mt-2 w-60 rounded-xl border border-border bg-background shadow-2xl z-50 p-3">
          <div className="text-[10px] text-muted-foreground uppercase tracking-wider mb-2 font-bold">
            View Account
          </div>
          {VIEW_TYPES.map(({ key, label, broker }) => {
            const isLive = modes[key] === "live";
            return (
              <div key={key} className="flex items-center gap-2 px-1 py-2 border-b border-border/50 last:border-0">
                <span className="text-[12px] font-bold text-foreground flex-1">{label}</span>
                <span className="text-[9px] text-muted-foreground/50 uppercase tracking-wider mr-2">{broker}</span>
                <div className="flex rounded-lg overflow-hidden ring-1 ring-border">
                  <button
                    onClick={() => switchMode(key, "paper")}
                    disabled={loading === key || !isLive}
                    className={`px-3 py-1 text-[10px] font-bold transition-colors ${
                      !isLive ? "bg-emerald-500/20 text-emerald-500" : "text-muted-foreground hover:bg-muted"
                    } disabled:opacity-40`}
                  >
                    Demo
                  </button>
                  <button
                    onClick={() => switchMode(key, "live")}
                    disabled={loading === key || isLive}
                    className={`px-3 py-1 text-[10px] font-bold transition-colors ${
                      isLive ? "bg-red-500/20 text-red-500" : "text-muted-foreground hover:bg-muted"
                    } disabled:opacity-40`}
                  >
                    Live
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
