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

export interface Conviction { score: number; thesis: string }
export async function scoreConviction(name: string, metrics: string, safety: Safety, smart: SmartMoney): Promise<Conviction> {
  if (!process.env.ANTHROPIC_API_KEY) return { score: 50, thesis: "no AI key — neutral" };
  try {
    const prompt = `You are grading a Solana meme coin as a SHORT-TERM momentum PAPER trade (not an investment). Be skeptical — ~99% of these go to zero, most pumps are bots, and by the time it's visible the early money is often already out.
Token: ${name}
Metrics: ${metrics}
Safety: ${safety.reason}${safety.risks.length ? `; flags: ${safety.risks.slice(0, 5).join(", ")}` : ""}
Smart money: ${smart.active ? `${smart.count} tracked winner wallet(s) currently hold it` : "not tracked (no data)"}
Score conviction that this keeps rising over the next few hours. Low score for bot-only pumps, thin liquidity, already-extended moves, or rug signs.
Return ONLY JSON: {"score": <0-100 integer>, "thesis": "<one short sentence>"}`;
    const msg = await anthropic.messages.create({ model: "claude-sonnet-4-6", max_tokens: 300, messages: [{ role: "user", content: prompt }] });
    const text = msg.content.filter((b): b is Anthropic.TextBlock => b.type === "text").map((b) => b.text).join("");
    const m = text.match(/\{[\s\S]*\}/);
    const j = m ? JSON.parse(m[0]) : {};
    return { score: Math.max(0, Math.min(100, Math.round(Number(j.score) || 50))), thesis: String(j.thesis || "").slice(0, 160) };
  } catch { return { score: 50, thesis: "AI score error — neutral" }; }
}
