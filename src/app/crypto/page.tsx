"use client";

import Link from "next/link";
import { useAccount } from "@/hooks/use-account";
import { usePositions } from "@/hooks/use-positions";
import { formatCurrency, pnlColor } from "@/lib/utils";
import { useEffect, useState, useMemo } from "react";
import useSWR from "swr";

const fetcher = (url: string) => fetch(url).then((r) => r.json());

interface CryptoSnapshotData {
  latestTrade: { p: number; s: number; t: string; tks: string };
  latestQuote: { bp: number; bs: number; ap: number; as: number; t: string };
  minuteBar: { t: string; o: number; h: number; l: number; c: number; v: number; vw: number; n: number };
  dailyBar: { t: string; o: number; h: number; l: number; c: number; v: number; vw: number; n: number };
  prevDailyBar: { t: string; o: number; h: number; l: number; c: number; v: number; vw: number; n: number };
}

const SYMBOLS = ["BTC/USD", "ETH/USD", "SOL/USD", "AVAX/USD", "DOGE/USD", "LINK/USD"];

function formatCryptoPrice(price: number): string {
  if (price >= 1000) return price.toLocaleString("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 });
  if (price >= 1) return price.toLocaleString("en-US", { style: "currency", currency: "USD", minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return price.toLocaleString("en-US", { style: "currency", currency: "USD", minimumFractionDigits: 4, maximumFractionDigits: 6 });
}

export default function CryptoPage() {
  const { data: account, isLoading: accountLoading } = useAccount();
  const { data: positions, isLoading: positionsLoading } = usePositions();
  const { data: modeData } = useSWR<{ modes: Record<string, string> }>("/api/trading-mode", (u: string) => fetch(u).then((r) => r.json()), { refreshInterval: 10000 });
  const viewMode = modeData?.modes?.crypto || "paper";
  const { data: snapshotData, isLoading: snapshotsLoading } = useSWR<{ snapshots: Record<string, CryptoSnapshotData> }>(
    "/api/crypto/snapshots",
    fetcher,
    { refreshInterval: 15000 }
  );

  const snapshots = snapshotData?.snapshots || {};

  // Filter to crypto-only positions
  const cryptoPositions = useMemo(() => positions?.filter((p) => p.asset_class === "crypto") || [], [positions]);

  const isLoading = accountLoading || positionsLoading;

  // Account metrics
  const equity = account ? parseFloat(account.equity) : 0;
  const buyingPower = account ? parseFloat(account.buying_power) : 0;
  const cryptoMarketValue = cryptoPositions.reduce((s, p) => s + Math.abs(parseFloat(p.market_value)), 0);
  const cryptoUnrealized = cryptoPositions.reduce((s, p) => s + parseFloat(p.unrealized_pl), 0);

  // Sort positions by market value descending
  const sortedPositions = useMemo(() =>
    [...cryptoPositions].sort((a, b) => Math.abs(parseFloat(b.market_value)) - Math.abs(parseFloat(a.market_value))),
    [cryptoPositions]
  );

  return (
    <div className="space-y-5 animate-fade-up">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-bold tracking-tight">Crypto</h1>
          <p className="text-[11px] text-muted-foreground/50">
            Alpaca {viewMode === "live" ? "live" : "paper"} — 24/7 crypto · No PDT
            <span className={`ml-2 inline-flex items-center gap-1 ${viewMode === "live" ? "text-red-400" : "text-emerald-400"}`}>
              <span className={`w-1.5 h-1.5 rounded-full ${viewMode === "live" ? "bg-red-400 animate-pulse" : "bg-emerald-400"}`} />
              {viewMode === "live" ? "Live" : "Demo"}
            </span>
          </p>
        </div>
        <div className="flex items-center gap-2">
          <span className="relative flex h-2 w-2">
            <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-purple-400 opacity-75" />
            <span className="relative inline-flex rounded-full h-2 w-2 bg-purple-400" />
          </span>
          <span className="text-[10px] text-purple-400/80 font-semibold uppercase tracking-wider">24/7 Market</span>
        </div>
      </div>

      {/* Account Metrics */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        {isLoading ? (
          Array.from({ length: 4 }).map((_, i) => (
            <div key={i} className="rounded-xl border border-white/[0.06] bg-white/[0.02] p-4">
              <div className="skeleton h-3 w-14 rounded mb-2" />
              <div className="skeleton h-6 w-20 rounded mb-1" />
              <div className="skeleton h-3 w-16 rounded" />
            </div>
          ))
        ) : (
          <>
            <div className="rounded-xl border border-purple-500/20 bg-gradient-to-br from-purple-500/[0.06] to-transparent p-4">
              <p className="text-[10px] text-purple-400/60 uppercase tracking-wider font-bold">Crypto Value</p>
              <p className="text-2xl font-black mt-1 tabular-nums">{formatCurrency(cryptoMarketValue)}</p>
              <p className="text-[11px] mt-0.5 text-muted-foreground/50">{cryptoPositions.length} positions</p>
            </div>
            <div className="rounded-xl border border-white/[0.06] bg-white/[0.02] p-4">
              <p className="text-[10px] text-muted-foreground/50 uppercase tracking-wider font-medium">Buying Power</p>
              <p className="text-xl font-bold mt-1 tabular-nums">{formatCurrency(buyingPower)}</p>
              <p className="text-[11px] mt-0.5 text-emerald-400/60">No PDT limit</p>
            </div>
            <div className="rounded-xl border border-white/[0.06] bg-white/[0.02] p-4">
              <p className="text-[10px] text-muted-foreground/50 uppercase tracking-wider font-medium">Unrealized</p>
              <p className={`text-xl font-bold mt-1 tabular-nums ${pnlColor(cryptoUnrealized)}`}>
                {cryptoUnrealized >= 0 ? "+" : ""}{formatCurrency(cryptoUnrealized)}
              </p>
              <p className="text-[11px] mt-0.5 text-muted-foreground/50">across all crypto</p>
            </div>
            <div className="rounded-xl border border-white/[0.06] bg-white/[0.02] p-4">
              <p className="text-[10px] text-muted-foreground/50 uppercase tracking-wider font-medium">Allocation</p>
              <p className={`text-xl font-bold mt-1 ${cryptoMarketValue > equity * 0.5 ? "text-amber-400" : "text-purple-400"}`}>
                {equity > 0 ? ((cryptoMarketValue / equity) * 100).toFixed(1) : "0"}%
              </p>
              <p className="text-[11px] mt-0.5 text-muted-foreground/50">of total equity</p>
            </div>
          </>
        )}
      </div>

      {/* Crypto Ticker Strip */}
      <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-2">
        {SYMBOLS.map((sym) => {
          const snap = snapshots[sym];
          const price = snap?.latestTrade?.p || 0;
          const prevClose = snap?.prevDailyBar?.c || 0;
          const change = prevClose > 0 ? ((price - prevClose) / prevClose) * 100 : 0;
          const vol = snap?.dailyBar?.v || 0;
          const label = sym.replace("/USD", "");

          return (
            <div key={sym} className="rounded-lg border border-white/[0.06] bg-white/[0.02] p-3 hover:bg-white/[0.04] transition-colors">
              <div className="flex items-center justify-between mb-1">
                <span className="text-[11px] font-bold">{label}</span>
                <span className={`text-[10px] font-bold tabular-nums ${change >= 0 ? "text-emerald-400" : "text-red-400"}`}>
                  {change >= 0 ? "+" : ""}{change.toFixed(2)}%
                </span>
              </div>
              <div className="text-[13px] font-black tabular-nums">
                {snapshotsLoading ? (
                  <div className="skeleton h-4 w-16 rounded" />
                ) : price > 0 ? (
                  formatCryptoPrice(price)
                ) : (
                  <span className="text-muted-foreground/30">—</span>
                )}
              </div>
              {vol > 0 && (
                <p className="text-[9px] text-muted-foreground/30 mt-1 tabular-nums">
                  Vol {vol >= 1e6 ? `${(vol / 1e6).toFixed(1)}M` : vol >= 1e3 ? `${(vol / 1e3).toFixed(0)}K` : vol.toFixed(0)}
                </p>
              )}
            </div>
          );
        })}
      </div>

      {/* Open Crypto Positions */}
      <div className="rounded-xl border border-white/[0.06] bg-white/[0.02] overflow-hidden">
        <div className="flex items-center justify-between px-4 py-3 border-b border-white/[0.06]">
          <div className="flex items-center gap-2">
            <p className="text-xs font-medium">Open Positions</p>
            <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-white/[0.06] text-muted-foreground/60 tabular-nums">{cryptoPositions.length}</span>
          </div>
          <Link href="/positions" className="text-[10px] text-purple-400 hover:underline">All Positions</Link>
        </div>

        {isLoading ? (
          <div className="divide-y divide-white/[0.04]">
            {Array.from({ length: 3 }).map((_, i) => (
              <div key={i} className="flex items-center justify-between px-4 py-3">
                <div className="flex items-center gap-3">
                  <div className="skeleton h-4 w-14 rounded" />
                  <div className="skeleton h-3 w-8 rounded" />
                </div>
                <div className="flex items-center gap-4">
                  <div className="skeleton h-3 w-16 rounded" />
                  <div className="skeleton h-3 w-14 rounded" />
                </div>
              </div>
            ))}
          </div>
        ) : sortedPositions.length > 0 ? (
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead>
                <tr className="text-muted-foreground/40 border-b border-white/[0.06]">
                  <th className="text-left px-4 py-2.5 font-medium">Symbol</th>
                  <th className="text-left px-2 py-2.5 font-medium">Side</th>
                  <th className="text-right px-2 py-2.5 font-medium">Qty</th>
                  <th className="text-right px-2 py-2.5 font-medium">Entry</th>
                  <th className="text-right px-2 py-2.5 font-medium">Current</th>
                  <th className="text-right px-2 py-2.5 font-medium">Mkt Value</th>
                  <th className="text-right px-2 py-2.5 font-medium">P&L</th>
                  <th className="text-right px-4 py-2.5 font-medium">% P&L</th>
                </tr>
              </thead>
              <tbody>
                {sortedPositions.map((pos) => {
                  const pl = parseFloat(pos.unrealized_pl);
                  const plPct = parseFloat(pos.unrealized_plpc) * 100;
                  return (
                    <tr key={pos.symbol} className="border-b border-white/[0.03] hover:bg-white/[0.02] transition-colors">
                      <td className="px-4 py-2.5">
                        <span className="font-bold">{pos.symbol.replace("/", "")}</span>
                      </td>
                      <td className="px-2 py-2.5">
                        <span className={`px-1.5 py-0.5 rounded text-[10px] font-bold ${
                          pos.side === "long" ? "bg-emerald-500/15 text-emerald-400" : "bg-red-500/15 text-red-400"
                        }`}>{pos.side.toUpperCase()}</span>
                      </td>
                      <td className="px-2 py-2.5 text-right tabular-nums">{parseFloat(pos.qty).toFixed(6)}</td>
                      <td className="px-2 py-2.5 text-right tabular-nums text-muted-foreground/60">{formatCryptoPrice(parseFloat(pos.avg_entry_price))}</td>
                      <td className="px-2 py-2.5 text-right tabular-nums">{formatCryptoPrice(parseFloat(pos.current_price))}</td>
                      <td className="px-2 py-2.5 text-right tabular-nums">{formatCurrency(pos.market_value)}</td>
                      <td className={`px-2 py-2.5 text-right font-bold tabular-nums ${pnlColor(pl)}`}>
                        {pl >= 0 ? "+" : ""}{formatCurrency(pl)}
                      </td>
                      <td className={`px-4 py-2.5 text-right font-medium tabular-nums ${pnlColor(plPct)}`}>
                        {plPct >= 0 ? "+" : ""}{plPct.toFixed(2)}%
                      </td>
                    </tr>
                  );
                })}
              </tbody>
              {sortedPositions.length > 0 && (
                <tfoot>
                  <tr className="border-t border-white/[0.08]">
                    <td className="px-4 py-2.5 font-bold text-[11px]" colSpan={5}>Total</td>
                    <td className="px-2 py-2.5 text-right font-bold tabular-nums">{formatCurrency(cryptoMarketValue)}</td>
                    <td className={`px-2 py-2.5 text-right font-bold tabular-nums ${pnlColor(cryptoUnrealized)}`}>
                      {cryptoUnrealized >= 0 ? "+" : ""}{formatCurrency(cryptoUnrealized)}
                    </td>
                    <td className="px-4 py-2.5" />
                  </tr>
                </tfoot>
              )}
            </table>
          </div>
        ) : (
          <div className="px-4 py-10 text-center">
            <p className="text-sm text-muted-foreground/40">No open crypto positions</p>
            <p className="text-[11px] text-muted-foreground/25 mt-1">
              Crypto trades 24/7 with no PDT restrictions — perfect for day trading
            </p>
          </div>
        )}
      </div>
    </div>
  );
}
