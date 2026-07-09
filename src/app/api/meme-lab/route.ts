import { getMemeLabStatus } from "@/lib/meme-scanner";

export const dynamic = "force-dynamic";

// Read-only status for the Meme Lab page. Also supports ?run=1 with the cron secret for a manual scan.
export async function GET(request: Request) {
  const url = new URL(request.url);
  if (url.searchParams.get("run") === "1") {
    const auth = request.headers.get("authorization");
    if (process.env.CRON_SECRET && auth === `Bearer ${process.env.CRON_SECRET}`) {
      const { runMemeScan } = await import("@/lib/meme-scanner");
      return Response.json(await runMemeScan());
    }
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }
  try {
    return Response.json(await getMemeLabStatus());
  } catch (error) {
    return Response.json({ error: String(error) }, { status: 500 });
  }
}
