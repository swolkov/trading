// TEMPORARY debug endpoint — verifies Opus 5 / Sonnet 5 actually respond (with adaptive thinking, the
// way the code calls 5-series models) before we wire them into real paths. Read-only. DELETE after.
export const dynamic = "force-dynamic";

async function testModel(model: string, key: string) {
  try {
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "x-api-key": key, "anthropic-version": "2023-06-01", "content-type": "application/json" },
      body: JSON.stringify({
        model,
        max_tokens: 64,
        thinking: { type: "adaptive" },
        messages: [{ role: "user", content: "Reply with exactly: OK" }],
      }),
    });
    const d = await res.json();
    if (!res.ok) return { model, ok: false, error: d.error?.message || JSON.stringify(d).slice(0, 200) };
    const text = (d.content || []).filter((c: { type: string }) => c.type === "text").map((c: { text: string }) => c.text).join("");
    return { model, ok: true, reply: text.slice(0, 40) };
  } catch (e) {
    return { model, ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

export async function GET() {
  const key = process.env.ANTHROPIC_API_KEY || "";
  const tests = await Promise.all(["claude-opus-5", "claude-sonnet-5"].map((m) => testModel(m, key)));
  return Response.json({ tests });
}
