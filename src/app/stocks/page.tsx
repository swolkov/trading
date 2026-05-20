"use client";

import Link from "next/link";
import { useAccount } from "@/hooks/use-account";
import { usePositions } from "@/hooks/use-positions";
import { formatCurrency, pnlColor } from "@/lib/utils";
import { useEffect, useState, useMemo } from "react";
import useSWR from "swr";

interface TradeAnalysis {
  stats: {
    totalTrades: number;
    openTrades: number;
    winners: number;
    losers: number;
    winRate: number;
    totalPnl: number;
    avgWin: number;
    avgLoss: number;
    profitFactor: number;
  };
  trades: {
    symbol: string;
    underlying: string;
    type: string;
    openSide: string;
    openDate: string;
    openPrice: number;
    openQty: number;
    closeDate: string | null;
    closePrice: number | null;
    pnl: number | null;
    pnlPct: number | null;
    holdDays: number | null;
    status: string;
  }[];
}

function parseOptionSymbol(symbol: string) {
  return /^[A-Z]+\d{6}[CP]\d+$/.test(symbol);
}

export default function StocksPage() {
  const { data: account, isLoading: accountLoading } = useAccount();
  const { data: positions, isLoading: positionsLoading } = usePositions();
  const { data: modeData } = useSWR<{ modes: Record<string, string> }>("/api/trading-mode", (u: string) => fetch(u).then((r) => r.json()), { refreshInterval: 10000 });
  const viewMode = modeData?.modes?.stocks || "paper";
  const [analysis, setAnalysis] = useState<TradeAnalysis | null>(null);
  const [analysisLoading, setAnalysisLoading] = useState(true);

  useEffect(() => {
    fetch("/api/trades/analysis").then((r) => r.json()).then((d) => {
      if (d && !d.error) setAnalysis(d);
    }).catch(() => {}).finally(() => setAnalysisLoading(false));
  }, []);

  const isLoading = accountLoading || positionsLoading;

  // Filter to stock-only positions (not options, not crypto)
  const stockPositions = useMemo(() => positions?.filter((p) => !parseOptionSymbol(p.symbol) && p.asset_class !== "crypto") || [], [positions]);

  // Account metrics
  const equity = account ? parseFloat(account.equity) : 0;
  const cash = account ? parseFloat(account.cash) : 0;
  const buyingPower = account ? parseFloat(account.buying_power) : 0;

  const totalMarketValue = stockPositions.reduce((s, p) => s + Math.abs(parseFloat(p.market_value)), 0);
  const totalUnrealized = stockPositions.reduce((s, p) => s + parseFloat(p.unrealized_pl), 0);
  // Stock-only daily P&L from position-level data (not account-level which mixes crypto)
  const dailyPnl = stockPositions.reduce((s, p) => {
    const qty = parseFloat(p.qty);
    const current = parseFloat(p.current_price);
    const lastday = parseFloat(p.lastday_price);
    return s + (current - lastday) * qty;
  }, 0);
  const costBasis = stockPositions.reduce((s, p) => s + Math.abs(parseFloat(p.cost_basis)), 0);
  const dailyPnlPct = costBasis > 0 ? (dailyPnl / costBasis) * 100 : 0;
  const stockExposurePct = equity > 0 ? (totalMarketValue / equity) * 100 : 0;

  // Stock-only trades from analysis
  const stockTrades = useMemo(() => analysis?.trades.filter((t) => t.type === "STOCK") || [], [analysis]);
  const recentStockTrades = stockTrades.slice(0, 20);

  // Sort positions by market value descending
  const sortedPositions = useMemo(() =>
    [...stockPositions].sort((a, b) => Math.abs(parseFloat(b.market_value)) - Math.abs(parseFloat(a.market_value))),
    [stockPositions]
  );

  return (
    <div className="space-y-5 animate-fade-up">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-bold tracking-tight">Stocks</h1>
          <p className="text-[11px] text-muted-foreground/50">
            Alpaca {viewMode === "live" ? "live" : "paper"} — equity positions
            <span className={`ml-2 inline-flex items-center gap-1 ${viewMode === "live" ? "text-red-400" : "text-emerald-400"}`}>
              <span className={`w-1.5 h-1.5 rounded-full ${viewMode === "live" ? "bg-red-400 animate-pulse" : "bg-emerald-400"}`} />
              {viewMode === "live" ? "Live" : "Demo"}
            </span>
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Link href="/trade" className="text-xs px-3 py-1.5 rounded-lg bg-emerald-500/10 text-emerald-400 hover:bg-emerald-500/20 transition-colors border border-emerald-500/20 font-medium">
            Trade
          </Link>
          <Link href="/crypto" className="text-xs px-3 py-1.5 rounded-lg bg-purple-500/10 text-purple-400 hover:bg-purple-500/20 transition-colors border border-purple-500/20 font-medium">
            Crypto
          </Link>
        </div>
      </div>

      {/* Account Metrics */}
      <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
        {isLoading ? (
          Array.from({ length: 5 }).map((_, i) => (
            <div key={i} className="rounded-xl border border-white/[0.06] bg-white/[0.02] p-4">
              <div className="skeleton h-3 w-14 rounded mb-2" />
              <div className="skeleton h-6 w-20 rounded mb-1" />
              <div className="skeleton h-3 w-16 rounded" />
            </div>
          ))
        ) : (
          <>
            <div className="rounded-xl border border-blue-500/20 bg-gradient-to-br from-blue-500/[0.06] to-transparent p-4">
              <p className="text-[10px] text-blue-400/60 uppercase tracking-wider font-bold">Equity</p>
              <p className="text-2xl font-black mt-1 tabular-nums">{formatCurrency(equity)}</p>
              <p className={`text-[11px] mt-0.5 font-medium ${pnlColor(dailyPnl)}`}>
                {dailyPnl >= 0 ? "+" : ""}{formatCurrency(dailyPnl)} ({dailyPnlPct >= 0 ? "+" : ""}{dailyPnlPct.toFixed(2)}%)
              </p>
            </div>
            <div className="rounded-xl border border-white/[0.06] bg-white/[0.02] p-4">
              <p className="text-[10px] text-muted-foreground/50 uppercase tracking-wider font-medium">Cash</p>
              <p className="text-xl font-bold mt-1 tabular-nums">{formatCurrency(cash)}</p>
              <p className="text-[11px] mt-0.5 text-muted-foreground/50">{equity > 0 ? ((cash / equity) * 100).toFixed(0) : 0}% of account</p>
            </div>
            <div className="rounded-xl border border-white/[0.06] bg-white/[0.02] p-4">
              <p className="text-[10px] text-muted-foreground/50 uppercase tracking-wider font-medium">Buying Power</p>
              <p className="text-xl font-bold mt-1 tabular-nums">{formatCurrency(buyingPower)}</p>
              <p className="text-[11px] mt-0.5 text-muted-foreground/50">{equity > 0 ? ((buyingPower / equity) * 100).toFixed(0) : 0}% available</p>
            </div>
            <div className="rounded-xl border border-white/[0.06] bg-white/[0.02] p-4">
              <p className="text-[10px] text-muted-foreground/50 uppercase tracking-wider font-medium">Unrealized</p>
              <p className={`text-xl font-bold mt-1 tabular-nums ${pnlColor(totalUnrealized)}`}>
                {totalUnrealized >= 0 ? "+" : ""}{formatCurrency(totalUnrealized)}
              </p>
              <p className="text-[11px] mt-0.5 text-muted-foreground/50">{stockPositions.length} positions</p>
            </div>
            <div className="rounded-xl border border-white/[0.06] bg-white/[0.02] p-4">
              <p className="text-[10px] text-muted-foreground/50 uppercase tracking-wider font-medium">Exposure</p>
              <p className={`text-xl font-bold mt-1 ${stockExposurePct > 80 ? "text-red-400" : stockExposurePct > 50 ? "text-amber-400" : "text-emerald-400"}`}>
                {stockExposurePct.toFixed(0)}%
              </p>
              <p className="text-[11px] mt-0.5 text-muted-foreground/50">{formatCurrency(totalMarketValue)} invested</p>
            </div>
          </>
        )}
      </div>

      {/* Open Stock Positions */}
      <div className="rounded-xl border border-white/[0.06] bg-white/[0.02] overflow-hidden">
        <div className="flex items-center justify-between px-4 py-3 border-b border-white/[0.06]">
          <div className="flex items-center gap-2">
            <p className="text-xs font-medium">Open Positions</p>
            <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-white/[0.06] text-muted-foreground/60 tabular-nums">{stockPositions.length}</span>
          </div>
          <Link href="/positions" className="text-[10px] text-emerald-400 hover:underline">All Positions</Link>
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
                  <div className="skeleton h-3 w-10 rounded" />
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
                  <th className="text-right px-2 py-2.5 font-medium">Weight</th>
                  <th className="text-right px-2 py-2.5 font-medium">P&L</th>
                  <th className="text-right px-4 py-2.5 font-medium">% P&L</th>
                </tr>
              </thead>
              <tbody>
                {sortedPositions.map((pos) => {
                  const pl = parseFloat(pos.unrealized_pl);
                  const plPct = parseFloat(pos.unrealized_plpc) * 100;
                  const mktVal = Math.abs(parseFloat(pos.market_value));
                  const weight = equity > 0 ? (mktVal / equity) * 100 : 0;
                  return (
                    <tr key={pos.symbol} className="border-b border-white/[0.03] hover:bg-white/[0.02] transition-colors">
                      <td className="px-4 py-2.5">
                        <Link href={`/research/${pos.symbol}`} className="font-bold hover:text-emerald-400 transition-colors">{pos.symbol}</Link>
                      </td>
                      <td className="px-2 py-2.5">
                        <span className={`px-1.5 py-0.5 rounded text-[10px] font-bold ${
                          pos.side === "long" ? "bg-emerald-500/15 text-emerald-400" : "bg-red-500/15 text-red-400"
                        }`}>{pos.side.toUpperCase()}</span>
                      </td>
                      <td className="px-2 py-2.5 text-right tabular-nums">{pos.qty}</td>
                      <td className="px-2 py-2.5 text-right tabular-nums text-muted-foreground/60">${parseFloat(pos.avg_entry_price).toFixed(2)}</td>
                      <td className="px-2 py-2.5 text-right tabular-nums">${parseFloat(pos.current_price).toFixed(2)}</td>
                      <td className="px-2 py-2.5 text-right tabular-nums">{formatCurrency(pos.market_value)}</td>
                      <td className="px-2 py-2.5 text-right">
                        <div className="flex items-center justify-end gap-1.5">
                          <div className="w-12 h-1.5 rounded-full bg-white/[0.06] overflow-hidden">
                            <div className="h-full rounded-full bg-blue-400/50" style={{ width: `${Math.min(100, weight)}%` }} />
                          </div>
                          <span className="text-[10px] tabular-nums text-muted-foreground/50 w-7 text-right">{weight.toFixed(0)}%</span>
                        </div>
                      </td>
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
                    <td className="px-2 py-2.5 text-right font-bold tabular-nums">{formatCurrency(totalMarketValue)}</td>
                    <td className="px-2 py-2.5 text-right font-bold tabular-nums text-[10px]">{stockExposurePct.toFixed(0)}%</td>
                    <td className={`px-2 py-2.5 text-right font-bold tabular-nums ${pnlColor(totalUnrealized)}`}>
                      {totalUnrealized >= 0 ? "+" : ""}{formatCurrency(totalUnrealized)}
                    </td>
                    <td className="px-4 py-2.5" />
                  </tr>
                </tfoot>
              )}
            </table>
          </div>
        ) : (
          <div className="px-4 py-10 text-center">
            <p className="text-sm text-muted-foreground/40">No open stock positions</p>
            <p className="text-[11px] text-muted-foreground/25 mt-1">
              <Link href="/trade" className="text-emerald-400 hover:underline">Place a trade</Link> to get started
            </p>
          </div>
        )}
      </div>

      {/* Recent Stock Trades */}
      {!analysisLoading && recentStockTrades.length > 0 && (
        <div className="rounded-xl border border-white/[0.06] bg-white/[0.02] overflow-hidden">
          <div className="flex items-center justify-between px-4 py-3 border-b border-white/[0.06]">
            <p className="text-xs font-medium">Recent Trades</p>
            <Link href="/performance" className="text-[10px] text-emerald-400 hover:underline">Full History</Link>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead>
                <tr className="text-muted-foreground/40 border-b border-white/[0.06]">
                  <th className="text-left px-4 py-2 font-medium">Date</th>
                  <th className="text-left px-2 py-2 font-medium">Symbol</th>
                  <th className="text-left px-2 py-2 font-medium">Side</th>
                  <th className="text-right px-2 py-2 font-medium">Qty</th>
                  <th className="text-right px-2 py-2 font-medium">Entry</th>
                  <th className="text-right px-2 py-2 font-medium">Exit</th>
                  <th className="text-right px-2 py-2 font-medium">P&L</th>
                  <th className="text-center px-4 py-2 font-medium">Result</th>
                </tr>
              </thead>
              <tbody>
                {recentStockTrades.map((t, i) => (
                  <tr key={i} className="border-b border-white/[0.03] hover:bg-white/[0.02]">
                    <td className="px-4 py-2 text-muted-foreground/50 tabular-nums">
                      {new Date(t.openDate).toLocaleDateString("en-US", { month: "short", day: "numeric" })}
                    </td>
                    <td className="px-2 py-2 font-bold">{t.underlying || t.symbol}</td>
                    <td className="px-2 py-2">
                      <span className={t.openSide === "buy" ? "text-emerald-400" : "text-red-400"}>
                        {t.openSide.toUpperCase()}
                      </span>
                    </td>
                    <td className="px-2 py-2 text-right tabular-nums">{t.openQty}</td>
                    <td className="px-2 py-2 text-right tabular-nums">${t.openPrice.toFixed(2)}</td>
                    <td className="px-2 py-2 text-right tabular-nums">{t.closePrice ? `$${t.closePrice.toFixed(2)}` : "—"}</td>
                    <td className={`px-2 py-2 text-right font-bold tabular-nums ${t.pnl != null ? pnlColor(t.pnl) : ""}`}>
                      {t.pnl != null ? `${t.pnl >= 0 ? "+" : ""}${formatCurrency(t.pnl)}` : "Open"}
                    </td>
                    <td className="px-4 py-2 text-center">
                      {t.status === "open" ? (
                        <span className="px-2 py-0.5 rounded-full text-[10px] bg-blue-500/15 text-blue-400 font-bold">OPEN</span>
                      ) : t.status === "winner" ? (
                        <span className="px-2 py-0.5 rounded-full text-[10px] bg-emerald-500/15 text-emerald-400 font-bold">WIN</span>
                      ) : (
                        <span className="px-2 py-0.5 rounded-full text-[10px] bg-red-500/15 text-red-400 font-bold">LOSS</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Trade Stats Summary */}
      {analysis && (
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          <div className="rounded-xl border border-white/[0.06] bg-white/[0.02] p-4">
            <p className="text-[10px] text-muted-foreground/50 uppercase tracking-wider font-medium">Total Realized</p>
            <p className={`text-xl font-black mt-1 tabular-nums ${pnlColor(analysis.stats.totalPnl)}`}>
              {analysis.stats.totalPnl >= 0 ? "+" : ""}{formatCurrency(analysis.stats.totalPnl)}
            </p>
            <p className="text-[11px] mt-0.5 text-muted-foreground/50">{analysis.stats.totalTrades} trades</p>
          </div>
          <div className="rounded-xl border border-white/[0.06] bg-white/[0.02] p-4">
            <p className="text-[10px] text-muted-foreground/50 uppercase tracking-wider font-medium">Win Rate</p>
            <p className={`text-xl font-black mt-1 ${analysis.stats.winRate >= 55 ? "text-emerald-400" : "text-red-400"}`}>
              {analysis.stats.winRate}%
            </p>
            <p className="text-[11px] mt-0.5 text-muted-foreground/50">{analysis.stats.winners}W / {analysis.stats.losers}L</p>
          </div>
          <div className="rounded-xl border border-white/[0.06] bg-white/[0.02] p-4">
            <p className="text-[10px] text-muted-foreground/50 uppercase tracking-wider font-medium">Avg Win</p>
            <p className="text-xl font-black mt-1 text-emerald-400 tabular-nums">+{formatCurrency(analysis.stats.avgWin)}</p>
          </div>
          <div className="rounded-xl border border-white/[0.06] bg-white/[0.02] p-4">
            <p className="text-[10px] text-muted-foreground/50 uppercase tracking-wider font-medium">Avg Loss</p>
            <p className="text-xl font-black mt-1 text-red-400 tabular-nums">-{formatCurrency(analysis.stats.avgLoss)}</p>
          </div>
        </div>
      )}
    </div>
  );
}
