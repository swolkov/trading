"use client";

import { useState } from "react";
import useSWR from "swr";
import Link from "next/link";

// ============ PAPER TRADES ============
// The shadow experiment's home. Every strategy the system runs on paper — scored on real
// Kraken prices with Spencer's real fees + rollover, zero money at risk — lives here:
// the tracked-signal record, the per-strategy scoreboard (what's working), and the full
// trade log. This is the record that has to show a real edge before anything goes live.

const fetcher = (u: string) => fetch(u).then((r) => r.json());

interface ConvictionTier {
  tier: string; resolved: number; wins: number; hitRate: number | null; totalPnl: number;
}
interface ShadowScore {
  resolved: number; wins: number; hitRate: number | null; totalPnl: number;
  avgWin: number; avgLoss: number; open: number; openUnrealized?: number; legacyOpen?: number; byConviction?: ConvictionTier[];
  nonUsOpen?: number; nonUsResolved?: number;
}
interface StrategyStat {
  key: string; label: string; resolved: number; wins: number; hitRate: number | null;
  avgWin: number; avgLoss: number; expectancy: number | null; totalPnl: number; open: number;
  grossPnl: number; fees: number; peakedGreen: number; liveNet: number; tStat: number | null; paperTStat?: number | null; verdict: string;
  forwardResolved?: number;
}
function verdictCls(v: string): string {
  if (v.startsWith("REAL EDGE")) return "text-emerald-400 font-bold";
  if (v.startsWith("promising")) return "text-amber-400";
  if (v.startsWith("retired")) return "text-muted-foreground/55";
  if (v.startsWith("not paying")) return "text-red-400";
  return "text-muted-foreground/50"; // gathering
}
interface EdgeStat {
  key: string; label: string; resolved: number; wins: number; hitRate: number | null;
  expectancy: number | null; totalPnl: number; open: number;
}
interface EdgeBreakdowns { byDirection: EdgeStat[]; byCoin: EdgeStat[] }

// Sample-size gate: thin slices find fake edges. Nothing is a verdict until ~20 resolved.
const MIN_EDGE_SAMPLE = 20;
function edgeVerdict(e: EdgeStat): { label: string; cls: string } {
  if (e.resolved < MIN_EDGE_SAMPLE) return { label: `watching · ${e.resolved}/${MIN_EDGE_SAMPLE}`, cls: "text-muted-foreground/40" };
  if (e.expectancy == null) return { label: "—", cls: "text-muted-foreground/40" };
  if (e.expectancy > 0) return { label: "promising", cls: "text-emerald-400" };
  return { label: "not paying", cls: "text-red-400" };
}

const money = (n: number) => `${n < 0 ? "−" : ""}$${Math.abs(n).toLocaleString(undefined, { maximumFractionDigits: 0 })}`;
const money2 = (n: number) => `${n < 0 ? "−" : "+"}$${Math.abs(n).toFixed(2)}`;
const col = (n: number) => (n > 0 ? "text-emerald-400" : n < 0 ? "text-red-400" : "text-muted-foreground");

export default function PaperTradesPage() {
  const { data: score } = useSWR<{ shadow: ShadowScore | null; strategies: StrategyStat[]; edges: EdgeBreakdowns }>(
    "/api/margin/scoreboard", fetcher, { refreshInterval: 60_000 },
  );

  // What we trade is the default view. Retired sleeves stay in the record (their numbers
  // are evidence, and a re-litigated kill needs them) but hide behind a toggle.
  const [showRetired, setShowRetired] = useState(false);
  const retired = (score?.strategies ?? []).filter((s) => s.verdict.startsWith("retired"));
  const shownStrategies = (score?.strategies ?? []).filter((s) => showRetired || !s.verdict.startsWith("retired"));

  const hasAny = !!score && (
    (score.shadow != null && (score.shadow.resolved > 0 || score.shadow.open > 0 || (score.shadow.legacyOpen ?? 0) > 0 || (score.shadow.nonUsOpen ?? 0) > 0)) ||
    (score.strategies != null && score.strategies.some((s) => s.resolved > 0 || s.open > 0))
  );

  return (
    <div className="space-y-5">
      {/* ── Header ── */}
      <div>
        <h2 className="text-xl font-bold tracking-tight">Paper Trades</h2>
        <p className="text-[11px] text-muted-foreground/50">
          The shadow experiment — every strategy scored on real prices with your real fees + rollover, no money at risk.
          This is the record that has to prove an edge before the $5k live book is armed. Risk stays 3% (6% high-conviction ceiling);
          leverage is allowed to grow only as that account actually grows.
        </p>
      </div>

      <div className="rounded-xl border border-border bg-card p-4 space-y-2">
        <p className="text-xs font-bold">The $5k live book — how this gets to thousands a day without blowing up</p>
        <p className="text-[11px] text-muted-foreground/70 leading-relaxed">
          Live goes off the real Kraken account (~$5k), not a fantasy size. Dollar risk is always
          {" "}<span className="text-foreground/80">equity × 3%</span> (high conviction 2×, hard ceiling 6%).
          The quality long cut on paper has averaged a few hundred dollars a trade at this size (measured Sep 5 on the US universe: 15 trades, 80% hit) — that is thousands a week IF it holds
          for 30+ trades and 7+ days, which is exactly what this page is measuring. Thousands a day at 3%
          still needs a larger account (~$50k+). Do not crank risk on $5k to fake the daily number.
        </p>
        <p className="text-[11px] text-muted-foreground/70 leading-relaxed">
          What grows is leverage cap, not risk %: <span className="text-foreground/80">2× below $10k</span> (now),
          {" "}<span className="text-foreground/80">3× from $10k</span>, <span className="text-foreground/80">5× from $20k</span>.
          Paper stays scored at a fixed $5k so the t-stats stay comparable — compounding paper equity into the verdict would fake an edge.
          Live stays unarmed until a sleeve prints <span className="text-foreground/80">REAL EDGE</span> (30+ resolved, net&gt;0 at live sizing, t≥2, 7+ days).
        </p>
        <p className="text-[11px] text-muted-foreground/70 leading-relaxed">
          Auto paper is the live-candidate sleeve only: <span className="text-foreground/80">high-conviction 5m/15m longs, not stretched</span>.
          Shorts on this sleeve lost on both the old 37-coin universe (17% hit, −$3.2k, Sep 4) and the US-only slice (40% hit, −$714, Sep 5) — they no longer open. Stretched longs were a coin-flip — skipped.
          1h/4h and both swing containers are paused (not the 3%/48h game). Retired: fast-tight, sweep-fade, scanner spray, selective-swing.
          This is not &quot;always profitable.&quot; The scoreboard below is the only number that counts, and it needs 30+ resolved over 7+ days before anything is armed.
        </p>
        <p className="text-[11px] text-muted-foreground/70 leading-relaxed">
          <span className="text-foreground/80">Universe: only coins a US retail Kraken account can actually margin-trade</span> — 26 scanned
          (BTC 20×, the majors 10×, the rest 5×/3×/2×). Until Sep 5 the desk scanned 37 coins and 19 of them were not on Kraken&apos;s US list at all;
          they produced most of the resolved trades and every dollar of the loss. Those trades are now excluded from every statistic on this page
          {(score?.shadow?.nonUsResolved ?? 0) > 0 && <> (<span className="text-foreground/80">{score?.shadow?.nonUsResolved} resolved</span> set aside)</>}
          {" "}and their open positions are winding down, badged <span className="text-amber-400/70">non-US</span> in the log. Paper measures what live can take, nothing else.
          The surviving trades were kept because Kraken&apos;s list excluded coins, not outcomes — but they were re-qualified after the fact, so the scoreboard also shows how many of each sleeve&apos;s resolved trades were entered <span className="text-foreground/80">after</span> the fix (&quot;fwd&quot;). Read the arming gate with that split in mind.
        </p>
      </div>

      {/* ── Empty state ── */}
      {!hasAny && (
        <div className="rounded-xl border border-border bg-card p-8 text-center">
          <p className="text-sm text-muted-foreground/60">No paper trades yet.</p>
          <p className="text-[11px] text-muted-foreground/40 mt-1">
            The scanner watches every US-tradeable margin coin. Paper opens only high-conviction 5m/15m longs that are not stretched. They&apos;ll appear here and score themselves — check back soon.
          </p>
        </div>
      )}

      {/* ── Tracked-signal paper record ── */}
      {score?.shadow && (score.shadow.resolved > 0 || score.shadow.open > 0 || (score.shadow.legacyOpen ?? 0) > 0 || (score.shadow.nonUsOpen ?? 0) > 0) && (
        <div className="rounded-xl border border-purple-500/20 bg-purple-500/[0.03] p-4">
          <div className="flex items-center justify-between mb-2">
            <p className="text-xs font-bold">📊 Tracked-Signal Paper Record — would these have made money?</p>
            <p className="text-[10px] text-muted-foreground/45">
              {score.shadow.open} open
              {score.shadow.open > 0 && score.shadow.openUnrealized != null && (
                <> · floating <span className={`font-bold ${col(score.shadow.openUnrealized)}`}>{money2(score.shadow.openUnrealized)}</span></>
              )}
              {(score.shadow.legacyOpen ?? 0) > 0 && (
                <> · <span title="Opened before the Sep 2 measurement upgrade — still tracked to their finish, but excluded from every statistic on this page">+{score.shadow.legacyOpen} winding down (old measurement)</span></>
              )}
              {(score.shadow.nonUsOpen ?? 0) > 0 && (
                <> · <span title="On coins a US retail Kraken account cannot margin-trade — tracked to their finish, but excluded from every statistic on this page because the live book could never take them">+{score.shadow.nonUsOpen} winding down (non-US coins)</span></>
              )}
              {" "}· no real money
            </p>
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
          {score.shadow.byConviction && score.shadow.byConviction.some((t) => t.resolved > 0) && (
            <div className="mt-3 pt-3 border-t border-purple-500/15">
              <p className="text-[9px] text-muted-foreground/60 uppercase tracking-wider mb-1.5">
                Does conviction matter? — win rate by how many signals agreed
              </p>
              <div className="space-y-1">
                {score.shadow.byConviction.filter((t) => t.resolved > 0).map((t) => (
                  <div key={t.tier} className="flex items-center gap-3 text-[11px] tabular-nums">
                    <span className="w-16 font-semibold capitalize text-foreground/70">{t.tier}</span>
                    <span className={`w-12 font-bold ${t.hitRate != null && t.hitRate >= 0.5 ? "text-emerald-400" : "text-amber-400"}`}>
                      {t.hitRate != null ? `${(t.hitRate * 100).toFixed(0)}%` : "—"}
                    </span>
                    <span className="w-20 text-muted-foreground/50">{t.wins}/{t.resolved} won</span>
                    <span className={`font-bold ${col(t.totalPnl)}`}>{money(t.totalPnl)}</span>
                  </div>
                ))}
              </div>
              <p className="text-[10px] text-muted-foreground/40 mt-1.5">
                Auto paper now opens the quality long cut only (high, 5m/15m, not stretched). This table still includes historical shorts, stretched names, and retired sleeves — that drag is why pooled high is not the live candidate.
              </p>
            </div>
          )}
          <p className="text-[10px] text-muted-foreground/40 mt-2">
            Estimate — each trade followed to a stop/target/48h outcome, net of fees: trade fee (<span className="text-foreground/60">~0.15% maker in + 0.25% taker out</span>) matched to your real 0.17%/side; 4h rollover (<span className="text-foreground/60">BTC 0.015% verified, ETH ~0.02%, alts ~0.03%</span>) on notional. Kraken&apos;s live rollover fluctuates — real fills are exact, these are conservative estimates. Spot swings pay no rollover.
          </p>
        </div>
      )}

      {/* ── Strategy scoreboard: what's working ── */}
      {score?.strategies && score.strategies.some((s) => s.resolved > 0 || s.open > 0) && (
        <div className="rounded-xl border border-border bg-card overflow-hidden">
          <div className="flex items-center justify-between px-4 py-2.5 border-b border-border">
            <p className="text-xs font-bold">🧭 Strategy Scoreboard — what&apos;s actually working</p>
            <p className="text-[10px] text-muted-foreground/45">
              paper · expectancy = avg $/trade after fees
              {retired.length > 0 && (
                <> · <button onClick={() => setShowRetired(!showRetired)} className="text-purple-400 hover:underline">{showRetired ? "hide" : "show"} {retired.length} retired sleeve{retired.length === 1 ? "" : "s"}</button></>
              )}
            </p>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-[11px]">
              <thead>
                <tr className="text-[9px] uppercase tracking-wider text-muted-foreground/50 border-b border-border/50">
                  <th className="text-left font-medium px-4 py-1.5">Strategy</th>
                  <th className="text-right font-medium px-2 py-1.5">Resolved</th>
                  <th className="text-right font-medium px-2 py-1.5">Open</th>
                  <th className="text-right font-medium px-2 py-1.5">Hit rate</th>
                  <th className="text-right font-medium px-2 py-1.5" title="P&L before fees — the raw edge">Gross</th>
                  <th className="text-right font-medium px-2 py-1.5" title="Fee + rollover drag">Fees</th>
                  <th className="text-right font-medium px-2 py-1.5" title="Gross − fees — what you actually keep, at the paper experiment's 3–6% research risk">Net (paper risk)</th>
                  <th className="text-right font-medium px-2 py-1.5 text-foreground/70" title="The same trades priced as the LIVE executor would size them — 3% risk, conviction-scaled exactly like paper. These columns AGREEING is the check that live reproduces the record; they diverge the moment live risk is set differently.">At LIVE sizing</th>
                  <th className="text-right font-medium px-2 py-1.5" title="Went green at peak → finished green. The gap between the two numbers is the give-back — green that appeared but wasn't banked">Green banked</th>
                  <th className="text-right font-medium px-4 py-1.5" title="Judged on LIVE sizing: 30+ trades, positive net AT LIVE RISK, t≥2 on the live-priced series, and resolutions spanning 7+ days. Live now uses the same 3% base + conviction 2×/0.5× (6% cap) as paper, so these columns agree unless kraken_margin_live_max_risk_pct is set differently.">Verdict <span className="opacity-40 font-normal">(at live sizing)</span></th>
                </tr>
              </thead>
              <tbody>
                {shownStrategies.map((s) => (
                  <tr key={s.key} className="border-b border-border/30 last:border-0">
                    <td className="text-left px-4 py-2 font-semibold text-foreground/80">{s.label}</td>
                    <td className="text-right px-2 py-2 tabular-nums">
                      {s.resolved}
                      {s.forwardResolved != null && s.resolved > 0 && !s.verdict.startsWith("retired") && (
                        <span className="text-[9px] text-muted-foreground/45 ml-1" title="Of these, how many were ENTERED after the Sep 5 universe fix — the forward-only part of the sample. The rest are valid (the fix excluded coins by Kraken's list, not by outcome) but were re-qualified after the fact.">{s.forwardResolved} fwd</span>
                      )}
                    </td>
                    <td className="text-right px-2 py-2 tabular-nums text-muted-foreground/50">{s.open}</td>
                    <td className={`text-right px-2 py-2 tabular-nums font-bold ${s.hitRate != null && s.hitRate >= 0.5 ? "text-emerald-400" : "text-amber-400"}`}>
                      {s.hitRate != null ? `${(s.hitRate * 100).toFixed(0)}%` : "—"}
                    </td>
                    <td className={`text-right px-2 py-2 tabular-nums ${col(s.grossPnl)}`}>{money(s.grossPnl)}</td>
                    <td className="text-right px-2 py-2 tabular-nums text-red-400/70">{s.fees ? `−$${Math.round(s.fees).toLocaleString()}` : "—"}</td>
                    <td className={`text-right px-2 py-2 tabular-nums ${col(s.totalPnl)} opacity-70`}>{money(s.totalPnl)}</td>
                    <td className={`text-right px-2 py-2 tabular-nums font-bold ${col(s.liveNet ?? 0)}`}>{money(s.liveNet ?? 0)}</td>
                    <td className="text-right px-2 py-2 tabular-nums text-muted-foreground/70" title="peaked green → finished green">
                      {s.resolved > 0 ? `${Math.round((s.peakedGreen / s.resolved) * 100)}% → ${Math.round((s.wins / s.resolved) * 100)}%` : "—"}
                    </td>
                    <td className={`text-right px-4 py-2 ${verdictCls(s.verdict)}`}>{s.verdict}{s.tStat != null && (s.resolved >= 30 || s.verdict.startsWith("retired")) ? <span className="text-[9px] font-normal opacity-50 ml-1">t={s.tStat.toFixed(1)}</span> : null}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="text-[10px] text-muted-foreground/40 px-4 py-2 border-t border-border/50">
            <span className="text-foreground/60">Gross</span> is the raw edge (before fees); <span className="text-red-400/70">Fees</span> is the drag; <span className="text-foreground/60">Net</span> is what you keep. This is the exact battle that sank your real trading — your gross was ~break-even, but fees were the whole loss. A strategy only earns if <span className="text-foreground/60">Gross beats Fees</span>. Maker entries + fewer/bigger trades shrink the Fees column. <span className="text-foreground/60">At LIVE sizing</span> prices each trade the way the live executor would size it. It now matches the paper column, and that agreement is the point — live scales by <span className="text-foreground/60">conviction</span> (2× high, 0.5× low) exactly as paper does. It did not always: while live bet a flat 3%, these same 48 trades were worth <span className="text-emerald-400/80">+$1,779</span> on paper and <span className="text-red-400/80">−$137</span> live, because flat sizing halves the winners (high conviction averages +$73/trade) and doubles the losers (low averages −$74). <span className="text-foreground/60">Green banked</span> is the give-back meter: what % of trades went green at their peak → what % finished green. A big gap means the strategy finds winners but hands them back — your August pattern (96% peaked green, 19% kept).
          </p>
        </div>
      )}

      {/* ── Edges: where's the money coming from? ── */}
      {score?.edges && (score.edges.byDirection.some((e) => e.resolved > 0 || e.open > 0) || score.edges.byCoin.some((e) => e.resolved > 0 || e.open > 0)) && (
        <div className="rounded-xl border border-border bg-card overflow-hidden">
          <div className="flex items-center justify-between px-4 py-2.5 border-b border-border">
            <p className="text-xs font-bold">🔬 Edges — where&apos;s the money coming from?</p>
            <p className="text-[10px] text-muted-foreground/45">the paper record, sliced by factor</p>
          </div>
          <div className="px-4 py-2 border-b border-border/50 bg-amber-500/[0.04]">
            <p className="text-[10px] text-amber-400/70">
              ⚠️ Thin slices lie. A bucket with a handful of trades can look brilliant by pure luck — that&apos;s data-mining, and it&apos;s how you talk yourself into betting on noise. Nothing here counts as an edge until it has a real sample ({MIN_EDGE_SAMPLE}+ resolved). Watch the count, not the color.
            </p>
          </div>
          {([
            { title: "By direction — do longs or shorts pay?", rows: score.edges.byDirection },
            { title: "By coin — which coins are worth trading?", rows: score.edges.byCoin.filter((e) => e.resolved > 0 || e.open > 0) },
          ] as { title: string; rows: EdgeStat[] }[]).map((grp) => (
            <div key={grp.title} className="border-b border-border/30 last:border-0">
              <p className="text-[9px] text-muted-foreground/60 uppercase tracking-wider px-4 pt-3 pb-1">{grp.title}</p>
              <div className="overflow-x-auto">
                <table className="w-full text-[11px]">
                  <thead>
                    <tr className="text-[9px] uppercase tracking-wider text-muted-foreground/40">
                      <th className="text-left font-medium px-4 py-1">Slice</th>
                      <th className="text-right font-medium px-2 py-1">Resolved</th>
                      <th className="text-right font-medium px-2 py-1">Open</th>
                      <th className="text-right font-medium px-2 py-1">Hit rate</th>
                      <th className="text-right font-medium px-2 py-1">Expectancy</th>
                      <th className="text-right font-medium px-2 py-1">Total P&amp;L</th>
                      <th className="text-right font-medium px-4 py-1">Verdict</th>
                    </tr>
                  </thead>
                  <tbody>
                    {grp.rows.map((e) => {
                      const v = edgeVerdict(e);
                      return (
                        <tr key={e.key} className="border-t border-border/20">
                          <td className="text-left px-4 py-1.5 font-semibold text-foreground/80">{e.label}</td>
                          <td className="text-right px-2 py-1.5 tabular-nums">{e.resolved}</td>
                          <td className="text-right px-2 py-1.5 tabular-nums text-muted-foreground/50">{e.open}</td>
                          <td className="text-right px-2 py-1.5 tabular-nums">{e.hitRate != null ? `${(e.hitRate * 100).toFixed(0)}%` : "—"}</td>
                          <td className={`text-right px-2 py-1.5 tabular-nums font-bold ${e.expectancy != null && e.resolved >= MIN_EDGE_SAMPLE ? col(e.expectancy) : "text-muted-foreground/40"}`}>
                            {e.expectancy != null ? money2(e.expectancy) : "—"}
                          </td>
                          <td className={`text-right px-2 py-1.5 tabular-nums ${e.resolved >= MIN_EDGE_SAMPLE ? col(e.totalPnl) : "text-muted-foreground/40"}`}>{money(e.totalPnl)}</td>
                          <td className={`text-right px-4 py-1.5 font-semibold ${v.cls}`}>{v.label}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </div>
          ))}
          <p className="text-[10px] text-muted-foreground/40 px-4 py-2 border-t border-border/50">
            Expectancy = avg $/trade after fees. A real edge is a slice with positive expectancy over a <span className="text-foreground/60">large</span> sample — the profitable setup is usually a combination of these factors, not one alone. Grayed numbers haven&apos;t earned a verdict yet.
          </p>
        </div>
      )}

      {hasAny && (
        <p className="text-[11px] text-muted-foreground/40">
          Every individual paper trade (with live P&amp;L) is in the full log on the <Link href="/orders" className="underline hover:text-foreground/70">Orders</Link> tab → Paper.
        </p>
      )}
    </div>
  );
}
