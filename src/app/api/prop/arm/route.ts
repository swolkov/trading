import { prisma } from "@/lib/db";
import { sendNotification } from "@/lib/notifications";
import { PROP_SOURCE_DEFAULT, clearPropDisarm, loadState, propArmLog, propConfig, propStatus } from "@/lib/prop-desk";
import { PROP_RISK_MAX_PCT } from "@/lib/prop-rules";
import { dxAccountStatus, dxConfigured } from "@/lib/dxtrade";

// THE PROP ARM SWITCH. Arming requires the typed word ARM, a configured broker, an account
// in FULL_TRADING, a fresh guardian stamp and no standing disarm reason. Disarming needs
// nothing — it only ever reduces risk (the guardian keeps managing anything open).
export const dynamic = "force-dynamic";

async function setKey(key: string, value: string) {
  await prisma.agentConfig.upsert({ where: { key }, update: { value }, create: { key, value } });
}

export async function POST(request: Request) {
  let body: { action?: string; confirm?: string; source?: string; riskBasePct?: number } = {};
  try { body = await request.json(); } catch { /* empty */ }
  const action = String(body.action ?? "");

  if (action === "disarm") {
    await setKey("prop_armed", "false");
    await propArmLog({ action: "disarm", by: "admin page" });
    await sendNotification("⚪ PROP desk DISARMED from the admin page. No new entries; the guardian keeps managing anything open.", "prop").catch(() => {});
    return Response.json({ ok: true, ...(await propStatus()) });
  }
  if (action === "clear-disarm") {
    // A deliberate human act after a breach/disarm reason: clears the reason, does NOT arm.
    const { state, unreliable } = await loadState();
    if (unreliable) return Response.json({ error: "state unreadable" }, { status: 500 });
    if (!state.disarmed) return Response.json({ error: "nothing to clear" }, { status: 400 });
    const reason = state.disarmed.reason;
    await clearPropDisarm();
    await propArmLog({ action: "clear-disarm", by: "admin page", cleared: reason });
    return Response.json({ ok: true, ...(await propStatus()) });
  }
  if (action !== "arm") return Response.json({ error: "action must be arm | disarm | clear-disarm" }, { status: 400 });
  if (String(body.confirm ?? "") !== "ARM") return Response.json({ error: "type ARM to confirm" }, { status: 400 });
  if (!dxConfigured()) return Response.json({ error: "prop broker not configured on this deployment" }, { status: 400 });
  const source = String(body.source ?? PROP_SOURCE_DEFAULT).trim().toLowerCase();
  if (source !== PROP_SOURCE_DEFAULT) return Response.json({ error: `only ${PROP_SOURCE_DEFAULT} has a prop container (got "${source}")` }, { status: 400 });
  const risk = Number(body.riskBasePct ?? 1.5);
  if (!(risk > 0) || risk > PROP_RISK_MAX_PCT) return Response.json({ error: `risk must be 0 < r ≤ ${PROP_RISK_MAX_PCT}` }, { status: 400 });
  const { state, unreliable } = await loadState();
  if (unreliable) return Response.json({ error: "state unreadable — arm refused" }, { status: 500 });
  if (state.disarmed) return Response.json({ error: `standing disarm: ${state.disarmed.reason} — clear it first` }, { status: 400 });
  const gAge = state.guardianAt ? Date.now() - new Date(state.guardianAt).getTime() : Infinity;
  if (gAge > 15 * 60_000) return Response.json({ error: "guardian has not run in the last 15 minutes — arm refused" }, { status: 400 });
  let acct;
  try { acct = await dxAccountStatus(); } catch (e) { return Response.json({ error: `broker: ${String(e).slice(0, 160)}` }, { status: 400 }); }
  if (acct.accountStatus !== "FULL_TRADING") return Response.json({ error: `account is ${acct.accountStatus}, not FULL_TRADING` }, { status: 400 });

  await setKey("prop_live_sources", source);
  await setKey("prop_risk_base_pct", String(risk));
  await setKey("prop_armed", "true");
  const c = await propConfig();
  await propArmLog({ action: "arm", by: "admin page", source, riskBasePct: risk, account: acct.account });
  await sendNotification(`🟢 PROP desk ARMED — ${source} on ${acct.account}, ${risk}% risk per trade (max ${c.riskMaxPct}%), ${c.maxPositions} slot, ${c.maxEntriesPerDay} entry/day. Floors: −3% daily, −6% static.`, "prop").catch(() => {});
  return Response.json({ ok: true, ...(await propStatus()) });
}
