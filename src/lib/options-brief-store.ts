// THE BRIEF'S I/O SEAM (D8). `refreshOptionsBrief` gathers the desk's state with soft catches, builds and renders the brief,
// writes `options_desk_brief` and the vault's Brain/options-desk-brief.md, and pages the `options` Slack lane only when the
// ACTION or the best symbol changed since the last brief (`options_desk_brief_last`). Called by the research ingest after
// each run and by the 17:32 account collect (which re-renders with the fresh account snapshot). Read-only on the desk:
// nothing here can place, size or gate an order.
import { prisma } from "./db";
import { sendNotification } from "./notifications";
import { buildOptionsBrief, renderOptionsBrief, type OptionsBriefInput } from "./options-brief";
import { OPTIONS_RESEARCH_KEY, isOptionsResearch, type OptionsResearch } from "./options-desk-model";
import { readOptionsIvHistory } from "./options-evidence-store";
import { vixLevel } from "./options-market-state";
import { OPTIONS_MAX_LOSS_KEY, parseOptionsMaxLoss } from "./options-operation";
import { readAccountSnapshot } from "./options-quote-store";
import { ivRanksFor } from "./options-score-ledger";
import { vaultWrite } from "./vault";

export const OPTIONS_BRIEF_KEY = "options_desk_brief", OPTIONS_BRIEF_LAST_KEY = "options_desk_brief_last", OPTIONS_BRIEF_VAULT_PATH = "Brain/options-desk-brief.md";
export interface StoredOptionsBrief { at: string; source: "ingest" | "collect"; action: OptionsBriefInput["action"]; bestSymbol: string | null; text: string; brief: OptionsBriefInput }

async function ownedLegs(): Promise<{ symbol: string; kind: string; atRiskUsd: number }[]> {
  try {
    const rows = await prisma.$queryRawUnsafe<{ payload: { underlying?: string; kind?: string; entryPrice?: number; legs?: { quantity?: number }[] } }[]>(`SELECT payload FROM options_live_owned_positions`);
    return rows.flatMap((r) => (typeof r.payload.underlying === "string" && typeof r.payload.kind === "string"
      ? [{ symbol: r.payload.underlying, kind: r.payload.kind, atRiskUsd: (Number(r.payload.entryPrice ?? 0) * 100 + 2) * (r.payload.legs?.[0]?.quantity ?? 1) }] : []));
  } catch { return []; }   // the table appears on the desk's first run
}
export async function refreshOptionsBrief(source: StoredOptionsBrief["source"], now = Date.now()): Promise<StoredOptionsBrief> {
  const keys = [OPTIONS_RESEARCH_KEY, OPTIONS_MAX_LOSS_KEY, "options_live_armed", "options_live_integration_verified", "options_live_market_veto", "options_score_promoted", "options_live_equity_high", "options_live_verified_fee_reserve_usd", OPTIONS_BRIEF_LAST_KEY];
  const [rows, account, ivHistory, owned, vix] = await Promise.all([
    prisma.agentConfig.findMany({ where: { key: { in: keys } } }), readAccountSnapshot(), readOptionsIvHistory().catch(() => []), ownedLegs(), vixLevel(),
  ]);
  const c = Object.fromEntries(rows.map((r) => [r.key, r.value]));
  let research: OptionsResearch | null = null;
  try { const parsed = JSON.parse(c[OPTIONS_RESEARCH_KEY] ?? "null"); if (isOptionsResearch(parsed)) research = parsed; } catch { /* no research → the brief says so */ }
  const brief = buildOptionsBrief({
    research, equity: account?.totalValue ?? null, buyingPower: account?.buyingPower ?? null, accountAt: account?.at ?? null,
    ceiling: parseOptionsMaxLoss(c[OPTIONS_MAX_LOSS_KEY]), feeReserveUsd: parseOptionsMaxLoss(c.options_live_verified_fee_reserve_usd) ?? 2,
    promoted: c.options_score_promoted === "true", armed: c.options_live_armed === "true", verified: c.options_live_integration_verified === "true", vetoOn: c.options_live_market_veto !== "false",
    owned, equityHigh: c.options_live_equity_high ? Number(c.options_live_equity_high) || null : null, vix,
    ivRanks: research ? ivRanksFor(research, ivHistory) : {}, now,
  });
  const text = renderOptionsBrief(brief);
  const stored: StoredOptionsBrief = { at: brief.at, source, action: brief.action, bestSymbol: brief.best?.symbol ?? null, text, brief };
  const set = (key: string, value: string) => prisma.agentConfig.upsert({ where: { key }, update: { value }, create: { key, value } });
  await set(OPTIONS_BRIEF_KEY, JSON.stringify(stored));
  await vaultWrite(OPTIONS_BRIEF_VAULT_PATH, `---\nupdated: "${brief.at}"\nsource: "${source}"\naction: "${brief.action.action}"\n---\n\n# Options desk brief\n\n\`\`\`\n${text}\n\`\`\`\n`, "options-desk").catch(() => {});
  // Slack only on a change of ACTION or best symbol — the brief itself is on the page and in the vault.
  let last: { action?: string; bestSymbol?: string | null } = {};
  try { last = JSON.parse(c[OPTIONS_BRIEF_LAST_KEY] ?? "{}"); } catch { /* first brief */ }
  if (last.action !== brief.action.action || (last.bestSymbol ?? null) !== stored.bestSymbol) {
    await sendNotification(`📋 Options desk brief (${source}): ${brief.action.action}${stored.bestSymbol ? ` · best ${stored.bestSymbol}` : ""}\n${text}`, "options").catch(() => {});
    await set(OPTIONS_BRIEF_LAST_KEY, JSON.stringify({ action: brief.action.action, bestSymbol: stored.bestSymbol, at: brief.at }));
  }
  return stored;
}
export async function readOptionsBrief(): Promise<StoredOptionsBrief | null> {
  const row = await prisma.agentConfig.findUnique({ where: { key: OPTIONS_BRIEF_KEY } }).catch(() => null);
  try { return row?.value ? JSON.parse(row.value) as StoredOptionsBrief : null; } catch { return null; }
}
