import { runWalkForwardOptimization } from "@/lib/walk-forward";

export const maxDuration = 120;

export async function GET(request: Request) {
  const authHeader = request.headers.get("authorization");
  if (!process.env.CRON_SECRET || authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }
  try {
    const result = await runWalkForwardOptimization();
    return Response.json(result);
  } catch (error) {
    console.error("[/api/cron/walk-forward]", error);
    return Response.json({ error: String(error) }, { status: 500 });
  }
}

export async function POST(request: Request) { return GET(request); }
