import {
  getCompanyProfile,
  getKeyStats,
  getIncomeStatements,
  getEarnings,
  getAnalystRecommendations,
} from "@/lib/yahoo";

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ symbol: string }> }
) {
  try {
    const { symbol } = await params;
    const upper = symbol.toUpperCase();

    const [profile, stats, income, earnings, analysts] = await Promise.all([
      getCompanyProfile(upper),
      getKeyStats(upper),
      getIncomeStatements(upper),
      getEarnings(upper),
      getAnalystRecommendations(upper),
    ]);

    return Response.json({
      profile,
      stats,
      income,
      earnings,
      analysts,
    });
  } catch (error) {
    console.error("[/api/research]", error);
    return Response.json(
      { error: error instanceof Error ? error.message : "Unknown error" },
      { status: 500 }
    );
  }
}
