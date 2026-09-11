"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import useSWR from "swr";
import { MarginChart, INTERVAL_LABELS, useTimeframeStats, type PriceLevel } from "@/components/margin/margin-chart";
import { pairMatchesSymbol, SCAN_UNIVERSE } from "@/lib/kraken-pairs";
import { Chip } from "@/components/ui/chip";
import { DataTable, Row, Td, Th } from "@/components/ui/data-table";
import { Empty, Label, Note, PageHeader, Panel, PanelBody, PanelHeader, Stat } from "@/components/ui/panel";
import { coinOf, money, pct, pnl2, timeOnly, tone, usd } from "@/lib/format";

// ============ LIVE ACCOUNT (Kraken) ============
// The live account: open positions with EXACT liquidation prices, the account's margin-level
// gauge, the scanner's signals, multi-timeframe charts on any margin-eligible pair, a
// break-even calculator, and the real round-trip scoreboard from Kraken's own ledger.

const fetcher = (u: string) => fetch(u).then((r) => r.json());

interface UniverseRow { pair: string; wsname: string; maxLeverage: number; spreadPct: number | null; tradeable: boolean; usMargin?: boolean }
interface Position {
  id: string; pair: string; side: "long" | "short"; vol: number; entryPrice: number;
  margin: number; net: number | null; leverage: number; rolloverAt: string; fee: number;
  currentPrice: number | null; liqPrice: number | null; liqPctAway: number | null; openedAt: string;
}
interface Health { equity: number; marginUsed: number; freeMargin: number; unrealized: number; marginLevel: number | null }
interface StatusResp { connected: boolean; health: Health | null; positions: Position[]; stale?: boolean; error?: string }
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
const TIMEFRAMES = [3, 5, 15, 60, 240, 1440];

// Kraken pair code → app symbol for the OHLC API (XBTUSD → BTC/USD style).
function wsnameToSymbol(wsname: string): string {
  return wsname.replace("XBT/", "BTC/");
}

const seg = (active: boolean) => `h-7 rounded-md border px-2.5 text-xs font-semibold transition-colors ${active ? "border-paper/50 bg-paper/15 text-paper" : "border-border text-muted-foreground hover:text-foreground"}`;

function TfTile({ symbol, interval, active, onClick }: { symbol: string; interval: number; active: boolean; onClick: () => void }) {
  const { changePct, rsi } = useTimeframeStats(symbol, interval);
  return (
    <button onClick={onClick} className={`rounded-lg border px-2.5 py-1.5 text-left transition-colors ${active ? "border-paper/50 bg-paper/10" : "border-border bg-card hover:bg-accent/50"}`}>
      <div className="flex items-center gap-2">
        <span className="text-xs font-semibold">{INTERVAL_LABELS[interval]}</span>
        <span className={`text-xs font-semibold tabular-nums ${tone(changePct ?? 0)}`}>
          {changePct != null ? `${changePct >= 0 ? "+" : ""}${changePct.toFixed(1)}%` : "…"}
        </span>
      </div>
      <p className={`text-[11px] tabular-nums ${rsi == null ? "text-muted-foreground" : rsi > 70 ? "text-down" : rsi < 30 ? "text-up" : "text-muted-foreground"}`}>
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
  const { data: status, error: statusErr } = useSWR<StatusResp>(
    "/api/margin/status", fetcher, { refreshInterval: 60_000 },
  );
  // Kraken unreachable must read as UNREACHABLE, never as "no positions" — a flat-looking
  // panel during an outage is exactly the false-empty read the guardian audit warned about.
  const krakenDown = !!statusErr || (status != null && (status.connected === false || !!status.error));
  const { data: score } = useSWR<{ scoreboard: Scoreboard; recentTrips: Trip[] }>(
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
  const positions = useMemo(() => status?.positions ?? [], [status?.positions]);
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
  // Fees are charged on NOTIONAL. Calibrated to Spencer's REAL fills (kraken_my_trades):
  // 0.172%/side measured — so ~0.15% maker / ~0.25% taker. Rollover ≈ 0.02% per 4h on
  // notional. A price move of m yields m×notional, so the break-even move equals total costs
  // as a % of notional — leverage cancels out of the move but multiplies what that move does
  // to your margin.
  const feeSide = beMaker ? 0.0015 : 0.0025;
  const rollover = 0.0002 * Math.ceil(beHours / 4);
  const beMovePct = (feeSide * 2 + rollover) * 100;
  const beNotional = beSize * beLev;
  const beCushionPct = (0.6 / Math.max(1, beLev)) * 100;

  const visiblePairs = (universe?.rows ?? []).filter((r) => showAllPairs || r.tradeable).slice(0, showAllPairs ? 200 : 24);

  const ml = health?.marginLevel ?? null;
  const mlTone = ml == null ? "grey" : ml < 100 ? "red" : ml < 150 ? "amber" : "green";
  const inputCls = "mt-1 h-8 w-full rounded-md border border-input bg-background px-2.5 text-[13px] font-semibold tabular-nums";

  return (
    <div className="space-y-5">
      <PageHeader
        title="Live Account"
        sub="What Kraken says right now — real money. Positions, margin level, signals, and the track record from the ledger. Margin call at 80% margin level, forced liquidation at 40%."
        right={krakenDown ? <Chip tone="red" size="md" dot>Kraken unreachable</Chip> : <Chip tone={mlTone} size="md" title="Account margin level: equity ÷ margin used">{ml != null ? `Margin level ${ml.toFixed(0)}%` : status ? "Margin not in use" : "Loading…"}</Chip>}
      />

      {(news?.imminent?.length ?? 0) > 0 && (
        <Panel tone="amber"><PanelBody>
          <p className="text-[13px] font-semibold text-warn">High-impact event within ~24h: {news!.imminent.map((e) => `${e.name} (${e.date} ${e.time})`).join(" · ")}</p>
          <Note className="mt-0.5">Volatility around these prints routinely exceeds a 20x position&apos;s entire 3% cushion. Being levered into one is a choice — make it knowingly.</Note>
        </PanelBody></Panel>
      )}

      {/* ── Open positions ── */}
      <Panel>
        <PanelHeader
          title="Open margin positions"
          aside={health && <span className="tabular-nums">equity {money(health.equity)} · margin used {money(health.marginUsed)} · free {money(health.freeMargin)}</span>}
        />
        {krakenDown ? <Empty><span className="text-down">Kraken did not answer</span> — positions unknown, not zero. The guardian keeps managing anything open; this page retries every 30s.</Empty>
          : !status ? <Empty>Loading positions…</Empty>
          : positions.length === 0 ? <Empty>No margin positions open.</Empty> : (
          <DataTable>
            <thead>
              <tr>
                <Th>Pair</Th>
                <Th>Side</Th>
                <Th num>Lev</Th>
                <Th num>Entry</Th>
                <Th num>Now</Th>
                <Th num>P&amp;L</Th>
                <Th num title="Per-position estimate (0.6/leverage). The account margin level gauge is the authoritative number.">Liquidation (est.)</Th>
                <Th num>Distance</Th>
              </tr>
            </thead>
            <tbody>
              {positions.map((p) => (
                <Row key={p.id}>
                  <Td strong title={p.pair}>{coinOf(p.pair)}</Td>
                  <Td className={`font-semibold ${p.side === "long" ? "text-up" : "text-down"}`}>{p.side === "long" ? "Long" : "Short"}</Td>
                  <Td num>{p.leverage.toFixed(0)}x</Td>
                  <Td num>{usd(p.entryPrice)}</Td>
                  <Td num>{p.currentPrice ? usd(p.currentPrice) : "—"}</Td>
                  <Td num className={`font-semibold ${tone(p.net ?? 0)}`}>{p.net != null ? pnl2(p.net) : "—"}</Td>
                  <Td num className="text-down">{p.liqPrice ? usd(p.liqPrice) : "—"}</Td>
                  <Td num className={`font-semibold ${p.liqPctAway == null ? "" : p.liqPctAway < 0.015 ? "text-down" : p.liqPctAway < 0.03 ? "text-warn" : "text-muted-foreground"}`}>
                    {pct(p.liqPctAway, 1)}
                  </Td>
                </Row>
              ))}
            </tbody>
          </DataTable>
        )}
      </Panel>

      {/* ── Live scanner signals ── */}
      <Panel>
        <PanelHeader title="Live signals — all margin coins, all timeframes" aside={<span>awareness only · scans every 5 min · not trade advice</span>} />
        {(sig?.signals?.length ?? 0) === 0 ? (
          <Empty>No notable signals in the last 24h. The scanner is watching the {SCAN_UNIVERSE.length} US-margin coins ({SCAN_UNIVERSE.join(", ")}) on 5m/15m/1h/4h/daily.</Empty>
        ) : (
          <div className="max-h-56 divide-y divide-border/60 overflow-y-auto">
            {sig!.signals.map((s, i) => {
              const bullish = s.kind === "oversold" || s.kind === "breakout" || s.kind === "move-up";
              const bearish = s.kind === "overbought" || s.kind === "breakdown" || s.kind === "move-down";
              return (
                <button key={i} onClick={() => { setPairWs(`${s.coin}/USD`); }} className="flex w-full items-center gap-3 px-4 py-1.5 text-left text-xs hover:bg-foreground/[0.03]">
                  <span className="w-16 shrink-0 tabular-nums text-muted-foreground">{timeOnly(s.ts)}</span>
                  <span className="w-12 shrink-0 font-semibold">{s.coin}</span>
                  <span className="w-8 shrink-0 text-muted-foreground">{s.timeframe}</span>
                  <span className={`flex-1 truncate ${bullish ? "text-up" : bearish ? "text-down" : ""}`}>{s.detail}</span>
                  <span className="tabular-nums text-muted-foreground">${s.price.toLocaleString()}</span>
                </button>
              );
            })}
          </div>
        )}
      </Panel>

      {/* ── Pair picker ── */}
      <Panel>
        <PanelHeader
          title="Margin pairs"
          aside={
            <>
              <span className="hidden sm:inline">US-retail only by default (BTC 20x, majors 10x) — non-US pairs cannot be traded from this account</span>
              <button onClick={() => setShowAllPairs(!showAllPairs)} className="text-primary hover:underline">{showAllPairs ? "show tradeable only" : `show all ${universe?.rows?.length ?? "…"}`}</button>
            </>
          }
        />
        <PanelBody className="flex flex-wrap gap-1.5 p-3">
          {visiblePairs.map((r) => (
            <button
              key={r.pair}
              onClick={() => setPairWs(wsnameToSymbol(r.wsname))}
              title={r.spreadPct != null ? `spread ${r.spreadPct.toFixed(3)}%` : ""}
              className={`${seg(wsnameToSymbol(r.wsname) === pairWs)} ${!r.tradeable && wsnameToSymbol(r.wsname) !== pairWs ? "border-down/25 bg-down/[0.04] text-muted-foreground" : ""}`}
            >
              {r.wsname.replace("/USD", "").replace("XBT", "BTC")}
              <span className="ml-1 text-[11px] text-muted-foreground">{r.maxLeverage}x</span>
              {r.usMargin === false
                ? <span className="ml-1 text-[11px] text-warn" title="Not on Kraken's US retail margin list — the executor refuses it">non-US</span>
                : !r.tradeable && <span className="ml-1 text-[11px] text-down">wide</span>}
            </button>
          ))}
        </PanelBody>
      </Panel>

      {/* ── Chart + timeframe tiles ── */}
      <Panel>
        <div className="flex flex-wrap items-center justify-between gap-2 px-3 pt-3">
          <p className="text-[13px] font-semibold">{pairWs}</p>
          <div className="flex gap-1">
            {TIMEFRAMES.map((tf) => (
              <button key={tf} onClick={() => setInterval_(tf)} className={seg(interval === tf)}>{INTERVAL_LABELS[tf]}</button>
            ))}
          </div>
        </div>
        <div className="p-3">
          <MarginChart symbol={symbol} interval={interval} levels={levels} height={440} />
          <div className="mt-2 grid grid-cols-3 gap-1.5 md:grid-cols-6">
            {TIMEFRAMES.map((tf) => (
              <TfTile key={tf} symbol={symbol} interval={tf} active={interval === tf} onClick={() => setInterval_(tf)} />
            ))}
          </div>
        </div>
      </Panel>

      {/* ── Break-even calculator ── */}
      <Panel>
        <PanelHeader title="Break-even calculator — what this trade must do before you earn a cent" />
        <PanelBody className="space-y-3">
          <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
            <label><Label>Margin (your money)</Label>
              <input type="number" value={beSize} min={10} onChange={(e) => setBeSize(Number(e.target.value) || 0)} className={inputCls} />
            </label>
            <label><Label>Leverage</Label>
              <select value={beLev} onChange={(e) => setBeLev(Number(e.target.value))} className={inputCls}>
                {[1, 2, 3, 5, 10, 20].map((l) => <option key={l} value={l}>{l}x</option>)}
              </select>
            </label>
            <label><Label>Expected hold (hours)</Label>
              <input type="number" value={beHours} min={0} onChange={(e) => setBeHours(Number(e.target.value) || 0)} className={inputCls} />
            </label>
            <label><Label>Order type</Label>
              <select value={beMaker ? "maker" : "taker"} onChange={(e) => setBeMaker(e.target.value === "maker")} className={inputCls}>
                <option value="taker">Market (taker ~0.25%/side)</option>
                <option value="maker">Limit (maker ~0.15%/side)</option>
              </select>
            </label>
          </div>
          <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
            <div className="rounded-lg border border-warn/30 bg-warn/[0.06] px-3 py-2">
              <Stat label="Price must move in your favour" value={`${beMovePct.toFixed(2)}%`} valueCls="text-warn" sub={`fees both sides + rollover on $${beNotional.toLocaleString()} notional`} />
            </div>
            <div className="rounded-lg border border-down/30 bg-down/[0.06] px-3 py-2">
              <Stat label="Liquidation if it moves against you" value={`${beCushionPct.toFixed(1)}%`} valueCls="text-down" sub={`you lose the full $${beSize.toLocaleString()} margin`} />
            </div>
            <div className="rounded-lg border border-border bg-background px-3 py-2">
              <Stat label="Rollover cost while held" value={`$${(beNotional * rollover).toFixed(2)}`} sub="~0.02% of notional every 4 hours" />
            </div>
          </div>
        </PanelBody>
      </Panel>

      {/* ── News & events ── */}
      <div className="grid gap-3 md:grid-cols-3">
        <Panel className="md:col-span-2">
          <PanelHeader title="Crypto headlines" />
          <div className="max-h-64 divide-y divide-border/60 overflow-y-auto">
            {(news?.headlines ?? []).length === 0 ? <Empty>Loading headlines…</Empty> : (
              news!.headlines.map((h, i) => (
                <a key={i} href={h.link} target="_blank" rel="noreferrer" className="block px-4 py-2 hover:bg-foreground/[0.03]">
                  <p className="text-xs leading-snug">{h.title}</p>
                  <p className="mt-0.5 text-[11px] text-muted-foreground">
                    {h.source}{h.publishedAt ? ` · ${new Date(h.publishedAt).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}` : ""}
                  </p>
                </a>
              ))
            )}
          </div>
        </Panel>
        <Panel>
          <PanelHeader title="High-impact calendar" />
          <PanelBody className="space-y-2 p-3">
            {(news?.upcoming ?? []).length === 0 ? <Note>Nothing major in the next 2 weeks.</Note> : (
              news!.upcoming.map((e, i) => (
                <div key={i} className="flex items-center justify-between text-xs">
                  <span className="font-semibold">{e.name}</span>
                  <span className="tabular-nums text-muted-foreground">{e.date}{e.approx ? " ~" : ""}</span>
                </div>
              ))
            )}
            <Note className="pt-1 text-[11px]">~ = date approximate; the daily brief verifies exact times.</Note>
          </PanelBody>
        </Panel>
      </div>

      {/* ── Scoreboard ── */}
      <Panel>
        <PanelHeader title="Your margin track record — from Kraken's own ledger" aside={sb && <span>automation gate: {sb.gate.progress}</span>} />
        {!sb || sb.trades === 0 ? (
          <Empty>No completed margin round trips synced yet. History syncs automatically every 5 minutes.</Empty>
        ) : (
          <PanelBody className="space-y-4">
            <div className="grid grid-cols-2 gap-4 md:grid-cols-5">
              <Stat label="Round trips" value={sb.trades} />
              <Stat label="Hit rate" value={pct(sb.hitRate)} valueCls={sb.hitRate != null && sb.hitRate >= 0.6 ? "text-up" : "text-warn"} />
              <Stat label="Avg win / loss" value={<><span className="text-up">{money(sb.avgWin)}</span><span className="mx-1 text-muted-foreground">/</span><span className="text-down">{money(sb.avgLoss)}</span></>} />
              <Stat label="Net P&L (after fees)" value={money(sb.totalNetPnl)} valueCls={tone(sb.totalNetPnl)} />
              <Stat label="After rollover" title="Rollover financing is account-level and subtracted from the total" value={money(sb.pnlAfterRollover)} valueCls={tone(sb.pnlAfterRollover)} />
            </div>
            <div className="grid gap-4 md:grid-cols-2">
              <div>
                <Label className="mb-1.5">By coin</Label>
                {Object.entries(sb.byPair).sort((a, b) => b[1].trades - a[1].trades).map(([pair, s]) => (
                  <div key={pair} className="flex items-center justify-between py-0.5 text-xs">
                    <span className="font-semibold" title={pair}>{coinOf(pair)}</span>
                    <span className="text-muted-foreground">{s.trades} trades · {s.trades ? ((s.wins / s.trades) * 100).toFixed(0) : 0}% win</span>
                    <span className={`font-semibold tabular-nums ${tone(s.netPnl)}`}>{money(s.netPnl)}</span>
                  </div>
                ))}
              </div>
              <div>
                <Label className="mb-1.5">By hold time</Label>
                {["minutes", "hours", "days", "weeks+"].filter((k) => sb.byHold[k]).map((k) => (
                  <div key={k} className="flex items-center justify-between py-0.5 text-xs">
                    <span className="font-semibold capitalize">{k}</span>
                    <span className="text-muted-foreground">{sb.byHold[k].trades} trades · {sb.byHold[k].trades ? ((sb.byHold[k].wins / sb.byHold[k].trades) * 100).toFixed(0) : 0}% win</span>
                    <span className={`font-semibold tabular-nums ${tone(sb.byHold[k].netPnl)}`}>{money(sb.byHold[k].netPnl)}</span>
                  </div>
                ))}
              </div>
            </div>
            {(score?.recentTrips?.length ?? 0) > 0 && (
              <Note>This is the performance summary. Every individual round trip with its P&amp;L is on <Link href="/orders" className="text-primary hover:underline">Orders</Link> → Live → Round trips.</Note>
            )}
          </PanelBody>
        )}
      </Panel>
    </div>
  );
}
