import { prisma } from "@/lib/db";
import { OPTIONS_MAX_LOSS_KEY, parseOptionsMaxLoss } from "@/lib/options-operation";
import { OPTIONS_LIVE_RULES } from "@/lib/options-live-guardian";
import { sendNotification } from "@/lib/notifications";

// THE OPTIONS LIVE DESK's admin surface. GET = what the desk on the Mac last reported (it writes
// options_live_state every tick), the switches, the probe result and the log tail. POST = the
// ARM / DISARM switch. Arming is a typed ceremony like the Kraken desk; disarming is one click.
// The runner reads options_live_armed on every tick, so a disarm takes effect within 5 minutes
// and never touches an open position — the guardian keeps managing it.
export const dynamic = "force-dynamic";
const KEYS = ["options_live_armed", "options_live_integration_verified", "options_live_guardian_ok_at", "options_live_verified_fee_reserve_usd", OPTIONS_MAX_LOSS_KEY,
  "options_live_state", "options_live_probe", "options_live_log", "options_live_equity_high", "options_live_arm_log"];
const DEFAULT_FEE_RESERVE_USD = 2;   // regulatory fees on one contract round trip are cents; $2 is a generous ceiling inside the $100 cap

async function view() {
  const rows = await prisma.agentConfig.findMany({ where: { key: { in: KEYS } } });
  const c = Object.fromEntries(rows.map((r) => [r.key, r.value]));
  const parse = (k: string) => { try { return c[k] ? JSON.parse(c[k]) : null; } catch { return null; } };
  const guardianAt = c.options_live_guardian_ok_at ?? null;
  const guardianAge = guardianAt ? Date.now() - Date.parse(guardianAt) : null;
  let intents: { refId: string; action: string; state: string; orderId: string | null; updatedAt: string }[] = [];
  let owned: unknown[] = [];
  try {
    intents = (await prisma.$queryRawUnsafe<{ ref_id: string; action: string; state: string; order_id: string | null; updated_at: Date }[]>(
      `SELECT ref_id, action, state, payload->'order'->>'id' AS order_id, updated_at FROM options_live_intents ORDER BY updated_at DESC LIMIT 20`))
      .map((r) => ({ refId: r.ref_id, action: r.action, state: r.state, orderId: r.order_id, updatedAt: r.updated_at.toISOString() }));
    owned = (await prisma.$queryRawUnsafe<{ payload: unknown }[]>(`SELECT payload FROM options_live_owned_positions ORDER BY updated_at`)).map((r) => r.payload);
  } catch { /* tables appear on the desk's first run */ }
  return {
    armed: c.options_live_armed === "true",
    verified: c.options_live_integration_verified === "true",
    maxLossUsd: parseOptionsMaxLoss(c[OPTIONS_MAX_LOSS_KEY]),
    feeReserveUsd: parseOptionsMaxLoss(c.options_live_verified_fee_reserve_usd),
    guardian: { at: guardianAt, fresh: guardianAge != null && guardianAge < 10 * 60_000 },
    rules: OPTIONS_LIVE_RULES,
    state: parse("options_live_state"), probe: parse("options_live_probe"),
    log: (parse("options_live_log") as string[] | null ?? []).slice(-40),
    armLog: (parse("options_live_arm_log") as string[] | null ?? []).slice(-10),
    equityHigh: c.options_live_equity_high ? Number(c.options_live_equity_high) : null,
    intents, owned,
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
    const maxLoss = parseOptionsMaxLoss((await prisma.agentConfig.findUnique({ where: { key: OPTIONS_MAX_LOSS_KEY } }))?.value);
    if (!maxLoss) return Response.json({ ok: false, error: "no approved maximum loss per trade is set" }, { status: 409 });
    const fee = parseOptionsMaxLoss((await prisma.agentConfig.findUnique({ where: { key: "options_live_verified_fee_reserve_usd" } }))?.value);
    if (!fee) await set("options_live_verified_fee_reserve_usd", String(DEFAULT_FEE_RESERVE_USD));
    await set("options_live_armed", "true");
    await log(`ARMED from the admin page: max loss $${maxLoss} incl. fees (reserve $${fee ?? DEFAULT_FEE_RESERVE_USD}), one contract, one position, ${OPTIONS_LIVE_RULES.maxEntriesPerDay}/day, debit structures only, stop ${OPTIONS_LIVE_RULES.premiumStopFrac * 100}% / trail from ${OPTIONS_LIVE_RULES.trailArmMult}x keeping ${OPTIONS_LIVE_RULES.trailLockFrac * 100}% of the best gain / out ${OPTIONS_LIVE_RULES.exitBeforeDte}d before expiry, halt at −$${OPTIONS_LIVE_RULES.drawdownHaltUsd}`);
    await sendNotification(`🔴 Options live desk ARMED from the admin page: real money, one contract, max loss $${maxLoss} including fees. The first tick reviews an order without placing it; only after that verifies does an entry go through.`, "options").catch(() => {});
    return Response.json({ ok: true, ...(await view()) });
  }
  return Response.json({ error: "action must be arm | disarm" }, { status: 400 });
}
