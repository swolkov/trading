import { getDashboardQuotes } from "@/lib/futures-data";

const MICRO_SYMBOLS = ["MES", "MNQ", "MGC", "MYM", "M2K"];

export async function GET() {
  try {
    const results = await getDashboardQuotes(MICRO_SYMBOLS);
    return Response.json(results);
  } catch (error) {
    console.error("[/api/futures/quotes]", error);
    return Response.json(
      { error: error instanceof Error ? error.message : "Failed to fetch futures quotes" },
      { status: 500 }
    );
  }
}
