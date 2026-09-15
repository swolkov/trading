import { clearAnomaly, deskLimits, promoteScore, setDeskEnabled, loadState } from "@/lib/futures-desk";
import { reviewSnapshot, scoreBucketReport } from "@/lib/futures-desk-review-jobs";
import { deskStatus } from "@/lib/futures-desk-status";

// ENABLE / DISABLE the futures desk. Enabling requires the typed word ENABLE and a fresh guardian
// stamp; disabling needs nothing — it only ever reduces risk (the guardian keeps managing what is open).
// This is a DEMO account, so "enable" risks no money; the ceremony exists so the paper record can
// never start by accident and so the drawdown disable is cleared by a person, not a retry.
// `clear-anomaly` (typed CLEAR) empties `futures_desk_anomaly` — the guardian's foreign-position /
// ledger-mismatch / equity-jump pause on ENTRIES — after a person has looked at the account.
// `promote-score` (typed PROMOTE) sets `futures_desk_score_promoted` = true ONLY on a green
// `scorePromotionVerdict` (≥ 30 resolved per bucket, ≥ 80 beats < 70 by mean R, Welch t ≥ 2); until then
// the 0–100 score is a stamp. Demotion is a config write (the key to anything but "true") — it only reduces risk.
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  let body: { action?: string; confirm?: string } = {};
  try { body = await request.json(); } catch { /* empty */ }
  if (body.action === "disable") { await setDeskEnabled(false, "admin page"); return Response.json({ ok: true, ...(await deskStatus()) }); }
  if (body.action === "clear-anomaly") {
    if (String(body.confirm ?? "") !== "CLEAR") return Response.json({ error: "type CLEAR to confirm" }, { status: 400 });
    await clearAnomaly("admin page");
    return Response.json({ ok: true, ...(await deskStatus()) });
  }
  if (body.action === "promote-score") {
    if (String(body.confirm ?? "") !== "PROMOTE") return Response.json({ error: "type PROMOTE to confirm" }, { status: 400 });
    const snap = await reviewSnapshot(await deskLimits());
    const report = await scoreBucketReport(snap.rows);
    if (!report.ok) return Response.json({ error: "score not promotable", reasons: report.reasons, buckets: report.buckets, tStat: report.tStat }, { status: 400 });
    await promoteScore("admin page");
    return Response.json({ ok: true, report, ...(await deskStatus()) });
  }
  if (body.action !== "enable") return Response.json({ error: "action must be enable | disable | clear-anomaly | promote-score" }, { status: 400 });
  if (String(body.confirm ?? "") !== "ENABLE") return Response.json({ error: "type ENABLE to confirm" }, { status: 400 });
  if (!process.env.TRADOVATE_USERNAME) return Response.json({ error: "Tradovate is not configured on this deployment" }, { status: 400 });
  const s = await loadState();
  const age = s.guardianAt ? Date.now() - Date.parse(s.guardianAt) : Infinity;
  if (age > 15 * 60_000) return Response.json({ error: "guardian has not run in the last 15 minutes — enable refused" }, { status: 400 });
  await setDeskEnabled(true, "admin page");
  return Response.json({ ok: true, ...(await deskStatus()) });
}
