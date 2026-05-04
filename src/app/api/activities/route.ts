import { getAccountActivities } from "@/lib/alpaca";

export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url);
    const type = searchParams.get("type") || "FILL";
    const activities = await getAccountActivities(type);
    return Response.json(activities);
  } catch (error) {
    console.error("[/api/activities]", error);
    return Response.json(
      { error: error instanceof Error ? error.message : "Unknown error" },
      { status: 500 }
    );
  }
}
