"use client";

import useSWR from "swr";
import Link from "next/link";

// ============ PAPER TRADES ============
// The shadow experiment's home. Every strategy the system runs on paper — scored on real
// Kraken prices with Spencer's real fees + rollover, zero money at risk — lives here:
// the tracked-signal record, the per-strategy scoreboard (what's working), and the full
// trade log. This is the record that has to show a real edge before anything goes live.

const fetcher = (u: string) => fetch(u).then((r) => r.json());

interface ConvictionTier {
  tier: string; resolved: number; wins: number; hitRate: number | null; totalPnl: number;
}
interface ShadowScore {
  resolved: number; wins: number; hitRate: number | null; totalPnl: number;
  avgWin: number; avgLoss: number; open: number; byConviction?: ConvictionTier[];
}
interface StrategyStat {
  key: string; label: string; resolved: number; wins: number; hitRate: number | null;
  avgWin: number; avgLoss: number; expectancy: number | null; totalPnl: number; open: number;
}
interface PaperTradeRow {
  id: number; time: string; source: string; symbol: string; side: string;
  leverage: number | null; conviction: string | null; entry: number | null;
  exit: number | null; pnl: number | null; status: string; reason: string | null;
}

const money = (n: number) => `${n < 0 ? "−" : ""}$${Math.abs(n).toLocaleString(undefined, { maximumFractionDigits: 0 })}`;
const money2 = (n: number) => `${n < 0 ? "−" : "+"}$${Math.abs(n).toFixed(2)}`;
const col = (n: number) => (n > 0 ? "text-emerald-400" : n < 0 ? "text-red-400" : "text-muted-foreground");

export default function PaperTradesPage() {
  const { data: score } = useSWR<{ shadow: ShadowScore | null; strategies: StrategyStat[]; log: PaperTradeRow[] }>(
    "/api/margin/scoreboard", fetcher, { refreshInterval: 60_000 },
  );

  const hasAny = !!score && (
    (score.shadow && (score.shadow.resolved > 0 || score.shadow.open > 0)) ||
    (score.log && score.log.length > 0)
  );

  return (
    <div className="space-y-5">
      {/* ── Header ── */}
      <div>
        <h2 className="text-xl font-bold tracking-tight">Paper Trades</h2>
        <p className="text-[11px] text-muted-foreground/50">
          The shadow experiment — every strategy scored on real prices with your real fees + rollover, no money at risk.
          This is the record that has to prove an edge before anything goes live.
        </p>
      </div>

      {/* ── Empty state ── */}
      {!hasAny && (
        <div className="rounded-xl border border-border bg-card p-8 text-center">
          <p className="text-sm text-muted-foreground/60">No paper trades yet.</p>
          <p className="text-[11px] text-muted-foreground/40 mt-1">
            The scanner opens them automatically as breakouts fire (a few times an hour). They&apos;ll appear here and score themselves to a win or loss — check back soon.
          </p>
        </div>
      )}

      {/* ── Tracked-signal paper record ── */}
      {score?.shadow && (score.shadow.resolved > 0 || score.shadow.open > 0) && (
        <div className="rounded-xl border border-purple-500/20 bg-purple-500/[0.03] p-4">
          <div className="flex items-center justify-between mb-2">
            <p className="text-xs font-bold">📊 Tracked-Signal Paper Record — would these have made money?</p>
            <p className="text-[10px] text-muted-foreground/45">{score.shadow.open} still open · no real money</p>
          </div>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
            <div>
              <p className="text-[9px] text-muted-foreground/60 uppercase tracking-wider">Resolved</p>
              <p className="text-lg font-black tabular-nums">{score.shadow.resolved}</p>
            </div>
            <div>
              <p className="text-[9px] text-muted-foreground/60 uppercase tracking-wider">Hit rate</p>
              <p className={`text-lg font-black tabular-nums ${score.shadow.hitRate != null && score.shadow.hitRate >= 0.5 ? "text-emerald-400" : "text-amber-400"}`}>
                {score.shadow.hitRate != null ? `${(score.shadow.hitRate * 100).toFixed(0)}%` : "—"}
              </p>
            </div>
            <div>
              <p className="text-[9px] text-muted-foreground/60 uppercase tracking-wider">Avg win / loss</p>
              <p className="text-lg font-black tabular-nums">
                <span className="text-emerald-400">{money(score.shadow.avgWin)}</span>
                <span className="text-muted-foreground/40 mx-1">/</span>
                <span className="text-red-400">{money(score.shadow.avgLoss)}</span>
              </p>
            </div>
            <div>
              <p className="text-[9px] text-muted-foreground/60 uppercase tracking-wider">Would-be P&L</p>
              <p className={`text-lg font-black tabular-nums ${col(score.shadow.totalPnl)}`}>{money(score.shadow.totalPnl)}</p>
            </div>
          </div>
          {score.shadow.byConviction && score.shadow.byConviction.some((t) => t.resolved > 0) && (
            <div className="mt-3 pt-3 border-t border-purple-500/15">
              <p className="text-[9px] text-muted-foreground/60 uppercase tracking-wider mb-1.5">
                Does conviction matter? — win rate by how many signals agreed
              </p>
              <div className="space-y-1">
                {score.shadow.byConviction.filter((t) => t.resolved > 0).map((t) => (
                  <div key={t.tier} className="flex items-center gap-3 text-[11px] tabular-nums">
                    <span className="w-16 font-semibold capitalize text-foreground/70">{t.tier}</span>
                    <span className={`w-12 font-bold ${t.hitRate != null && t.hitRate >= 0.5 ? "text-emerald-400" : "text-amber-400"}`}>
                      {t.hitRate != null ? `${(t.hitRate * 100).toFixed(0)}%` : "—"}
                    </span>
                    <span className="w-20 text-muted-foreground/50">{t.wins}/{t.resolved} won</span>
                    <span className={`font-bold ${col(t.totalPnl)}`}>{money(t.totalPnl)}</span>
                  </div>
                ))}
              </div>
              <p className="text-[10px] text-muted-foreground/40 mt-1.5">
                If <span className="text-foreground/60">high</span> beats <span className="text-foreground/60">low</span> here over enough trades, conviction is a real edge worth sizing into. If not, it&apos;s a feeling — and this is how we&apos;d know.
              </p>
            </div>
          )}
          <p className="text-[10px] text-muted-foreground/40 mt-2">
            Estimate — each trade followed to a stop/target/48h outcome, net of fees calibrated to your real fills (<span className="text-foreground/60">~0.15% maker in + 0.25% taker out</span>) and per-coin 4h rollover (<span className="text-foreground/60">BTC ~0.015%, alts ~0.03% per 4h</span>), all on notional so they scale with leverage. Spot swings pay no rollover.
          </p>
        </div>
      )}

      {/* ── Strategy scoreboard: what's working ── */}
      {score?.strategies && score.strategies.some((s) => s.resolved > 0 || s.open > 0) && (
        <div className="rounded-xl border border-border bg-card overflow-hidden">
          <div className="flex items-center justify-between px-4 py-2.5 border-b border-border">
            <p className="text-xs font-bold">🧭 Strategy Scoreboard — what&apos;s actually working</p>
            <p className="text-[10px] text-muted-foreground/45">paper · expectancy = avg $/trade after fees</p>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-[11px]">
              <thead>
                <tr className="text-[9px] uppercase tracking-wider text-muted-foreground/50 border-b border-border/50">
                  <th className="text-left font-medium px-4 py-1.5">Strategy</th>
                  <th className="text-right font-medium px-2 py-1.5">Resolved</th>
                  <th className="text-right font-medium px-2 py-1.5">Open</th>
                  <th className="text-right font-medium px-2 py-1.5">Hit rate</th>
                  <th className="text-right font-medium px-2 py-1.5">Avg win / loss</th>
                  <th className="text-right font-medium px-2 py-1.5">Expectancy</th>
                  <th className="text-right font-medium px-4 py-1.5">Total P&amp;L</th>
                </tr>
              </thead>
              <tbody>
                {score.strategies.map((s) => (
                  <tr key={s.key} className="border-b border-border/30 last:border-0">
                    <td className="text-left px-4 py-2 font-semibold text-foreground/80">{s.label}</td>
                    <td className="text-right px-2 py-2 tabular-nums">{s.resolved}</td>
                    <td className="text-right px-2 py-2 tabular-nums text-muted-foreground/50">{s.open}</td>
                    <td className={`text-right px-2 py-2 tabular-nums font-bold ${s.hitRate != null && s.hitRate >= 0.5 ? "text-emerald-400" : "text-amber-400"}`}>
                      {s.hitRate != null ? `${(s.hitRate * 100).toFixed(0)}%` : "—"}
                    </td>
                    <td className="text-right px-2 py-2 tabular-nums">
                      <span className="text-emerald-400">{money(s.avgWin)}</span>
                      <span className="text-muted-foreground/40 mx-0.5">/</span>
                      <span className="text-red-400">{money(s.avgLoss)}</span>
                    </td>
                    <td className={`text-right px-2 py-2 tabular-nums font-bold ${s.expectancy != null ? col(s.expectancy) : ""}`}>
                      {s.expectancy != null ? money2(s.expectancy) : "—"}
                    </td>
                    <td className={`text-right px-4 py-2 tabular-nums font-bold ${col(s.totalPnl)}`}>{money(s.totalPnl)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="text-[10px] text-muted-foreground/40 px-4 py-2 border-t border-border/50">
            The row with positive <span className="text-foreground/60">expectancy</span> over enough trades is the one worth real money. A high hit rate with tiny wins and big losses still loses — watch expectancy, not just win rate.
          </p>
        </div>
      )}

      {/* ── Trade log: every tracked trade ── */}
      {score?.log && score.log.length > 0 && (
        <div className="rounded-xl border border-border bg-card overflow-hidden">
          <div className="flex items-center justify-between px-4 py-2.5 border-b border-border">
            <p className="text-xs font-bold">📒 Trade Log — every tracked trade</p>
            <p className="text-[10px] text-muted-foreground/45">newest first · paper · last {score.log.length}</p>
          </div>
          <div className="overflow-auto max-h-[32rem]">
            <table className="w-full text-[11px]">
              <thead className="sticky top-0 bg-card">
                <tr className="text-[9px] uppercase tracking-wider text-muted-foreground/50 border-b border-border/50">
                  <th className="text-left font-medium px-3 py-1.5">Time</th>
                  <th className="text-left font-medium px-2 py-1.5">Strategy</th>
                  <th className="text-left font-medium px-2 py-1.5">Coin</th>
                  <th className="text-left font-medium px-2 py-1.5">Side</th>
                  <th className="text-left font-medium px-2 py-1.5">Conv.</th>
                  <th className="text-right font-medium px-2 py-1.5">Entry</th>
                  <th className="text-right font-medium px-2 py-1.5">Exit</th>
                  <th className="text-right font-medium px-2 py-1.5">P&amp;L</th>
                  <th className="text-left font-medium px-3 py-1.5">Outcome</th>
                </tr>
              </thead>
              <tbody>
                {score.log.map((t) => {
                  const open = t.status !== "resolved";
                  return (
                    <tr key={t.id} className="border-b border-border/20 last:border-0">
                      <td className="text-left px-3 py-1.5 tabular-nums text-muted-foreground/60 whitespace-nowrap">
                        {new Date(t.time).toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })}
                      </td>
                      <td className="text-left px-2 py-1.5 text-muted-foreground/70">{t.source}</td>
                      <td className="text-left px-2 py-1.5 font-semibold">{t.symbol.replace("/USD", "")}</td>
                      <td className={`text-left px-2 py-1.5 font-medium ${t.side === "buy" ? "text-emerald-400" : "text-red-400"}`}>
                        {t.side.toUpperCase()}{t.leverage ? ` ${t.leverage}x` : ""}
                      </td>
                      <td className="text-left px-2 py-1.5 text-muted-foreground/60 capitalize">{t.conviction ?? "—"}</td>
                      <td className="text-right px-2 py-1.5 tabular-nums">{t.entry != null ? `$${t.entry.toLocaleString()}` : "—"}</td>
                      <td className="text-right px-2 py-1.5 tabular-nums">{t.exit != null ? `$${t.exit.toLocaleString()}` : "—"}</td>
                      <td className={`text-right px-2 py-1.5 tabular-nums font-bold ${t.pnl != null ? col(t.pnl) : "text-muted-foreground/40"}`}>
                        {t.pnl != null ? money2(t.pnl) : "—"}
                      </td>
                      <td className="text-left px-3 py-1.5 whitespace-nowrap">
                        {open
                          ? <span className="text-amber-400/80">● open</span>
                          : <span className="text-muted-foreground/60">{t.reason ?? "closed"}</span>}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <p className="text-[10px] text-muted-foreground/40 px-4 py-2 border-t border-border/50">
            Every paper trade the system tracked, labeled by strategy and conviction. Nothing here moved real money. Your <span className="text-foreground/60">real</span> completed trades are on the <Link href="/margin" className="underline hover:text-foreground/70">Margin Cockpit</Link>.
          </p>
        </div>
      )}
    </div>
  );
}
