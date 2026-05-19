import { getCryptoBars } from "@/lib/alpaca";

export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url);
    const symbol = searchParams.get("symbol");
    const timeframe = searchParams.get("timeframe") || "1Day";
    const start = searchParams.get("start") || undefined;
    const end = searchParams.get("end") || undefined;

    if (!symbol) {
      return Response.json({ error: "symbol is required" }, { status: 400 });
    }

    const bars = await getCryptoBars(symbol, timeframe, start, end);

    return Response.json({ bars });
  } catch (error) {
    return Response.json({ error: String(error) }, { status: 500 });
  }
}
