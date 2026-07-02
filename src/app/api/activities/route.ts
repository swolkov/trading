import { getAccountActivities } from "@/lib/alpaca";

export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url);
    const type = searchParams.get("type") || "FILL";
    // Alpaca is live-only — no paper fills in the trade history
    const activities = await getAccountActivities(type, "live");
    return Response.json(activities);
  } catch (error) {
    console.error("[/api/activities]", error);
    return Response.json(
      { error: error instanceof Error ? error.message : "Unknown error" },
      { status: 500 }
    );
  }
}
