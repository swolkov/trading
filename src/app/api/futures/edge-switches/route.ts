import { getEdgeSwitchboard } from "@/lib/edge-performance";

// Read model for the Futures-page inline edge switches: each registered edge with its current
// demo/live switch state + demo/live realized results. Writes go through /api/admin/strategy-toggle.
export const dynamic = "force-dynamic";

export async function GET() {
  try {
    return Response.json({ edges: await getEdgeSwitchboard() });
  } catch (e) {
    return Response.json({ error: e instanceof Error ? e.message : String(e), edges: [] }, { status: 500 });
  }
}
