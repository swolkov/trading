import { getSocialSentiment, getUpgradesDowngrades } from "@/lib/finnhub";

export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url);
    const symbol = searchParams.get("symbol");
    if (!symbol) return Response.json({ error: "symbol required" }, { status: 400 });

    const [sentiment, upgrades] = await Promise.all([
      getSocialSentiment(symbol.toUpperCase()),
      getUpgradesDowngrades(symbol.toUpperCase()),
    ]);

    return Response.json({ sentiment, upgrades });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : "Failed" }, { status: 500 });
  }
}
