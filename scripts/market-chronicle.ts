/**
 * MARKET CHRONICLE — the system's memory of what the market DID, every day, and what tends to follow.
 *
 * Builds a structured daily record across the cross-asset basket (equities, rates, FX, energy, metals,
 * grains) from the 16yr daily history in data/daily/. For each day it computes returns, range/vol
 * expansion, breadth, risk-on/off tone, and a regime label — then, for the LATEST day, finds the
 * historical days most SIMILAR to today and reports the distribution of NQ's next-day & next-5-day
 * returns ("on days like today, the market did X"). That analogue lookup is the part that benefits
 * future trading: context the engine + AI grader can condition on.
 *
 * Outputs:
 *   data/market-chronicle.csv          full accumulating history (one row per trading day)
 *   Brain/market-history.md (vault)    recent days + regime read + today's historical analogues
 *
 *   npx tsx scripts/market-chronicle.ts            (compute + write csv; vault write if reachable)
 *   npx tsx scripts/market-chronicle.ts --no-vault (skip vault write)
 */
import fs from "node:fs";

const ROOT = new URL("..", import.meta.url);
const OUT_CSV = new URL("data/market-chronicle.csv", ROOT).pathname;
const NO_VAULT = process.argv.includes("--no-vault");

interface Bar { o: number; h: number; l: number; c: number; v: number; }
function load(sym: string): Map<string, Bar> {
  const m = new Map<string, Bar>();
  try {
    for (const r of fs.readFileSync(new URL(`data/daily/${sym}_1d.csv`, ROOT), "utf8").trim().split("\n").slice(1)) {
      const c = r.split(","); const o = +c[4], h = +c[5], l = +c[6], cl = +c[7], v = +c[8];
      if (isFinite(cl) && cl > 0) m.set(c[0].slice(0, 10), { o, h, l, c: cl, v });
    }
  } catch {}
  return m;
}

// Cross-asset basket. Dollar proxy = inverse of 6E (EUR futures); bonds = ZN; growth = HG; haven = GC.
const MK = { NQ: load("NQ"), ES: load("ES"), RTY: load("RTY"), YM: load("YM"), ZN: load("ZN"), ZB: load("ZB"), "6E": load("6E"), CL: load("CL"), GC: load("GC"), HG: load("HG"), ZC: load("ZC"), ZS: load("ZS"), ZW: load("ZW") };
const ret = (mk: Map<string, Bar>, d: string, pd: string) => { const a = mk.get(pd)?.c, b = mk.get(d)?.c; return a && b ? (b - a) / a : NaN; };
const mom = (mk: Map<string, Bar>, dates: string[], i: number, n: number) => { if (i < n) return NaN; const a = mk.get(dates[i - n])?.c, b = mk.get(dates[i])?.c; return a && b ? (b - a) / a : NaN; };
const mean = (a: number[]) => a.length ? a.reduce((s, v) => s + v, 0) / a.length : 0;
const std = (a: number[]) => { if (a.length < 2) return 1; const m = mean(a); return Math.sqrt(mean(a.map(v => (v - m) ** 2))) || 1; };
const pct = (sorted: number[], v: number) => { let lo = 0; for (const x of sorted) if (x < v) lo++; return sorted.length ? lo / sorted.length : 0.5; };

interface Row { date: string; nqRet: number; esRet: number; gcRet: number; clRet: number; usdRet: number; znRet: number; hgRet: number;
  breadth: number; rangeAtr: number; closePos: number; nq5d: number; nq20d: number; volRegime: string; volPctile: number;
  riskTone: string; toneScore: number; dayType: string; regime: string; narrative: string;
  // feature vector for similarity + the realized forward outcome (filled where known)
  feat: number[]; fwd1: number; fwd5: number; }

function build(): Row[] {
  const dates = [...MK.NQ.keys()].filter(d => MK.ES.has(d)).sort();
  const rows: Row[] = [];
  const atrWin: number[] = [];
  for (let i = 1; i < dates.length; i++) {
    const d = dates[i], pd = dates[i - 1];
    const nb = MK.NQ.get(d)!, pnb = MK.NQ.get(pd)!;
    const nqRet = ret(MK.NQ, d, pd), esRet = ret(MK.ES, d, pd), gcRet = ret(MK.GC, d, pd), clRet = ret(MK.CL, d, pd);
    const znRet = ret(MK.ZN, d, pd), hgRet = ret(MK.HG, d, pd), eRet = ret(MK["6E"], d, pd), usdRet = isFinite(eRet) ? -eRet : NaN;
    // breadth across the 4 equity indices
    const eq = [ret(MK.NQ, d, pd), ret(MK.ES, d, pd), ret(MK.RTY, d, pd), ret(MK.YM, d, pd)].filter(isFinite);
    const breadth = eq.length ? eq.filter(x => x > 0).length / eq.length : 0.5;
    // NQ true range vs ATR20 (vol expansion)
    const tr = Math.max(nb.h - nb.l, Math.abs(nb.h - pnb.c), Math.abs(nb.l - pnb.c));
    atrWin.push(tr); if (atrWin.length > 20) atrWin.shift();
    const atr20 = mean(atrWin); const rangeAtr = atr20 > 0 ? tr / atr20 : 1;
    const closePos = nb.h > nb.l ? (nb.c - nb.l) / (nb.h - nb.l) : 0.5; // 1=closed at high, 0=at low
    const nq5d = mom(MK.NQ, dates, i, 5), nq20d = mom(MK.NQ, dates, i, 20);
    // vol regime via ATR/price percentile over trailing 252d
    const atrPx = atr20 / nb.c;
    rows.push({ date: d, nqRet, esRet, gcRet, clRet, usdRet, znRet, hgRet, breadth, rangeAtr, closePos, nq5d, nq20d,
      volRegime: "", volPctile: NaN, riskTone: "", toneScore: NaN, dayType: "", regime: "", narrative: "",
      feat: [], fwd1: NaN, fwd5: NaN });
    (rows[rows.length - 1] as any)._atrPx = atrPx;
  }
  // Second pass: regimes, tone, dayType, narrative, features, forward outcomes
  const atrPxHist: number[] = [];
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i]; const apx = (r as any)._atrPx as number;
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
    // regime from NQ 20d vs 50d-ish momentum
    r.regime = !isFinite(r.nq20d) ? "n/a" : r.nq20d > 0.02 ? "bull" : r.nq20d < -0.02 ? "bear" : "chop";
    const p1 = (x: number) => `${x >= 0 ? "+" : ""}${(x * 100).toFixed(2)}%`;
    r.narrative = `NQ ${p1(r.nqRet)} (${r.dayType}, vol ${r.volRegime}), ${r.riskTone} — breadth ${(r.breadth * 100).toFixed(0)}%, gold ${p1(r.gcRet)}, oil ${p1(r.clRet)}, $ ${p1(r.usdRet)}, bonds ${p1(r.znRet)}`;
    r.feat = [r.nq5d, r.nq20d, r.rangeAtr, r.toneScore, r.usdRet, r.clRet, r.znRet].map(x => (isFinite(x) ? x : 0));
    // realized forward NQ returns (for analogue outcomes)
    if (i + 1 < rows.length) r.fwd1 = rows[i + 1].nqRet;
    if (i + 5 < rows.length) { const a = MK.NQ.get(rows[i].date)?.c, b = MK.NQ.get(rows[i + 5].date)?.c; r.fwd5 = a && b ? (b - a) / a : NaN; }
  }
  return rows;
}

// Normalize features across history, find K nearest historical days to the latest, summarize forward outcomes.
function analogues(rows: Row[], k = 30) {
  const valid = rows.filter(r => isFinite(r.nq20d));
  if (valid.length < 100) return null;
  const dim = valid[0].feat.length;
  const mu = Array.from({ length: dim }, (_, j) => mean(valid.map(r => r.feat[j])));
  const sd = Array.from({ length: dim }, (_, j) => std(valid.map(r => r.feat[j])));
  const z = (f: number[]) => f.map((v, j) => (v - mu[j]) / sd[j]);
  const today = valid[valid.length - 1]; const zt = z(today.feat);
  // candidates: all but the last ~10 days (need realized fwd outcomes)
  const cand = valid.slice(0, -10).filter(r => isFinite(r.fwd1) && isFinite(r.fwd5));
  const scored = cand.map(r => ({ r, dist: Math.sqrt(z(r.feat).reduce((s, v, j) => s + (v - zt[j]) ** 2, 0)) })).sort((a, b) => a.dist - b.dist);
  const near = scored.slice(0, k).map(s => s.r);
  const f1 = near.map(r => r.fwd1), f5 = near.map(r => r.fwd5);
  return { today, k, fwd1Avg: mean(f1), fwd1Up: f1.filter(x => x > 0).length / f1.length, fwd5Avg: mean(f5), fwd5Up: f5.filter(x => x > 0).length / f5.length,
    examples: near.slice(0, 5).map(r => r.date) };
}

async function main() {
  const rows = build();
  if (!rows.length) { console.error("No data — run scripts/dbn-fetch-daily.ts first"); process.exit(1); }

  // 1) Full history CSV
  const cols = ["date", "nqRet", "esRet", "gcRet", "clRet", "usdRet", "znRet", "hgRet", "breadth", "rangeAtr", "closePos", "nq5d", "nq20d", "volRegime", "volPctile", "riskTone", "toneScore", "dayType", "regime"];
  const csv = cols.join(",") + "\n" + rows.map(r => cols.map(c => { const v = (r as any)[c]; return typeof v === "number" ? (isFinite(v) ? v.toFixed(5) : "") : v; }).join(",")).join("\n") + "\n";
  fs.writeFileSync(OUT_CSV, csv);

  const ana = analogues(rows);
  const recent = rows.slice(-15);
  const W = 104;
  console.log("\n" + "═".repeat(W));
  console.log("  MARKET CHRONICLE — what the market did, and what tends to follow");
  console.log("═".repeat(W));
  console.log(`  ${rows.length} trading days recorded (${rows[0].date} → ${rows[rows.length - 1].date})  →  data/market-chronicle.csv`);
  console.log("─".repeat(W));
  console.log(`  ${"date".padEnd(11)} ${"NQ".padEnd(8)} ${"regime".padEnd(6)} ${"vol".padEnd(7)} ${"tone".padEnd(8)} ${"dayType".padEnd(9)} narrative`);
  for (const r of recent) console.log(`  ${r.date.padEnd(11)} ${((r.nqRet >= 0 ? "+" : "") + (r.nqRet * 100).toFixed(2) + "%").padEnd(8)} ${r.regime.padEnd(6)} ${r.volRegime.padEnd(7)} ${r.riskTone.padEnd(8)} ${r.dayType.padEnd(9)}`);
  let vaultBody = "";
  if (ana) {
    console.log("─".repeat(W));
    const t = ana.today;
    console.log(`  TODAY (${t.date}): ${t.narrative}`);
    console.log(`  ANALOGUES — the ${ana.k} historical days most similar to today (vol/tone/momentum/cross-asset):`);
    console.log(`     NQ next 1d:  avg ${(ana.fwd1Avg * 100).toFixed(2)}%   up ${(ana.fwd1Up * 100).toFixed(0)}% of the time`);
    console.log(`     NQ next 5d:  avg ${(ana.fwd5Avg * 100).toFixed(2)}%   up ${(ana.fwd5Up * 100).toFixed(0)}% of the time`);
    console.log(`     e.g. similar days: ${ana.examples.join(", ")}`);
    const edge1 = Math.abs(ana.fwd1Up - 0.5) > 0.15 || Math.abs(ana.fwd1Avg) > 0.004;
    console.log(`     → ${edge1 ? "⚠️ skewed — days like today have a directional lean (context for sizing, NOT a standalone signal)." : "≈ coin-flip — today looks unremarkable; no analogue edge."}`);
    vaultBody = `## Today (${t.date})\n\n${t.narrative}\n\n**Regime:** ${t.regime} · **Vol:** ${t.volRegime} (${(t.volPctile * 100).toFixed(0)}th pctile) · **Risk tone:** ${t.riskTone} · **Day type:** ${t.dayType}\n\n## Historical analogues (the ${ana.k} most-similar days)\n\n- NQ **next 1 day**: avg ${(ana.fwd1Avg * 100).toFixed(2)}%, up ${(ana.fwd1Up * 100).toFixed(0)}% of the time\n- NQ **next 5 days**: avg ${(ana.fwd5Avg * 100).toFixed(2)}%, up ${(ana.fwd5Up * 100).toFixed(0)}% of the time\n- Similar days: ${ana.examples.join(", ")}\n\n*Use as context for conviction/sizing — not a standalone entry signal (small samples, regime-dependent).*\n`;
  }
  console.log("═".repeat(W) + "\n");

  // 2) Vault summary for the research agent / AI grader
  if (!NO_VAULT) {
    try {
      const { vaultWrite } = await import("../src/lib/vault");
      const today = new Date().toISOString().slice(0, 10);
      const tbl = ["| date | NQ | regime | vol | tone | day |", "|---|---|---|---|---|---|",
        ...recent.slice().reverse().map(r => `| ${r.date} | ${(r.nqRet >= 0 ? "+" : "") + (r.nqRet * 100).toFixed(2)}% | ${r.regime} | ${r.volRegime} | ${r.riskTone} | ${r.dayType} |`)].join("\n");
      const md = `---\nlast_updated: "${today}"\nupdated_by: "market-chronicle"\n---\n\n# Market History\n\nWhat the market did recently, and what historically follows days like today. Source: data/market-chronicle.csv (${rows.length} days).\n\n${vaultBody}\n## Last 15 trading days\n\n${tbl}\n`;
      await vaultWrite("Brain/market-history.md", md, "market-chronicle");
      console.log("  ✅ vault: Brain/market-history.md updated");
    } catch (e) { console.log(`  (vault write skipped: ${e instanceof Error ? e.message : e})`); }
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
