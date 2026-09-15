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
  regime: { at: string; byRoot: Record<string, { label: string; atrPct: number | null; at: string }> } | null;
  rolls: { root: string; micro: string; contract: string; kind: string; rollOn: string; daysUntilRoll: number; held: boolean }[];
  scorePromoted: boolean; minScore: number;
  /** The weekly score-bucket verdict (E7): green = PROMOTE is allowed; null while the review read fails. */
  scoreVerdict: { ok: boolean; reasons: string[]; tStat: number | null; buckets: { label: string; n: number; meanR: number | null; pf: number | null }[]; unscored: number; promoted: boolean } | null;
}
export interface FuturesBriefView { at: string; action: "NO TRADE" | "REDUCE" | "WAIT"; markdown: string }

const actionTone = (a: FuturesBriefView["action"] | null): ChipTone => (a === "WAIT" ? "amber" : a === "REDUCE" ? "red" : "grey");
const rollDate = (iso: string) => new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "America/New_York" });
/** A root label older than two days is one the refresh could not renew (its bars failed) — shown amber, never as fresh. */
const REGIME_STALE_DAYS = 2;
const ageDays = (iso: string) => { const t = Date.parse(iso); return Number.isFinite(t) ? Math.max(0, (Date.now() - t) / 86_400_000) : Infinity; };
const f2 = (x: number | null) => (x == null ? "—" : x.toFixed(2));

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
          <Stat label="Next roll per root (calendar)" value={<span className="text-sm font-medium">{d.rolls.length ? d.rolls.map((r) => (r.held ? `${r.root} held ${r.contract.slice(r.micro.length)} rolls ~${rollDate(r.rollOn)}` : `${r.root} ${r.contract} ~${rollDate(r.rollOn)}`)).join(" · ") : "—"}</span>} sub={<>the broker&apos;s own maturity dates decide the real roll; index expiry − 2 days, metals first notice − 20 days</>} />
        </div>
        <div className="sm:col-span-3 lg:col-span-6">
          <Stat label={<>Regime {d.regime ? `· ${ago(d.regime.at)}` : ""}</>} value={<span className="flex flex-wrap gap-1.5">{d.regime && Object.keys(d.regime.byRoot).length ? Object.entries(d.regime.byRoot).map(([root, v]) => { const age = ageDays(v.at); const stale = age > REGIME_STALE_DAYS; return <Chip key={root} tone={stale ? "amber" : v.label.startsWith("uptrend") ? "green" : v.label.startsWith("downtrend") ? "red" : "grey"} title={`labelled ${ago(v.at)}`}>{root} {v.label}{stale ? ` · stale (${Math.round(age)} d)` : ""}</Chip>; }) : <span className="text-sm font-medium">— (no snapshot yet; the guardian labels once a day from Yahoo daily bars)</span>}</span>} />
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

const btn = "inline-flex h-8 items-center justify-center rounded-md border px-3 text-xs font-semibold transition-colors disabled:cursor-not-allowed disabled:opacity-40 border-up/50 bg-up/10 text-up hover:bg-up/20";

/** The PROMOTE control (E7): the score becomes a size only on a green bucket verdict, typed like CLEAR/ENABLE. */
export function FuturesScorePanel({ verdict, promoted, minScore, busy, confirm, setConfirm, onPromote }: {
  verdict: FuturesDashboardView["scoreVerdict"]; promoted: boolean; minScore: number; busy: boolean; confirm: string; setConfirm: (v: string) => void; onPromote: () => void;
}) {
  const green = !!verdict?.ok;
  return (
    <Panel>
      <PanelHeader title="Score promotion" aside={<><Chip tone={promoted ? "green" : verdict?.ok ? "amber" : "grey"}>{promoted ? "PROMOTED" : green ? "verdict GREEN" : "stamp only"}</Chip><span>≥ 30 per bucket · ≥ 80 beats &lt; 70 by mean R · Welch t ≥ 2</span></>} />
      <PanelBody className="space-y-2">
        {verdict ? (
          <p className="text-xs text-muted-foreground">
            {verdict.buckets.map((b) => `${b.label}: n ${b.n} · mean R ${f2(b.meanR)} · PF ${b.pf == null ? "—" : b.pf === Infinity ? "∞" : f2(b.pf)}`).join(" · ")} · t {f2(verdict.tStat)} · unscored {verdict.unscored}
          </p>
        ) : <Note>Verdict unavailable — the review read failed.</Note>}
        {promoted ? (
          <Note>Promoted: Strong (≥ 80) and A+ (≥ 90) budgets are live and the desk minimum score ({minScore}) refuses. Demotion is a config write of <code>futures_desk_score_promoted</code>.</Note>
        ) : (
          <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
            <input value={confirm} onChange={(e) => setConfirm(e.target.value)} placeholder="type PROMOTE" aria-label="Type PROMOTE" disabled={!green} className="h-8 w-full rounded-md border border-input bg-background px-2.5 text-[13px] sm:w-36" />
            <button disabled={busy || !green || confirm !== "PROMOTE"} onClick={onPromote} title={green ? "Promote the score to a size" : verdict?.reasons.join(" · ") ?? "verdict unavailable"} className={`${btn} w-full sm:w-auto`}>{busy ? "…" : "Promote the score"}</button>
            {!green && <Note>{verdict ? `Not yet: ${verdict.reasons.join(" · ")}` : ""}</Note>}
          </div>
        )}
      </PanelBody>
    </Panel>
  );
}
