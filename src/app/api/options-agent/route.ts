import { runOptionsAgent, getOptionsStatus } from "@/lib/options-agent";

export const maxDuration = 120;

// Read-only status for the /options page: config + honest scoreboard + per-run reasoning. Cheap, no auth.
export async function GET() {
  try {
    return Response.json(await getOptionsStatus());
  } catch (error) {
    return Response.json({ error: String(error) }, { status: 500 });
  }
}

// Manual trigger (auth-gated). POST ?dry=1 runs a scan WITHOUT placing orders (returns would-be
// trades); POST with no query runs one live tick. Used for testing/verification.
export async function POST(request: Request) {
  const authHeader = request.headers.get("authorization");
  if (!process.env.CRON_SECRET || authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }
  try {
    const dry = new URL(request.url).searchParams.get("dry") === "1";
    const result = await runOptionsAgent({ dry });
    return Response.json(result);
  } catch (error) {
    console.error("[/api/options-agent POST]", error);
    return Response.json({ error: String(error) }, { status: 500 });
  }
}
