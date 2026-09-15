import { deskLimits } from "@/lib/futures-desk";
import { renderFuturesBrief } from "@/lib/futures-desk-brief";
import { BRIEF_KEY, briefInputNow, parseBriefLatest } from "@/lib/futures-desk-brief-jobs";
import { cfg } from "@/lib/futures-desk-store";

// The desk brief (E8): MARKET REGIME / TOP OPPORTUNITIES / RECOMMENDED TRADE / ACTION. Default = the
// latest written by the guardian after the daily review (`futures_desk_brief_latest`); `?live=1`
// renders it now from the keys and tables (no broker call). Owner auth via the proxy, like every
// other /api/futures route.
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  try {
    const live = new URL(request.url).searchParams.get("live") === "1";
    if (live) {
      const now = new Date();
      const { markdown, action } = renderFuturesBrief(await briefInputNow(await deskLimits(), now));
      return Response.json({ at: now.toISOString(), action, markdown, source: "live" });
    }
    const latest = parseBriefLatest(await cfg(BRIEF_KEY));
    return Response.json(latest ? { ...latest, source: "stored" } : { at: null, action: null, markdown: null, source: "stored" });
  } catch (e) {
    return Response.json({ error: String(e).slice(0, 300) }, { status: 500 });
  }
}
