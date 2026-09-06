"use client";

import useSWR from "swr";
import { Chip, verdictTone } from "@/components/ui/chip";
import { DataTable, Row, Td, Th } from "@/components/ui/data-table";
import { Explainer, Label, Note, PageHeader, Panel, PanelBody, PanelHeader, Stat } from "@/components/ui/panel";
import { ago, money, pct, pnl2, timeOnly, tone, usd, when } from "@/lib/format";

// ============ STOCK PAPER BOOK ============
// The crypto desk's method, on US stocks: scan 30 liquid marginable names, open PAPER
// longs on high-conviction breakouts, score them on real 1-minute bars with realistic
// costs, and keep the statistical record. Nothing here touches Robinhood — see the
// explainer. Signals also go to Slack for Spencer to take by hand if he chooses.

const fetcher = (u: string) => fetch(u).then((r) => r.json());

interface Tier { tier: string; resolved: number; wins: number; hitRate: number | null; totalPnl: number }
interface Score {
  resolved: number; wins: number; hitRate: number | null; totalPnl: number; fees: number;
  avgWin: number; avgLoss: number; open: number; openUnrealized: number; byConviction: Tier[]; voided?: number;
}
interface Strat {
  key: string; label: string; resolved: number; wins: number; hitRate: number | null; expectancy: number | null;
  totalPnl: number; grossPnl: number; fees: number; open: number; peakedGreen: number; days: number; tStat: number | null; verdict: string;
}
interface RowT {
  id: number; time: string; symbol: string; source: string; timeframe: string | null; conviction: string | null;
  entry: number; notional: number; exit: number | null; pnl: number | null; unrealized: number | null;
  fees: number | null; status: string; reason: string | null; stop: number | null; peak: number | null; simVersion?: string;
}
interface Signal { ts: string; symbol: string; timeframe: string; kind: string; detail: string; price: number }
interface Payload { score: Score | null; strategies: Strat[]; log: RowT[]; lastRun: string | null; universe: string[]; signals: Signal[] }

const hitTone = (h: number | null) => (h != null && h >= 0.5 ? "text-up" : "text-warn");

export default function StockPaperPage() {
  const { data } = useSWR<Payload>("/api/stocks/paper", fetcher, { refreshInterval: 60_000 });
  const score = data?.score ?? null;
  const strategies = data?.strategies ?? [];
  const log = data?.log ?? [];
  const hasAny = !!score && (score.resolved > 0 || score.open > 0);

  return (
    <div className="space-y-5">
      <PageHeader
        title="Stock Paper Book"
        sub="The crypto desk's method on US stocks: high-conviction breakout longs, scored on real 1-minute bars with slippage and margin interest. No money at risk."
        right={<><Chip tone="paper" size="md">Paper only</Chip><Chip tone="grey" size="md" title="Runs every 15 min, 9:30–4:00 ET">Scanner ran {ago(data?.lastRun ?? null)}</Chip></>}
      />

      <Explainer title="Why this is paper, and what it is for">
        <p>
          Robinhood has margin on your main account, but no official way for software to trade it. Their agent route (Agentic Trading) is a separate
          <strong> cash account, long-only, no margin borrowing yet, no shorting, no paper mode</strong>. The unofficial APIs get accounts frozen, so nothing here
          connects to Robinhood at all. This book answers the question that matters first: <strong>does the signal that showed promise on crypto work on stocks?</strong>
          If it does, the record is ready the day Robinhood enables margin for agents. Until then every signal also goes to Slack — take it by hand in your margin account if you want to; the scoreboard will tell you whether you should.
        </p>
        <p>
          Two long-only sleeves, same entry rule (high conviction, not stretched), split by the timeframe that fired: <strong>Fast</strong> (5m/15m, 2% stop, out by the next close)
          and <strong>Swing</strong> (1h/1d, 5% stop, up to ~10 sessions). Sizing is risk-based like crypto: 3% of a $5k reference account per trade (6% on high conviction), capped at
          2× equity book-wide, which is Robinhood&apos;s overnight margin — an entry that would push the book past that is skipped, not shrunk. Costs: 0.05% chase in, 0.05% slippage out, 5% APR on the financed half of every position. No commission.
          Verdict rules are identical to the crypto desk: 30+ resolved, positive net, t≥2, 7+ distinct days before anything is called an edge.
        </p>
        <p>Universe ({data?.universe?.length ?? 30}): {data?.universe?.join(", ")}</p>
      </Explainer>

      {!hasAny && (
        <Panel><PanelBody className="py-8 text-center">
          <p className="text-[13px] text-muted-foreground">No stock paper trades yet.</p>
          <Note className="mt-1">Paper opens only on high-conviction breakouts during regular hours. Check back after a session or two.</Note>
        </PanelBody></Panel>
      )}

      {score && hasAny && (
        <Panel tone="paper">
          <PanelHeader
            title="Paper record — would these have made money?"
            aside={
              <>
                <Chip tone="paper">{score.open} open</Chip>
                {score.open > 0 && <span>floating <span className={`font-semibold ${tone(score.openUnrealized)}`}>{pnl2(score.openUnrealized)}</span></span>}
                {(score.voided ?? 0) > 0 && <Chip tone="grey" title="Trades whose outcome could not be known — the evaluator was down longer than Yahoo's 1-minute history reaches. Excluded from every statistic.">{score.voided} voided</Chip>}
                <span>no real money</span>
              </>
            }
          />
          <PanelBody className="space-y-4">
            <div className="grid grid-cols-2 gap-4 md:grid-cols-5">
              <Stat label="Resolved" value={score.resolved} />
              <Stat label="Hit rate" value={pct(score.hitRate)} valueCls={hitTone(score.hitRate)} />
              <Stat label="Net P&L" value={money(score.totalPnl)} valueCls={tone(score.totalPnl)} />
              <Stat label="Costs" value={score.fees ? `−$${Math.round(score.fees).toLocaleString()}` : "—"} valueCls="text-down/80" />
              <Stat label="Avg win / loss" value={<><span className="text-up">{money(score.avgWin)}</span><span className="mx-1 text-muted-foreground">/</span><span className="text-down">{money(score.avgLoss)}</span></>} />
            </div>
            {score.byConviction.length > 0 && (
              <div className="border-t border-border pt-3">
                <Label className="mb-2">By conviction — does confluence predict on stocks too?</Label>
                <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
                  {score.byConviction.map((t) => (
                    <div key={t.tier} className="flex items-center gap-2 rounded-lg border border-border px-2.5 py-1.5 text-xs">
                      <span className="font-semibold capitalize">{t.tier}</span>
                      <span className="text-muted-foreground">{t.resolved} · {pct(t.hitRate)}</span>
                      <span className={`ml-auto font-semibold tabular-nums ${tone(t.totalPnl)}`}>{money(t.totalPnl)}</span>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </PanelBody>
        </Panel>
      )}

      {strategies.some((s) => s.resolved > 0 || s.open > 0) && (
        <Panel>
          <PanelHeader title="Sleeves — what's working" aside={<span>paper · expectancy = avg $/trade after costs</span>} />
          <DataTable>
            <thead>
              <tr>
                <Th>Sleeve</Th>
                <Th num>Resolved</Th>
                <Th num>Open</Th>
                <Th num>Hit rate</Th>
                <Th num>Gross</Th>
                <Th num>Costs</Th>
                <Th num>Net</Th>
                <Th num title="Went green at peak → finished green">Green banked</Th>
                <Th num>Days</Th>
                <Th num>Verdict</Th>
              </tr>
            </thead>
            <tbody>
              {strategies.map((s) => (
                <Row key={s.key}>
                  <Td strong>{s.label}</Td>
                  <Td num>{s.resolved}</Td>
                  <Td num muted>{s.open}</Td>
                  <Td num className={`font-semibold ${hitTone(s.hitRate)}`}>{pct(s.hitRate)}</Td>
                  <Td num className={tone(s.grossPnl)}>{money(s.grossPnl)}</Td>
                  <Td num className="text-down/80">{s.fees ? `−$${Math.round(s.fees).toLocaleString()}` : "—"}</Td>
                  <Td num className={`font-semibold ${tone(s.totalPnl)}`}>{money(s.totalPnl)}</Td>
                  <Td num muted>{s.resolved > 0 ? `${Math.round((s.peakedGreen / s.resolved) * 100)}% → ${Math.round((s.wins / s.resolved) * 100)}%` : "—"}</Td>
                  <Td num muted>{s.days}</Td>
                  <Td num>
                    <span className="inline-flex items-center gap-1.5">
                      <Chip tone={verdictTone(s.verdict)}>{s.verdict}</Chip>
                      {s.tStat != null && s.resolved >= 30 && <span className="text-[11px] text-muted-foreground">t={s.tStat.toFixed(1)}</span>}
                    </span>
                  </Td>
                </Row>
              ))}
            </tbody>
          </DataTable>
        </Panel>
      )}

      {log.length > 0 && (
        <Panel>
          <PanelHeader title="Paper log" aside={<span>newest first · open rows show the live float</span>} />
          <DataTable sticky maxH="28rem">
            <thead>
              <tr>
                <Th>Time</Th>
                <Th>Sleeve</Th>
                <Th>Symbol</Th>
                <Th>Conviction</Th>
                <Th num>Size</Th>
                <Th num>Entry</Th>
                <Th num>Stop</Th>
                <Th num>Exit</Th>
                <Th num>P&amp;L</Th>
                <Th>Outcome</Th>
              </tr>
            </thead>
            <tbody>
              {log.map((t) => {
                const open = t.status === "open";
                const val = open ? t.unrealized : t.pnl;
                return (
                  <Row key={t.id}>
                    <Td muted>{when(t.time)}</Td>
                    <Td muted>{t.source.replace("stock-", "")}{t.timeframe ? <span className="ml-1 text-muted-foreground/70">{t.timeframe}</span> : null}</Td>
                    <Td strong>{t.symbol}{t.simVersion && t.simVersion !== "s1" && <span className="ml-1 text-[11px] text-muted-foreground" title="Older measurement cohort — excluded from the scoreboard">{t.simVersion}</span>}</Td>
                    <Td muted className="capitalize">{t.conviction ?? "—"}</Td>
                    <Td num muted>{money(t.notional)}</Td>
                    <Td num muted>{usd(t.entry)}</Td>
                    <Td num muted>{t.stop != null ? usd(t.stop) : "—"}</Td>
                    <Td num muted>{t.exit != null ? usd(t.exit) : "—"}</Td>
                    <Td num className={`font-semibold ${val != null ? tone(val) : "text-muted-foreground"}`}>{val != null ? pnl2(val) : "—"}{open && <span className="ml-1 text-[10px] font-normal text-muted-foreground">float</span>}</Td>
                    <Td>{open ? <Chip tone="amber">open</Chip> : t.status === "void" ? <Chip tone="grey">void</Chip> : <span className="text-muted-foreground">{t.reason ?? t.status}</span>}</Td>
                  </Row>
                );
              })}
            </tbody>
          </DataTable>
        </Panel>
      )}

      {(data?.signals?.length ?? 0) > 0 && (
        <Panel>
          <PanelHeader title="Scanner — last 24h" aside={<span>awareness only · not trade advice</span>} />
          <div className="max-h-56 divide-y divide-border/60 overflow-y-auto">
            {data!.signals.map((s, i) => {
              const bullish = s.kind === "oversold" || s.kind === "breakout" || s.kind === "move-up";
              const bearish = s.kind === "overbought" || s.kind === "breakdown" || s.kind === "move-down";
              return (
                <div key={i} className="flex items-center gap-3 px-4 py-1.5 text-xs">
                  <span className="w-16 shrink-0 tabular-nums text-muted-foreground">{timeOnly(s.ts)}</span>
                  <span className="w-14 shrink-0 font-semibold">{s.symbol}</span>
                  <span className="w-8 shrink-0 text-muted-foreground">{s.timeframe}</span>
                  <span className={`flex-1 truncate ${bullish ? "text-up" : bearish ? "text-down" : ""}`}>{s.detail}</span>
                  <span className="tabular-nums text-muted-foreground">${(s.price ?? 0).toLocaleString()}</span>
                </div>
              );
            })}
          </div>
        </Panel>
      )}
    </div>
  );
}
