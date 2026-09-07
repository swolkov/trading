import { runMarginWeekly } from "@/lib/margin-weekly";

// The Monday review for the margin desk (vercel.json: 13:00 UTC Mondays). Writes one page
// to the vault by rule and posts the headline to Slack. It changes nothing. CRON_SECRET-gated.
export const maxDuration = 300;
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const authHeader = request.headers.get("authorization");
  if (!process.env.CRON_SECRET || authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }
  try {
    const r = await runMarginWeekly();
    return Response.json(r);
  } catch (e) {
    console.error("[/api/cron/margin-weekly]", e);
    return Response.json({ ok: false, error: String(e).slice(0, 300) }, { status: 500 });
  }
}
