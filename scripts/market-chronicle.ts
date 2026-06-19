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
 * The chronicle/analogue MATH lives in src/lib/market-chronicle.ts (shared with the daily-research
 * Vercel cron so the two stay in lockstep). This script supplies the local-CSV data + CSV/console output.
 *
 * Outputs:
 *   data/market-chronicle.csv          full accumulating history (one row per trading day)
 *   Brain/market-history.md (vault)    recent days + regime read + today's historical analogues
 *
 *   npx tsx scripts/market-chronicle.ts            (compute + write csv; vault write if reachable)
 *   npx tsx scripts/market-chronicle.ts --no-vault (skip vault write)
 */
import fs from "node:fs";
import { buildChronicle, findAnalogues, chronicleMarkdown, CHRONICLE_SYMBOLS, type Bar } from "../src/lib/market-chronicle";

const ROOT = new URL("..", import.meta.url);
const OUT_CSV = new URL("data/market-chronicle.csv", ROOT).pathname;
const NO_VAULT = process.argv.includes("--no-vault");

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

const MK: Record<string, Map<string, Bar>> = {};
for (const s of CHRONICLE_SYMBOLS) MK[s] = load(s);

async function main() {
  const rows = buildChronicle(MK);
  if (!rows.length) { console.error("No data — run scripts/dbn-fetch-daily.ts first"); process.exit(1); }

  // 1) Full history CSV
  const cols = ["date", "nqRet", "esRet", "gcRet", "clRet", "usdRet", "znRet", "hgRet", "breadth", "rangeAtr", "closePos", "nq5d", "nq20d", "volRegime", "volPctile", "riskTone", "toneScore", "dayType", "regime"];
  const csv = cols.join(",") + "\n" + rows.map((r) => cols.map((c) => { const v = (r as unknown as Record<string, unknown>)[c]; return typeof v === "number" ? (isFinite(v) ? v.toFixed(5) : "") : v; }).join(",")).join("\n") + "\n";
  fs.writeFileSync(OUT_CSV, csv);

  const ana = findAnalogues(rows);
  const recent = rows.slice(-15);
  const W = 104;
  console.log("\n" + "═".repeat(W));
  console.log("  MARKET CHRONICLE — what the market did, and what tends to follow");
  console.log("═".repeat(W));
  console.log(`  ${rows.length} trading days recorded (${rows[0].date} → ${rows[rows.length - 1].date})  →  data/market-chronicle.csv`);
  console.log("─".repeat(W));
  console.log(`  ${"date".padEnd(11)} ${"NQ".padEnd(8)} ${"regime".padEnd(6)} ${"vol".padEnd(7)} ${"tone".padEnd(8)} ${"dayType".padEnd(9)} narrative`);
  for (const r of recent) console.log(`  ${r.date.padEnd(11)} ${((r.nqRet >= 0 ? "+" : "") + (r.nqRet * 100).toFixed(2) + "%").padEnd(8)} ${r.regime.padEnd(6)} ${r.volRegime.padEnd(7)} ${r.riskTone.padEnd(8)} ${r.dayType.padEnd(9)}`);
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
  }
  console.log("═".repeat(W) + "\n");

  // 2) Vault summary for the research agent / AI grader
  if (!NO_VAULT) {
    try {
      const { vaultWrite } = await import("../src/lib/vault");
      const today = new Date().toISOString().slice(0, 10);
      await vaultWrite("Brain/market-history.md", chronicleMarkdown(rows, today), "market-chronicle");
      console.log("  ✅ vault: Brain/market-history.md updated");
    } catch (e) { console.log(`  (vault write skipped: ${e instanceof Error ? e.message : e})`); }
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
