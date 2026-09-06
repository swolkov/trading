"use client";

import Link from "next/link";
import useSWR from "swr";
import { Chip, type ChipTone } from "@/components/ui/chip";
import { PageHeader, Panel, PanelBody, PanelHeader, Stat, Label, Note } from "@/components/ui/panel";
import { ago, coinOf, money, pct, pnl0, pnl2, tone, usd, when } from "@/lib/format";

const fetcher = (u: string) => fetch(u).then((r) => r.json());

// ============ DASHBOARD ============
// One job: "how is the desk right now?" — four numbers, the executor's state, the open live
// position, and the parked spot book labelled as what it is. No analytics here; the paper
// record lives on Road to Live, the trade list on Orders, machinery on System Health.
// Every read is an existing read-only endpoint; nothing on this page can place an order.

interface Holding { coin: string; amount: number; price: number; value: number }
interface KrakenStatus {
  connected: boolean; usd: number; holdings: Holding[]; totalValue: number;
  strategyValue: number; strategyCapital: number; strategyPnl: number; otherValue: number;
}
interface MarginHealth { equity: number; marginUsed: number; freeMargin: number; unrealized: number; marginLevel: number | null }
interface MarginPosition { pair: string; side: string; vol: number; entryPrice: number; currentPrice: number | null; liqPctAway: number | null; openedAt: string; leverage: number }
interface LiveNow { pair: string; side: string; vol: number; entry: number; net: number | null; openedAt: string }
interface ArmStatus {
  armed: boolean; auto: boolean; validateOnly: boolean; sources: string[]; riskPct: number; maxPositions: number;
  ddTripped: boolean; liveNow?: LiveNow[]; log: string[];
  stage3?: { status: string; target: number; done: number; fromBase: number; toBase: number; note?: string } | null;
}
interface Trip { closedAt: string; netPnl: number; pair: string }
interface StrategyStat { key: string; resolved: number; liveNet: number; tStat: number | null; days?: number; verdict: string }
interface Command { heartbeats: { marginScan: string | null; marginWatch: string | null }; error?: string }

const LIVE_CANDIDATE = "selective";

function startOfToday(): number { const d = new Date(); d.setHours(0, 0, 0, 0); return d.getTime(); }

function heartbeatTone(iso: string | null | undefined, warnMin: number, critMin: number): ChipTone {
  if (!iso) return "grey";
  const m = (Date.now() - Date.parse(iso)) / 60000;
  return m < warnMin ? "green" : m < critMin ? "amber" : "red";
}

export default function DashboardPage() {
  const { data: krk } = useSWR<KrakenStatus>("/api/kraken-agent", fetcher, { refreshInterval: 60_000 });
  const { data: status } = useSWR<{ connected: boolean; health: MarginHealth | null; positions: MarginPosition[] }>("/api/margin/status", fetcher, { refreshInterval: 30_000 });
  const { data: arm } = useSWR<ArmStatus>("/api/margin/arm", fetcher, { refreshInterval: 30_000 });
  const { data: score } = useSWR<{ recentTrips: Trip[]; strategies: StrategyStat[] }>("/api/margin/scoreboard", fetcher, { refreshInterval: 120_000 });
  const { data: cmd } = useSWR<Command>("/api/command", fetcher, { refreshInterval: 60_000 });

  const health = status?.health ?? null;
  const equity = health?.equity ?? (krk?.connected ? krk.totalValue : null);

  // Today = closed round trips since local midnight (Kraken's own ledger) + the float on the
  // bot's open positions. Balance-based, not a sum of app-side logs.
  const t0 = startOfToday();
  const closedToday = (score?.recentTrips ?? []).filter((t) => Date.parse(t.closedAt) >= t0);
  const realizedToday = closedToday.reduce((s, t) => s + t.netPnl, 0);
  const liveNow = arm?.liveNow ?? [];
  const floating = liveNow.reduce((s, p) => s + (p.net ?? 0), 0);
  const today = realizedToday + floating;

  // The open live position, enriched with the cockpit's liquidation distance when it matches.
  const open = liveNow[0] ?? null;
  const openDetail = open ? (status?.positions ?? []).find((p) => p.pair === open.pair && p.side === open.side && Math.abs(p.vol - open.vol) < 1e-9) ?? null : null;

  const s3 = arm?.stage3 ?? null;
  const s3Pct = s3 && s3.target > 0 ? Math.min(100, (s3.done / s3.target) * 100) : 0;

  // Paper gate, same four checks as Road to Live.
  const cand = score?.strategies?.find((s) => s.key === LIVE_CANDIDATE) ?? null;
  const gateGreen = cand ? [cand.resolved >= 30, cand.resolved > 0 && cand.liveNet > 0, cand.tStat != null && cand.tStat >= 2, (cand.days ?? 0) >= 7].filter(Boolean).length : null;
  const gateOpen = gateGreen === 4;

  const scanTone = heartbeatTone(cmd?.heartbeats?.marginScan, 20, 60);
  const watchTone = heartbeatTone(cmd?.heartbeats?.marginWatch, 20, 60);
  const machineryTone: ChipTone = [scanTone, watchTone].includes("red") ? "red" : [scanTone, watchTone].includes("amber") ? "amber" : [scanTone, watchTone].includes("grey") ? "grey" : "green";

  const lastEvent = arm?.log?.[0] ?? null;
  const lastEventAt = lastEvent ? lastEvent.slice(0, 24).trim() : null;
  const lastEventText = lastEvent ? lastEvent.slice(24).trim() : null;

  const loading = !arm && !status && !krk;

  return (
    <div className="space-y-5">
      <PageHeader
        title="Dashboard"
        sub="The Kraken margin desk, right now."
        right={arm && (
          <>
            <Chip tone={arm.armed ? "red" : "grey"} dot={arm.armed} size="md">{arm.armed ? `Armed · ${arm.sources.join(", ") || "selective"}` : "Disarmed"}</Chip>
            {arm.ddTripped && <Chip tone="red" size="md">Drawdown breaker tripped</Chip>}
            <Chip tone={gateOpen ? "green" : cand ? "amber" : "grey"} size="md" title="The live candidate's paper gate: 30+ resolved, net > 0 at live sizing, t ≥ 2, 7+ days">
              {gateOpen ? "Paper gate open" : cand ? `Paper gate ${gateGreen} of 4` : "Paper gate — no data"}
            </Chip>
            <Chip tone={machineryTone} size="md" title={`Scanner ${ago(cmd?.heartbeats?.marginScan)} · guardian ${ago(cmd?.heartbeats?.marginWatch)}`}>
              {machineryTone === "green" ? "Machinery healthy" : machineryTone === "grey" ? "Machinery unknown" : "Machinery stale"}
            </Chip>
          </>
        )}
      />

      {/* ── The four numbers ── */}
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <Panel><PanelBody>
          {loading ? <Skeleton /> : (
            <Stat size="lg" label="Equity" value={equity != null ? money(equity) : "—"} title="Kraken margin equity — the number the executor sizes every trade off"
              sub={health ? <>margin level <span className={health.marginLevel == null ? "" : health.marginLevel < 100 ? "text-down font-semibold" : health.marginLevel < 150 ? "text-warn font-semibold" : "text-foreground/80"}>{health.marginLevel != null ? `${health.marginLevel.toFixed(0)}%` : "n/a"}</span> · free {money(health.freeMargin)}</> : "Kraken not reachable"} />
          )}
        </PanelBody></Panel>

        <Panel><PanelBody>
          {loading ? <Skeleton /> : (
            <Stat size="lg" label="Today" value={pnl0(today)} valueCls={tone(today)} title="Round trips closed since midnight (Kraken ledger) plus the float on the bot's open positions"
              sub={<>{closedToday.length} closed{closedToday.length > 0 && <> ({pnl0(realizedToday)})</>} · floating <span className={tone(floating)}>{pnl2(floating)}</span></>} />
          )}
        </PanelBody></Panel>

        <Panel><PanelBody>
          {loading ? <Skeleton /> : open ? (
            <Stat size="lg" label="Open live position" value={<>{coinOf(open.pair)} <span className={`text-base font-medium ${open.side === "long" ? "text-up" : "text-down"}`}>{open.side}</span></>}
              sub={<>entry {usd(open.entry)} · <span className={`font-semibold ${tone(open.net)}`}>{open.net != null ? pnl2(open.net) : "P&L pending"}</span>{openDetail?.liqPctAway != null && <> · {pct(openDetail.liqPctAway, 1)} from liquidation</>} · since {when(open.openedAt)}</> } />
          ) : (
            <Stat size="lg" label="Open live position" value={<span className="text-muted-foreground">None</span>}
              sub={arm?.armed ? "waiting for the next high-conviction breakout" : "executor disarmed — nothing will open"} />
          )}
        </PanelBody></Panel>

        <Panel><PanelBody>
          {loading ? <Skeleton /> : s3 ? (
            <div>
              <Label>Stage 3 · first live trades</Label>
              <p className="mt-0.5 text-[28px] font-semibold tabular-nums leading-none">{s3.done}<span className="text-base text-muted-foreground"> / {s3.target}</span></p>
              <div className="mt-2 h-1.5 w-full overflow-hidden rounded-full bg-muted">
                <div className={`h-full rounded-full ${s3.status === "held" ? "bg-down" : s3.status === "graduated" ? "bg-up" : "bg-primary"}`} style={{ width: `${s3.status === "graduated" ? 100 : s3Pct}%` }} />
              </div>
              <div className="mt-1.5 text-xs text-muted-foreground">
                {s3.status === "running" && <>{s3.fromBase}% risk until live matches paper, then {s3.toBase}%</>}
                {s3.status === "graduated" && <span className="text-up">graduated — paper&apos;s full sizing is on</span>}
                {s3.status === "held" && <span className="text-down">held at {s3.fromBase}% — {s3.note ?? "live diverged from paper"}</span>}
              </div>
            </div>
          ) : (
            <Stat size="lg" label="Stage 3 · first live trades" value={<span className="text-muted-foreground">—</span>} sub="starts on the first arm" />
          )}
        </PanelBody></Panel>
      </div>

      {/* ── Last executor event ── */}
      {lastEvent && (
        <Panel>
          <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1 px-4 py-2.5">
            <Label>Last executor event</Label>
            <span className="text-xs text-muted-foreground tabular-nums">{lastEventAt && Number.isFinite(Date.parse(lastEventAt)) ? `${when(lastEventAt)} · ${ago(lastEventAt)}` : ""}</span>
            <span className="min-w-0 flex-1 truncate text-[13px]" title={lastEventText ?? ""}>{lastEventText}</span>
            <Link href="/margin/paper" className="text-xs text-primary hover:underline">Road to Live</Link>
          </div>
        </Panel>
      )}

      {/* ── Parked coins: not the desk ── */}
      <Panel>
        <PanelHeader title="Parked coins" aside={<span>hand-held BTC/ETH from the retired bot · not traded by the desk</span>} />
        <PanelBody>
          {!krk ? <Skeleton /> : !krk.connected ? <Note>Kraken not reachable.</Note> : (
            <div className="grid grid-cols-2 gap-4 md:grid-cols-4">
              <Stat label="Coins held" value={money(krk.strategyValue)} sub={krk.holdings.map((h) => `${h.coin} ${money(h.value)}`).join(" · ") || "none"} />
              <Stat label="vs deposits" value={pnl0(krk.strategyPnl)} valueCls={tone(krk.strategyPnl)} sub={krk.strategyCapital > 0 ? `${(krk.strategyPnl / krk.strategyCapital * 100).toFixed(1)}% on ${money(krk.strategyCapital)} deposited` : undefined} />
              <Stat label="Cash" value={money(krk.usd)} sub={krk.totalValue > 0 ? `${((krk.usd / krk.totalValue) * 100).toFixed(0)}% of account` : undefined} />
              <Stat label="Own book" value={money(krk.otherValue)} sub="hand-bought, untouched" />
            </div>
          )}
        </PanelBody>
      </Panel>

      {/* ── Where to go ── */}
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4">
        {[
          { href: "/margin", title: "Margin Cockpit", sub: "Live account: positions, liquidation distance, charts, signals" },
          { href: "/margin/paper", title: "Road to Live", sub: "The paper gate, the arm switch, the strategy scoreboard" },
          { href: "/orders", title: "Orders", sub: "Every real fill and round trip, and the paper log" },
          { href: "/command", title: "System Health", sub: "Scanner and guardian heartbeats, switches, locks" },
        ].map((l) => (
          <Link key={l.href} href={l.href} className="rounded-xl border border-border bg-card px-4 py-3 transition-colors hover:border-foreground/20 hover:bg-accent/40">
            <p className="text-[13px] font-semibold">{l.title}</p>
            <p className="mt-0.5 text-xs text-muted-foreground">{l.sub}</p>
          </Link>
        ))}
      </div>
    </div>
  );
}

function Skeleton() {
  return (
    <div>
      <div className="skeleton mb-2 h-3 w-16" />
      <div className="skeleton mb-1 h-7 w-28" />
      <div className="skeleton h-3 w-24" />
    </div>
  );
}
