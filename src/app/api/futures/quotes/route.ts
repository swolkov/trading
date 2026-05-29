import { getDashboardQuotes } from "@/lib/futures-data";

// All contracts needed across demo + live views, including crypto futures.
// Crypto quotes flow via the live_quotes table (sidecar) since Tradovate/Yahoo don't carry them.
const ALL_SYMBOLS = [
  "ES", "NQ", "GC", "MES", "MNQ", "MGC", "MYM", "M2K",
  "MBT", "MET", "BFF", "MXR", "MSL",
];

export async function GET() {
  try {
    const results = await getDashboardQuotes(ALL_SYMBOLS);
    return Response.json(results);
  } catch (error) {
    console.error("[/api/futures/quotes]", error);
    return Response.json(
      { error: error instanceof Error ? error.message : "Failed to fetch futures quotes" },
      { status: 500 }
    );
  }
}
