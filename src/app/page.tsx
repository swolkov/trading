"use client";

import Link from "next/link";
import useSWR from "swr";
import { Chip, type ChipTone } from "@/components/ui/chip";
import { PageHeader, Panel, PanelBody, PanelHeader, Stat, Note } from "@/components/ui/panel";
import { ago, money, pnl0, tone } from "@/lib/format";

const fetcher = (u: string) => fetch(u).then((r) => r.json());

// ============ DASHBOARD ============
// One job: "how are the desks right now?" — the real Robinhood options account and the
// Tradovate futures DEMO, each with its money state named. No analytics here; the paper
// records live on the desk pages, the trade lists on Orders, machinery on System Health.
// Every read is an existing read-only endpoint; nothing on this page can place an order.
// The Kraken margin desk that used to headline this page was retired Sep 19 2026.

interface OptionsLive {
  account?: { totalValue: number; optionLevel: string; buyingPower: number; at: string } | null;
  live?: { positions: unknown[]; orders: unknown[]; at: string } | null;
  execution?: { canPlaceOrders: boolean; armed?: boolean; verified?: boolean; maxLossUsd: number | null; why: string };
}
interface FuturesDesk {
  enabled: boolean; disabledReason: string | null; entriesToday: number;
  limits: { sizingBasisUsd: number; riskPct: number; maxPositions: number; maxEntriesPerDay: number };
  guardian: { at: string | null; fresh: boolean; lastError: string | null };
  broker: { netLiq: number; positions: unknown[]; workingOrders: number } | null; brokerError: string | null;
  open: { contract: string; side: string; qty: number; entry_price: number; stop_price: number; edge: string }[];
  record: { trades: number; wins: number; pnl: number }; error?: string;
}

function heartbeatTone(iso: string | null | undefined, warnMin: number, critMin: number): ChipTone {
  if (!iso) return "grey";
  const m = (Date.now() - Date.parse(iso)) / 60000;
  return m < warnMin ? "green" : m < critMin ? "amber" : "red";
}

export default function DashboardPage() {
  const { data: opt } = useSWR<OptionsLive>("/api/options/live", fetcher, { refreshInterval: 120_000 });
  // The futures desk: Tradovate DEMO, paper by design, sized off a fixed $50k basis.
  const { data: fut } = useSWR<FuturesDesk>("/api/futures/desk", fetcher, { refreshInterval: 120_000 });

  const loading = !opt && !fut;
  const optionsArmed = Boolean(opt?.execution?.canPlaceOrders);
  const guardianTone = fut && !fut.error ? heartbeatTone(fut.guardian.at, 20, 60) : "grey";

  return (
    <div className="space-y-5">
      <PageHeader
        title="Dashboard"
        sub="Both desks, right now: Robinhood options (real account) · Tradovate futures (demo, paper only)."
        right={(opt || fut) && (
          <>
            <Chip tone={optionsArmed ? "red" : opt?.execution?.armed ? "amber" : "grey"} dot={optionsArmed} size="md">
              {optionsArmed ? "Options desk armed" : opt?.execution?.armed ? "Options armed · unverified" : "Options desk disarmed"}
            </Chip>
            <Chip tone={fut && !fut.error ? (fut.enabled ? "paper" : "grey") : "grey"} dot={!!fut?.enabled} size="md">{fut?.enabled ? "Futures demo enabled" : "Futures demo disabled"}</Chip>
            <Chip tone={guardianTone} size="md" title={`futures guardian ${ago(fut?.guardian?.at)}`}>
              {guardianTone === "green" ? "Guardian healthy" : guardianTone === "grey" ? "Guardian unknown" : "Guardian stale"}
            </Chip>
          </>
        )}
      />

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
            <Stat size="lg" label="Options positions" value={opt?.live ? String(opt.live.positions.length) : "—"} title="Open positions in the real account"
              sub={opt?.execution?.maxLossUsd != null ? `max loss per trade ${money(opt.execution.maxLossUsd)} incl. fees · one contract` : "max loss not set"} />
          )}
        </PanelBody></Panel>

        <Panel><PanelBody>
          {loading ? <Skeleton /> : (
            <Stat size="lg" label="Futures demo equity" value={fut?.broker ? money(fut.broker.netLiq) : "—"} title="Tradovate DEMO net liquidation — paper only"
              sub={fut?.brokerError ? <span className="text-down">broker not read</span> : fut && !fut.error ? `sized off a fixed ${money(fut.limits.sizingBasisUsd)} at ${fut.limits.riskPct}% a trade` : "loading…"} />
          )}
        </PanelBody></Panel>

        <Panel><PanelBody>
          {loading ? <Skeleton /> : (
            <Stat size="lg" label="Futures open" value={fut && !fut.error ? `${fut.open.length} of ${fut.limits.maxPositions}` : "—"} title="Open demo positions against the desk's slot limit"
              sub={fut?.open?.length ? fut.open.map((o) => `${o.side === "long" ? "▲" : "▼"} ${o.contract} × ${o.qty}`).join(" · ") : fut?.enabled ? "waiting for a TradingView alert" : "nothing opens while disabled"} />
          )}
        </PanelBody></Panel>
      </div>

      <Panel>
        <PanelHeader title="Tradovate futures · demo" aside={fut && !fut.error ? (
          <div className="flex items-center gap-2">
            <Chip tone={fut.enabled ? "paper" : "grey"} dot={fut.enabled}>{fut.enabled ? "Desk enabled" : "Desk disabled"}</Chip>
            <Chip tone={fut.guardian.fresh ? "green" : "grey"} title={fut.guardian.at ? `guardian ${ago(fut.guardian.at)}` : "guardian has not run"}>{fut.guardian.fresh ? "Guardian reporting" : "Guardian quiet"}</Chip>
          </div>
        ) : <Chip tone="grey">loading…</Chip>} />
        <PanelBody>
          <div className="grid grid-cols-2 gap-4 md:grid-cols-4">
            <Stat label="Entries today" value={fut && !fut.error ? `${fut.entriesToday} of ${fut.limits.maxEntriesPerDay}` : "—"} />
            <Stat label="Working orders" value={fut?.broker ? String(fut.broker.workingOrders) : "—"} sub="stops resting on the demo" />
            <Stat label="Record" value={fut && !fut.error ? `${fut.record.trades} closed` : "—"} sub={fut && fut.record.trades ? <>{fut.record.wins} wins · <span className={tone(fut.record.pnl)}>{pnl0(fut.record.pnl)}</span> after modeled fees</> : "no desk trades yet"} />
            <Stat label="Last desk error" value={fut?.guardian?.lastError ? <span className="text-warn text-base">see Futures Desk</span> : <span className="text-muted-foreground">none</span>} />
          </div>
          <Note className="mt-3">{fut?.disabledReason ? `Disabled: ${fut.disabledReason}. ` : ""}Paper only, by design: registered rules evaluated on TradingView, executed on the demo with the stop attached. Spencer trades futures by hand; this desk is the analyst and the record. The edges&apos; verdicts and the enable switch are on the Futures Desk.</Note>
        </PanelBody>
      </Panel>

      <Panel>
        <PanelHeader title="Robinhood options" aside={
          <Chip tone={optionsArmed ? "red" : opt?.execution?.armed ? "amber" : "grey"} dot={optionsArmed}>
            {optionsArmed ? "Live desk armed · verified" : opt?.execution?.armed ? "Armed · adapter unverified" : "Live execution inactive"}
          </Chip>} />
        <PanelBody>
          <div className="grid grid-cols-2 gap-4 md:grid-cols-4">
            <Stat label="Account value" value={opt?.account ? money(opt.account.totalValue) : "—"} />
            <Stat label="Buying power" value={opt?.account ? money(opt.account.buyingPower) : "—"} />
            <Stat label="Open orders" value={opt?.live ? String(opt.live.orders.length) : "—"} />
            <Stat label="Maximum loss per trade" value={opt?.execution?.maxLossUsd != null ? money(opt.execution.maxLossUsd) : "Not set"} sub="including fees · one contract · one position" />
          </div>
          <Note className="mt-3">{opt?.execution?.why ?? "Loading account status..."} {opt?.account ? `Account snapshot ${ago(opt.account.at)}.` : ""}</Note>
        </PanelBody>
      </Panel>

      {/* ── Where to go ── */}
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4">
        {[
          { href: "/futures", title: "Futures Desk · Tradovate demo", sub: "Registered rules, their verdicts, the enable switch, the TradingView setup" },
          { href: "/options", title: "Live Account · Robinhood", sub: "The real options account: positions, orders, the research screen, the live desk switch" },
          { href: "/orders", title: "Orders", sub: "Every platform, broken down: futures demo ledger and alerts, Robinhood account orders" },
          { href: "/command", title: "System Health", sub: "Heartbeats, switches, credentials — both desks" },
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
