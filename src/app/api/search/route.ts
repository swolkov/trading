// Symbol search — the equities brokerage asset directory was removed.
// Returns the typed query as a single uppercased candidate so the autocomplete
// box (research/backtest/AI/watchlist pages) keeps working without a live feed.
export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url);
    const q = (searchParams.get("q") || "").trim().toUpperCase();
    if (q.length < 1) {
      return Response.json([]);
    }
    return Response.json([{ symbol: q, name: q }]);
  } catch (error) {
    console.error("[/api/search]", error);
    return Response.json(
      { error: error instanceof Error ? error.message : "Unknown error" },
      { status: 500 }
    );
  }
}
