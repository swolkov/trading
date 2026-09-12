import { setDeskEnabled, loadState } from "@/lib/futures-desk";
import { deskStatus } from "@/lib/futures-desk-status";

// ENABLE / DISABLE the futures desk. Enabling requires the typed word ENABLE and a fresh guardian
// stamp; disabling needs nothing — it only ever reduces risk (the guardian keeps managing what is open).
// This is a DEMO account, so "enable" risks no money; the ceremony exists so the paper record can
// never start by accident and so the drawdown disable is cleared by a person, not a retry.
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  let body: { action?: string; confirm?: string } = {};
  try { body = await request.json(); } catch { /* empty */ }
  if (body.action === "disable") { await setDeskEnabled(false, "admin page"); return Response.json({ ok: true, ...(await deskStatus()) }); }
  if (body.action !== "enable") return Response.json({ error: "action must be enable | disable" }, { status: 400 });
  if (String(body.confirm ?? "") !== "ENABLE") return Response.json({ error: "type ENABLE to confirm" }, { status: 400 });
  if (!process.env.TRADOVATE_USERNAME) return Response.json({ error: "Tradovate is not configured on this deployment" }, { status: 400 });
  const s = await loadState();
  const age = s.guardianAt ? Date.now() - Date.parse(s.guardianAt) : Infinity;
  if (age > 15 * 60_000) return Response.json({ error: "guardian has not run in the last 15 minutes — enable refused" }, { status: 400 });
  await setDeskEnabled(true, "admin page");
  return Response.json({ ok: true, ...(await deskStatus()) });
}
