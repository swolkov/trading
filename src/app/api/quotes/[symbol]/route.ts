import { getQuote } from "@/lib/alpaca";

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ symbol: string }> }
) {
  try {
    const { symbol } = await params;
    const quote = await getQuote(symbol.toUpperCase());
    return Response.json(quote);
  } catch (error) {
    console.error("[/api/quotes]", error);
    return Response.json(
      { error: error instanceof Error ? error.message : "Unknown error" },
      { status: 500 }
    );
  }
}
