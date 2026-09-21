"use client";

import Link from "next/link";
import useSWR from "swr";
import { Chip, type ChipTone } from "@/components/ui/chip";
import { PageHeader, Panel, PanelBody, PanelHeader, Stat, Note } from "@/components/ui/panel";
import { ago, money, pnl0, tone } from "@/lib/format";

const fetcher = (u: string) => fetch(u).then((r) => r.json());

// ============ DASHBOARD ============
// One job: "how is the money right now?" — Spencer's LIVE Tradovate account (his hand trades,
// headlined) and the real Robinhood options account, each with its money state named. The paper
// futures desk was retired Sep 21 2026. No analytics here; the records live on the desk pages, the trade lists on
// Orders, machinery on System Health. Every read is an existing read-only endpoint; nothing on
// this page can place an order. The Kraken margin desk that used to headline it was retired Sep 19 2026.

interface OptionsLive {
  account?: { totalValue: number; optionLevel: string; buyingPower: number; at: string } | null;
  live?: { positions: unknown[]; orders: unknown[]; at: string } | null;
  execution?: { canPlaceOrders: boolean; armed?: boolean; verified?: boolean; maxLossUsd: number | null; why: string };
}
interface RoomView {
  at: string;
  live: { at: string; ok: boolean; error?: string; netLiq: number | null; realizedPnl: number | null; unrealizedPnl: number | null; positions: { contract: string; netPos: number; netPrice: number }[]; fillsToday: number } | null;
  card: { at: string; events: { name: string; atMs: number; tier: number }[] } | null;
  settings: { contracts: number; dailyLossUsd: number | null };
}
interface DeskView { owned: { underlying: string; kind: string; entryPrice: number; legs?: { quantity: number }[] }[]; state?: { slots?: number; candidate?: string; at?: string } | null; ladder: { reserveMaxFrac: number }; guardian: { at: string | null; fresh: boolean } }
interface JournalData {
  ledger?: { byDay: { day: string; trades: number; netUsd: number; cumNetUsd: number }[] };
  rows?: { exitTs: string; netUsd: number; feesUsd: number; open: boolean }[];
  scoreboard?: { closed: number; winRate: number | null; meanR: number | null; profitFactor: number | null; verdict: { status: string } };
}

function heartbeatTone(iso: string | null | undefined, warnMin: number, critMin: number): ChipTone {
  if (!iso) return "grey";
  const m = (Date.now() - Date.parse(iso)) / 60000;
  return m < warnMin ? "green" : m < critMin ? "amber" : "red";
}

export default function DashboardPage() {
  const { data: opt } = useSWR<OptionsLive>("/api/options/live", fetcher, { refreshInterval: 120_000 });
  // The live account he trades by hand: read by the Trading Room every 5 minutes, never written.
  const { data: room } = useSWR<RoomView>("/api/trade", fetcher, { refreshInterval: 60_000 });
  const { data: jr } = useSWR<JournalData>("/api/trade/journal", fetcher, { refreshInterval: 120_000 });
  // The options desk's own state (what it holds, its slots) — live, unlike the after-close account snapshot.
  const { data: desk } = useSWR<DeskView>("/api/options/live-desk", fetcher, { refreshInterval: 60_000 });

  const loading = !opt && !room;
  const live = room?.live?.ok ? room.live : null;
  const days = jr?.ledger?.byDay ?? [];
  const lastDay = [...days].reverse().find((d) => d.trades > 0) ?? null;
  const nowMs = Date.parse(room?.at ?? "") || 0;   // the server's clock at read time, so render stays pure
  const nextPrint = room?.card ? room.card.events.filter((e) => e.atMs > nowMs).sort((a, b) => a.atMs - b.atMs)[0] ?? null : null;
  const todayLoss = live?.realizedPnl != null && live.realizedPnl < 0 ? -live.realizedPnl : 0;
  const lossLine = room?.settings.dailyLossUsd ?? null;
  const optionsArmed = Boolean(opt?.execution?.canPlaceOrders);
  // Today's closed trades on the live account (exchange day = the room's ledger day), for the two live cards.
  const todayKey = lastDay?.day ?? null;
  const todayRows = (jr?.rows ?? []).filter((r) => !r.open && todayKey != null && r.exitTs.slice(0, 10) === todayKey);
  const todayFees = todayRows.reduce((a, r) => a + r.feesUsd, 0), todayWins = todayRows.filter((r) => r.netUsd > 0).length;
  const sb = jr?.scoreboard ?? null;

  return (
    <div className="space-y-5">
      <PageHeader
        title="Dashboard"
        sub="The money right now: your live Tradovate account (by hand) · Robinhood options (real account)."
        right={(opt || room) && (
          <>
            {live && <Chip tone={lossLine != null && todayLoss >= lossLine ? "red" : live.positions.length ? "amber" : "green"} dot={!!live.positions.length} size="md" title="Your live Tradovate account, read every 5 minutes">
              {lossLine != null && todayLoss >= lossLine ? "Past your daily loss line" : live.positions.length ? `Live · ${live.positions.length} open` : "Live · flat"}
            </Chip>}
            <Chip tone={optionsArmed ? "red" : opt?.execution?.armed ? "amber" : "grey"} dot={optionsArmed} size="md">
              {optionsArmed ? "Options desk armed" : opt?.execution?.armed ? "Options armed · unverified" : "Options desk disarmed"}
            </Chip>
            <Chip tone={heartbeatTone(room?.live?.at, 10, 30)} size="md" title={`the room last read your account ${ago(room?.live?.at)}`}>
              {heartbeatTone(room?.live?.at, 10, 30) === "green" ? "Room reporting" : heartbeatTone(room?.live?.at, 10, 30) === "grey" ? "Room not read" : "Room stale"}
            </Chip>
          </>
        )}
      />

      {/* ── The live account, first ── */}
      <Panel tone={lossLine != null && todayLoss >= lossLine ? "red" : undefined}>
        <PanelHeader title="Tradovate · live · by hand" aside={<Link href="/trade" className="text-primary hover:underline">Trading Room →</Link>} />
        <PanelBody>
          <div className="grid grid-cols-2 gap-4 md:grid-cols-5">
            <Stat size="lg" label="Net liquidation" value={live?.netLiq != null ? money(live.netLiq) : "—"} sub={room?.live ? `read ${ago(room.live.at)}` : "not read yet"} title="Your real account, from the broker" />
            <Stat label="Today" value={live ? pnl0(live.realizedPnl ?? 0) : "—"} valueCls={tone(live?.realizedPnl ?? 0)} sub={live?.unrealizedPnl ? `open ${pnl0(live.unrealizedPnl)}` : lossLine != null ? `loss line ${money(lossLine)}` : "no daily loss line set"} />
            <Stat label="Open" value={live ? (live.positions.length ? live.positions.map((p) => `${p.contract} ${p.netPos > 0 ? "+" : ""}${p.netPos}`).join(" · ") : "flat") : "—"} sub={live ? `${live.fillsToday} fills seen today` : undefined} />
            <Stat label="Last trading day" value={lastDay ? pnl0(lastDay.netUsd) : "—"} valueCls={tone(lastDay?.netUsd ?? 0)} sub={lastDay ? `${lastDay.day} · ${lastDay.trades} paired trades · running ${pnl0(lastDay.cumNetUsd)}` : "no ledger yet"} />
            <Stat label="Next print" value={nextPrint ? new Date(nextPrint.atMs).toLocaleString("en-US", { timeZone: "America/New_York", weekday: "short", hour: "numeric", minute: "2-digit" }) : "none"} sub={nextPrint ? `${nextPrint.name}${nextPrint.tier === 1 ? " · tier 1 · lockout ±30 min" : ""}` : "nothing scheduled this week"} />
          </div>
          <Note className="mt-3">Read-only. You trade this account yourself at {room?.settings.contracts ?? "—"} micros; the room shows levels, the tape, the ledger and the 40-trade scoreboard. Nothing on this site places, changes or cancels an order here.</Note>
        </PanelBody>
      </Panel>

      {/* ── The four numbers ── */}
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <Panel><PanelBody>
          {loading ? <Skeleton /> : (
            <Stat size="lg" label="Robinhood account" value={opt?.account ? money(opt.account.totalValue) : "—"} title="The real options account, as the desk session last saw it"
              sub={opt?.account ? <>buying power {money(opt.account.buyingPower)} · snapshot {ago(opt.live?.at ?? opt.account.at)}</> : "no snapshot yet"} />
          )}
        </PanelBody></Panel>

        <Panel><PanelBody>
          {loading ? <Skeleton /> : (
            <Stat size="lg" label="Options desk" value={desk ? `${desk.owned.length} of ${desk.state?.slots ?? 3}` : "—"} title="Names the desk holds right now, against its slots"
              sub={desk ? <>{money(desk.owned.reduce((a, o) => a + o.entryPrice * 100 * (o.legs?.[0]?.quantity ?? 1), 0))} at risk{opt?.account ? ` of ${money(desk.ladder.reserveMaxFrac * opt.account.totalValue)} allowed` : ""}{desk.owned.length ? ` · ${desk.owned.map((o) => o.underlying).join(", ")}` : ""}</> : "desk state not read"} />
          )}
        </PanelBody></Panel>

        <Panel><PanelBody>
          {loading ? <Skeleton /> : (
            <Stat size="lg" label={`${lastDay ? lastDay.day.slice(5).replace("-", "/") : "Latest day"} · live`} value={todayRows.length ? `${todayRows.length} trade${todayRows.length === 1 ? "" : "s"}` : "no closed trades"} title="Closed trades on your live account on the latest exchange day (Tradovate's day rolls at 5 PM ET), from the journal"
              sub={todayRows.length ? <>{todayWins}W / {todayRows.length - todayWins}L · fees {money(todayFees)} · net <span className={tone(todayRows.reduce((a, r) => a + r.netUsd, 0))}>{pnl0(todayRows.reduce((a, r) => a + r.netUsd, 0))}</span></> : "no ledger yet"} />
          )}
        </PanelBody></Panel>

        <Panel><PanelBody>
          {loading ? <Skeleton /> : (
            <Stat size="lg" label="40-trade test" value={sb ? `${Math.min(sb.closed, 40)} of 40` : "—"} title="The pre-registered test on your live trades — see the Trading Room scoreboard"
              sub={sb ? <>{sb.verdict.status}{sb.winRate != null ? ` · win ${Math.round(sb.winRate * 100)}%` : ""}{sb.meanR != null ? ` · mean ${sb.meanR >= 0 ? "+" : ""}${sb.meanR.toFixed(2)}R` : ""}{sb.profitFactor != null ? ` · PF ${sb.profitFactor.toFixed(2)}` : ""}</> : "no trades yet"} />
          )}
        </PanelBody></Panel>
      </div>

      <Panel>
        <PanelHeader title="Robinhood options" aside={
          <Chip tone={optionsArmed ? "red" : opt?.execution?.armed ? "amber" : "grey"} dot={optionsArmed}>
            {optionsArmed ? "Live desk armed · verified" : opt?.execution?.armed ? "Armed · adapter unverified" : "Live execution inactive"}
          </Chip>} />
        <PanelBody>
          <div className="grid grid-cols-2 gap-4 md:grid-cols-4">
            <Stat label="Account value" value={opt?.account ? money(opt.account.totalValue) : "—"} />
            <Stat label="Buying power" value={opt?.account ? money(opt.account.buyingPower) : "—"} />
            <Stat label="Desk holds" value={desk ? String(desk.owned.length) : "—"} sub={desk?.state?.candidate ? `last tick: ${desk.state.candidate.slice(0, 60)}` : desk?.guardian.at ? `guardian ${ago(desk.guardian.at)}` : undefined} />
            <Stat label="Maximum loss per trade" value={opt?.execution?.maxLossUsd != null ? money(opt.execution.maxLossUsd) : "Not set"} sub="including fees · 1 contract (2 on a Strong grade that fits twice) · up to 3 names at once" />
          </div>
          <Note className="mt-3">{opt?.execution?.why ?? "Loading account status..."} {opt?.account ? `Account snapshot ${ago(opt.account.at)}.` : ""}</Note>
        </PanelBody>
      </Panel>

      {/* ── Where to go ── */}
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-5">
        {[
          { href: "/trade", title: "Trading Room · Tradovate live", sub: "Levels for MES · MNQ · MGC, the news clock, the tape, your ledger and the 40-trade scoreboard" },
          { href: "/trade/library", title: "Trade Library", sub: "Every trade replayed: stats, equity curve, tags, grades, and the Slack replay button" },
          { href: "/options", title: "Live Account · Robinhood", sub: "The real options account: positions, orders, the research screen, the live desk switch" },
          { href: "/orders", title: "Orders", sub: "Every platform, broken down: your live trades and the Robinhood account's orders" },
          { href: "/command", title: "System Health", sub: "Heartbeats, switches, credentials, Slack lanes — both desks" },
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
