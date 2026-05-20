import { getDashboardQuotes } from "@/lib/futures-data";

// All contracts needed across demo (ES, NQ, GC) and live (MES, MNQ) views
const ALL_SYMBOLS = ["ES", "NQ", "GC", "MES", "MNQ", "MGC", "MYM", "M2K"];

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
