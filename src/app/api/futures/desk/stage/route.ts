import { STAGES, stageReadiness, type Stage } from "@/lib/futures-desk-rules";
import { deskLimits, rawRows, setDeskStage } from "@/lib/futures-desk";
import { deskStatus, mergeRollChains } from "@/lib/futures-desk-status";

// ADVANCE the sizing stage: A (one micro) → B (two) → C (five). Requires the typed word STAGE and
// the readiness gate on the CURRENT stage's own resolved trades (≥ 30, net > 0, PF ≥ 1.2, max
// drawdown ≤ 3% of basis). One step at a time, never backwards here (lowering is a config write —
// it only reduces risk). Stage D (one MINI) is never reachable from this route: it needs
// `futures_desk_stage` = D and `futures_desk_stage_d_armed` = true set by hand, and is documented
// as essentially unreachable at a $500 budget.
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  let body: { confirm?: string; to?: string } = {};
  try { body = await request.json(); } catch { /* empty */ }
  if (String(body.confirm ?? "") !== "STAGE") return Response.json({ error: "type STAGE to confirm" }, { status: 400 });
  const limits = await deskLimits();
  const current = limits.stage;
  const next = STAGES[STAGES.indexOf(current) + 1] as Stage | undefined;
  if (!next || next === "D" || body.to !== next) return Response.json({ error: "stage can only advance one step, from A to B or B to C" }, { status: 400 });
  const rows = mergeRollChains(await rawRows<{ id: number; status: string; exit_reason: string | null; pnl_usd: number | null; rolled_from: number | null; stage: string | null }>(
    `SELECT id, status, exit_reason, pnl_usd, rolled_from, stage FROM futures_desk_trades WHERE stage = $1`, current));
  const readiness = stageReadiness(rows, current, limits);
  if (!readiness.ok) return Response.json({ error: "stage not earned", readiness }, { status: 400 });
  await setDeskStage(next, "admin page");
  return Response.json({ ok: true, readiness, ...(await deskStatus()) });
}
