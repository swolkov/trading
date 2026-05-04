import { getBars } from "@/lib/alpaca";

export async function GET(
  request: Request,
  { params }: { params: Promise<{ symbol: string }> }
) {
  try {
    const { symbol } = await params;
    const { searchParams } = new URL(request.url);
    const timeframe = searchParams.get("timeframe") || "1Day";
    const start = searchParams.get("start") || undefined;
    const end = searchParams.get("end") || undefined;
    const bars = await getBars(symbol.toUpperCase(), timeframe, start, end);
    return Response.json(bars);
  } catch (error) {
    console.error("[/api/bars]", error);
    return Response.json(
      { error: error instanceof Error ? error.message : "Unknown error" },
      { status: 500 }
    );
  }
}
