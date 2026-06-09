/**
 * Fable 5 backtester audit — feeds VERBATIM source of the MBT NR4 chain and asks
 * for a rigorous look-ahead / fill-bias audit. The output gates a real-money
 * decision (fund live to $2.5K to trade MBT NR4), so the bar is: does the edge
 * survive a CORRECTED backtest?
 *
 * Run: node_modules/.bin/tsx scripts/fable5-backtest-audit.ts
 */
import Anthropic from "@anthropic-ai/sdk";
import { readFileSync } from "fs";

const apiKey =
  process.env.ANTHROPIC_API_KEY ||
  (readFileSync(".env", "utf8").match(/^ANTHROPIC_API_KEY=(.+)$/m)?.[1] || "").trim();
if (!apiKey) throw new Error("ANTHROPIC_API_KEY not found");
const anthropic = new Anthropic({ apiKey });

const file = (p: string) => readFileSync(p, "utf8");

const PROMPT = `You are Fable 5 auditing a backtester for look-ahead and fill bias. The result gates a REAL-MONEY decision: whether to fund a live account to $2.5K and trade the "MBT NR4" Bitcoin-micro strategy as the sole live edge. Be skeptical and quantitative. Do not flatter. If the edge is fake, say so.

CONTEXT — three different Profit Factor (PF) numbers exist for this same strategy in the codebase, and they need reconciling:
- 2.03 (strategy file header, attributed to edge-scan-crypto-deep.ts, 4yr)
- 1.71 (a prior run of the slippage sweep at "standard" 1 tick + $2 commission)
- 0.84 (a 1yr backtest comment in the registry)

The human auditor has already read the code and flagged these PRIOR SUSPICIONS — confirm, refute, or refine each, and find anything they missed:
(S1) The slippage-sweep exit loop walks 1m bars from the session OPEN (dayStart), not from the entry moment — so a stop/target that printed BEFORE price broke nr4.h is counted as the trade outcome (sequencing look-ahead).
(S2) Entry is confirmed using the COMPLETED daily bar's high/low (today.h/today.l). A gap-open above nr4.h would book a fill at nr4.h that never existed.
(S3) The slippage sweep enters at exactly nr4.h (optimistic limit), while the deep edge-scan enters at next-day OPEN + 1 tick (realistic). The LIVE strategy copies the optimistic nr4.h entry. So the validated PF and the live behavior may not match.
(S4) Live/backtest divergence: backtest daily bars are CME-session (Databento ohlcv-1d, ~5pm ET boundary); the live buildTodayDailyBar cuts the day at UTC midnight. Different day boundaries → different NR4 anchors.

YOUR DELIVERABLE:
1. For each suspicion S1–S4: CONFIRMED / PARTIAL / REFUTED, with the specific line/mechanism and the DIRECTION + rough MAGNITUDE of PF distortion it causes.
2. Any additional look-ahead, survivorship, or fill-realism bugs the human missed.
3. Reconcile the 2.03 / 1.71 / 0.84 discrepancy — which number, if any, is trustworthy, and what is your best estimate of the TRUE cost-and-bias-corrected PF and its confidence interval given n≈136 and "4 of 5 years positive"?
4. VERDICT: Is MBT NR4 a real edge worth $2.5K of real money? One of: TRADE IT / FIX-AND-RE-TEST FIRST / DEAD. Justify in 3 sentences. If FIX-AND-RE-TEST, list the exact code corrections required before the re-run is trustworthy.

=== FILE: src/lib/strategies/mbt-nr4-daily.ts (LIVE strategy) ===
${file("src/lib/strategies/mbt-nr4-daily.ts")}

=== FILE: src/lib/strategy-runner.ts (LIVE execution adapter) ===
${file("src/lib/strategy-runner.ts")}

=== FILE: scripts/backtest-crypto-slippage-sweep.ts (the "PF holds at 5x slippage" validation) ===
${file("scripts/backtest-crypto-slippage-sweep.ts")}

=== FILE: scripts/edge-scan-crypto-deep.ts (the PF 2.03 source of record) ===
${file("scripts/edge-scan-crypto-deep.ts")}`;

async function main() {
  console.error("Running Fable 5 backtester audit (xhigh, streaming)…\n");
  const stream = anthropic.messages.stream({
    model: "claude-fable-5",
    max_tokens: 32000,
    thinking: { type: "adaptive" },
    output_config: { effort: "high" },
    messages: [{ role: "user", content: PROMPT }],
  });
  let streamed = "";
  stream.on("text", (t) => { streamed += t; process.stdout.write(t); });
  const final = await stream.finalMessage();
  if (!streamed) {
    // Nothing streamed via text events — print text blocks from the final message directly.
    const txt = final.content.filter((b): b is Anthropic.TextBlock => b.type === "text").map((b) => b.text).join("");
    process.stdout.write(txt || "[no text content returned]\n");
  }
  console.error(`\n\n--- usage: in ${final.usage.input_tokens} / out ${final.usage.output_tokens} | stop: ${final.stop_reason} ---`);
}
main().catch((e) => { console.error("Failed:", e instanceof Error ? e.message : e); process.exit(1); });
