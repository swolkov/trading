import { runMarginSynthesis } from "@/lib/margin-synthesis";

// Daily learning loop for the margin desk (paper + live). See src/lib/margin-synthesis.ts.
// CRON_SECRET-gated; `?force=1` re-runs regardless of the 20-hour spacing.
export const maxDuration = 300;
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const authHeader = request.headers.get("authorization");
  if (!process.env.CRON_SECRET || authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }
  const force = new URL(request.url).searchParams.get("force") === "1";
  try {
    const r = await runMarginSynthesis(force);
    return Response.json({ ok: true, ...r });
  } catch (e) {
    console.error("[/api/cron/margin-synthesis]", e);
    return Response.json({ ok: false, error: String(e).slice(0, 300) }, { status: 500 });
  }
}
