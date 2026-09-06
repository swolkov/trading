"use client";

import { useState } from "react";
import useSWR from "swr";
import Link from "next/link";
import { Chip, verdictTone } from "@/components/ui/chip";
import { DataTable, Row, Td, Th } from "@/components/ui/data-table";
import { Explainer, Label, Note, PageHeader, Panel, PanelBody, PanelHeader, Stat } from "@/components/ui/panel";
import { GoLivePanel, type StrategyStat } from "@/components/margin/go-live-panel";
import { money, pct, pnl2, tone } from "@/lib/format";

// ============ ROAD TO LIVE ============
// The shadow experiment's home. Every strategy the system runs on paper — scored on real
// Kraken prices with Spencer's real fees + rollover, zero money at risk — lives here:
// the go-live panel (plumbing → paper gate → arm), the pooled paper record, the
// per-strategy scoreboard, and the edge breakdowns. Individual trades are on Orders → Paper.

const fetcher = (u: string) => fetch(u).then((r) => r.json());

interface ConvictionTier { tier: string; resolved: number; wins: number; hitRate: number | null; totalPnl: number }
interface ShadowScore {
  resolved: number; wins: number; hitRate: number | null; totalPnl: number;
  avgWin: number; avgLoss: number; open: number; openUnrealized?: number; legacyOpen?: number; byConviction?: ConvictionTier[];
  nonUsOpen?: number; nonUsResolved?: number;
}
interface EdgeStat {
  key: string; label: string; resolved: number; wins: number; hitRate: number | null;
  expectancy: number | null; totalPnl: number; open: number;
}
interface EdgeBreakdowns { byDirection: EdgeStat[]; byCoin: EdgeStat[] }

// Sample-size gate: thin slices find fake edges. Nothing is a verdict until ~20 resolved.
const MIN_EDGE_SAMPLE = 20;
function edgeVerdict(e: EdgeStat): { label: string; tone: "grey" | "green" | "red" } {
  if (e.resolved < MIN_EDGE_SAMPLE) return { label: `watching · ${e.resolved}/${MIN_EDGE_SAMPLE}`, tone: "grey" };
  if (e.expectancy == null) return { label: "—", tone: "grey" };
  if (e.expectancy > 0) return { label: "promising", tone: "green" };
  return { label: "not paying", tone: "red" };
}
const hitTone = (h: number | null) => (h != null && h >= 0.5 ? "text-up" : "text-warn");

export default function PaperTradesPage() {
  const { data: score } = useSWR<{ shadow: ShadowScore | null; strategies: StrategyStat[]; edges: EdgeBreakdowns }>(
    "/api/margin/scoreboard", fetcher, { refreshInterval: 60_000 },
  );

  // What we trade is the default view. Retired sleeves stay in the record (their numbers
  // are evidence, and a re-litigated kill needs them) but hide behind a toggle.
  const [showRetired, setShowRetired] = useState(false);
  const retired = (score?.strategies ?? []).filter((s) => s.verdict.startsWith("retired"));
  const shownStrategies = (score?.strategies ?? []).filter((s) => showRetired || !s.verdict.startsWith("retired"));

  const sh = score?.shadow ?? null;
  const shadowHasAny = sh != null && (sh.resolved > 0 || sh.open > 0 || (sh.legacyOpen ?? 0) > 0 || (sh.nonUsOpen ?? 0) > 0);
  const hasAny = !!score && (shadowHasAny || (score.strategies ?? []).some((s) => s.resolved > 0 || s.open > 0));

  return (
    <div className="space-y-5">
      <PageHeader
        title="Road to Live"
        sub="Three steps, in order. Every strategy is scored on paper first with real Kraken prices and your real fees. Nothing trades real money until step 2 is green."
      />

      <GoLivePanel strategies={score?.strategies ?? []} />

      <Explainer title="How to read this page">
        <ul className="space-y-1">
          <li><strong>Paper</strong> = the strategy ran on real prices with real fees, but no money moved. It is the evidence.</li>
          <li><strong>Live candidate</strong> = the one strategy that can be armed: high-conviction 5-minute and 15-minute breakouts, longs only, 3% stop, breakeven then a trailing stop, 48-hour time limit.</li>
          <li><strong>Confidence (t)</strong> = how far the average result is from zero, in units of its own noise. Below 2 a good run can still be luck. That is why the gate needs 2.</li>
          <li><strong>Distinct days</strong> = crypto coins move together, so 30 wins in one day are closer to one bet than thirty. The gate needs results spread over 7 days.</li>
          <li><strong>Universe</strong> = only the 26 coins a US retail Kraken account can margin-trade. Trades on other coins are kept in the log for honesty but count toward nothing{(sh?.nonUsResolved ?? 0) > 0 && <> ({sh?.nonUsResolved} set aside)</>}.</li>
          <li>Retired strategies (fast-tight, sweep-fade, scanner spray, selective-swing, shorts) lost on this record and no longer open trades. Their numbers stay behind the toggle in the scoreboard.</li>
        </ul>
      </Explainer>

      {!hasAny && (
        <Panel><PanelBody className="py-8 text-center">
          <p className="text-[13px] text-muted-foreground">No paper trades yet.</p>
          <Note className="mt-1">The scanner watches every US-tradeable margin coin. Paper opens only high-conviction 5m/15m longs that are not stretched. They appear here and score themselves.</Note>
        </PanelBody></Panel>
      )}

      {/* ── Pooled paper record ── */}
      {sh && shadowHasAny && (
        <Panel tone="paper">
          <PanelHeader
            title="All paper trades together — would these have made money?"
            aside={
              <>
                <Chip tone="paper">{sh.open} open</Chip>
                {sh.open > 0 && sh.openUnrealized != null && <span>floating <span className={`font-semibold ${tone(sh.openUnrealized)}`}>{pnl2(sh.openUnrealized)}</span></span>}
                {(sh.legacyOpen ?? 0) > 0 && <Chip tone="grey" title="Opened before the Sep 2 measurement upgrade — still tracked to their finish, but excluded from every statistic on this page">+{sh.legacyOpen} old measurement</Chip>}
                {(sh.nonUsOpen ?? 0) > 0 && <Chip tone="grey" title="On coins a US retail Kraken account cannot margin-trade — tracked to their finish, but excluded from every statistic because the live book could never take them">+{sh.nonUsOpen} non-US coins</Chip>}
                <span>no real money</span>
              </>
            }
          />
          <PanelBody className="space-y-4">
            <div className="grid grid-cols-2 gap-4 md:grid-cols-4">
              <Stat label="Resolved" value={sh.resolved} />
              <Stat label="Hit rate" value={pct(sh.hitRate)} valueCls={hitTone(sh.hitRate)} />
              <Stat label="Avg win / loss" value={<><span className="text-up">{money(sh.avgWin)}</span><span className="mx-1 text-muted-foreground">/</span><span className="text-down">{money(sh.avgLoss)}</span></>} />
              <Stat label="Would-be P&L" value={money(sh.totalPnl)} valueCls={tone(sh.totalPnl)} />
            </div>
            {sh.byConviction && sh.byConviction.some((t) => t.resolved > 0) && (
              <div className="border-t border-border pt-3">
                <Label className="mb-2">Does conviction matter? — win rate by how many signals agreed</Label>
                <div className="space-y-1">
                  {sh.byConviction.filter((t) => t.resolved > 0).map((t) => (
                    <div key={t.tier} className="flex items-center gap-3 text-xs tabular-nums">
                      <span className="w-16 font-semibold capitalize">{t.tier}</span>
                      <span className={`w-12 font-semibold ${hitTone(t.hitRate)}`}>{pct(t.hitRate)}</span>
                      <span className="w-20 text-muted-foreground">{t.wins}/{t.resolved} won</span>
                      <span className={`font-semibold ${tone(t.totalPnl)}`}>{money(t.totalPnl)}</span>
                    </div>
                  ))}
                </div>
                <Note className="mt-2">Auto paper now opens the quality long cut only (high, 5m/15m, not stretched). This table still includes historical shorts, stretched names, and retired sleeves — that drag is why pooled high is not the live candidate.</Note>
              </div>
            )}
            <Note>
              Estimate — each trade followed to a stop/target/48h outcome, net of fees: trade fee (~0.15% maker in + 0.25% taker out) matched to your real 0.17%/side; 4h rollover (BTC 0.015% verified, ETH ~0.02%, alts ~0.03%) on notional. Kraken&apos;s live rollover fluctuates — real fills are exact, these are conservative estimates. Spot swings pay no rollover.
            </Note>
          </PanelBody>
        </Panel>
      )}

      {/* ── Strategy scoreboard ── */}
      {score?.strategies && score.strategies.some((s) => s.resolved > 0 || s.open > 0) && (
        <Panel>
          <PanelHeader
            title="Which strategies are working — the scoreboard behind the gate"
            aside={
              <>
                <span>paper · expectancy = avg $/trade after fees</span>
                {retired.length > 0 && (
                  <button onClick={() => setShowRetired(!showRetired)} className="text-primary hover:underline">{showRetired ? "hide" : "show"} {retired.length} retired sleeve{retired.length === 1 ? "" : "s"}</button>
                )}
              </>
            }
          />
          <DataTable>
            <thead>
              <tr>
                <Th>Strategy</Th>
                <Th num>Resolved</Th>
                <Th num>Open</Th>
                <Th num>Hit rate</Th>
                <Th num title="P&L before fees — the raw edge">Gross</Th>
                <Th num title="Fee + rollover drag">Fees</Th>
                <Th num title="Gross − fees — what you actually keep, at the paper experiment's 3–6% research risk">Net (paper risk)</Th>
                <Th num className="text-foreground" title="The same trades priced as the LIVE executor would size them — 3% risk, conviction-scaled exactly like paper. These columns agreeing is the check that live reproduces the record.">At live sizing</Th>
                <Th num title="Went green at peak → finished green. The gap is the give-back — green that appeared but wasn't banked">Green banked</Th>
                <Th num title="Judged on LIVE sizing: 30+ trades, positive net at live risk, t≥2 on the live-priced series, and resolutions spanning 7+ days.">Verdict</Th>
              </tr>
            </thead>
            <tbody>
              {shownStrategies.map((s) => (
                <Row key={s.key}>
                  <Td strong>{s.label}</Td>
                  <Td num>
                    {s.resolved}
                    {s.forwardResolved != null && s.resolved > 0 && !s.verdict.startsWith("retired") && (
                      <span className="ml-1 text-[11px] text-muted-foreground" title="Of these, how many were entered after the Sep 5 universe fix — the forward-only part of the sample.">{s.forwardResolved} fwd</span>
                    )}
                  </Td>
                  <Td num muted>{s.open}</Td>
                  <Td num className={`font-semibold ${hitTone(s.hitRate)}`}>{pct(s.hitRate)}</Td>
                  <Td num className={tone(s.grossPnl)}>{money(s.grossPnl)}</Td>
                  <Td num className="text-down/80">{s.fees ? `−$${Math.round(s.fees).toLocaleString()}` : "—"}</Td>
                  <Td num className={`${tone(s.totalPnl)} opacity-70`}>{money(s.totalPnl)}</Td>
                  <Td num className={`font-semibold ${tone(s.liveNet ?? 0)}`}>{money(s.liveNet ?? 0)}</Td>
                  <Td num muted title="peaked green → finished green">{s.resolved > 0 ? `${Math.round((s.peakedGreen / s.resolved) * 100)}% → ${Math.round((s.wins / s.resolved) * 100)}%` : "—"}</Td>
                  <Td num>
                    <span className="inline-flex items-center gap-1.5">
                      <Chip tone={verdictTone(s.verdict)}>{s.verdict}</Chip>
                      {s.tStat != null && (s.resolved >= 30 || s.verdict.startsWith("retired")) && <span className="text-[11px] text-muted-foreground">t={s.tStat.toFixed(1)}</span>}
                    </span>
                  </Td>
                </Row>
              ))}
            </tbody>
          </DataTable>
          <div className="border-t border-border px-4 py-3">
            <Note>
              <strong>Gross</strong> is the raw edge (before fees); <strong>Fees</strong> is the drag; <strong>Net</strong> is what you keep. This is the exact battle that sank your real trading — your gross was ~break-even, but fees were the whole loss. A strategy only earns if gross beats fees. Maker entries + fewer/bigger trades shrink the fees column. <strong>At live sizing</strong> prices each trade the way the live executor would size it; it matches the paper column because live scales by conviction (2× high, 0.5× low) exactly as paper does. While live bet a flat 3%, these same 48 trades were worth <span className="text-up">+$1,779</span> on paper and <span className="text-down">−$137</span> live — flat sizing halves the winners and doubles the losers. <strong>Green banked</strong> is the give-back meter: what % of trades went green at their peak → what % finished green. A big gap means the strategy finds winners but hands them back — your August pattern (96% peaked green, 19% kept).
            </Note>
          </div>
        </Panel>
      )}

      {/* ── Edges: where's the money coming from? ── */}
      {score?.edges && (score.edges.byDirection.some((e) => e.resolved > 0 || e.open > 0) || score.edges.byCoin.some((e) => e.resolved > 0 || e.open > 0)) && (
        <Panel>
          <PanelHeader title="Where the money comes from — by direction and by coin" aside={<span>the paper record, sliced by factor</span>} />
          <div className="border-b border-border bg-warn/[0.06] px-4 py-2">
            <Note className="text-warn/90">
              Thin slices lie. A bucket with a handful of trades can look brilliant by pure luck — that is data-mining. Nothing here counts as an edge until it has a real sample ({MIN_EDGE_SAMPLE}+ resolved). Watch the count, not the colour.
            </Note>
          </div>
          {([
            { title: "By direction — do longs or shorts pay?", rows: score.edges.byDirection },
            { title: "By coin — which coins are worth trading?", rows: score.edges.byCoin.filter((e) => e.resolved > 0 || e.open > 0) },
          ] as { title: string; rows: EdgeStat[] }[]).map((grp) => (
            <div key={grp.title} className="border-b border-border last:border-0">
              <Label className="px-4 pb-1 pt-3">{grp.title}</Label>
              <DataTable dense>
                <thead>
                  <tr>
                    <Th>Slice</Th>
                    <Th num>Resolved</Th>
                    <Th num>Open</Th>
                    <Th num>Hit rate</Th>
                    <Th num>Expectancy</Th>
                    <Th num>Total P&amp;L</Th>
                    <Th num>Verdict</Th>
                  </tr>
                </thead>
                <tbody>
                  {grp.rows.map((e) => {
                    const v = edgeVerdict(e);
                    const judged = e.resolved >= MIN_EDGE_SAMPLE;
                    return (
                      <Row key={e.key}>
                        <Td strong>{e.label}</Td>
                        <Td num>{e.resolved}</Td>
                        <Td num muted>{e.open}</Td>
                        <Td num>{pct(e.hitRate)}</Td>
                        <Td num className={`font-semibold ${judged && e.expectancy != null ? tone(e.expectancy) : "text-muted-foreground"}`}>{e.expectancy != null ? pnl2(e.expectancy) : "—"}</Td>
                        <Td num className={judged ? tone(e.totalPnl) : "text-muted-foreground"}>{money(e.totalPnl)}</Td>
                        <Td num><Chip tone={v.tone}>{v.label}</Chip></Td>
                      </Row>
                    );
                  })}
                </tbody>
              </DataTable>
            </div>
          ))}
          <div className="border-t border-border px-4 py-3">
            <Note>Expectancy = avg $/trade after fees. A real edge is a slice with positive expectancy over a <strong>large</strong> sample — the profitable setup is usually a combination of these factors, not one alone. Grey numbers have not earned a verdict yet.</Note>
          </div>
        </Panel>
      )}

      {hasAny && (
        <Note>Every individual paper trade (with live P&amp;L) is in the full log on <Link href="/orders" className="text-primary hover:underline">Orders</Link> → Paper.</Note>
      )}
    </div>
  );
}
