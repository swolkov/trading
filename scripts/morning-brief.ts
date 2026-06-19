/**
 * MORNING BRIEF — one brilliant daily market document, with charts.
 *
 * Consolidates the scattered morning intelligence into a single artifact the desk reads each day:
 *   • what the traded instruments did + key levels (computed from the 16yr daily history)
 *   • candlestick CHARTS (dependency-free SVG) for NQ / ES / GC with PDC / 20d range / 50d marked
 *   • the regime + the AI daily plan (read from the vault)
 *   • "days like today" — the market-chronicle's historical analogues (what NQ tends to do next)
 *   • top active lessons to apply
 *
 * The analysis + composition lives in src/lib/market-chronicle.ts (shared with the daily-research
 * Vercel cron). This script supplies local-CSV data and writes SVGs to the repo + Obsidian folder.
 * Writes Brain/morning-brief.md (vault) + reports/charts/<sym>-morning.svg + the SVGs into the
 * Obsidian vault folder so they render inline.
 *
 *   railway run npx tsx scripts/morning-brief.ts        (needs DATABASE_URL for vault read/write)
 *   npx tsx scripts/morning-brief.ts --no-vault         (charts + console only)
 */
import fs from "node:fs";
import { type Candle } from "../src/lib/svg-chart";
import { analyzeInstrument, morningBriefMarkdown, sectionExtract, FOCUS_SYMBOLS, type Inst } from "../src/lib/market-chronicle";

const ROOT = new URL("..", import.meta.url);
const NO_VAULT = process.argv.includes("--no-vault");
const CHART_DIR = new URL("reports/charts/", ROOT).pathname;
const VAULT_DIR = "/Users/user/Desktop/Trading/Trading";

function loadDaily(sym: string): Candle[] {
  const out: Candle[] = [];
  try {
    for (const r of fs.readFileSync(new URL(`data/daily/${sym}_1d.csv`, ROOT), "utf8").trim().split("\n").slice(1)) {
      const c = r.split(","); const o = +c[4], h = +c[5], l = +c[6], cl = +c[7], v = +c[8];
      if (isFinite(cl) && cl > 0) out.push({ date: c[0].slice(0, 10), o, h, l, c: cl, v });
    }
  } catch {}
  return out;
}

async function main() {
  const today = new Date().toISOString().slice(0, 10);
  try { fs.mkdirSync(CHART_DIR, { recursive: true }); } catch {}

  const insts = FOCUS_SYMBOLS.map((s) => analyzeInstrument(s, loadDaily(s))).filter((x): x is Inst => !!x);
  if (!insts.length) { console.error("No daily data — run scripts/dbn-fetch-daily.ts"); process.exit(1); }

  // write SVG charts (repo + vault folder for Obsidian inline embeds)
  const vaultCharts = `${VAULT_DIR}/Brain/charts`;
  let vaultChartsOk = false;
  if (!NO_VAULT) { try { fs.mkdirSync(vaultCharts, { recursive: true }); vaultChartsOk = true; } catch {} }
  for (const it of insts) {
    fs.writeFileSync(`${CHART_DIR}${it.sym}-morning.svg`, it.svg);
    if (vaultChartsOk) { try { fs.writeFileSync(`${vaultCharts}/${it.sym}-morning.svg`, it.svg); } catch {} }
  }

  // read vault context (regime, AI plan, chronicle analogues, lessons)
  let regimeDoc: string | null = null, planDoc: string | null = null, histDoc: string | null = null, lessonsDoc: string | null = null;
  if (!NO_VAULT) {
    try {
      const { vaultRead } = await import("../src/lib/vault");
      [regimeDoc, planDoc, histDoc, lessonsDoc] = await Promise.all([
        vaultRead("Brain/market-regime.md"), vaultRead("Brain/daily-plan.md"),
        vaultRead("Brain/market-history.md"), vaultRead("Lessons/active-lessons.md"),
      ]);
    } catch (e) { console.log(`(vault read skipped: ${e instanceof Error ? e.message : e})`); }
  }

  // compose the brief (charts as Obsidian wikilinks under charts/)
  const md = morningBriefMarkdown({
    today, insts, regimeDoc, planDoc, histDoc, lessonsDoc,
    chartPath: (sym) => `charts/${sym}-morning.svg`,
  });

  // console preview
  const regimeLine = (regimeDoc?.match(/\*\*Current\*\*:\s*`?(\w+)`?/i)?.[1] ?? "unknown").toUpperCase();
  const movers = insts.map((it) => `${it.sym} ${it.last.toFixed(it.last > 1000 ? 0 : 2)} (${it.dayChg >= 0 ? "+" : ""}${(it.dayChg * 100).toFixed(2)}%)`).join(" · ");
  const todayHist = sectionExtract(histDoc, /^##\s*Today/i, 4);
  const L = (it: Inst) => it.levels.map((l) => `${l.label} ${l.price.toFixed(l.price > 1000 ? 0 : 2)}`).join(" · ");
  const W = 92;
  console.log("\n" + "═".repeat(W));
  console.log(`  🌅 MORNING BRIEF — ${today}    Regime: ${regimeLine}`);
  console.log("═".repeat(W));
  console.log("  " + movers);
  for (const it of insts) console.log(`  ${it.sym.padEnd(3)} levels: ${L(it)}`);
  if (todayHist) console.log("  ──\n  " + todayHist.replace(/\n/g, "\n  "));
  console.log(`  charts → reports/charts/{${insts.map((i) => i.sym).join(",")}}-morning.svg`);
  console.log("═".repeat(W) + "\n");

  if (!NO_VAULT) {
    try {
      const { vaultWrite } = await import("../src/lib/vault");
      await vaultWrite("Brain/morning-brief.md", md, "morning-brief");
      console.log("  ✅ vault: Brain/morning-brief.md updated" + (vaultChartsOk ? " (+ inline charts)" : ""));
    } catch (e) { console.log(`  (vault write skipped: ${e instanceof Error ? e.message : e})`); }
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
