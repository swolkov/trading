import { getEdgePerformance } from "@/lib/edge-performance";

// The /futures "Validated Edges" scoreboard now shares the SAME clean per-edge logic as /admin/strategies
// (getEdgePerformance): it pairs live_ entries→exits by direction, so it is immune to the duplicate
// futures_/shadow_ log rows AND the phantom ghost-cover rows that inflated the old sum. Gold is split
// oversold-LONG vs overbought-SHORT; index is split short vs long. Both pages now agree.
export const dynamic = "force-dynamic";

export async function GET() {
  try {
    return Response.json(await getEdgePerformance());
  } catch (error) {
    console.error("[/api/futures/edge-scoreboard]", error);
    return Response.json({ error: String(error) }, { status: 500 });
  }
}
