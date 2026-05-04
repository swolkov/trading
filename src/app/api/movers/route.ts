import { getMostActives, getTopMovers } from "@/lib/alpaca";

export async function GET() {
  try {
    const [mostActive, gainers, losers] = await Promise.all([
      getMostActives(),
      getTopMovers("gainers"),
      getTopMovers("losers"),
    ]);
    return Response.json({ mostActive, gainers, losers });
  } catch (error) {
    console.error("[/api/movers]", error);
    return Response.json(
      { error: error instanceof Error ? error.message : "Unknown error" },
      { status: 500 }
    );
  }
}
