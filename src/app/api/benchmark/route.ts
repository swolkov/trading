import { generateBenchmarkReport } from "@/lib/benchmark";

export const maxDuration = 60;

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const period = (searchParams.get("period") || "1M") as "1W" | "1M" | "3M" | "6M" | "1Y";

  try {
    const result = await generateBenchmarkReport(period);
    return Response.json(result);
  } catch (error) {
    console.error("[/api/benchmark]", error);
    return Response.json({ error: String(error) }, { status: 500 });
  }
}
