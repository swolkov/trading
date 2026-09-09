"use client";

import useSWR from "swr";
import { Chip, verdictTone } from "@/components/ui/chip";
import { DataTable, Row, Td, Th } from "@/components/ui/data-table";
import { Explainer, Label, Note, PageHeader, Panel, PanelBody, PanelHeader, Stat } from "@/components/ui/panel";
import { ago, pct, pnl2, tone, usd, when } from "@/lib/format";

// ============ OPTIONS PAPER BOOK ============
// Two sleeves, identical rules, different reference equity ($1,000 and $5,000). The gap
// between them is the experiment: it measures what account size is actually worth in this
// strategy, instead of anyone asserting it. Nothing here places an order, and nothing here
// touches the Kraken margin desk.

const fetcher = (u: string) => fetch(u).then((r) => r.json());

interface Sleeve {
  key: string; label: string; refEquity: number; resolved: number; wins: number; hitRate: number | null;
  expectancy: number | null; totalPnl: number; open: number; openPremium: number; openMark: number;
  voided: number; days: number; tStat: number | null; verdict: string;
  avgSpreadPct: number | null; entriesThisMonth: number;
}
interface TradeRow {
  id: number; time: string; symbol: string; source: string; occ: string; strike: number | null;
  expiry: string | null; entryAsk: number; costUsd: number; markUsd: number | null; peakUsd: number | null;
  exitBid: number | null; pnl: number | null; pnlPct: number | null; status: string; reason: string | null;
  entryDelta: number | null; entrySpreadPct: number | null; simVersion: string;
}
interface Rules { maxEntriesPerMonth: number; maxConcurrent: number; maxSpreadPct: number; minDte: number; maxDte: number; minDelta: number; maxDelta: number }
interface LastResult { at: string; scanned: number; signals: string[]; fresh: string[]; opened: string[]; refused: string[] }
interface Payload {
  simVersion: string; rules: Rules; universe: { symbol: string; group: string }[];
  excluded: Record<string, string>; sleeves: Sleeve[]; trades: TradeRow[];
  lastRun: string | null; lastResult: LastResult | null;
}

export default function OptionsPaperPage() {
  const { data } = useSWR<Payload>("/api/options/paper", fetcher, { refreshInterval: 60_000 });
  const sleeves = data?.sleeves ?? [];
  const trades = data?.trades ?? [];
  const rules = data?.rules;
  const groups = (data?.universe ?? []).reduce<Record<string, string[]>>((acc, n) => {
    (acc[n.group] ||= []).push(n.symbol); return acc;
  }, {});

  return (
    <div className="space-y-5">
      <PageHeader
        title="Options Paper Book"
        sub="In-the-money calls on a 50-day breakout, held for months. Two sleeves at $1,000 and $5,000 — same rules, different size."
        right={<>
          <Chip tone="paper" size="md">Paper only</Chip>
          <Chip tone="grey" size="md" title="Runs once a day after the close, Mon–Fri">
            {data?.lastRun ? `Scanned ${ago(data.lastRun)}` : "No run yet"}
          </Chip>
        </>}
      />

      <Explainer title="What this is testing, and why it is slow on purpose">
        <p>
          A screen of 63 stocks against live quotes found the thing that decides whether options can work on a small account, and it is not the
          strategy — it is <strong>friction</strong>. Round-trip spread on the tradeable in-the-money contracts is <strong>2.2–2.9%</strong>, roughly
          <strong> 8× the Kraken desk&apos;s 0.34%</strong>. At four to six round trips a month that is 12–17% of the account gone to spread alone, which
          no edge survives. At one or two trades a month held for 60–120 days it is 3–6%. So the frequency <em>is</em> the strategy here, and the code
          enforces it: at most {rules?.maxEntriesPerMonth ?? 2} entries per sleeve per month, {rules?.maxConcurrent ?? 3} positions at once.
        </p>
        <p>
          The signal is a <strong>50-day Donchian breakout above the 200-day average</strong> — the daily version of the only rule that has ever survived
          out-of-sample testing here. The expression is a <strong>{rules ? `${rules.minDelta}–${rules.maxDelta}` : "0.70–0.85"} delta call, {rules?.minDte ?? 60}–{rules?.maxDte ?? 120} days out</strong>:
          mostly intrinsic value, so time decay is small; the tightest spreads on the board; and no stop-loss needed, because the premium is the floor.
          Not out-of-the-money lottery tickets — those expire worthless most of the time and are how small options accounts die.
        </p>
        <p>
          <strong>Entry pays the ask and exit receives the bid</strong>, both from live quotes — so the dominant cost is observed, not modeled. That is the
          honest upgrade over the July research, which had to price entries with a formula because real options history costs $207 per name-year. Exits also
          require real size behind the bid and a recent quote, so a phantom price on an untraded strike cannot book a profit.
        </p>
        <p>
          <strong>One caveat, stated plainly:</strong> this account is not signed up for the OPRA agreement, so quotes come from Alpaca&apos;s
          <em> indicative</em> feed rather than the executable NBBO. That is real market data, not a model — but the true tradeable spread may be wider than
          what is recorded here, which means these results are, if anything, <strong>flattering</strong>. Signing the OPRA agreement in the Alpaca dashboard
          upgrades every number on this page with no other change.
        </p>
        <p>
          The other trade-off: this can only measure forward. At two entries a month, a 30-trade verdict is roughly <strong>15 months</strong> away. It is a
          slow instrument by design, and the number below will say &quot;gathering&quot; for a long time. That is the measurement working, not stalling.
        </p>
      </Explainer>

      <div className="grid gap-4 md:grid-cols-2">

        {sleeves.map((s) => (
          <Panel key={s.key}>
            <PanelHeader title={s.label} aside={<Chip tone={verdictTone(s.verdict)} size="md">{s.verdict}</Chip>} />
            <PanelBody>
              <div className="grid grid-cols-3 gap-3">
                {/* Net P&L is REALIZED only. With an open position that has not resolved it reads
                    +$0.00, which next to a live mark can look like "flat" when the book is in fact
                    down the spread. Unrealized sits beside it so the two are never confused. */}
                <Stat label="Net P&L" sub="realized" value={<span className={tone(s.totalPnl)}>{pnl2(s.totalPnl)}</span>} />
                <Stat label="Unrealized" sub={s.open > 0 ? "open positions" : undefined}
                  value={s.open > 0
                    ? <span className={tone(s.openMark - s.openPremium)}>{pnl2(s.openMark - s.openPremium)}</span>
                    : "—"} />
                <Stat label="Resolved" value={String(s.resolved)} />
                <Stat label="Open" value={`${s.open} · ${usd(s.openPremium)}`} />
                <Stat label="Hit rate" value={s.hitRate != null ? pct(s.hitRate) : "—"} />
                <Stat label="t-stat" value={s.tStat != null ? s.tStat.toFixed(2) : "—"} />
              </div>
              {s.open === 0 && s.resolved === 0 && (
                <Note className="mt-3">
                  Nothing opened yet. On this sleeve that is usually a <strong>result, not a gap</strong>: a breakout fired but no contract cleared the
                  filters inside a {usd(s.refEquity * 0.55)} budget. The last scan below shows exactly what was refused and why.
                </Note>
              )}
              <div className="mt-3 flex flex-wrap gap-2">
                <Chip tone="grey">Reference equity {usd(s.refEquity)}</Chip>
                <Chip tone="grey">{s.entriesThisMonth}/{rules?.maxEntriesPerMonth ?? 2} entries this month</Chip>
                {s.avgSpreadPct != null && <Chip tone={s.avgSpreadPct <= 3 ? "grey" : "amber"}>Avg spread paid {s.avgSpreadPct.toFixed(1)}%</Chip>}
                {s.voided > 0 && <Chip tone="amber">{s.voided} voided</Chip>}
              </div>
            </PanelBody>
          </Panel>
        ))}
      </div>

      {sleeves.length === 2 && sleeves.every((s) => s.resolved > 0) && (
        <Panel>
          <PanelHeader title="Does account size matter?" />
          <PanelBody>
            <Note>
              Both sleeves run the identical rule at {usd(sleeves[0].refEquity)} and {usd(sleeves[1].refEquity)}. Compare <strong>return on reference equity</strong>,
              not dollars — the bigger book will always show bigger dollars.
            </Note>
            <div className="mt-3 grid grid-cols-2 gap-3">
              {sleeves.map((s) => (
                <Stat key={s.key} label={`${s.key} return on equity`}
                  value={<span className={tone(s.totalPnl)}>{pct(s.totalPnl / (s.refEquity || 1), 1)}</span>} />
              ))}
            </div>
          </PanelBody>
        </Panel>
      )}

      {data?.lastResult && (
        <Panel>
          <PanelHeader title="Last scan" aside={<Label>{ago(data.lastResult.at)}</Label>} />
          <PanelBody>
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
              <Stat label="Scanned" value={String(data.lastResult.scanned)} />
              <Stat label="Trend signals" value={data.lastResult.signals.length ? data.lastResult.signals.join(", ") : "none"} />
              <Stat label="Opened" value={String(data.lastResult.opened.length)} />
              <Stat label="Refused" value={String(data.lastResult.refused.length)} />
            </div>
            {data.lastResult.refused.length > 0 && (
              <div className="mt-4">
                <Label>Refused, and why</Label>
                <div className="mt-2 space-y-1">
                  {data.lastResult.refused.map((r, i) => <div key={i} className="text-xs text-muted-foreground">{r}</div>)}
                </div>
                <Note className="mt-2">
                  Refusals are the point, not noise. &quot;No contract passes filters&quot; on the $1,000 sleeve is this experiment&apos;s central
                  finding being recorded in real time.
                </Note>
              </div>
            )}
          </PanelBody>
        </Panel>
      )}

      <Panel>
        <PanelHeader title="Position log" aside={<Label>{trades.length} shown</Label>} />
        <PanelBody>
          <DataTable sticky maxH="60vh">
            <thead>
              <tr>
                <Th>When</Th><Th>Sleeve</Th><Th>Contract</Th><Th num>Δ / spread</Th>
                <Th num>Paid</Th><Th num>Mark / exit</Th><Th num>P&L <span className="normal-case opacity-60">(open = unreal.)</span></Th><Th>Status</Th>
              </tr>
            </thead>
            <tbody>
            {trades.map((t) => (
              <Row key={t.id}>
                <Td title={when(t.time)}>{ago(t.time)}</Td>
                <Td>{t.source}</Td>
                <Td className="whitespace-nowrap">{t.symbol} ${t.strike ?? "—"} {t.expiry ?? ""}</Td>
                <Td num>{t.entryDelta != null ? t.entryDelta.toFixed(2) : "—"} / {t.entrySpreadPct != null ? `${t.entrySpreadPct.toFixed(1)}%` : "—"}</Td>
                <Td num>{usd(t.costUsd)}</Td>
                <Td num>{t.status === "resolved" ? (t.exitBid != null ? usd(t.exitBid * 100) : "—") : (t.markUsd != null ? usd(t.markUsd) : "—")}</Td>
                {/* An open row has everything needed to show its P&L (paid vs mark); a bare dash
                    hides exactly the spread cost this book exists to measure. Shown in parentheses
                    so it reads as unrealized and is never mistaken for a booked result. */}
                <Td num className={t.pnl != null ? tone(t.pnl) : t.markUsd != null ? tone(t.markUsd - t.costUsd) : ""}>
                  {t.pnl != null ? pnl2(t.pnl) : t.markUsd != null ? `(${pnl2(t.markUsd - t.costUsd)})` : "—"}
                </Td>
                <Td title={t.reason ?? ""}>
                  <Chip tone={t.status === "resolved" ? (t.pnl != null && t.pnl >= 0 ? "green" : "red") : t.status === "void" ? "amber" : "paper"}>
                    {t.status === "resolved" ? (t.reason ?? "closed") : t.status}
                  </Chip>
                </Td>
              </Row>
            ))}
            {trades.length === 0 && <Row><Td colSpan={8}><Note>Nothing yet.</Note></Td></Row>}
            </tbody>
          </DataTable>
        </PanelBody>
      </Panel>

      <Panel>
        <PanelHeader title="Universe" aside={<Label>one position per group</Label>} />
        <PanelBody>
          <Note>
            Groups come from the measured 90-day correlation matrix, not sector labels. Only one position per group may be open at a time — holding WULF,
            IREN and APLD together is one bet in triplicate (they correlate 0.72–0.84 with each other).
          </Note>
          <div className="mt-3 space-y-2">
            {Object.entries(groups).map(([g, syms]) => (
              <div key={g} className="flex flex-wrap items-center gap-2">
                <Label>{g}</Label>
                {syms.map((s) => <Chip key={s} tone="grey">{s}</Chip>)}
              </div>
            ))}
          </div>
          {data?.excluded && Object.keys(data.excluded).length > 0 && (
            <div className="mt-4">
              <Label>Excluded — these ARE the Kraken book</Label>
              <div className="mt-2 space-y-1">
                {Object.entries(data.excluded).map(([sym, why]) => (
                  <div key={sym} className="text-xs text-muted-foreground"><strong>{sym}</strong> — {why}</div>
                ))}
              </div>
            </div>
          )}
        </PanelBody>
      </Panel>
    </div>
  );
}
