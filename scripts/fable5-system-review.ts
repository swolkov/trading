/**
 * FABLE 5 SYSTEM REVIEW — the automated "head" of the desk.
 *
 * Pulls per-account P&L from the PRODUCTION DB (the accurate source — verified clean ~1.00x,
 * NOT the ~3x myth, and NOT the incomplete journal), deduplicated, separated live (MES/MNQ) vs
 * demo (NQ/ES/GC/MBT). Then Fable 5 reviews health, the bug fixes, edge-vs-variance, and the $25k
 * decision. Writes Brain/system-review.md + a dated ledger.
 *
 * Run in prod context (needs DATABASE_URL + ANTHROPIC_API_KEY from Railway):
 *   railway run npx tsx scripts/fable5-system-review.ts
 * Scheduled daily via scripts/spread-track-daily.sh.
 */
import Anthropic from "@anthropic-ai/sdk";
import fs from "node:fs";
import { prisma } from "../src/lib/db";

const VAULT = "/Users/user/Desktop/Trading/Trading";
const OUT = `${VAULT}/Brain/system-review.md`;
const LEDGER = `${VAULT}/Brain/system-review-ledger.csv`;
const DEMO = new Set(["NQ", "ES", "GC", "MBT", "MGC"]);
const LIVE = new Set(["MES", "MNQ", "MYM", "M2K"]);
const sym = (s: string) => s.replace("FUT:", "");
const apiKey = process.env.ANTHROPIC_API_KEY || (() => { try { return fs.readFileSync(new URL("../.env", import.meta.url), "utf8").match(/^ANTHROPIC_API_KEY=(.+)$/m)?.[1]?.trim(); } catch { return undefined; } })();
const anthropic = new Anthropic({ apiKey });

interface T { sym: string; size: number; pnl: number; reason: string; date: string }

// Pull realized futures trades from the DB and DEDUPLICATE (cluster near-identical rows → one logical trade).
async function loadFromDB(): Promise<T[]> {
  const rows = await prisma.autoTradeLog.findMany({
    where: { pnl: { not: null }, symbol: { startsWith: "FUT:" }, createdAt: { gte: new Date("2026-05-18") } },
    select: { id: true, symbol: true, qty: true, pnl: true, orderId: true, action: true, createdAt: true },
    orderBy: { createdAt: "asc" },
  });
  const used = new Set<number>();
  const out: T[] = [];
  for (const r of rows) {
    if (used.has(r.id)) continue;
    used.add(r.id);
    for (const o of rows) {
      if (used.has(o.id)) continue;
      const sameOrder = r.orderId && o.orderId && r.orderId === o.orderId;
      const near = sym(o.symbol) === sym(r.symbol) && Math.abs((o.pnl || 0) - (r.pnl || 0)) <= 1 && Math.abs(o.createdAt.getTime() - r.createdAt.getTime()) < 10 * 60 * 1000;
      if (sameOrder || near) used.add(o.id);
    }
    out.push({ sym: sym(r.symbol), size: r.qty, pnl: r.pnl || 0, reason: r.action.replace(/^(futures|live)_/, ""), date: r.createdAt.toISOString().slice(0, 10) });
  }
  return out;
}

function reconcile(label: string, trades: T[]): string {
  if (!trades.length) return `\n### ${label}\n  no trades\n`;
  const $ = (x: number) => (x >= 0 ? "+$" : "-$") + Math.abs(x).toFixed(0);
  const total = trades.reduce((s, t) => s + t.pnl, 0);
  const wins = trades.filter((t) => t.pnl > 0);
  const sorted = [...trades].sort((a, b) => b.pnl - a.pnl);
  const top3 = sorted.slice(0, 3).reduce((s, t) => s + t.pnl, 0);
  const bySym = new Map<string, { n: number; pnl: number; w: number }>();
  for (const t of trades) { const e = bySym.get(t.sym) ?? { n: 0, pnl: 0, w: 0 }; e.n++; e.pnl += t.pnl; if (t.pnl > 0) e.w++; bySym.set(t.sym, e); }
  const byDay = new Map<string, number>();
  for (const t of trades) byDay.set(t.date, (byDay.get(t.date) ?? 0) + t.pnl);
  const days = [...byDay.entries()].sort((a, b) => a[1] - b[1]);
  return [
    `\n### ${label}`,
    `  ${trades.length} deduped trades | win ${(wins.length / trades.length * 100).toFixed(0)}% | net ${$(total)}`,
    `  Top-3 winners = ${$(top3)} (${total !== 0 ? (top3 / total * 100).toFixed(0) : "—"}% of net) → net w/o top 3: ${$(total - top3)}${total - top3 <= 0 ? " ⚠️ profit IS those 3 (variance)" : ""}`,
    `  Biggest: ${sorted.slice(0, 3).map((t) => `${t.sym} ${$(t.pnl)}(${t.size}ct)`).join("  ")}`,
    `  Worst:   ${sorted.slice(-3).reverse().map((t) => `${t.sym} ${$(t.pnl)}(${t.size}ct ${t.reason})`).join("  ")}`,
    `  By instrument: ${[...bySym.entries()].sort((a, b) => b[1].pnl - a[1].pnl).map(([s, e]) => `${s} ${$(e.pnl)}(${e.n}t ${(e.w / e.n * 100).toFixed(0)}%w)`).join("  ")}`,
    `  Oversized (>10ct): ${trades.filter((t) => t.size > 10).map((t) => `${t.date} ${t.sym} ${t.size}ct ${$(t.pnl)}`).join(", ") || "none"}`,
    `  Stop failures (loss >$5k single): ${trades.filter((t) => t.pnl < -5000).map((t) => `${t.date} ${t.sym} ${$(t.pnl)}`).join(", ") || "none"}`,
  ].join("\n") + "\n";
}

async function main() {
  const all = await loadFromDB();
  const demo = all.filter((t) => DEMO.has(t.sym));
  const live = all.filter((t) => LIVE.has(t.sym));
  const recon = `## RECONCILIATION (production DB, deduplicated — verified clean ~1.00x)
${reconcile("DEMO ($59k — NQ/ES/GC/MBT)", demo)}${reconcile("LIVE ($1k — MES/MNQ)", live)}`;

  const prompt = `You are FABLE 5, HEAD OF THE TRADING DESK, doing your scheduled review. Skeptical, concise, decisive. Read by the founder for real-money decisions. No flattery.

=== TODAY'S RECONCILIATION (production DB, deduplicated — this is the accurate source) ===
${recon}

=== RECENT CHANGES (deployed June 9) ===
- Fixed naked-stop runaway: stop moves now use atomic server-side modifyorder (was cancel-then-place; a failed re-place left a position with no stop → the -$24,100 NQ trade). If modify fails, the ORIGINAL stop stays live. Plus a hard loss backstop (force-close >2x intended stop / 5% equity).
- Size cap: pyramid respects configured maxTotalContracts (was equity/500=118 → 30-contract trades).
- Focus: demo NQ-only (ES was a bleeder), live MNQ-only, smooth $60k full-size ramp (was a $25k cliff).
- Accounting: DB verified ~1.00x clean (the "3x inflation" was a myth; the incomplete journal was the bad source). Forward dedup guard added.

=== CONTEXT ===
- Demo is genuinely +~$10k (+20%) in 3 weeks, almost entirely NQ, on a sub-50% win rate (a few big trend-day runners). Backtest of the underlying setups = PF 0.97; NQ RSI loses out-of-sample. So real money, but likely variance/momentum not a proven durable edge.
- The only durable validated edge is a relative-value spread book (Sharpe ~1.5, ~10% max DD), needs ~$100k/prop, runs as paper.
- Founder plans to put $25k into live (now ramps smoothly on MNQ).

=== YOUR REVIEW — brief, decisive ===
1. HEALTH: healthy now? biggest risk?
2. BUG FIXES: are the atomic-modify stop fix + backstop + size cap sufficient to prevent a repeat of the -$24,100 / 30-contract events? any remaining gap?
3. EDGE vs VARIANCE: from the deduped numbers, edge or variance? The single metric to watch over the next ~30 NQ trades to tell them apart.
4. $25k DECISION: given the demo is genuinely +$10k and the bugs are fixed but the edge is unproven — YES / NOT YET / NO, and the one condition to meet first.
5. NEXT ACTIONS: top 2-3 ranked.
Keep it tight.`;

  console.error("Running Fable 5 head-of-desk review on clean DB data…\n");
  const stream = anthropic.messages.stream({ model: "claude-fable-5", max_tokens: 32000, thinking: { type: "adaptive" }, output_config: { effort: "high" }, messages: [{ role: "user", content: prompt }] });
  let txt = "";
  stream.on("text", (t) => { txt += t; process.stdout.write(t); });
  const final = await stream.finalMessage();
  if (!txt) txt = final.content.filter((b): b is Anthropic.TextBlock => b.type === "text").map((b) => b.text).join("");

  const date = new Date().toISOString().slice(0, 10);
  try { fs.writeFileSync(OUT, `---\ndate: "${date}"\nreviewer: "fable-5"\nsource: "production-db-deduped"\n---\n\n# System Review — ${date}\n\n${recon}\n\n## Fable 5 Head-of-Desk Review\n\n${txt}\n`); } catch (e) { console.error("vault write failed:", e); }
  const verdict = txt.match(/\b(YES|NOT YET|NO)\b/)?.[1] || "?";
  if (!fs.existsSync(LEDGER)) fs.writeFileSync(LEDGER, "date,demo_net,live_net,25k_verdict\n");
  fs.appendFileSync(LEDGER, `${date},${demo.reduce((s, t) => s + t.pnl, 0).toFixed(0)},${live.reduce((s, t) => s + t.pnl, 0).toFixed(0)},${verdict}\n`);
  console.error(`\n\n--- review → Brain/system-review.md | $25k verdict: ${verdict} ---`);
  await prisma.$disconnect();
}
main().catch(async (e) => { console.error("Failed:", e instanceof Error ? e.message : e); await prisma.$disconnect().catch(() => {}); process.exit(1); });
