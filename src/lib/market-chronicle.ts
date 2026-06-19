// ============ MARKET CHRONICLE — SHARED LOGIC ============
// The system's structured daily memory of what the cross-asset market DID and what tends to follow.
//
// This module is the SINGLE SOURCE OF TRUTH for the chronicle math (regime, vol percentile, risk tone,
// day type, historical analogues) AND the morning-brief composition. It operates purely on in-memory
// `Map<date, Bar>` baskets so the SAME code runs in two places that must stay consistent:
//   • scripts/market-chronicle.ts + scripts/morning-brief.ts  (local CSV source, Mac launchd failover)
//   • src/app/api/cron/daily-research/route.ts                 (Databento-in-memory source, Vercel cron)
//
// No filesystem, no env, no DB access here — callers supply the data and decide where output goes.

import { candlestickSVG, type Candle, type Level } from "./svg-chart";

export interface Bar { o: number; h: number; l: number; c: number; v: number; }
export type Basket = Record<string, Map<string, Bar>>;

// Cross-asset basket the chronicle reasons over. Dollar proxy = inverse of 6E (EUR futures);
// bonds = ZN; growth = HG; haven = GC. These are exactly the symbols the cron must fetch.
export const CHRONICLE_SYMBOLS = ["NQ", "ES", "RTY", "YM", "ZN", "ZB", "6E", "CL", "GC", "HG", "ZC", "ZS", "ZW"] as const;

// The instruments the engines actually trade — charted in the morning brief.
export const FOCUS_SYMBOLS = ["NQ", "ES", "GC"] as const;
export const FOCUS_NAMES: Record<string, string> = { NQ: "Nasdaq-100 (NQ)", ES: "S&P 500 (ES)", GC: "Gold (GC)" };

// ── small numeric helpers ──
const mean = (a: number[]) => (a.length ? a.reduce((s, v) => s + v, 0) / a.length : 0);
const std = (a: number[]) => { if (a.length < 2) return 1; const m = mean(a); return Math.sqrt(mean(a.map((v) => (v - m) ** 2))) || 1; };
const pct = (sorted: number[], v: number) => { let lo = 0; for (const x of sorted) if (x < v) lo++; return sorted.length ? lo / sorted.length : 0.5; };
const ret = (mk: Map<string, Bar>, d: string, pd: string) => { const a = mk.get(pd)?.c, b = mk.get(d)?.c; return a && b ? (b - a) / a : NaN; };
const mom = (mk: Map<string, Bar>, dates: string[], i: number, n: number) => { if (i < n) return NaN; const a = mk.get(dates[i - n])?.c, b = mk.get(dates[i])?.c; return a && b ? (b - a) / a : NaN; };

export interface ChronicleRow {
  date: string; nqRet: number; esRet: number; gcRet: number; clRet: number; usdRet: number; znRet: number; hgRet: number;
  breadth: number; rangeAtr: number; closePos: number; nq5d: number; nq20d: number; volRegime: string; volPctile: number;
  riskTone: string; toneScore: number; dayType: string; regime: string; narrative: string;
  // feature vector for similarity + the realized forward outcome (filled where known)
  feat: number[]; fwd1: number; fwd5: number;
}

// Build the full daily chronicle from a cross-asset basket. Mirrors scripts/market-chronicle.ts:build().
export function buildChronicle(MK: Basket): ChronicleRow[] {
  if (!MK.NQ || !MK.ES) return [];
  const dates = [...MK.NQ.keys()].filter((d) => MK.ES.has(d)).sort();
  const rows: ChronicleRow[] = [];
  const atrWin: number[] = [];
  for (let i = 1; i < dates.length; i++) {
    const d = dates[i], pd = dates[i - 1];
    const nb = MK.NQ.get(d)!, pnb = MK.NQ.get(pd)!;
    const nqRet = ret(MK.NQ, d, pd), esRet = ret(MK.ES, d, pd), gcRet = ret(MK.GC, d, pd), clRet = ret(MK.CL, d, pd);
    const znRet = ret(MK.ZN, d, pd), hgRet = ret(MK.HG, d, pd), eRet = ret(MK["6E"], d, pd), usdRet = isFinite(eRet) ? -eRet : NaN;
    // breadth across the 4 equity indices
    const eq = [ret(MK.NQ, d, pd), ret(MK.ES, d, pd), ret(MK.RTY, d, pd), ret(MK.YM, d, pd)].filter(isFinite);
    const breadth = eq.length ? eq.filter((x) => x > 0).length / eq.length : 0.5;
    // NQ true range vs ATR20 (vol expansion)
    const tr = Math.max(nb.h - nb.l, Math.abs(nb.h - pnb.c), Math.abs(nb.l - pnb.c));
    atrWin.push(tr); if (atrWin.length > 20) atrWin.shift();
    const atr20 = mean(atrWin); const rangeAtr = atr20 > 0 ? tr / atr20 : 1;
    const closePos = nb.h > nb.l ? (nb.c - nb.l) / (nb.h - nb.l) : 0.5; // 1=closed at high, 0=at low
    const nq5d = mom(MK.NQ, dates, i, 5), nq20d = mom(MK.NQ, dates, i, 20);
    const atrPx = atr20 / nb.c;
    rows.push({ date: d, nqRet, esRet, gcRet, clRet, usdRet, znRet, hgRet, breadth, rangeAtr, closePos, nq5d, nq20d,
      volRegime: "", volPctile: NaN, riskTone: "", toneScore: NaN, dayType: "", regime: "", narrative: "",
      feat: [], fwd1: NaN, fwd5: NaN });
    (rows[rows.length - 1] as unknown as { _atrPx: number })._atrPx = atrPx;
  }
  // Second pass: regimes, tone, dayType, narrative, features, forward outcomes
  const atrPxHist: number[] = [];
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i]; const apx = (r as unknown as { _atrPx: number })._atrPx;
    // percentile of today's ATR/price within the TRAILING 252 days (a year), chronological — not all-time.
    r.volPctile = pct(atrPxHist.slice(-252), apx);
    atrPxHist.push(apx);
    r.volRegime = r.volPctile > 0.85 ? "extreme" : r.volPctile > 0.6 ? "high" : r.volPctile < 0.25 ? "low" : "normal";
    // risk tone: equities & copper up = risk-on; bonds & gold & dollar up = risk-off
    const s = (x: number) => (isFinite(x) ? Math.sign(x) : 0);
    r.toneScore = s(r.nqRet) + s(r.hgRet) - s(r.znRet) - s(r.gcRet);
    r.riskTone = r.toneScore >= 2 ? "risk-on" : r.toneScore <= -2 ? "risk-off" : "mixed";
    // day type from NQ candle: trend (closed near extreme, range-expanding) vs reversal vs inside/chop
    r.dayType = r.rangeAtr > 1.3 && (r.closePos > 0.7 || r.closePos < 0.3) ? "trend"
      : r.rangeAtr < 0.7 ? "inside" : (r.closePos > 0.7 && r.nqRet < 0) || (r.closePos < 0.3 && r.nqRet > 0) ? "reversal" : "range";
    // regime from NQ 20d momentum
    r.regime = !isFinite(r.nq20d) ? "n/a" : r.nq20d > 0.02 ? "bull" : r.nq20d < -0.02 ? "bear" : "chop";
    const p1 = (x: number) => `${x >= 0 ? "+" : ""}${(x * 100).toFixed(2)}%`;
    r.narrative = `NQ ${p1(r.nqRet)} (${r.dayType}, vol ${r.volRegime}), ${r.riskTone} — breadth ${(r.breadth * 100).toFixed(0)}%, gold ${p1(r.gcRet)}, oil ${p1(r.clRet)}, $ ${p1(r.usdRet)}, bonds ${p1(r.znRet)}`;
    r.feat = [r.nq5d, r.nq20d, r.rangeAtr, r.toneScore, r.usdRet, r.clRet, r.znRet].map((x) => (isFinite(x) ? x : 0));
    // realized forward NQ returns (for analogue outcomes)
    if (i + 1 < rows.length) r.fwd1 = rows[i + 1].nqRet;
    if (i + 5 < rows.length) { const a = MK.NQ.get(rows[i].date)?.c, b = MK.NQ.get(rows[i + 5].date)?.c; r.fwd5 = a && b ? (b - a) / a : NaN; }
  }
  return rows;
}

export interface Analogue {
  today: ChronicleRow; k: number;
  fwd1Avg: number; fwd1Up: number; fwd5Avg: number; fwd5Up: number; examples: string[];
}

// Normalize features across history, find K nearest historical days to the latest, summarize forward outcomes.
export function findAnalogues(rows: ChronicleRow[], k = 30): Analogue | null {
  const valid = rows.filter((r) => isFinite(r.nq20d));
  if (valid.length < 100) return null;
  const dim = valid[0].feat.length;
  const mu = Array.from({ length: dim }, (_, j) => mean(valid.map((r) => r.feat[j])));
  const sd = Array.from({ length: dim }, (_, j) => std(valid.map((r) => r.feat[j])));
  const z = (f: number[]) => f.map((v, j) => (v - mu[j]) / sd[j]);
  const today = valid[valid.length - 1]; const zt = z(today.feat);
  // candidates: all but the last ~10 days (need realized fwd outcomes)
  const cand = valid.slice(0, -10).filter((r) => isFinite(r.fwd1) && isFinite(r.fwd5));
  const scored = cand.map((r) => ({ r, dist: Math.sqrt(z(r.feat).reduce((s, v, j) => s + (v - zt[j]) ** 2, 0)) })).sort((a, b) => a.dist - b.dist);
  const near = scored.slice(0, k).map((s) => s.r);
  const f1 = near.map((r) => r.fwd1), f5 = near.map((r) => r.fwd5);
  return { today, k, fwd1Avg: mean(f1), fwd1Up: f1.filter((x) => x > 0).length / f1.length, fwd5Avg: mean(f5), fwd5Up: f5.filter((x) => x > 0).length / f5.length,
    examples: near.slice(0, 5).map((r) => r.date) };
}

// ── Market-history.md (Brain/market-history.md) ──
// Recent days table + today's regime read + historical analogues. Mirrors market-chronicle.ts vault write.
export function chronicleMarkdown(rows: ChronicleRow[], today: string): string {
  const recent = rows.slice(-15);
  const ana = findAnalogues(rows);
  let body = "";
  if (ana) {
    const t = ana.today;
    body = `## Today (${t.date})\n\n${t.narrative}\n\n**Regime:** ${t.regime} · **Vol:** ${t.volRegime} (${(t.volPctile * 100).toFixed(0)}th pctile) · **Risk tone:** ${t.riskTone} · **Day type:** ${t.dayType}\n\n## Historical analogues (the ${ana.k} most-similar days)\n\n- NQ **next 1 day**: avg ${(ana.fwd1Avg * 100).toFixed(2)}%, up ${(ana.fwd1Up * 100).toFixed(0)}% of the time\n- NQ **next 5 days**: avg ${(ana.fwd5Avg * 100).toFixed(2)}%, up ${(ana.fwd5Up * 100).toFixed(0)}% of the time\n- Similar days: ${ana.examples.join(", ")}\n\n*Use as context for conviction/sizing — not a standalone entry signal (small samples, regime-dependent).*\n`;
  }
  const tbl = ["| date | NQ | regime | vol | tone | day |", "|---|---|---|---|---|---|",
    ...recent.slice().reverse().map((r) => `| ${r.date} | ${(r.nqRet >= 0 ? "+" : "") + (r.nqRet * 100).toFixed(2)}% | ${r.regime} | ${r.volRegime} | ${r.riskTone} | ${r.dayType} |`)].join("\n");
  return `---\nlast_updated: "${today}"\nupdated_by: "market-chronicle"\n---\n\n# Market History\n\nWhat the market did recently, and what historically follows days like today. Source: cross-asset daily history (${rows.length} days).\n\n${body}## Last 15 trading days\n\n${tbl}\n`;
}

// ── Per-instrument analysis for the morning brief (key levels + chart). Mirrors morning-brief.ts:analyze(). ──
export interface Inst { sym: string; last: number; dayChg: number; levels: Level[]; svg: string; }

export function analyzeInstrument(sym: string, bars: Candle[]): Inst | null {
  if (bars.length < 55) return null;
  const view = bars.slice(-55);                 // ~11 weeks of context for the chart
  const last = view[view.length - 1], prev = view[view.length - 2];
  const hi20 = Math.max(...view.slice(-20).map((b) => b.h));
  const lo20 = Math.min(...view.slice(-20).map((b) => b.l));
  const sma50 = mean(view.slice(-50).map((b) => b.c));
  const levels: Level[] = [
    { label: "PDC", price: prev.c, color: "#f59e0b" },
    { label: "20d hi", price: hi20, color: "#16a34a" },
    { label: "20d lo", price: lo20, color: "#dc2626" },
    { label: "50d", price: sma50, color: "#3b82f6" },
  ];
  const dayChg = (last.c - prev.c) / prev.c;
  const subtitle = `last ${last.c.toFixed(last.c > 1000 ? 0 : 2)} · ${dayChg >= 0 ? "+" : ""}${(dayChg * 100).toFixed(2)}% · 50d ${last.c >= sma50 ? "above ↑" : "below ↓"} · through ${last.date}`;
  const svg = candlestickSVG({ title: FOCUS_NAMES[sym] ?? sym, subtitle, candles: view, levels });
  return { sym, last: last.c, dayChg, levels, svg };
}

// Pull a section out of a vault markdown doc (between a heading and the next heading).
export function sectionExtract(md: string | null, heading: RegExp, maxLines = 12): string {
  if (!md) return "";
  const lines = md.split("\n"); const out: string[] = []; let on = false;
  for (const l of lines) {
    if (on && /^#{1,3}\s/.test(l)) break;
    if (on) out.push(l);
    if (heading.test(l)) on = true;
  }
  return out.filter((l) => l.trim()).slice(0, maxLines).join("\n");
}

// ── Morning brief markdown (Brain/morning-brief.md). Mirrors morning-brief.ts:main() composition. ──
// `chartPath(sym)` lets the caller decide how charts are embedded (Obsidian wikilink vs DB vault path).
export function morningBriefMarkdown(opts: {
  today: string;
  insts: Inst[];
  regimeDoc: string | null;
  planDoc: string | null;
  histDoc: string | null;
  lessonsDoc: string | null;
  chartPath: (sym: string) => string;
}): string {
  const { today, insts, regimeDoc, planDoc, histDoc, lessonsDoc, chartPath } = opts;
  const regimeLine = (regimeDoc?.match(/\*\*Current\*\*:\s*`?(\w+)`?/i)?.[1] ?? "unknown").toUpperCase();
  const todayHist = sectionExtract(histDoc, /^##\s*Today/i, 4);
  const analogues = sectionExtract(histDoc, /analogue/i, 8);
  const planBias = sectionExtract(planDoc, /bias|##\s*Plan|##\s*Daily/i, 8);
  const lessons = sectionExtract(lessonsDoc, /^#{1,3}/i, 6);

  const L = (it: Inst) => it.levels.map((l) => `${l.label} ${l.price.toFixed(l.price > 1000 ? 0 : 2)}`).join(" · ");
  const movers = insts.map((it) => `**${it.sym}** ${it.last.toFixed(it.last > 1000 ? 0 : 2)} (${it.dayChg >= 0 ? "+" : ""}${(it.dayChg * 100).toFixed(2)}%)`).join(" · ");

  return `---
last_updated: "${today}"
updated_by: "morning-brief"
---

# 🌅 Morning Brief — ${today}

**Regime:** ${regimeLine} · ${movers}

## What the market did
${todayHist || "(chronicle not available — daily-research cron writes Brain/market-history.md)"}

${analogues ? `## Days like today (historical analogues)\n${analogues}\n` : ""}## Today's plan (AI advisor)
${planBias || "(no daily plan in vault yet — premarket cron writes Brain/daily-plan.md)"}

## Instruments & key levels
${insts.map((it) => `### ${FOCUS_NAMES[it.sym] ?? it.sym}\n${L(it)}\n\n![[${chartPath(it.sym)}]]`).join("\n\n")}

## Lessons to apply
${lessons || "(none)"}

---
*Generated daily. Charts: dependency-free SVG from cross-asset daily history. Context is for sizing/conviction — not standalone signals.*
`;
}
