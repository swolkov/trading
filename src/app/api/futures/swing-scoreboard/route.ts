import { getSwingPerformance } from "@/lib/daily-swing";

export const dynamic = "force-dynamic";

// Read-only scoreboard for the Daily Index Mean-Reversion paper forward-test.
export async function GET() {
  try {
    const perf = await getSwingPerformance();
    return Response.json(perf);
  } catch (error) {
    console.error("[/api/futures/swing-scoreboard]", error);
    return Response.json({ error: String(error) }, { status: 500 });
  }
}
