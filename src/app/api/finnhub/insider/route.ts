import { getInsiderTransactions, getCongressionalTrading } from "@/lib/finnhub";

export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url);
    const symbol = searchParams.get("symbol");
    if (!symbol) return Response.json({ error: "symbol required" }, { status: 400 });

    const [insider, congressional] = await Promise.all([
      getInsiderTransactions(symbol.toUpperCase()),
      getCongressionalTrading(symbol.toUpperCase()),
    ]);

    return Response.json({ insider, congressional });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : "Failed" }, { status: 500 });
  }
}
