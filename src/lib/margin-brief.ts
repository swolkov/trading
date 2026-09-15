// THE DESK BRIEF (Sep 15 2026) — the operating spec's reporting format, eight sections in a fixed
// order, rendered by rule from numbers the desk already holds. Pure: input in, markdown out.
// margin-brief-build.ts gathers the input (soft catches everywhere) and publishes it; nothing
// here fetches, and nothing here changes what trades.
//
//   MARKET REGIME → BEST OPPORTUNITIES → TRADE TABLE → PAPER STRATEGIES → LIVE STRATEGIES →
//   UNDER REVIEW → PORTFOLIO RISK → ACTION
//
// deriveAction() is the one judgement, and it is a precedence ladder, not a weighing:
//   paused (event window, breaker tripped, anomaly set)        → NO TRADE
//   cushion warning, demotion, decay reduced                     → REDUCE/EXIT
//   armed and a fresh HIGH-conviction setup that was not refused → ENTER
//   armed, nothing fresh                                         → WAIT
//   nothing armed                                                → PAPER TEST
import type { RegimeLabel } from "@/lib/margin-regime-label";

export const BRIEF_SECTIONS = ["MARKET REGIME", "BEST OPPORTUNITIES", "TRADE TABLE", "PAPER STRATEGIES", "LIVE STRATEGIES", "UNDER REVIEW", "PORTFOLIO RISK", "ACTION"] as const;
export type BriefAction = "NO TRADE" | "REDUCE/EXIT" | "ENTER" | "WAIT" | "PAPER TEST";

export interface BriefMajor { close: number; sma20: number; label: RegimeLabel }
export interface BriefRegime {
  btc: BriefMajor | null;
  eth: BriefMajor | null;
  ethBtc: number | null;                          // ETH/BTC from the public Ticker
  breadth: { above: number; of: number } | null;  // total-market proxy: universe coins above their 20d SMA
  realizedVol20: number | null;                   // BTC 20d realised vol, annualised (fraction)
  funding: { btc: number | null; eth: number | null } | null;   // relative, per 8h
  fearGreed: { value: number; label: string } | null;
  event: { mode: string; reason: string } | null;
  btcShock: string | null;                        // unknown | calm | shock-up | shock-down
}
export interface BriefOpportunity { coin: string; tf: string; kind: string; score?: number; tier?: string; outcome: string; detail?: string }
export interface BriefPaperRow { symbol: string; side: string; source: string; entry: number | null; unrealized: number | null; ageH: number; maxHoldH: number }
export interface BriefLivePosition { pair: string; side: string; leverage: number; entryPrice: number; net: number | null; cushionUsed: number | null }
export interface BriefStrategy { key: string; label: string; resolved: number; hitRate: number | null; liveNet: number; tStat: number | null; verdict: string; action?: string }
export interface BriefLive {
  armed: boolean; validateOnly: boolean; sources: string[];
  stage3: { status: string; done?: number; target: number } | null;
  fills: { count: number; closed: number; realNet: number; verdict: string } | null;
}
export interface BriefReview {
  underReview: string[];                          // "swing-wide: KILL CANDIDATE" …
  demoted: { source: string; reason: string } | null;
  decay: { multiplier: string | null; state: string | null; source: string | null } | null;
  anomaly: string | null;
}
export interface BriefRisk {
  equity: number | null; marginLevel: number | null;
  dd: number | null; tier: string | number | null; mult: number | null; losersToday: number | null;
  exposure: { grossNotional: number; netNotional: number; riskIfAllStopsHitUsd: number; riskIfAllStopsHitPct: number; breakerHeadroomPct: number; clusterOk: boolean } | null;
  cushionWarn: boolean;
  breakerTripped: boolean;
}
export interface BriefInput {
  at: string;
  regime: BriefRegime | null;
  opportunities: BriefOpportunity[];
  paperOpen: BriefPaperRow[];
  livePositions: BriefLivePosition[];
  livePositionsAt: string | null;
  strategies: BriefStrategy[];
  live: BriefLive | null;
  review: BriefReview | null;
  risk: BriefRisk | null;
}

/** Outcomes that mean "the desk did NOT take it" — a fresh HIGH with any of these is not an ENTER. */
export const REFUSED_OUTCOMES = new Set(["live refused", "live skipped", "btc vetoed", "blocked", "no trade", "skipped", "live ERROR", "prop refused", "prop ERROR", "watched"]);

export function deriveAction(i: Pick<BriefInput, "regime" | "opportunities" | "live" | "review" | "risk">): { action: BriefAction; reason: string } {
  if (i.regime?.event?.mode === "paused") return { action: "NO TRADE", reason: `event window paused — ${i.regime.event.reason}` };
  if (i.risk?.breakerTripped) return { action: "NO TRADE", reason: "drawdown breaker tripped (kraken_margin_disarmed_dd) — entries halted until reviewed" };
  if (i.review?.anomaly) return { action: "NO TRADE", reason: `anomaly set — ${i.review.anomaly}` };
  if (i.risk?.cushionWarn) return { action: "REDUCE/EXIT", reason: "a live position has used ≥70% of its liquidation cushion" };
  if (i.review?.demoted) return { action: "REDUCE/EXIT", reason: `${i.review.demoted.source} demoted — ${i.review.demoted.reason}` };
  const decayMult = i.review?.decay?.multiplier != null ? parseFloat(i.review.decay.multiplier) : NaN;
  if (i.review?.decay?.state === "DECAYING" || (Number.isFinite(decayMult) && decayMult < 1)) return { action: "REDUCE/EXIT", reason: `${i.review?.decay?.source ?? "the armed sleeve"} is ${i.review?.decay?.state ?? "reduced"} — decay multiplier ${i.review?.decay?.multiplier ?? "0.5"}` };
  const armed = !!i.live && i.live.armed && !i.live.validateOnly;
  if (!armed) return { action: "PAPER TEST", reason: i.live?.validateOnly ? "validate-only — live orders are not sent" : "nothing armed — the record keeps measuring on paper" };
  const fresh = i.opportunities.filter((o) => o.tier === "high" && !REFUSED_OUTCOMES.has(o.outcome)).sort((a, b) => (b.score ?? -1) - (a.score ?? -1))[0];
  if (fresh) return { action: "ENTER", reason: `${fresh.coin} ${fresh.tf} ${fresh.kind} — high conviction${fresh.score != null ? `, score ${fresh.score}` : ""}, ${fresh.outcome}` };
  return { action: "WAIT", reason: `${i.live!.sources.join(", ") || "armed sleeve"} armed — no fresh high-conviction setup this tick` };
}

// ---------- rendering ----------
const dash = "—";
const money = (n: number | null | undefined) => (n == null || !Number.isFinite(n) ? dash : `${n < 0 ? "−" : ""}$${Math.abs(n).toLocaleString(undefined, { maximumFractionDigits: 0 })}`);
const pct = (n: number | null | undefined, d = 1) => (n == null || !Number.isFinite(n) ? dash : `${n >= 0 ? "+" : "−"}${(Math.abs(n) * 100).toFixed(d)}%`);
const pctAbs = (n: number | null | undefined, d = 0) => (n == null || !Number.isFinite(n) ? dash : `${(n * 100).toFixed(d)}%`);
const px = (n: number | null | undefined) => (n == null || !Number.isFinite(n) ? dash : `$${n.toLocaleString(undefined, { maximumFractionDigits: n >= 100 ? 0 : n >= 1 ? 2 : 5 })}`);
const t2 = (n: number | null | undefined) => (n == null || !Number.isFinite(n) ? dash : n.toFixed(2));
const hhmm = (iso: string) => `${iso.slice(11, 16)}Z`;

function major(name: string, m: BriefMajor | null): string {
  if (!m) return `- ${name}: ${dash}`;
  return `- ${name} ${px(m.close)} vs 20d SMA ${px(m.sma20)} (${pct(m.close / m.sma20 - 1)}) — ${m.label}`;
}

export function renderRegimeLines(r: BriefRegime | null): string[] {
  if (!r) return [`- ${dash}`];
  const L = [major("BTC", r.btc), major("ETH", r.eth)];
  L.push(`- ETH/BTC: ${r.ethBtc != null ? r.ethBtc.toFixed(5) : dash}`);
  L.push(`- Breadth (total-market proxy): ${r.breadth ? `${r.breadth.above}/${r.breadth.of} coins above their 20d SMA` : dash}`);
  L.push(`- BTC 20d realised vol: ${r.realizedVol20 != null ? `${(r.realizedVol20 * 100).toFixed(0)}% annualised` : dash}`);
  L.push(`- Funding (relative, per 8h): BTC ${r.funding?.btc != null ? pct(r.funding.btc, 3) : dash} · ETH ${r.funding?.eth != null ? pct(r.funding.eth, 3) : dash}`);
  L.push(`- Fear & Greed: ${r.fearGreed ? `${r.fearGreed.value} (${r.fearGreed.label})` : dash}`);
  L.push(`- Event policy: ${r.event ? `${r.event.mode} — ${r.event.reason}` : dash}`);
  L.push(`- BTC shock: ${r.btcShock ?? dash}`);
  return L;
}

export function renderDeskBrief(i: BriefInput): string {
  const { action, reason } = deriveAction(i);
  const L: string[] = [`# Crypto desk brief — ${i.at.slice(0, 10)} ${hhmm(i.at)}`, ""];
  L.push(`## ${BRIEF_SECTIONS[0]}`, ...renderRegimeLines(i.regime), "");

  L.push(`## ${BRIEF_SECTIONS[1]}`);
  const top = [...i.opportunities].filter((o) => o.kind === "breakout" || o.kind === "breakdown").sort((a, b) => (b.score ?? -1) - (a.score ?? -1)).slice(0, 5);
  if (!top.length) L.push(`- ${dash}`);
  else {
    L.push("| # | Coin | TF | Signal | Score | Conviction | Outcome |", "|---|---|---|---|---|---|---|");
    top.forEach((o, n) => L.push(`| ${n + 1} | ${o.coin} | ${o.tf} | ${o.kind} | ${o.score ?? dash} | ${o.tier ?? dash} | ${o.outcome}${o.detail ? ` — ${o.detail}` : ""} |`));
    L.push("", "_Score = the 0–100 paper ranker (margin-opportunity-score.ts): stamped and measured, not a gate._");
  }
  L.push("");

  L.push(`## ${BRIEF_SECTIONS[2]}`);
  L.push(`**Live positions** (Kraken, cached read${i.livePositionsAt ? ` at ${hhmm(i.livePositionsAt)}` : ""})`);
  // An unread account is UNKNOWN, never flat — the same rule as the cockpit's position panel.
  if (!i.livePositionsAt) L.push(`- ${dash} (Kraken not read this run — positions unknown, not zero)`);
  else if (!i.livePositions.length) L.push(`- ${dash} (flat)`);
  else {
    L.push("| Pair | Side | Lev | Entry | P&L | Cushion used |", "|---|---|---|---|---|---|");
    for (const p of i.livePositions) L.push(`| ${p.pair} | ${p.side} | ${p.leverage.toFixed(0)}× | ${px(p.entryPrice)} | ${money(p.net)} | ${pctAbs(p.cushionUsed)} |`);
  }
  L.push("", "**Open paper rows**");
  if (!i.paperOpen.length) L.push(`- ${dash}`);
  else {
    L.push("| Symbol | Side | Sleeve | Entry | Floating | Held |", "|---|---|---|---|---|---|");
    for (const r of i.paperOpen.slice(0, 12)) L.push(`| ${r.symbol} | ${r.side} | ${r.source} | ${px(r.entry)} | ${money(r.unrealized)} | ${r.ageH.toFixed(0)}h / ${r.maxHoldH}h |`);
    if (i.paperOpen.length > 12) L.push(`| … | | ${i.paperOpen.length - 12} more | | | |`);
  }
  L.push("");

  L.push(`## ${BRIEF_SECTIONS[3]}`);
  const strats = i.strategies.filter((s) => s.resolved > 0);
  if (!strats.length) L.push(`- ${dash}`);
  else {
    L.push("| Sleeve | Resolved | Hit | Net (live-sized) | t | Verdict | Weekly action |", "|---|---|---|---|---|---|---|");
    for (const s of strats) L.push(`| ${s.label} | ${s.resolved} | ${pctAbs(s.hitRate)} | ${money(s.liveNet)} | ${t2(s.tStat)} | ${s.verdict} | ${s.action ?? dash} |`);
  }
  L.push("");

  L.push(`## ${BRIEF_SECTIONS[4]}`);
  if (!i.live) L.push(`- ${dash}`);
  else {
    L.push(`- Armed: ${i.live.armed && !i.live.validateOnly ? `**${i.live.sources.join(", ") || dash}** (live orders on)` : i.live.validateOnly ? `${i.live.sources.join(", ") || dash} — validate-only` : "nothing armed"}`);
    L.push(`- Stage 3: ${i.live.stage3 ? `${i.live.stage3.status}${i.live.stage3.done != null ? ` — ${i.live.stage3.done}/${i.live.stage3.target} closed` : ""}` : dash}`);
    L.push(`- Live fills: ${i.live.fills ? `${i.live.fills.count} (${i.live.fills.closed} closed), real net ${money(i.live.fills.realNet)} — ${i.live.fills.verdict}` : dash}`);
  }
  L.push("");

  L.push(`## ${BRIEF_SECTIONS[5]}`);
  if (!i.review) L.push(`- ${dash}`);
  else {
    const lines: string[] = [];
    for (const u of i.review.underReview) lines.push(`- ${u}`);
    if (i.review.demoted) lines.push(`- DEMOTED: ${i.review.demoted.source} — ${i.review.demoted.reason}`);
    if (i.review.decay && (i.review.decay.state || i.review.decay.multiplier)) lines.push(`- Decay: ${i.review.decay.source ?? dash} ${i.review.decay.state ?? dash} · multiplier ${i.review.decay.multiplier ?? "1"}`);
    if (i.review.anomaly) lines.push(`- ANOMALY: ${i.review.anomaly}`);
    L.push(...(lines.length ? lines : [`- ${dash}`]));
  }
  L.push("");

  L.push(`## ${BRIEF_SECTIONS[6]}`);
  if (!i.risk) L.push(`- ${dash}`);
  else {
    const r = i.risk;
    L.push(`- Equity ${money(r.equity)} · margin level ${r.marginLevel != null ? `${r.marginLevel.toFixed(0)}%` : "not in use"} · drawdown ${r.dd != null ? `${r.dd.toFixed(1)}%` : dash} (tier ${r.tier ?? dash}, ×${r.mult ?? dash}) · losers today ${r.losersToday ?? dash}`);
    L.push(r.exposure
      ? `- Exposure: gross ${money(r.exposure.grossNotional)} · net ${money(r.exposure.netNotional)} · all-stops risk ${money(r.exposure.riskIfAllStopsHitUsd)} (${r.exposure.riskIfAllStopsHitPct.toFixed(1)}% of equity) · breaker headroom ${r.exposure.breakerHeadroomPct.toFixed(1)}% · cluster ${r.exposure.clusterOk ? "ok" : "OVER CAP"}`
      : `- Exposure: ${dash}`);
    L.push(`- Breaker: ${r.breakerTripped ? "TRIPPED" : "armed"} · cushion warning: ${r.cushionWarn ? "YES" : "no"}`);
  }
  L.push("");

  L.push(`## ${BRIEF_SECTIONS[7]}`, `**${action}** — ${reason}`, "");
  return L.join("\n");
}

/** Fraction of the liquidation cushion a position has consumed at price `px` (0.6/lev at entry). */
export function cushionUsed(side: string, entryPrice: number, leverage: number, px: number | null): number | null {
  if (px == null || !(px > 0) || !(entryPrice > 0)) return null;
  const adverse = 0.6 / Math.max(1, leverage);
  const liq = side === "long" ? entryPrice * (1 - adverse) : entryPrice * (1 + adverse);
  const pctAway = side === "long" ? (px - liq) / px : (liq - px) / px;
  return 1 - pctAway / adverse;
}
