import { analyzeStock } from "@/lib/ai-analyst";

export async function POST(request: Request) {
  try {
    const { symbol } = await request.json();
    if (!symbol) {
      return Response.json({ error: "symbol required" }, { status: 400 });
    }
    const analysis = await analyzeStock(symbol.toUpperCase());
    return Response.json(analysis);
  } catch (error) {
    console.error("[/api/ai/analyze]", error);
    return Response.json(
      { error: error instanceof Error ? error.message : "Analysis failed" },
      { status: 500 }
    );
  }
}
