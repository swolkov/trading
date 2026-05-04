import { getEarningsCalendar, getEconomicCalendar } from "@/lib/finnhub";

export async function GET() {
  try {
    const [earnings, economic] = await Promise.all([
      getEarningsCalendar(),
      getEconomicCalendar(),
    ]);
    return Response.json({ earnings, economic });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : "Failed" }, { status: 500 });
  }
}
