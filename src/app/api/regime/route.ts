import { detectMarketRegime } from "@/lib/market-regime";

export async function GET() {
  try {
    const regime = await detectMarketRegime();
    return Response.json(regime);
  } catch (error) {
    return Response.json(
      { error: error instanceof Error ? error.message : "Failed" },
      { status: 500 }
    );
  }
}
