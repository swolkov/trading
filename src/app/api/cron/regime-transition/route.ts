import { runTransitionCheck } from "@/lib/regime-transition";
import { updateJARVIS } from "@/lib/vault";

export const maxDuration = 60;

export async function GET(request: Request) {
  const authHeader = request.headers.get("authorization");
  if (
    !process.env.CRON_SECRET ||
    authHeader !== `Bearer ${process.env.CRON_SECRET}`
  ) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const result = await runTransitionCheck();
    try { await updateJARVIS("regime-transition"); } catch { /* jarvis optional */ }
    return Response.json(result);
  } catch (error) {
    console.error("[/api/cron/regime-transition]", error);
    return Response.json({ error: String(error) }, { status: 500 });
  }
}

export async function POST(request: Request) {
  return GET(request);
}
