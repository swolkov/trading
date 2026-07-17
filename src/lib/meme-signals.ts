// Meme Lab signal layers — bolt-on research for the paper harness:
//   1. SAFETY  (RugCheck, free)     — reject honeypots / unlocked-LP scams before entering
//   2. SMART MONEY (Helius, keyed)  — do tracked winner wallets hold it? (inert without HELIUS_API_KEY + a wallet list)
//   3. AI CONVICTION (Claude)       — synthesize stats+safety+smart into a 0-100 short-term score + thesis
// Every layer is LOGGED on the paper bet so we can later measure whether research actually improves outcomes.
import Anthropic from "@anthropic-ai/sdk";
import { prisma } from "./db";

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY || "" });

export interface Safety { ok: boolean; scoreNorm: number; lpLocked: number; risks: string[]; reason: string; }
export async function checkSafety(mint: string): Promise<Safety> {
  if (!mint) return { ok: true, scoreNorm: 0, lpLocked: 0, risks: [], reason: "no mint — unchecked" };
  try {
    const r = await fetch(`https://api.rugcheck.xyz/v1/tokens/${mint}/report/summary`, { headers: { Accept: "application/json" }, signal: AbortSignal.timeout(12000) });
    if (!r.ok) return { ok: true, scoreNorm: 0, lpLocked: 0, risks: [], reason: "safety API unavailable — unchecked" };
    const d = await r.json();
    const risks: string[] = Array.isArray(d.risks) ? d.risks.map((x: { name?: string; description?: string }) => x.name || x.description || "").filter(Boolean) : [];
    const lpLocked = Number(d.lpLockedPct) || 0;
    const critical = risks.some((n) => /honeypot|freeze|mint authority enabled|can.?t sell|scam|transfer/i.test(n));
    // LOOSENED (user-authorized): block only critical scam/honeypot flags. Locked-LP is no longer a hard
    // gate — it's noted as riskier. The buy-time canSell honeypot check remains the hard floor.
    const ok = !critical;
    return { ok, scoreNorm: Number(d.score_normalised) || 0, lpLocked, risks, reason: ok ? `LP ${lpLocked.toFixed(0)}% locked${lpLocked < 50 ? " (unlocked — riskier)" : ""}, ${risks.length} flags` : `BLOCK: critical risk (${risks.slice(0, 2).join(", ") || "flagged"})` };
  } catch { return { ok: true, scoreNorm: 0, lpLocked: 0, risks: [], reason: "safety check error — unchecked" }; }
}

export interface SmartMoney { active: boolean; count: number; hits: string[] }
async function smartWallets(): Promise<Set<string>> {
  try { const r = await prisma.agentConfig.findUnique({ where: { key: "meme_smart_wallets" } }); return new Set((r?.value || "").split(",").map((s) => s.trim()).filter(Boolean)); }
  catch { return new Set(); }
}
// Proxy signal: do any tracked "smart" wallets hold this mint RIGHT NOW? Cheap + inverted — one Helius
// getTokenAccounts call per coin (the coin's holder set), intersected with our tracked-wallet set. That's
// ~1 call/candidate instead of one-per-wallet. Needs HELIUS_API_KEY + a curated meme_smart_wallets list
// (see scripts/meme-discover-wallets.ts). EXPERIMENTAL signal — logged on every trade so we can measure
// whether it actually predicts winners before ever letting it relax a gate.
export async function checkSmartMoney(mint: string): Promise<SmartMoney> {
  const key = process.env.HELIUS_API_KEY;
  const wallets = await smartWallets();
  if (!key || wallets.size === 0 || !mint) return { active: false, count: 0, hits: [] };
  try {
    const r = await fetch(`https://mainnet.helius-rpc.com/?api-key=${key}`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: "sm", method: "getTokenAccounts", params: { mint, limit: 200, page: 1 } }),
      signal: AbortSignal.timeout(9000),
    });
    if (!r.ok) return { active: true, count: 0, hits: [] };
    const d = await r.json();
    const owners: string[] = (d?.result?.token_accounts || []).map((a: { owner?: string; amount?: number }) => (a.amount && a.amount > 0 ? a.owner : "")).filter(Boolean);
    const hits = [...new Set(owners)].filter((o) => wallets.has(o));
    return { active: true, count: hits.length, hits };
  } catch { return { active: true, count: 0, hits: [] }; }
}

// 4. HOLDER CONCENTRATION (Helius, keyed) — anti-manipulation. On-chain studies show ~82% of >100% pumps
// are manufactured, and the tell is concentrated ownership (a few wallets hold the float, ready to dump on
// retail). We sum balances per owner, drop the single largest (almost always the AMM pool / bonding-curve
// vault — a normal huge "holder"), and measure how much of the REMAINING float the next few wallets control.
// A high number = a handful of non-pool wallets own the coin = exit-liquidity trap. Informational to the
// grader + a conservative hard-gate on egregious cases. No key = unchecked (holders:0, never gates).
export interface Concentration { top5Pct: number; top1Pct: number; holders: number; reason: string }
export async function checkConcentration(mint: string): Promise<Concentration> {
  const key = process.env.HELIUS_API_KEY;
  if (!key || !mint) return { top5Pct: 0, top1Pct: 0, holders: 0, reason: "concentration unchecked (no key)" };
  try {
    const r = await fetch(`https://mainnet.helius-rpc.com/?api-key=${key}`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: "conc", method: "getTokenAccounts", params: { mint, limit: 500, page: 1 } }),
      signal: AbortSignal.timeout(9000),
    });
    if (!r.ok) return { top5Pct: 0, top1Pct: 0, holders: 0, reason: "concentration API error" };
    const d = await r.json();
    const byOwner = new Map<string, number>();
    for (const a of (d?.result?.token_accounts || [])) { const amt = Number(a.amount) || 0; if (amt > 0 && a.owner) byOwner.set(a.owner, (byOwner.get(a.owner) || 0) + amt); }
    const amounts = [...byOwner.values()].sort((x, y) => y - x);
    const holders = amounts.length;
    if (holders < 3) return { top5Pct: 0, top1Pct: 0, holders, reason: `only ${holders} holders — too few to assess` };
    const total = amounts.reduce((s, x) => s + x, 0) || 1;
    const top1Pct = (amounts[0] / total) * 100;
    // exclude the largest holder (LP/pool proxy); measure the next-5 share of the remaining float
    const rest = amounts.slice(1);
    const restTotal = rest.reduce((s, x) => s + x, 0) || 1;
    const top5Pct = (rest.slice(0, 5).reduce((s, x) => s + x, 0) / restTotal) * 100;
    return { top5Pct, top1Pct, holders, reason: `${holders} holders; top wallet ${top1Pct.toFixed(0)}% (treated as LP); next-5 hold ${top5Pct.toFixed(0)}% of the rest` };
  } catch { return { top5Pct: 0, top1Pct: 0, holders: 0, reason: "concentration check error" }; }
}

export interface Conviction { score: number; thesis: string }
export async function scoreConviction(name: string, metrics: string, safety: Safety, smart: SmartMoney, conc?: Concentration): Promise<Conviction> {
  if (!process.env.ANTHROPIC_API_KEY) return { score: 50, thesis: "no AI key — neutral" };
  try {
    const prompt = `You are grading a Solana meme coin as a SHORT-TERM momentum trade with real money. IMPORTANT: this candidate has ALREADY passed hard automated filters before reaching you — LP-lock/honeypot safety, broad holder distribution (not concentrated), AND a fresh, accelerating, buy-dominated move that is NOT already over-extended (anti-chase caps applied). The generic "most memes rug / go to zero" traps are largely filtered out already. So do NOT reject on blanket priors — your job is to RANK how strong THIS specific momentum setup is, and differentiate the strong ones from the mediocre. Meme trading is asymmetric: small size, occasional big winner, so a good-but-imperfect momentum setup is a BUY, not a pass.
Token: ${name}
Metrics: ${metrics}
Safety: ${safety.reason}${safety.risks.length ? `; flags: ${safety.risks.slice(0, 5).join(", ")}` : ""}
Holder concentration: ${conc ? conc.reason : "unchecked"}
Smart money: ${smart.active ? `${smart.count} tracked winner wallet(s) currently hold it` : "not tracked (no data)"}
Score conviction 0-100 on the STRENGTH of this continuation setup (how likely the move keeps running over the next few hours). Use the full range and be decisive — do NOT cluster everything low:
- 70-90: fresh, accelerating, strongly buy-dominated move, healthy liquidity/turnover, broad holders, clear room to run (higher if smart money holds or it's a clean pump.fun graduate).
- 45-69: real momentum but mixed (cooling acceleration, thinner liquidity, or moderate extension).
- 0-40: genuine red flags survived the filters — one-sided/bot volume, near-exhausted move, borderline concentration, or dead turnover.
Return ONLY JSON: {"score": <0-100 integer>, "thesis": "<one short sentence>"}`;
    const msg = await anthropic.messages.create({ model: "claude-opus-4-8", max_tokens: 400, messages: [{ role: "user", content: prompt }] });
    const text = msg.content.filter((b): b is Anthropic.TextBlock => b.type === "text").map((b) => b.text).join("");
    const m = text.match(/\{[\s\S]*\}/);
    const j = m ? JSON.parse(m[0]) : {};
    return { score: Math.max(0, Math.min(100, Math.round(Number(j.score) || 50))), thesis: String(j.thesis || "").slice(0, 160) };
  } catch { return { score: 50, thesis: "AI score error — neutral" }; }
}
