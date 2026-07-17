import { getEdgePerformance } from "@/lib/edge-performance";

export const dynamic = "force-dynamic";

// Live per-edge win-rate + P&L for the futures admin ("what's working").
export async function GET() {
  try {
    return Response.json(await getEdgePerformance());
  } catch (error) {
    console.error("[/api/admin/edge-performance]", error);
    return Response.json({ error: String(error) }, { status: 500 });
  }
}
