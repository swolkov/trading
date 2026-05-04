import { getNews } from "@/lib/alpaca";

export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url);
    const symbolsParam = searchParams.get("symbols");
    const symbols = symbolsParam
      ? symbolsParam.split(",").map((s) => s.trim())
      : undefined;
    const limit = parseInt(searchParams.get("limit") || "20");
    const news = await getNews(symbols, limit);
    return Response.json(news);
  } catch (error) {
    console.error("[/api/news]", error);
    return Response.json(
      { error: error instanceof Error ? error.message : "Unknown error" },
      { status: 500 }
    );
  }
}
