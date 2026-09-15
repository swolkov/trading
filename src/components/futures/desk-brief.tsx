"use client";

import { Chip, type ChipTone } from "@/components/ui/chip";
import { Empty, Note, Panel, PanelBody, PanelHeader, Stat } from "@/components/ui/panel";
import { ago, money, pnl0, tone } from "@/lib/format";

// The futures desk's dashboard numbers and the desk brief (E8). Both read GET /api/futures/desk —
// the guardian's own keys (risk state, event policy, regime, the latest brief) and the review rows;
// nothing here triggers a broker call.

export interface FuturesDashboardView {
  dailyRealized: number | null; openPnl: number | null; weekPnl: number; monthPnl: number; tradesToday: number; violationsToday: number;
  risk: { dd: number; tier: number; mult: number; openRisk: number; dailyLossRemaining: number; at: string } | null;
  eventMode: string | null; eventWindow: string | null;
  regime: { at: string; byRoot: Record<string, { label: string; atrPct: number | null }> } | null;
  rolls: { root: string; contract: string; kind: string; rollOn: string; daysUntilRoll: number }[];
  scorePromoted: boolean; minScore: number;
}
export interface FuturesBriefView { at: string; action: "NO TRADE" | "REDUCE" | "WAIT"; markdown: string }

const actionTone = (a: FuturesBriefView["action"] | null): ChipTone => (a === "WAIT" ? "amber" : a === "REDUCE" ? "red" : "grey");
const rollDate = (iso: string) => new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "America/New_York" });

export function FuturesDashboard({ d, equity, equityHigh, positions, trades, feedSeenAt, feedStale, stage }: {
  d: FuturesDashboardView; equity: number | null; equityHigh: number | null; positions: number; trades: number; feedSeenAt: string | null; feedStale: boolean; stage: string;
}) {
  const dd = equity != null && equityHigh ? (equity / equityHigh - 1) * 100 : null;
  return (
    <Panel>
      <PanelHeader title="Desk numbers" aside={<span>from the guardian&apos;s last run{d.risk ? ` · risk state ${ago(d.risk.at)}` : ""}</span>} />
      <PanelBody className="grid gap-4 sm:grid-cols-3 lg:grid-cols-6">
        <Stat label="Equity" value={equity != null ? money(equity) : "—"} sub={<>HWM {equityHigh != null ? money(equityHigh) : "—"}</>} />
        <Stat label="Drawdown" value={dd != null ? `${dd.toFixed(1)}%` : "—"} valueCls={tone(dd ?? 0)} sub={<>tier {d.risk?.tier ?? "—"} · budget ×{d.risk?.mult ?? "—"}</>} />
        <Stat label="Daily realized" value={d.dailyRealized != null ? pnl0(d.dailyRealized) : "—"} valueCls={tone(d.dailyRealized)} sub={<>open P&amp;L {d.openPnl != null ? pnl0(d.openPnl) : "—"} (netLiq − cash)</>} />
        <Stat label="Week / month" value={pnl0(d.weekPnl)} valueCls={tone(d.weekPnl)} sub={<>month <span className={tone(d.monthPnl)}>{pnl0(d.monthPnl)}</span> · judged (after slip)</>} />
        <Stat label="Positions" value={String(positions)} sub={<>open risk {d.risk ? money(d.risk.openRisk) : "—"} · daily loss left {d.risk ? money(d.risk.dailyLossRemaining) : "—"}</>} />
        <Stat label="Trades" value={String(trades)} sub={<>{d.tradesToday} today · violations today {d.violationsToday}</>} />
        <Stat label="Feed" value={feedStale ? "stale" : "live"} valueCls={feedStale ? "text-down" : "text-up"} sub={<>last seen {feedSeenAt ? ago(feedSeenAt) : "never"}</>} />
        <Stat label="Stage · event" value={`${stage} · ${d.eventMode ?? "—"}`} sub={<>{d.eventWindow ?? "no event window"}</>} />
        <Stat label="Score" value={d.scorePromoted ? "promoted" : "stamp only"} sub={<>min {d.minScore} {d.scorePromoted ? "(enforced)" : "(inert until promoted)"}</>} />
        <div className="sm:col-span-3 lg:col-span-3">
          <Stat label="Next roll per root (calendar)" value={<span className="text-sm font-medium">{d.rolls.length ? d.rolls.map((r) => `${r.root} ${r.contract} ~${rollDate(r.rollOn)}`).join(" · ") : "—"}</span>} sub={<>the broker&apos;s own maturity dates decide the real roll; index expiry − 2 days, metals first notice − 20 days</>} />
        </div>
        <div className="sm:col-span-3 lg:col-span-6">
          <Stat label={<>Regime {d.regime ? `· ${ago(d.regime.at)}` : ""}</>} value={<span className="flex flex-wrap gap-1.5">{d.regime && Object.keys(d.regime.byRoot).length ? Object.entries(d.regime.byRoot).map(([root, v]) => <Chip key={root} tone={v.label.startsWith("uptrend") ? "green" : v.label.startsWith("downtrend") ? "red" : "grey"}>{root} {v.label}</Chip>) : <span className="text-sm font-medium">— (no snapshot yet; the guardian labels once a day from Yahoo daily bars)</span>}</span>} />
        </div>
      </PanelBody>
    </Panel>
  );
}

export function FuturesBriefPanel({ brief }: { brief: FuturesBriefView | null }) {
  return (
    <Panel>
      <PanelHeader title="Desk brief" aside={brief ? <><Chip tone={actionTone(brief.action)}>{brief.action}</Chip><span>written {ago(brief.at)} · also in the vault at <code>Brain/futures-desk-brief.md</code> and on Slack</span></> : <span>written after the daily review (17:05 ET)</span>} />
      {brief ? (
        <PanelBody className="space-y-2">
          <pre className="max-h-[28rem] overflow-auto whitespace-pre-wrap rounded-md border border-border bg-background p-3 text-xs leading-relaxed">{brief.markdown}</pre>
          <Note>MARKET REGIME · TOP OPPORTUNITIES · RECOMMENDED TRADE · ACTION. The ACTION is what a person reading the desk would do — the executor keeps its own gates. <code>GET /api/futures/brief?live=1</code> renders it now.</Note>
        </PanelBody>
      ) : <PanelBody><Empty>No brief yet — the guardian writes the first one after the next daily review.</Empty></PanelBody>}
    </Panel>
  );
}
