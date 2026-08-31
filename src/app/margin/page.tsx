"use client";

import { useMemo, useState } from "react";
import useSWR from "swr";
import { MarginChart, INTERVAL_LABELS, useTimeframeStats, type PriceLevel } from "@/components/margin/margin-chart";
import { pairMatchesSymbol } from "@/lib/kraken-pairs";

// ============ MARGIN COCKPIT ============
// Home base for discretionary margin trading: multi-timeframe charts on any
// margin-eligible pair, open positions with EXACT liquidation prices, the account's
// margin-level gauge, a break-even calculator, and the scoreboard measuring the real
// edge (hit rate + expectancy after fees and rollover) from Kraken's own trade ledger.

const fetcher = (u: string) => fetch(u).then((r) => r.json());

interface UniverseRow { pair: string; wsname: string; maxLeverage: number; spreadPct: number | null; tradeable: boolean }
interface Position {
  id: string; pair: string; side: "long" | "short"; vol: number; entryPrice: number;
  margin: number; net: number | null; leverage: number; rolloverAt: string; fee: number;
  currentPrice: number | null; liqPrice: number | null; liqPctAway: number | null; openedAt: string;
}
interface Health { equity: number; marginUsed: number; freeMargin: number; unrealized: number; marginLevel: number | null }
interface Scoreboard {
  trades: number; wins: number; hitRate: number | null; avgWin: number; avgLoss: number;
  profitFactor: number | null; totalNetPnl: number; totalFees: number; totalRollover: number;
  pnlAfterRollover: number; expectancy: number | null;
  byPair: Record<string, { trades: number; wins: number; netPnl: number }>;
  byHold: Record<string, { trades: number; wins: number; netPnl: number }>;
  gate: { target: number; required: number; progress: string };
}
interface Trip {
  pair: string; side: string; openedAt: string; closedAt: string; holdMinutes: number;
  entryPrice: number; exitPrice: number; netPnl: number;
}
interface ShadowScore {
  resolved: number; wins: number; hitRate: number | null; totalPnl: number;
  avgWin: number; avgLoss: number; open: number;
}

const TIMEFRAMES = [3, 5, 15, 60, 240, 1440];
const money = (n: number) => `${n < 0 ? "−" : ""}$${Math.abs(n).toLocaleString(undefined, { maximumFractionDigits: 0 })}`;
const money2 = (n: number) => `${n < 0 ? "−" : "+"}$${Math.abs(n).toFixed(2)}`;
const col = (n: number) => (n > 0 ? "text-emerald-400" : n < 0 ? "text-red-400" : "text-muted-foreground");

// Kraken pair code → app symbol for the OHLC API (XBTUSD → BTC/USD style).
function wsnameToSymbol(wsname: string): string {
  return wsname.replace("XBT/", "BTC/");
}

function holdLabel(minutes: number): string {
  if (minutes < 60) return `${minutes.toFixed(0)}m`;
  if (minutes < 24 * 60) return `${(minutes / 60).toFixed(1)}h`;
  return `${(minutes / 1440).toFixed(1)}d`;
}

function TfTile({ symbol, interval, active, onClick }: { symbol: string; interval: number; active: boolean; onClick: () => void }) {
  const { changePct, rsi } = useTimeframeStats(symbol, interval);
  return (
    <button
      onClick={onClick}
      className={`rounded-lg border px-2.5 py-1.5 text-left transition-colors ${
        active ? "border-purple-500/50 bg-purple-500/10" : "border-border bg-card hover:border-border/80"
      }`}
    >
      <div className="flex items-center gap-2">
        <span className="text-[11px] font-bold">{INTERVAL_LABELS[interval]}</span>
        <span className={`text-[10px] font-semibold tabular-nums ${col(changePct ?? 0)}`}>
          {changePct != null ? `${changePct >= 0 ? "+" : ""}${changePct.toFixed(1)}%` : "…"}
        </span>
      </div>
      <p className={`text-[9px] tabular-nums ${rsi == null ? "text-muted-foreground/40" : rsi > 70 ? "text-red-400" : rsi < 30 ? "text-emerald-400" : "text-muted-foreground/60"}`}>
        RSI {rsi != null ? rsi.toFixed(0) : "—"}{rsi != null && rsi > 70 ? " overbought" : rsi != null && rsi < 30 ? " oversold" : ""}
      </p>
    </button>
  );
}

export default function MarginCockpitPage() {
  const [pairWs, setPairWs] = useState("BTC/USD");
  const [interval, setInterval_] = useState(60);
  const [showAllPairs, setShowAllPairs] = useState(false);

  const { data: universe } = useSWR<{ rows: UniverseRow[] }>("/api/margin/universe", fetcher, { refreshInterval: 300_000 });
  const { data: status } = useSWR<{ connected: boolean; health: Health | null; positions: Position[] }>(
    "/api/margin/status", fetcher, { refreshInterval: 30_000 },
  );
  const { data: score } = useSWR<{ scoreboard: Scoreboard; recentTrips: Trip[]; shadow: ShadowScore | null }>(
    "/api/margin/scoreboard", fetcher, { refreshInterval: 120_000 },
  );
  const { data: news } = useSWR<{
    headlines: { title: string; link: string; source: string; publishedAt: string | null }[];
    upcoming: { date: string; time: string; name: string; approx: boolean }[];
    imminent: { date: string; time: string; name: string }[];
  }>("/api/margin/news", fetcher, { refreshInterval: 300_000 });
  const { data: sig } = useSWR<{ signals: { ts: string; coin: string; timeframe: string; kind: string; detail: string; price: number }[] }>(
    "/api/margin/signals", fetcher, { refreshInterval: 120_000 });

  const symbol = wsnameToSymbol(pairWs);
  const positions = status?.positions ?? [];
  const health = status?.health ?? null;
  const sb = score?.scoreboard;

  // Liquidation lines for positions on the charted pair.
  const levels = useMemo<PriceLevel[]>(() => {
    const out: PriceLevel[] = [];
    for (const p of positions) {
      if (!pairMatchesSymbol(p.pair, symbol)) continue;
      if (p.liqPrice) out.push({ price: p.liqPrice, label: `est. liquidation ${p.leverage.toFixed(0)}x`, color: "#ef4444" });
      out.push({ price: p.entryPrice, label: `entry ${p.side}`, color: "#a78bfa" });
    }
    return out;
  }, [positions, symbol]);

  // Break-even calculator state.
  const [beSize, setBeSize] = useState(1000);
  const [beLev, setBeLev] = useState(10);
  const [beHours, setBeHours] = useState(6);
  const [beMaker, setBeMaker] = useState(false);
  // Fees are charged on NOTIONAL. His tier ($2.5k+ assets-on-platform): 0.30% maker / 0.60% taker
  // per side. Rollover ≈ 0.02% per 4h on notional. A price move of m yields m×notional, so the
  // break-even move equals total costs as a % of notional — leverage cancels out of the move but
  // multiplies what that move does to your margin.
  const feeSide = beMaker ? 0.003 : 0.006;
  const rollover = 0.0002 * Math.ceil(beHours / 4);
  const beMovePct = (feeSide * 2 + rollover) * 100;
  const beNotional = beSize * beLev;
  const beCushionPct = (0.6 / Math.max(1, beLev)) * 100;

  const visiblePairs = (universe?.rows ?? []).filter((r) => showAllPairs || r.tradeable).slice(0, showAllPairs ? 200 : 24);

  return (
    <div className="space-y-5">
      {/* ── Header + health ── */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-xl font-bold tracking-tight">Margin Cockpit</h2>
          <p className="text-[11px] text-muted-foreground/50">
            Kraken spot margin — call at 80% margin level, forced liquidation at 40%
          </p>
        </div>
        {health && health.marginLevel != null ? (
          <div className={`px-4 py-2 rounded-xl border ${
            health.marginLevel < 100 ? "border-red-500/40 bg-red-500/10" :
            health.marginLevel < 150 ? "border-amber-500/40 bg-amber-500/10" :
            "border-emerald-500/25 bg-emerald-500/5"
          }`}>
            <p className="text-[9px] text-muted-foreground/60 uppercase tracking-wider">Margin Level</p>
            <p className={`text-xl font-black tabular-nums ${
              health.marginLevel < 100 ? "text-red-400" : health.marginLevel < 150 ? "text-amber-400" : "text-emerald-400"
            }`}>
              {health.marginLevel.toFixed(0)}%
            </p>
          </div>
        ) : (
          <div className="px-4 py-2 rounded-xl border border-border bg-card">
            <p className="text-[9px] text-muted-foreground/60 uppercase tracking-wider">Margin</p>
            <p className="text-sm font-bold text-muted-foreground">not in use</p>
          </div>
        )}
      </div>

      {/* ── Imminent high-impact event warning ── */}
      {(news?.imminent?.length ?? 0) > 0 && (
        <div className="rounded-xl border border-amber-500/40 bg-amber-500/[0.07] px-4 py-3">
          <p className="text-xs font-bold text-amber-400">
            ⚠️ High-impact event within ~24h: {news!.imminent.map((e) => `${e.name} (${e.date} ${e.time})`).join(" · ")}
          </p>
          <p className="text-[11px] text-muted-foreground/60 mt-0.5">
            Volatility around these prints routinely exceeds a 20x position&apos;s entire 3% cushion. Being levered into one is a choice — make it knowingly.
          </p>
        </div>
      )}

      {/* ── Open positions ── */}
      <div className="rounded-xl border border-border bg-card overflow-hidden">
        <div className="flex items-center justify-between px-4 py-2.5 border-b border-border">
          <p className="text-xs font-bold">Open Margin Positions</p>
          {health && (
            <p className="text-[10px] text-muted-foreground/50 tabular-nums">
              equity {money(health.equity)} · margin used {money(health.marginUsed)} · free {money(health.freeMargin)}
            </p>
          )}
        </div>
        {positions.length === 0 ? (
          <p className="px-4 py-5 text-sm text-muted-foreground/40">No margin positions open.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-[12px]">
              <thead className="text-[9px] uppercase tracking-wider text-muted-foreground/45 border-b border-border">
                <tr>
                  <th className="text-left px-4 py-2 font-medium">Pair</th>
                  <th className="text-left px-2 py-2 font-medium">Side</th>
                  <th className="text-right px-2 py-2 font-medium">Lev</th>
                  <th className="text-right px-2 py-2 font-medium">Entry</th>
                  <th className="text-right px-2 py-2 font-medium">Now</th>
                  <th className="text-right px-2 py-2 font-medium">P&L</th>
                  <th className="text-right px-2 py-2 font-medium" title="Per-position estimate (0.6/leverage). The account margin level gauge is the authoritative number.">Liquidation (est.)</th>
                  <th className="text-right px-4 py-2 font-medium">Distance</th>
                </tr>
              </thead>
              <tbody>
                {positions.map((p) => (
                  <tr key={p.id} className="border-b border-border/40">
                    <td className="px-4 py-2 font-bold">{p.pair}</td>
                    <td className={`px-2 py-2 font-bold ${p.side === "long" ? "text-emerald-400" : "text-red-400"}`}>
                      {p.side.toUpperCase()}
                    </td>
                    <td className="px-2 py-2 text-right tabular-nums">{p.leverage.toFixed(0)}x</td>
                    <td className="px-2 py-2 text-right tabular-nums">${p.entryPrice.toLocaleString(undefined, { maximumFractionDigits: 2 })}</td>
                    <td className="px-2 py-2 text-right tabular-nums">{p.currentPrice ? `$${p.currentPrice.toLocaleString(undefined, { maximumFractionDigits: 2 })}` : "—"}</td>
                    <td className={`px-2 py-2 text-right tabular-nums font-bold ${col(p.net ?? 0)}`}>{p.net != null ? money2(p.net) : "—"}</td>
                    <td className="px-2 py-2 text-right tabular-nums text-red-400">{p.liqPrice ? `$${p.liqPrice.toLocaleString(undefined, { maximumFractionDigits: 2 })}` : "—"}</td>
                    <td className={`px-4 py-2 text-right tabular-nums font-bold ${
                      p.liqPctAway == null ? "" : p.liqPctAway < 0.015 ? "text-red-400" : p.liqPctAway < 0.03 ? "text-amber-400" : "text-muted-foreground"
                    }`}>
                      {p.liqPctAway != null ? `${(p.liqPctAway * 100).toFixed(1)}%` : "—"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* ── Live scanner signals ── */}
      <div className="rounded-xl border border-border bg-card overflow-hidden">
        <div className="flex items-center justify-between px-4 py-2.5 border-b border-border">
          <p className="text-xs font-bold">🔎 Live Signals — all margin coins, all timeframes</p>
          <p className="text-[10px] text-muted-foreground/45">awareness only · scans every 5 min · not trade advice</p>
        </div>
        {(sig?.signals?.length ?? 0) === 0 ? (
          <p className="px-4 py-4 text-sm text-muted-foreground/40">No notable signals in the last 24h. The scanner is watching {`{`}BTC, ETH, SOL, XRP, DOGE, ADA, AVAX, LINK, LTC, DOT, SUI, AAVE, HYPE{`}`} on 5m/15m/1h/4h/daily.</p>
        ) : (
          <div className="max-h-56 overflow-y-auto divide-y divide-border/40">
            {sig!.signals.map((s, i) => {
              const bullish = s.kind === "oversold" || s.kind === "breakout" || s.kind === "move-up";
              const bearish = s.kind === "overbought" || s.kind === "breakdown" || s.kind === "move-down";
              return (
                <button
                  key={i}
                  onClick={() => { setPairWs(`${s.coin === "BTC" ? "BTC" : s.coin}/USD`); }}
                  className="w-full flex items-center gap-3 px-4 py-1.5 hover:bg-white/[0.02] text-left"
                >
                  <span className="text-[10px] text-muted-foreground/45 tabular-nums w-16 shrink-0">
                    {new Date(s.ts).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })}
                  </span>
                  <span className="font-bold text-[12px] w-12 shrink-0">{s.coin}</span>
                  <span className="text-[10px] text-muted-foreground/50 w-8 shrink-0">{s.timeframe}</span>
                  <span className={`text-[12px] flex-1 ${bullish ? "text-emerald-400" : bearish ? "text-red-400" : "text-muted-foreground/80"}`}>
                    {s.detail}
                  </span>
                  <span className="text-[10px] text-muted-foreground/40 tabular-nums">${s.price.toLocaleString()}</span>
                </button>
              );
            })}
          </div>
        )}
      </div>

      {/* ── Pair picker ── */}
      <div className="rounded-xl border border-border bg-card p-3">
        <div className="flex items-center justify-between mb-2">
          <p className="text-[10px] font-bold text-muted-foreground/50 uppercase tracking-wider">
            Margin pairs — max US-retail leverage (BTC 20x, majors 10x)
          </p>
          <button onClick={() => setShowAllPairs(!showAllPairs)} className="text-[10px] text-purple-400 hover:underline">
            {showAllPairs ? "show tradeable only" : `show all ${universe?.rows?.length ?? "…"}`}
          </button>
        </div>
        <div className="flex flex-wrap gap-1.5">
          {visiblePairs.map((r) => (
            <button
              key={r.pair}
              onClick={() => setPairWs(wsnameToSymbol(r.wsname))}
              title={r.spreadPct != null ? `spread ${r.spreadPct.toFixed(3)}%` : ""}
              className={`px-2 py-1 rounded-md border text-[11px] font-semibold transition-colors ${
                wsnameToSymbol(r.wsname) === pairWs
                  ? "border-purple-500/60 bg-purple-500/15 text-purple-300"
                  : r.tradeable
                    ? "border-border bg-background hover:border-border/60"
                    : "border-red-500/20 bg-red-500/[0.04] text-muted-foreground/50"
              }`}
            >
              {r.wsname.replace("/USD", "").replace("XBT", "BTC")}
              <span className="text-[8px] text-muted-foreground/50 ml-1">{r.maxLeverage}x</span>
              {!r.tradeable && <span className="text-[8px] text-red-400/70 ml-1">wide</span>}
            </button>
          ))}
        </div>
      </div>

      {/* ── Chart + timeframe tiles ── */}
      <div className="rounded-xl border border-border bg-card p-3">
        <div className="flex flex-wrap items-center justify-between gap-2 mb-2">
          <p className="text-sm font-bold">{pairWs}</p>
          <div className="flex gap-1.5">
            {TIMEFRAMES.map((tf) => (
              <button
                key={tf}
                onClick={() => setInterval_(tf)}
                className={`px-2.5 py-1 rounded-md border text-[11px] font-bold ${
                  interval === tf ? "border-purple-500/60 bg-purple-500/15 text-purple-300" : "border-border text-muted-foreground hover:text-foreground"
                }`}
              >
                {INTERVAL_LABELS[tf]}
              </button>
            ))}
          </div>
        </div>
        <MarginChart symbol={symbol} interval={interval} levels={levels} height={440} />
        {/* Multi-timeframe snapshot: every frame at a glance, click to switch */}
        <div className="grid grid-cols-3 md:grid-cols-6 gap-1.5 mt-2">
          {TIMEFRAMES.map((tf) => (
            <TfTile key={tf} symbol={symbol} interval={tf} active={interval === tf} onClick={() => setInterval_(tf)} />
          ))}
        </div>
      </div>

      {/* ── Break-even calculator ── */}
      <div className="rounded-xl border border-border bg-card p-4">
        <p className="text-xs font-bold mb-3">Break-Even Calculator — what this trade must do before you earn a cent</p>
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-3">
          <label className="text-[10px] text-muted-foreground/60 uppercase tracking-wider">
            Margin (your money)
            <input type="number" value={beSize} min={10} onChange={(e) => setBeSize(Number(e.target.value) || 0)}
              className="mt-1 w-full rounded-md border border-border bg-background px-2 py-1.5 text-sm font-bold tabular-nums" />
          </label>
          <label className="text-[10px] text-muted-foreground/60 uppercase tracking-wider">
            Leverage
            <select value={beLev} onChange={(e) => setBeLev(Number(e.target.value))}
              className="mt-1 w-full rounded-md border border-border bg-background px-2 py-1.5 text-sm font-bold">
              {[1, 2, 3, 5, 10, 20].map((l) => <option key={l} value={l}>{l}x</option>)}
            </select>
          </label>
          <label className="text-[10px] text-muted-foreground/60 uppercase tracking-wider">
            Expected hold (hours)
            <input type="number" value={beHours} min={0} onChange={(e) => setBeHours(Number(e.target.value) || 0)}
              className="mt-1 w-full rounded-md border border-border bg-background px-2 py-1.5 text-sm font-bold tabular-nums" />
          </label>
          <label className="text-[10px] text-muted-foreground/60 uppercase tracking-wider">
            Order type
            <select value={beMaker ? "maker" : "taker"} onChange={(e) => setBeMaker(e.target.value === "maker")}
              className="mt-1 w-full rounded-md border border-border bg-background px-2 py-1.5 text-sm font-bold">
              <option value="taker">Market (taker 0.60%)</option>
              <option value="maker">Limit (maker 0.30%)</option>
            </select>
          </label>
        </div>
        <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
          <div className="rounded-lg border border-amber-500/25 bg-amber-500/[0.05] px-3 py-2">
            <p className="text-[9px] text-muted-foreground/60 uppercase tracking-wider">Price must move in your favor</p>
            <p className="text-xl font-black text-amber-400 tabular-nums">{beMovePct.toFixed(2)}%</p>
            <p className="text-[10px] text-muted-foreground/50">fees both sides + rollover on ${beNotional.toLocaleString()} notional</p>
          </div>
          <div className="rounded-lg border border-red-500/25 bg-red-500/[0.05] px-3 py-2">
            <p className="text-[9px] text-muted-foreground/60 uppercase tracking-wider">Liquidation if it moves against you</p>
            <p className="text-xl font-black text-red-400 tabular-nums">{beCushionPct.toFixed(1)}%</p>
            <p className="text-[10px] text-muted-foreground/50">you lose the full ${beSize.toLocaleString()} margin</p>
          </div>
          <div className="rounded-lg border border-border bg-background px-3 py-2">
            <p className="text-[9px] text-muted-foreground/60 uppercase tracking-wider">Rollover cost while held</p>
            <p className="text-xl font-black tabular-nums">${(beNotional * rollover).toFixed(2)}</p>
            <p className="text-[10px] text-muted-foreground/50">~0.02% of notional every 4 hours</p>
          </div>
        </div>
      </div>

      {/* ── News & events ── */}
      <div className="grid md:grid-cols-3 gap-3">
        <div className="md:col-span-2 rounded-xl border border-border bg-card overflow-hidden">
          <p className="px-4 py-2.5 border-b border-border text-xs font-bold">Crypto Headlines</p>
          <div className="max-h-64 overflow-y-auto divide-y divide-border/40">
            {(news?.headlines ?? []).length === 0 ? (
              <p className="px-4 py-4 text-sm text-muted-foreground/40">Loading headlines…</p>
            ) : (
              news!.headlines.map((h, i) => (
                <a key={i} href={h.link} target="_blank" rel="noreferrer" className="block px-4 py-2 hover:bg-white/[0.02]">
                  <p className="text-[12px] leading-snug">{h.title}</p>
                  <p className="text-[9px] text-muted-foreground/40 mt-0.5">
                    {h.source}{h.publishedAt ? ` · ${new Date(h.publishedAt).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}` : ""}
                  </p>
                </a>
              ))
            )}
          </div>
        </div>
        <div className="rounded-xl border border-border bg-card overflow-hidden">
          <p className="px-4 py-2.5 border-b border-border text-xs font-bold">High-Impact Calendar</p>
          <div className="p-3 space-y-2">
            {(news?.upcoming ?? []).length === 0 ? (
              <p className="text-[11px] text-muted-foreground/40">Nothing major in the next 2 weeks.</p>
            ) : (
              news!.upcoming.map((e, i) => (
                <div key={i} className="flex items-center justify-between text-[11px]">
                  <span className="font-semibold">{e.name}</span>
                  <span className="text-muted-foreground/60 tabular-nums">{e.date}{e.approx ? " ~" : ""}</span>
                </div>
              ))
            )}
            <p className="text-[9px] text-muted-foreground/35 pt-1">~ = date approximate; the daily brief verifies exact times.</p>
          </div>
        </div>
      </div>

      {/* ── Tracked-signal paper record ── */}
      {score?.shadow && (score.shadow.resolved > 0 || score.shadow.open > 0) && (
        <div className="rounded-xl border border-purple-500/20 bg-purple-500/[0.03] p-4">
          <div className="flex items-center justify-between mb-2">
            <p className="text-xs font-bold">📊 Tracked-Signal Paper Record — would your alerts have made money?</p>
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
          <p className="text-[10px] text-muted-foreground/40 mt-2">
            Estimate — each alert followed to a stop/target/48h outcome, net of modeled maker+taker fees and per-coin 4h rollover (all scaled by leverage). Your <span className="text-foreground/60">real</span> completed trades below are exact (from Kraken&apos;s ledger). This is the record that earns real-money automation.
          </p>
        </div>
      )}

      {/* ── Scoreboard ── */}
      <div className="rounded-xl border border-border bg-card overflow-hidden">
        <div className="flex items-center justify-between px-4 py-2.5 border-b border-border">
          <p className="text-xs font-bold">Your Margin Track Record — from Kraken&apos;s own ledger</p>
          {sb && <p className="text-[10px] text-muted-foreground/50">automation gate: {sb.gate.progress}</p>}
        </div>
        {!sb || sb.trades === 0 ? (
          <p className="px-4 py-5 text-sm text-muted-foreground/40">
            No completed margin round trips synced yet. History syncs automatically every 5 minutes.
          </p>
        ) : (
          <div className="p-4 space-y-4">
            <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
              <div>
                <p className="text-[9px] text-muted-foreground/60 uppercase tracking-wider">Round trips</p>
                <p className="text-lg font-black tabular-nums">{sb.trades}</p>
              </div>
              <div>
                <p className="text-[9px] text-muted-foreground/60 uppercase tracking-wider">Hit rate</p>
                <p className={`text-lg font-black tabular-nums ${sb.hitRate != null && sb.hitRate >= 0.6 ? "text-emerald-400" : "text-amber-400"}`}>
                  {sb.hitRate != null ? `${(sb.hitRate * 100).toFixed(0)}%` : "—"}
                </p>
              </div>
              <div>
                <p className="text-[9px] text-muted-foreground/60 uppercase tracking-wider">Avg win / loss</p>
                <p className="text-lg font-black tabular-nums">
                  <span className="text-emerald-400">{money(sb.avgWin)}</span>
                  <span className="text-muted-foreground/40 mx-1">/</span>
                  <span className="text-red-400">{money(sb.avgLoss)}</span>
                </p>
              </div>
              <div>
                <p className="text-[9px] text-muted-foreground/60 uppercase tracking-wider">Net P&L (after fees)</p>
                <p className={`text-lg font-black tabular-nums ${col(sb.totalNetPnl)}`}>{money(sb.totalNetPnl)}</p>
              </div>
              <div>
                <p className="text-[9px] text-muted-foreground/60 uppercase tracking-wider" title="Rollover financing is account-level and subtracted from the total">After rollover</p>
                <p className={`text-lg font-black tabular-nums ${col(sb.pnlAfterRollover)}`}>{money(sb.pnlAfterRollover)}</p>
              </div>
            </div>
            <div className="grid md:grid-cols-2 gap-4">
              <div>
                <p className="text-[9px] text-muted-foreground/60 uppercase tracking-wider mb-1.5">By coin</p>
                {Object.entries(sb.byPair).sort((a, b) => b[1].trades - a[1].trades).map(([pair, s]) => (
                  <div key={pair} className="flex items-center justify-between text-[11px] py-0.5">
                    <span className="font-semibold">{pair}</span>
                    <span className="text-muted-foreground/60">{s.trades} trades · {s.trades ? ((s.wins / s.trades) * 100).toFixed(0) : 0}% win</span>
                    <span className={`font-bold tabular-nums ${col(s.netPnl)}`}>{money(s.netPnl)}</span>
                  </div>
                ))}
              </div>
              <div>
                <p className="text-[9px] text-muted-foreground/60 uppercase tracking-wider mb-1.5">By hold time</p>
                {["minutes", "hours", "days", "weeks+"].filter((k) => sb.byHold[k]).map((k) => (
                  <div key={k} className="flex items-center justify-between text-[11px] py-0.5">
                    <span className="font-semibold capitalize">{k}</span>
                    <span className="text-muted-foreground/60">{sb.byHold[k].trades} trades · {sb.byHold[k].trades ? ((sb.byHold[k].wins / sb.byHold[k].trades) * 100).toFixed(0) : 0}% win</span>
                    <span className={`font-bold tabular-nums ${col(sb.byHold[k].netPnl)}`}>{money(sb.byHold[k].netPnl)}</span>
                  </div>
                ))}
              </div>
            </div>
            {(score?.recentTrips?.length ?? 0) > 0 && (
              <div>
                <p className="text-[9px] text-muted-foreground/60 uppercase tracking-wider mb-1.5">Recent round trips</p>
                <div className="max-h-56 overflow-y-auto space-y-0.5">
                  {score!.recentTrips.map((t, i) => (
                    <div key={i} className="flex items-center gap-3 text-[11px]">
                      <span className="text-muted-foreground/50 tabular-nums whitespace-nowrap min-w-[90px]">
                        {new Date(t.closedAt).toLocaleDateString(undefined, { month: "short", day: "numeric" })}
                      </span>
                      <span className="font-semibold min-w-[70px]">{t.pair}</span>
                      <span className={t.side === "long" ? "text-emerald-400" : "text-red-400"}>{t.side}</span>
                      <span className="text-muted-foreground/50 tabular-nums min-w-[50px]">{holdLabel(t.holdMinutes)}</span>
                      <span className={`font-bold tabular-nums ml-auto ${col(t.netPnl)}`}>{money2(t.netPnl)}</span>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
