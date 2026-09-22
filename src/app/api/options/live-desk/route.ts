import { prisma } from "@/lib/db";
import { OPTIONS_MAX_LOSS_KEY, parseOptionsMaxLoss } from "@/lib/options-operation";
import { OPTIONS_LIVE_RULES } from "@/lib/options-live-guardian";
import { OPTIONS_LADDER, OPTIONS_LADDER_RULES, clusterOf } from "@/lib/options-risk-ladder";
import { OPTIONS_RESEARCH_KEY, isOptionsResearch } from "@/lib/options-desk-model";
import { unmatchedQuoteCount } from "@/lib/options-research-ingest";
import { sendNotification } from "@/lib/notifications";
import { optionsScoreReport } from "@/lib/options-score-report";

// THE OPTIONS LIVE DESK's admin surface. GET = what the desk on the Mac last reported (it writes
// options_live_state every tick), the switches, the probe result and the log tail. POST = the
// ARM / DISARM switch. Arming is a typed ceremony like the Kraken desk; disarming is one click.
// The runner reads options_live_armed on every tick, so a disarm takes effect within 5 minutes
// and never touches an open position — the guardian keeps managing it.
// ARM sets options_live_max_loss_usd to the ladder's CEILING (Sep 15 2026): $150, or $225 once the
// score is promoted. Per trade the runner sizes by grade under it — Normal $100 / Strong $150 /
// A+ $225 (or 6.7 / 10 / 15% of equity) × the drawdown tier — and hands the core that cap.
export const dynamic = "force-dynamic";
const PROMOTED_KEY = "options_score_promoted", DD_TIER_KEY = "options_live_dd_tier";
const KEYS = ["options_live_armed", "options_live_integration_verified", "options_live_guardian_ok_at", "options_live_verified_fee_reserve_usd", OPTIONS_MAX_LOSS_KEY,
  "options_live_state", "options_live_probe", "options_live_log", "options_live_equity_high", "options_live_arm_log", OPTIONS_RESEARCH_KEY, PROMOTED_KEY, DD_TIER_KEY];
const DEFAULT_FEE_RESERVE_USD = 2;   // regulatory fees on one contract round trip are cents; $2 is a generous ceiling inside the cap (scaled by contracts in the core)
const ceilingFor = (promoted: boolean) => (promoted ? OPTIONS_LADDER["A+"].usd : OPTIONS_LADDER.Strong.usd);

async function view() {
  const rows = await prisma.agentConfig.findMany({ where: { key: { in: KEYS } } });
  const c = Object.fromEntries(rows.map((r) => [r.key, r.value]));
  const parse = (k: string) => { try { return c[k] ? JSON.parse(c[k]) : null; } catch { return null; } };
  // What the entry tick will screen: the merged research snapshot (all slices), with the last run's unmatched-quote count.
  const research = parse(OPTIONS_RESEARCH_KEY);
  const researchLine = isOptionsResearch(research)
    ? { capturedAt: research.capturedAt, symbols: Object.keys(research.bars).length, contracts: research.contracts.length, unmatchedQuotes: unmatchedQuoteCount(research.errors), errors: research.errors.length }
    : null;
  const guardianAt = c.options_live_guardian_ok_at ?? null;
  const guardianAge = guardianAt ? Date.now() - Date.parse(guardianAt) : null;
  let intents: { refId: string; action: string; state: string; orderId: string | null; updatedAt: string }[] = [];
  let owned: Record<string, unknown>[] = [];
  try {
    intents = (await prisma.$queryRawUnsafe<{ ref_id: string; action: string; state: string; order_id: string | null; updated_at: Date }[]>(
      `SELECT ref_id, action, state, payload->'order'->>'id' AS order_id, updated_at FROM options_live_intents ORDER BY updated_at DESC LIMIT 20`))
      .map((r) => ({ refId: r.ref_id, action: r.action, state: r.state, orderId: r.order_id, updatedAt: r.updated_at.toISOString() }));
    owned = (await prisma.$queryRawUnsafe<{ payload: Record<string, unknown> }[]>(`SELECT payload FROM options_live_owned_positions ORDER BY updated_at`))
      .map((r) => ({ ...r.payload, cluster: typeof r.payload.underlying === "string" ? clusterOf(r.payload.underlying) : null }));
  } catch { /* tables appear on the desk's first run */ }
  const promoted = c[PROMOTED_KEY] === "true";
  return {
    at: new Date().toISOString(),
    armed: c.options_live_armed === "true",
    verified: c.options_live_integration_verified === "true",
    maxLossUsd: parseOptionsMaxLoss(c[OPTIONS_MAX_LOSS_KEY]),
    ladder: { rungs: OPTIONS_LADDER, promoted, ceilingOnArm: ceilingFor(promoted), reserveMaxFrac: OPTIONS_LADDER_RULES.reserveMaxFrac, defaultSlots: OPTIONS_LADDER_RULES.defaultSlots, ddHaltFloorUsd: OPTIONS_LADDER_RULES.ddHaltFloorUsd, ddHaltPct: OPTIONS_LADDER_RULES.ddHaltPct, maxSlots: OPTIONS_LADDER_RULES.maxSlots, ddTierPcts: OPTIONS_LADDER_RULES.ddTierPcts, ddTierMults: OPTIONS_LADDER_RULES.ddTierMults, slotUnlockClosedTrades: OPTIONS_LADDER_RULES.slotUnlockClosedTrades },
    ddTier: parse(DD_TIER_KEY),
    feeReserveUsd: parseOptionsMaxLoss(c.options_live_verified_fee_reserve_usd),
    guardian: { at: guardianAt, fresh: guardianAge != null && guardianAge < 10 * 60_000 },
    rules: OPTIONS_LIVE_RULES,
    state: parse("options_live_state"), probe: parse("options_live_probe"),
    log: (parse("options_live_log") as string[] | null ?? []).slice(-40),
    armLog: (parse("options_live_arm_log") as string[] | null ?? []).slice(-10),
    equityHigh: c.options_live_equity_high ? Number(c.options_live_equity_high) : null,
    research: researchLine, intents, owned,
  };
}
export async function GET() { return Response.json(await view()); }

export async function POST(request: Request) {
  let body: { action?: string; confirm?: string } = {};
  try { body = await request.json(); } catch { /* empty */ }
  const set = (key: string, value: string) => prisma.agentConfig.upsert({ where: { key }, update: { value }, create: { key, value } });
  const log = async (line: string) => {
    const prior: string[] = await prisma.agentConfig.findUnique({ where: { key: "options_live_arm_log" } }).then((r) => (r?.value ? JSON.parse(r.value) : [])).catch(() => []);
    await set("options_live_arm_log", JSON.stringify([...prior, `${new Date().toISOString()} ${line}`].slice(-50)));
  };
  if (body.action === "disarm") {
    await set("options_live_armed", "false");
    await log("DISARMED from the admin page — no new entries; open positions stay under the guardian");
    await sendNotification("🟡 Options live desk DISARMED from the admin page. No new entries; the guardian keeps managing anything open.", "options").catch(() => {});
    return Response.json({ ok: true, ...(await view()) });
  }
  if (body.action === "arm") {
    if (body.confirm !== "ARM") return Response.json({ ok: false, error: "type ARM to confirm" }, { status: 400 });
    const promoted = (await prisma.agentConfig.findUnique({ where: { key: PROMOTED_KEY } }))?.value === "true";
    const ceiling = ceilingFor(promoted);
    // Sanity on the promoted ceiling: $225 is the A+ rung's dollar floor, never more than 15% of the last account snapshot.
    if (promoted) {
      const acct = await prisma.agentConfig.findUnique({ where: { key: "options_account_snapshot" } }).then((r) => (r?.value ? JSON.parse(r.value) as { totalValue?: number } : null)).catch(() => null);
      const equity = typeof acct?.totalValue === "number" && acct.totalValue > 0 ? acct.totalValue : null;
      if (equity == null || ceiling > OPTIONS_LADDER["A+"].pct * equity) return Response.json({ ok: false, error: `score is promoted but the $${ceiling} ceiling exceeds ${OPTIONS_LADDER["A+"].pct * 100}% of the last account value (${equity == null ? "no account snapshot on file" : `$${equity.toFixed(0)}`}) — not armed` }, { status: 409 });
    }
    await set(OPTIONS_MAX_LOSS_KEY, String(ceiling));
    const fee = parseOptionsMaxLoss((await prisma.agentConfig.findUnique({ where: { key: "options_live_verified_fee_reserve_usd" } }))?.value);
    if (!fee) await set("options_live_verified_fee_reserve_usd", String(DEFAULT_FEE_RESERVE_USD));
    await set("options_live_armed", "true");
    const L = OPTIONS_LADDER;
    await log(`ARMED from the admin page: ceiling $${ceiling}; per trade by grade Normal $${L.Normal.usd} / Strong $${L.Strong.usd} / A+ ${promoted ? `$${L["A+"].usd}` : "locked"}; × drawdown tier (fee reserve $${fee ?? DEFAULT_FEE_RESERVE_USD} per contract, ${OPTIONS_LADDER_RULES.defaultSlots} slots (throttled to 1 if the divergence check is red after ${OPTIONS_LADDER_RULES.slotUnlockClosedTrades} closed live trades), ${OPTIONS_LIVE_RULES.maxEntriesPerDay}/day, no name twice a day, debit structures only, stop ${OPTIONS_LIVE_RULES.premiumStopFrac * 100}% / trail from ${OPTIONS_LIVE_RULES.trailArmMult}x keeping ${OPTIONS_LIVE_RULES.trailLockFrac * 100}% of the best gain / out ${OPTIONS_LIVE_RULES.exitBeforeDte}d before expiry, halt at the larger of $${OPTIONS_LIVE_RULES.drawdownHaltUsd} and ${OPTIONS_LADDER_RULES.ddHaltPct * 100}% under the high)`);
    await sendNotification(`🔴 Options live desk ARMED from the admin page: real money, ceiling $${ceiling} per trade including fees — Normal $${L.Normal.usd} / Strong $${L.Strong.usd} / A+ ${promoted ? `$${L["A+"].usd}` : "locked"} by grade, scaled by the drawdown tier. The first tick reviews an order without placing it; only after that verifies does an entry go through.`, "options").catch(() => {});
    return Response.json({ ok: true, ...(await view()) });
  }
  // D7: the 0–100 score becomes a live input (unlocks the A+ rung on the next ARM) ONLY on a green measurement verdict — typed, never automatic.
  if (body.action === "promote-score") {
    if (body.confirm !== "PROMOTE") return Response.json({ ok: false, error: "type PROMOTE to confirm" }, { status: 400 });
    const report = await optionsScoreReport();
    if (!report.verdict.green) return Response.json({ ok: false, error: `score not promotable: ${report.verdict.reasons.join("; ")}` }, { status: 409 });
    await set(PROMOTED_KEY, "true");
    const line = `SCORE PROMOTED from the admin page: ${report.buckets.map((b) => `${b.name} n=${b.n} mean $${b.mean}`).join(" · ")}, Welch t ${report.verdict.welchT} (registered ${report.registeredAt}). A+ unlocks on the next ARM; the runner still sizes without a score until a later PR feeds it one.`;
    await log(line);
    await sendNotification(`🟢 Options 0–100 score PROMOTED — ${line}`, "options").catch(() => {});
    return Response.json({ ok: true, ...(await view()) });
  }
  return Response.json({ error: "action must be arm | disarm | promote-score" }, { status: 400 });
}
