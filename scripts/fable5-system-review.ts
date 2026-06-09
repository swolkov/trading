/**
 * FABLE 5 SYSTEM REVIEW — the automated "head" that reviews the trading operation.
 *
 * Two jobs in one:
 *  1) CLEAN RECONCILIATION — rebuilds per-account P&L from the trade-level JOURNAL (the trustworthy
 *     source), not the ~3x-inflated DB sums or the contaminated balance curve. Separates live
 *     (MES/MNQ) from demo (NQ/ES/GC/MBT) by instrument, and surfaces concentration + worst days so
 *     edge-vs-variance is visible. Flags data-quality gaps rather than hiding them.
 *  2) FABLE 5 REVIEW — sends the clean briefing to Fable 5 for a skeptical, head-of-desk review:
 *     system health, are the bug fixes sound, is the NQ run edge or fading variance, risk, and a
 *     direct verdict on the $25k-live decision. Writes the review to the vault + a dated ledger.
 *
 * Run: node_modules/.bin/tsx scripts/fable5-system-review.ts
 * Scheduled daily via scripts/spread-track-daily.sh.
 */
import Anthropic from "@anthropic-ai/sdk";
import fs from "node:fs";

const VAULT = "/Users/user/Desktop/Trading/Trading";
const JOURNAL = `${VAULT}/Journal`;
const OUT = `${VAULT}/Brain/system-review.md`;
const LEDGER = `${VAULT}/Brain/system-review-ledger.csv`;
const DEMO = new Set(["NQ", "ES", "GC", "MBT", "MGC"]);
const LIVE = new Set(["MES", "MNQ", "MYM", "M2K"]);

const apiKey = process.env.ANTHROPIC_API_KEY || (fs.readFileSync(new URL("../.env", import.meta.url), "utf8").match(/^ANTHROPIC_API_KEY=(.+)$/m)?.[1] || "").trim();
if (!apiKey) throw new Error("ANTHROPIC_API_KEY not found");
const anthropic = new Anthropic({ apiKey });

interface T { sym: string; size: number; pnl: number; reason: string; date: string }

// Parse every FUT trade with a realized pnl out of the journal YAML blocks.
function parseJournal(): T[] {
  const out: T[] = [];
  for (const f of fs.readdirSync(JOURNAL).filter((f) => /^2026-\d\d-\d\d\.md$/.test(f))) {
    const blocks = fs.readFileSync(`${JOURNAL}/${f}`, "utf8").split(/### Trade /).slice(1);
    for (const b of blocks) {
      const inst = b.match(/instrument:\s*"FUT:([A-Z0-9]+)"/)?.[1];
      const pnlM = b.match(/pnl_dollars:\s*(-?[0-9.]+)/);
      if (!inst || !pnlM) continue;
      out.push({
        sym: inst,
        size: parseInt(b.match(/contracts_shares:\s*(\d+)/)?.[1] || "0"),
        pnl: parseFloat(pnlM[1]),
        reason: b.match(/exit_reason:\s*"([^"]*)"/)?.[1] || "",
        date: f.slice(0, 10),
      });
    }
  }
  return out;
}

function reconcile(label: string, trades: T[]): string {
  if (!trades.length) return `\n### ${label}\n  no journaled trades\n`;
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
  const lines = [
    `\n### ${label}`,
    `  ${trades.length} journaled trades | win ${(wins.length / trades.length * 100).toFixed(0)}% | net ${$(total)}`,
    `  Top-3 winners = ${$(top3)} (${total !== 0 ? (top3 / total * 100).toFixed(0) : "—"}% of net) → net w/o top 3: ${$(total - top3)}${total - top3 <= 0 ? " ⚠️ profit IS those 3 (variance)" : ""}`,
    `  Biggest: ${sorted.slice(0, 3).map((t) => `${t.sym} ${$(t.pnl)}(${t.size}ct)`).join("  ")}`,
    `  Worst:   ${sorted.slice(-3).reverse().map((t) => `${t.sym} ${$(t.pnl)}(${t.size}ct ${t.reason})`).join("  ")}`,
    `  By instrument: ${[...bySym.entries()].sort((a, b) => b[1].pnl - a[1].pnl).map(([s, e]) => `${s} ${$(e.pnl)}(${e.n}t ${(e.w / e.n * 100).toFixed(0)}%w)`).join("  ")}`,
    `  Worst day ${days[0][0]} ${$(days[0][1])} | best day ${days[days.length - 1][0]} ${$(days[days.length - 1][1])}`,
    `  Oversized (>10ct): ${trades.filter((t) => t.size > 10).map((t) => `${t.date} ${t.sym} ${t.size}ct ${$(t.pnl)}`).join(", ") || "none"}`,
    `  Stop failures (loss >$5k single trade): ${trades.filter((t) => t.pnl < -5000).map((t) => `${t.date} ${t.sym} ${$(t.pnl)} (${t.reason})`).join(", ") || "none"}`,
  ];
  return lines.join("\n") + "\n";
}

async function main() {
  const all = parseJournal();
  const demo = all.filter((t) => DEMO.has(t.sym));
  const live = all.filter((t) => LIVE.has(t.sym));
  const recon = `## CLEAN RECONCILIATION (from trade journal — not the ~3x-inflated DB or contaminated balance curve)
${reconcile("DEMO ($59k — NQ/ES/GC/MBT)", demo)}${reconcile("LIVE ($1k — MES/MNQ)", live)}
DATA CAVEATS: journal may miss some trades (agents don't always log every fill); DB pnl sums ~3x inflated; vault balance curve contaminated (live $926 bled into demo). This reconciliation is the most trustworthy view but treat absolute totals as indicative.`;

  const prompt = `You are FABLE 5, acting as the HEAD OF THE TRADING DESK doing your scheduled review of an automated futures operation. Be skeptical, concise, and decisive — this review is read by the founder to make real-money decisions. Do not flatter.

=== TODAY'S CLEAN RECONCILIATION ===
${recon}

=== RECENT CHANGES (deployed June 9, commit ec005b3) ===
- Fixed a naked-stop runaway bug: a stop-move used cancel-then-place; if the re-place failed the position was left with NO stop (caused a -$24,100 NQ trade that ran 120 pts past its ~$2,148 stop). FIX: hard loss backstop force-closes any position losing >2x its intended stop (or 5% equity post-breakeven) on reliable quotes.
- Fixed a size-cap bug: pyramiding used floor(equity/500)=118 contracts on the $59k account instead of the configured cap (8/10), causing 30-contract trades (-$6,900, -$5,250). FIX: pyramid now respects configured maxTotalContracts.
- Refocused instruments: demo trades NQ only (ES was a -$5,662 bleeder, GC/MBT flat); live trades MNQ only (micro Nasdaq mirroring demo's NQ at 1/10 size), auto-upgrading to NQ full-size at $25k equity.

=== CONTEXT (validated this session) ===
- NQ's profit comes from a few big trend-day runners on a <50% win rate (the +$20,253 and the ~$14.5k Friday). Backtest of the underlying setups = PF 0.97 (break-even-to-losing); NQ RSI loses out-of-sample. So NQ is likely variance/momentum, not a proven durable edge.
- The only durable validated edge is a relative-value spread book (Sharpe ~1.5, ~10% max drawdown) — needs ~$100k / a prop firm, runs separately as paper.
- Founder's plan: grow demo, then put $25k into live (which would auto-upgrade live to full-size NQ).

=== YOUR REVIEW — answer each, briefly and decisively ===
1. HEALTH: Is the operation healthy right now? Biggest current risk?
2. BUG FIXES: Are the two fixes (loss backstop at 2x intended risk; pyramid cap = configured max) actually sufficient to prevent a repeat of the -$24,100 and 30-contract events? Any gap or failure mode they miss?
3. EDGE vs VARIANCE: From the reconciliation, is NQ showing a repeatable edge or just variance? What single metric, watched over the next 2 weeks, would distinguish them?
4. $25k DECISION: Is the data clean enough and the system safe enough to justify the founder putting $25k into live now? YES / NOT YET / NO — and the one condition that must be met first.
5. NEXT ACTIONS: The top 2-3 things to do before next review, ranked.
Keep it tight. If the data is too thin/dirty to answer something, say so and name what's missing.`;

  console.error("Running Fable 5 head-of-desk review (xhigh, streaming)…\n");
  const stream = anthropic.messages.stream({ model: "claude-fable-5", max_tokens: 32000, thinking: { type: "adaptive" }, output_config: { effort: "high" }, messages: [{ role: "user", content: prompt }] });
  let txt = "";
  stream.on("text", (t) => { txt += t; process.stdout.write(t); });
  const final = await stream.finalMessage();
  if (!txt) txt = final.content.filter((b): b is Anthropic.TextBlock => b.type === "text").map((b) => b.text).join("");

  const date = new Date().toISOString().slice(0, 10);
  const doc = `---\ndate: "${date}"\nreviewer: "fable-5"\n---\n\n# System Review — ${date}\n\n${recon}\n\n## Fable 5 Head-of-Desk Review\n\n${txt}\n`;
  try { fs.writeFileSync(OUT, doc); } catch (e) { console.error("vault write failed:", e); }
  const verdict = txt.match(/(YES|NOT YET|NO)\b/)?.[1] || "?";
  if (!fs.existsSync(LEDGER)) fs.writeFileSync(LEDGER, "date,demo_net,live_net,25k_verdict\n");
  fs.appendFileSync(LEDGER, `${date},${demo.reduce((s, t) => s + t.pnl, 0).toFixed(0)},${live.reduce((s, t) => s + t.pnl, 0).toFixed(0)},${verdict}\n`);
  console.error(`\n\n--- review written to Brain/system-review.md | $25k verdict: ${verdict} | usage out ${final.usage.output_tokens} ---`);
}
main().catch((e) => { console.error("Failed:", e instanceof Error ? e.message : e); process.exit(1); });
