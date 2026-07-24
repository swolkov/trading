// TEMPORARY debug endpoint — lists the Anthropic models available to this account so we can wire the
// exact, verified model IDs (Opus 5 / Sonnet 5) instead of guessing. Read-only, exposes no secrets.
// DELETE after grabbing the IDs.
export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const res = await fetch("https://api.anthropic.com/v1/models?limit=100", {
      headers: {
        "x-api-key": process.env.ANTHROPIC_API_KEY || "",
        "anthropic-version": "2023-06-01",
      },
    });
    const data = await res.json();
    const models = (data.data || []).map((m: { id: string; display_name?: string }) => ({
      id: m.id,
      name: m.display_name,
    }));
    return Response.json({ count: models.length, models });
  } catch (e) {
    return Response.json({ error: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
}
