import { searchAssets } from "@/lib/alpaca";

export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url);
    const q = searchParams.get("q") || "";
    if (q.length < 1) {
      return Response.json([]);
    }
    const assets = await searchAssets(q);
    return Response.json(assets);
  } catch (error) {
    console.error("[/api/search]", error);
    return Response.json(
      { error: error instanceof Error ? error.message : "Unknown error" },
      { status: 500 }
    );
  }
}
