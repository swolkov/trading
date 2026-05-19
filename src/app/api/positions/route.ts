import { getPositions } from "@/lib/alpaca";
import { getViewMode } from "@/lib/trading-mode";

export async function GET() {
  try {
    // Use view mode so dashboard shows paper/live based on toggle (mirrors futures pattern)
    const viewMode = await getViewMode("stocks");
    const positions = await getPositions(viewMode);
    return Response.json(positions);
  } catch (error) {
    console.error("[/api/positions]", error);
    return Response.json(
      { error: error instanceof Error ? error.message : "Unknown error" },
      { status: 500 }
    );
  }
}
