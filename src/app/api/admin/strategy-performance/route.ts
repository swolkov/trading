import { getPerformanceSummary } from "@/lib/strategy-performance";

export async function GET() {
  const summary = await getPerformanceSummary();
  return Response.json({ summary });
}
