/**
 * MORNING BRIEF — one brilliant daily market document, with charts.
 *
 * Consolidates the scattered morning intelligence into a single artifact the desk reads each day:
 *   • what the traded instruments did + key levels (computed from the 16yr daily history)
 *   • candlestick CHARTS (dependency-free SVG) for NQ / ES / GC with PDC / 20d range / 50d marked
 *   • the regime + the AI daily plan (read from the vault)
 *   • "days like today" — the market-chronicle's historical analogues (what NQ tends to do next)
 *   • top active lessons to apply
 * Writes Brain/morning-brief.md (vault) + reports/charts/<sym>-morning.svg + (if reachable) the SVGs
 * into the Obsidian vault folder so they render inline.
 *
 *   railway run npx tsx scripts/morning-brief.ts        (needs DATABASE_URL for vault read/write)
 *   npx tsx scripts/morning-brief.ts --no-vault         (charts + console only)
 */
import fs from "node:fs";
import { candlestickSVG, type Candle, type Level } from "../src/lib/svg-chart";

const ROOT = new URL("..", import.meta.url);
const NO_VAULT = process.argv.includes("--no-vault");
const CHART_DIR = new URL("reports/charts/", ROOT).pathname;
const VAULT_DIR = "/Users/user/Desktop/Trading/Trading";
const FOCUS = ["NQ", "ES", "GC"]; // the instruments the engines actually trade
const NAMES: Record<string, string> = { NQ: "Nasdaq-100 (NQ)", ES: "S&P 500 (ES)", GC: "Gold (GC)" };

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
const mean = (a: number[]) => a.length ? a.reduce((s, v) => s + v, 0) / a.length : 0;
const pctChg = (a: number, b: number) => (b - a) / a;

interface Inst { sym: string; last: number; dayChg: number; levels: Level[]; svg: string; bars: Candle[]; }

function analyze(sym: string): Inst | null {
  const bars = loadDaily(sym);
  if (bars.length < 55) return null;
  const view = bars.slice(-55);                 // ~11 weeks of context for the chart
  const last = view[view.length - 1], prev = view[view.length - 2];
  const hi20 = Math.max(...view.slice(-20).map(b => b.h));
  const lo20 = Math.min(...view.slice(-20).map(b => b.l));
  const sma50 = mean(view.slice(-50).map(b => b.c));
  const levels: Level[] = [
    { label: "PDC", price: prev.c, color: "#f59e0b" },
    { label: "20d hi", price: hi20, color: "#16a34a" },
    { label: "20d lo", price: lo20, color: "#dc2626" },
    { label: "50d", price: sma50, color: "#3b82f6" },
  ];
  const dayChg = pctChg(prev.c, last.c);
  const subtitle = `last ${last.c.toFixed(last.c > 1000 ? 0 : 2)} · ${dayChg >= 0 ? "+" : ""}${(dayChg * 100).toFixed(2)}% · 50d ${last.c >= sma50 ? "above ↑" : "below ↓"} · through ${last.date}`;
  const svg = candlestickSVG({ title: NAMES[sym] ?? sym, subtitle, candles: view, levels });
  return { sym, last: last.c, dayChg, levels, svg, bars };
}

// Pull a section out of a vault markdown doc (between a heading and the next heading).
function section(md: string | null, heading: RegExp, maxLines = 12): string {
  if (!md) return "";
  const lines = md.split("\n"); const out: string[] = []; let on = false;
  for (const l of lines) {
    if (on && /^#{1,3}\s/.test(l)) break;
    if (on) out.push(l);
    if (heading.test(l)) on = true;
  }
  return out.filter(l => l.trim()).slice(0, maxLines).join("\n");
}

async function main() {
  const today = new Date().toISOString().slice(0, 10);
  try { fs.mkdirSync(CHART_DIR, { recursive: true }); } catch {}

  const insts = FOCUS.map(analyze).filter((x): x is Inst => !!x);
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
  const regimeLine = (regimeDoc?.match(/\*\*Current\*\*:\s*`?(\w+)`?/i)?.[1] ?? "unknown").toUpperCase();
  const todayHist = section(histDoc, /^##\s*Today/i, 4);
  const analogues = section(histDoc, /analogue/i, 8);
  const planBias = section(planDoc, /bias|##\s*Plan|##\s*Daily/i, 8);
  const lessons = section(lessonsDoc, /^#{1,3}/i, 6);

  // compose the brief
  const L = (it: Inst) => it.levels.map(l => `${l.label} ${l.price.toFixed(l.price > 1000 ? 0 : 2)}`).join(" · ");
  const movers = insts.map(it => `**${it.sym}** ${it.last.toFixed(it.last > 1000 ? 0 : 2)} (${it.dayChg >= 0 ? "+" : ""}${(it.dayChg * 100).toFixed(2)}%)`).join(" · ");
  const md = `---
last_updated: "${today}"
updated_by: "morning-brief"
---

# 🌅 Morning Brief — ${today}

**Regime:** ${regimeLine} · ${movers}

## What the market did
${todayHist || "(chronicle not available — run scripts/market-chronicle.ts)"}

${analogues ? `## Days like today (historical analogues)\n${analogues}\n` : ""}
## Today's plan (AI advisor)
${planBias || "(no daily plan in vault yet — premarket cron writes Brain/daily-plan.md)"}

## Instruments & key levels
${insts.map(it => `### ${NAMES[it.sym] ?? it.sym}\n${L(it)}\n\n![[charts/${it.sym}-morning.svg]]`).join("\n\n")}

## Lessons to apply
${lessons || "(none)"}

---
*Generated by scripts/morning-brief.ts. Charts: dependency-free SVG from 16yr daily history. Context is for sizing/conviction — not standalone signals.*
`;

  // console preview
  const W = 92;
  console.log("\n" + "═".repeat(W));
  console.log(`  🌅 MORNING BRIEF — ${today}    Regime: ${regimeLine}`);
  console.log("═".repeat(W));
  console.log("  " + movers.replace(/\*\*/g, ""));
  for (const it of insts) console.log(`  ${it.sym.padEnd(3)} levels: ${L(it)}`);
  if (todayHist) console.log("  ──\n  " + todayHist.replace(/\n/g, "\n  "));
  console.log(`  charts → reports/charts/{${insts.map(i => i.sym).join(",")}}-morning.svg`);
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
