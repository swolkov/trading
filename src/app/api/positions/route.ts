import { getPositions } from "@/lib/alpaca";

export async function GET() {
  try {
    // Alpaca is live-only — always show real live positions (no paper/demo).
    const positions = await getPositions("live");
    return Response.json(positions);
  } catch (error) {
    console.error("[/api/positions]", error);
    return Response.json(
      { error: error instanceof Error ? error.message : "Unknown error" },
      { status: 500 }
    );
  }
}
