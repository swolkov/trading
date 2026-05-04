import { scanMarket } from "@/lib/ai-analyst";

export async function POST() {
  try {
    const results = await scanMarket();
    return Response.json({ results });
  } catch (error) {
    console.error("[/api/ai/scan]", error);
    return Response.json(
      { error: error instanceof Error ? error.message : "Scan failed" },
      { status: 500 }
    );
  }
}
