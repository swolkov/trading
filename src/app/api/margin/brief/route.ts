import { readLatestBrief } from "@/lib/margin-brief-build";

// The latest desk brief (margin-brief-build.ts publishDeskBrief), as the /margin panel reads it.
// AgentConfig only — no Kraken call, no fetch; the brief is written by the margin scan's daily
// 13:00 UTC pass and dated.
export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const brief = await readLatestBrief();
    return Response.json({ brief, at: new Date().toISOString() });
  } catch (error) {
    console.error("[/api/margin/brief]", error);
    return Response.json({ error: String(error) }, { status: 500 });
  }
}
