import { getMarketClock } from "@/lib/alpaca";

export async function GET() {
  try {
    const clock = await getMarketClock();
    return Response.json(clock);
  } catch (error) {
    console.error("[/api/clock]", error);
    return Response.json(
      { error: error instanceof Error ? error.message : "Unknown error" },
      { status: 500 }
    );
  }
}
