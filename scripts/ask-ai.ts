/**
 * Second opinion from the AI we ALREADY have: Anthropic/Claude (the engine's grader key).
 * No OpenAI key exists locally, so this uses ANTHROPIC_API_KEY to RED-TEAM our edge research and
 * relay the answer verbatim. NOTE: Claude is the same family as the assistant — a fresh, un-anchored
 * independent pass, not a rival vendor. For a true GPT view, add OPENAI_API_KEY and use ask-gpt.ts.
 *   npx tsx scripts/ask-ai.ts                 send the spread red-team brief
 *   npx tsx scripts/ask-ai.ts "question"      custom prompt
 */
import fs from "node:fs";

function apiKey(): string {
  if (process.env.ANTHROPIC_API_KEY) return process.env.ANTHROPIC_API_KEY;
  for (const f of [".env.local", ".env", ".env.vercel"]) {
    try {
      const m = fs.readFileSync(new URL(`../${f}`, import.meta.url), "utf8").match(/^ANTHROPIC_API_KEY=(.+)$/m);
      if (m) return m[1].trim().replace(/^["']|["']$/g, "");
    } catch { /* next file */ }
  }
  return "";
}

const BRIEF = `You are a skeptical quant risk reviewer. RED-TEAM this strategy hard — do NOT be agreeable.

A systematic relative-value spread (pairs) strategy on CME futures: crack spreads (CL/RB, CL/HO),
grains (ZC/ZS, ZS/ZW), FX (6E/6B), metals (GC/HG). Entry on z-score divergence of the spread
(60-bar lookback, entry z=2, exit z=0, stop z=3.5, max hold 40 bars), trading mean-reversion. Pairs
chosen by economic cointegration logic, not data-mined.

Validation on 3 years of 1-minute data, net of MEASURED transaction costs (~0.03R/trade from real
bid/ask): forward expectancy +0.43R/trade, Sharpe 1.59, positive in 14 of 14 rolling walk-forward
windows back to 2011, deflated Sharpe significant vs ~40 trials, survives 4x measured cost. Known
weaknesses: gap-through-stop on ~38% of exits (fat left tail), worst trade -6.3R, max pairwise
correlation 0.55 in normal regimes, one full-size spread margins at $1,200-$24,000 (needs ~$100k+).

Answer concisely: (1) the single most likely reason this degrades with real money that a clean
walk-forward would NOT catch; (2) the 3 biggest ways I'm probably fooling myself; (3) the ONE test
that would best falsify the edge before funding it.`;

async function ask(key: string, model: string, prompt: string) {
  return fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "x-api-key": key, "anthropic-version": "2023-06-01", "content-type": "application/json" },
    body: JSON.stringify({ model, max_tokens: 1500, messages: [{ role: "user", content: prompt }] }),
  });
}

async function main() {
  const key = apiKey();
  if (!key || !key.startsWith("sk-ant")) {
    console.error("\n⛔ No ANTHROPIC_API_KEY found in env files.\n"); process.exit(1);
  }
  const prompt = process.argv.slice(2).join(" ") || BRIEF;
  const models = [process.env.AI_MODEL || "claude-opus-4-7", "claude-sonnet-4-6", "claude-3-5-sonnet-latest"];
  let res: Response | undefined, used = "";
  for (const m of models) { res = await ask(key, m, prompt); used = m; if (res.ok) break; }
  if (!res || !res.ok) { console.error(`\n⛔ Anthropic HTTP ${res?.status}: ${res ? (await res.text()).slice(0, 400) : "no response"}\n`); process.exit(1); }
  const j = await res.json();
  const text = (j.content as { text?: string }[] | undefined)?.map(c => c.text ?? "").join("") || JSON.stringify(j).slice(0, 600);
  console.log("\n" + "═".repeat(84));
  console.log(`  ${used} (Anthropic, fresh context) — RED-TEAM OF THE SPREAD STRATEGY`);
  console.log("═".repeat(84) + "\n");
  console.log(text);
  console.log("\n" + "═".repeat(84) + "\n");
}
main().catch(e => { console.error(e); process.exit(1); });
