import { readRoundTrip, startRoundTrip, advanceRoundTrip, abortRoundTrip, roundTripVerdict, RT_CHECKS } from "@/lib/margin-round-trip";

// The $20 round trip's admin surface. Owner-only (the proxy protects everything outside
// /api/cron and /api/webhook). POST {action:"start", symbol?} sends the real $20 entry
// through the executor; "advance" runs a check tick now instead of waiting for the guardian;
// "abort" closes and stops. GET reads the state for the card.
export const dynamic = "force-dynamic";
export const maxDuration = 300;

function view(state: Awaited<ReturnType<typeof readRoundTrip>>) {
  return {
    state,
    checklist: RT_CHECKS.map((c) => ({ ...c, result: state?.checks[c.key] ?? null })),
    verdict: state ? roundTripVerdict(state.checks) : null,
  };
}

export async function GET() {
  return Response.json(view(await readRoundTrip()));
}

export async function POST(request: Request) {
  const routeDeadlineMs = Date.now() + maxDuration * 1000;
  let body: { action?: string; symbol?: string } = {};
  try { body = await request.json(); } catch { /* empty */ }
  const action = String(body.action ?? "");
  if (action === "start") {
    const r = await startRoundTrip(String(body.symbol ?? "BTC/USD"), routeDeadlineMs);
    return Response.json({ ok: r.ok, note: r.note, ...view(r.state) }, { status: r.ok ? 200 : 409 });
  }
  if (action === "advance") return Response.json(view(await advanceRoundTrip()));
  if (action === "abort") return Response.json(view(await abortRoundTrip()));
  return Response.json({ error: "action must be start | advance | abort" }, { status: 400 });
}
