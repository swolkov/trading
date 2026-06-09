/**
 * Fable 5 system + self-capability audit.
 * Feeds the most capable model the VERIFIED ground truth of the trading system
 * and asks it to (1) audit honestly, (2) self-assess where Fable 5 is worth its
 * cost vs wasted, (3) rank next actions by expected value.
 *
 * Run: node_modules/.bin/tsx scripts/fable5-audit.ts
 */
import Anthropic from "@anthropic-ai/sdk";
import { readFileSync } from "fs";

// Load ANTHROPIC_API_KEY from .env without a dotenv dependency.
const apiKey =
  process.env.ANTHROPIC_API_KEY ||
  (readFileSync(".env", "utf8").match(/^ANTHROPIC_API_KEY=(.+)$/m)?.[1] || "").trim();
if (!apiKey) throw new Error("ANTHROPIC_API_KEY not found in env or .env");

const anthropic = new Anthropic({ apiKey });

const BRIEFING = `You are Fable 5 — the most capable model available — acting as an independent auditor of an automated futures trading system. Be brutally honest. Do NOT flatter. The owner wants the truth about where the edge is, what to stop doing, and where YOUR intelligence is worth $10/$50-per-MTok vs where it is wasted ceremony.

=== VERIFIED GROUND TRUTH (from backtests, live results, and code) ===

CAPITAL & ACCOUNTS:
- LIVE: ~$926 real money on Tradovate. Trades MES only (S&P micro). MNQ was removed after losing -$213. MES is +$148 lifetime.
- DEMO: $59K simulated account, 24/7 learning. Trades ES, NQ, GC, MBT. PF 1.26 overall BUT punctuated by ~30 catastrophic NQ blowups. Config: max 10 contracts/trade, 20 total, 120 trades/day, 7% risk/trade, 20% daily loss limit.

VALIDATED EDGES (the actual evidence base):
- Spread book (calendar/inter-product z-score): the ONLY fully validated edge. Needs $100k+ or a prop-firm account. Forward track record Sharpe ~1.59, ~$52k/$100k over 18mo. NOT runnable at $1K.
- GC gold RSI-bounce: real edge, PF 1.23 in 1yr backtest. Currently runs in legacy 5m intraday path, NOT yet in the strategy registry.
- MBT (micro Bitcoin) NR4 daily breakout: real edge, PF 1.71 at standard costs (1 tick + $2 comm), n=146, 53% WR, +$25/trade. Holds >1.0 even at 5x slippage. Needs ~$2.5K account for margin (runs demo-only today).
- ES/NQ on the 5m setup library: LOSE. PF ~0.98 break-even at best; the live engine historically traded the losing micros.
- Crypto on the 5m equity library: catastrophic (MET PF 0.06, BFF PF 0.27). Registry now routes crypto away from the 5m path.
- Pre-FOMC drift: REJECTED (decayed + concentrated).
- MSL, XRP, MET, BFF: all patterns tested LOSE. $1K has NO validated 24/7 tradeable edge.

AI STACK (current):
- Realtime engine (Railway, main): Sonnet 4.6 executor grades each setup. Native Advisor Tool (Opus 4.8) consulted mid-generation on live trades + ambiguous demo patterns.
- Fable 5 daily plan: generated premarket, xhigh effort. Produces bias, per-instrument priority/direction, preferred/avoid setups, riskAdjustment. UNTIL NOW it was injected only as text into the grading prompt — it did NOT deterministically control execution. We are now wiring it into sizing/stops/gating.
- Fable 5 escalation: second opinion on borderline A/B grades (cron engine path).
- The AI grader itself is UNVALIDATED. It vetoes ~75%-scoring setups at a ~72% threshold. We do not have evidence it improves P&L; it may just be suppressing trade count.

STRATEGY REGISTRY: only MBT NR4 is formally registered. GC RSI-bounce, equity-index RSI-bounce, spread-book z-score are identified but still live in ad-hoc 5m code or unbuilt.

GOAL: prove $1K works, then compound $1K -> $2.5K -> $5K -> $25K (ES) -> $50K, eventually a hedge fund (2/20, proprietary algo).

=== YOUR TASK ===

Produce a concise, ruthlessly prioritized audit. Use these sections:

1. VERDICT (3-4 sentences): Is this system net-positive expected value as it stands? What is the single biggest lie the system might be telling itself?

2. WHERE THE EDGE ACTUALLY IS: Rank what we should ACTUALLY be trading with real money, given the evidence. Be specific about instrument + account size.

3. STOP DOING: What is active ceremony, negative-EV activity, or unvalidated overlay that should be cut or quarantined behind an A/B test?

4. FABLE 5 SELF-ASSESSMENT — be honest about your own value:
   a. Where does my (Fable 5) intelligence genuinely add P&L per dollar of API cost? (rank the uses: daily plan, escalation, weekly synthesis, system audit, trade post-mortems, live grading, etc.)
   b. Where am I expensive ceremony that a cheaper model or a hard-coded rule would match?
   c. What CAN I do that this system is not currently using me for, that would move P&L? (Think: research/pattern-mining across full trade history, generating new strategy hypotheses to backtest, auditing the backtester itself for look-ahead bias, designing the A/B test that validates the AI grader, etc.)

5. NEXT 3 MOVES, ranked by expected value, each with: the action, why it matters, and roughly how to validate it worked.

Keep it tight and specific. No hedging filler. If something is unknowable from the briefing, say so and state what data would resolve it.`;

async function main() {
  console.error("Running Fable 5 audit (xhigh effort, streaming)…\n");
  const stream = anthropic.messages.stream({
    model: "claude-fable-5",
    max_tokens: 16000,
    thinking: { type: "adaptive" },
    output_config: { effort: "xhigh" },
    messages: [{ role: "user", content: BRIEFING }],
  });

  stream.on("text", (t) => process.stdout.write(t));
  const final = await stream.finalMessage();
  const u = final.usage;
  console.error(
    `\n\n--- usage: in ${u.input_tokens} / out ${u.output_tokens} tokens ---`,
  );
}

main().catch((e) => {
  console.error("Audit failed:", e instanceof Error ? e.message : e);
  process.exit(1);
});
