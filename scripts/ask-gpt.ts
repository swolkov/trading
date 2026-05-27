/**
 * Second opinion — ask OpenAI to RED-TEAM our edge research and relay its verbatim answer.
 * Needs a real OPENAI_API_KEY in .env.local (platform.openai.com/api-keys). Auto-picks the best
 * available GPT model (so it works whatever the current naming is).
 *   npx tsx scripts/ask-gpt.ts                 send the built-in spread red-team brief
 *   npx tsx scripts/ask-gpt.ts "any question"  send a custom prompt
 *   GPT_MODEL=gpt-5.5 npx tsx scripts/ask-gpt.ts   force a specific model
 */
import fs from "node:fs";

function apiKey(): string {
  if (process.env.OPENAI_API_KEY) return process.env.OPENAI_API_KEY;
  try {
    const m = fs.readFileSync(new URL("../.env.local", import.meta.url), "utf8").match(/^OPENAI_API_KEY=(.+)$/m);
    return m ? m[1].trim().replace(/^["']|["']$/g, "") : "";
  } catch { return ""; }
}

const BRIEF = `I run a systematic futures strategy: relative-value spread (pairs) trading on CME futures —
crack spreads (CL/RB, CL/HO), grains (ZC/ZS, ZS/ZW), FX (6E/6B), metals (GC/HG). Entry on z-score
divergence of the spread (60-bar lookback, entry z=2, exit z=0, stop z=3.5, max hold 40 bars), trading
mean-reversion. Pairs were chosen by economic cointegration logic, not data-mined.

Validation on 3 years of 1-minute data, net of MEASURED transaction costs (~0.03R/trade from real
bid/ask): forward expectancy +0.43R/trade, Sharpe 1.59, positive in 14 of 14 rolling walk-forward
windows back to 2011, deflated Sharpe significant vs ~40 trials, survives 4x the measured cost.
Known weaknesses: gap-through-stop on ~38% of exits (fat left tail), worst trade -6.3R, max pairwise
correlation 0.55 in normal times, and one full-size spread margins at $1,200-$24,000 so it needs ~$100k+.

Red-team this hard. Where am I most likely fooling myself? What makes a backtested spread-reversion
strategy fail with real money that a clean walk-forward would NOT catch? What is the single most
likely reason this degrades live, and what one test would best falsify the edge before I fund it?`;

async function bestModel(headers: Record<string, string>, want: string): Promise<string> {
  try {
    const r = await fetch("https://api.openai.com/v1/models", { headers });
    if (!r.ok) return want;
    const ids = ((await r.json()).data as { id: string }[]).map(d => d.id);
    if (ids.includes(want)) return want;
    const cand = ids.filter(i => /^(gpt|o)\d/.test(i) || /^gpt-/.test(i)).filter(i => !/(audio|realtime|image|vision|tts|transcribe|embedding|moderation)/.test(i)).sort().reverse();
    return cand[0] || want;
  } catch { return want; }
}

async function main() {
  const key = apiKey();
  if (!key || key.includes("...") || /your[-_]?key/i.test(key) || !key.startsWith("sk-")) {
    console.error(`\n⛔ No REAL OpenAI key found in .env.local (got: ${key ? "a placeholder" : "nothing"}).\n` +
      `   Get one at https://platform.openai.com/api-keys, then add it (use your ACTUAL sk-... value):\n` +
      `     echo 'OPENAI_API_KEY=sk-REPLACE_WITH_REAL_KEY' >> .env.local\n` +
      `   then re-run:  npx tsx scripts/ask-gpt.ts\n`);
    process.exit(1);
  }
  const headers = { Authorization: `Bearer ${key}`, "Content-Type": "application/json" };
  const model = await bestModel(headers, process.env.GPT_MODEL || "gpt-5.5");
  const prompt = process.argv.slice(2).join(" ") || BRIEF;
  console.log(`\n  → asking ${model} to red-team the spread strategy...`);

  const res = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST", headers,
    body: JSON.stringify({ model, messages: [{ role: "user", content: prompt }] }),
  });
  if (!res.ok) {
    console.error(`\n⛔ OpenAI HTTP ${res.status}: ${(await res.text()).slice(0, 400)}\n`);
    process.exit(1);
  }
  const j = await res.json();
  const answer = j.choices?.[0]?.message?.content ?? JSON.stringify(j).slice(0, 600);
  console.log("\n" + "═".repeat(84));
  console.log(`  ${model.toUpperCase()} — RED-TEAM OF THE SPREAD STRATEGY`);
  console.log("═".repeat(84) + "\n");
  console.log(answer);
  console.log("\n" + "═".repeat(84) + "\n");
}
main().catch(e => { console.error(e); process.exit(1); });
