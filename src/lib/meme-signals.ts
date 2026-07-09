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
async function smartWallets(): Promise<string[]> {
  try { const r = await prisma.agentConfig.findUnique({ where: { key: "meme_smart_wallets" } }); return (r?.value || "").split(",").map((s) => s.trim()).filter(Boolean); }
  catch { return []; }
}
// Proxy signal: do any tracked "smart" wallets currently hold this mint? Needs HELIUS_API_KEY + a curated
// wallet list. Curating genuinely-skilled wallets is the hard part — seed via meme_smart_wallets config.
export async function checkSmartMoney(mint: string): Promise<SmartMoney> {
  const key = process.env.HELIUS_API_KEY;
  const wallets = await smartWallets();
  if (!key || wallets.length === 0 || !mint) return { active: false, count: 0, hits: [] };
  const hits: string[] = [];
  for (const w of wallets.slice(0, 20)) {
    try {
      const r = await fetch(`https://api.helius.xyz/v0/addresses/${w}/balances?api-key=${key}`, { signal: AbortSignal.timeout(8000) });
      if (!r.ok) continue;
      const d = await r.json();
      if ((d.tokens || []).some((t: { mint?: string; amount?: number }) => t.mint === mint && (t.amount || 0) > 0)) hits.push(w);
    } catch { /* skip wallet */ }
  }
  return { active: true, count: hits.length, hits };
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
