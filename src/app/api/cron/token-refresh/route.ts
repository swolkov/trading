import { prisma } from "@/lib/db";

export const maxDuration = 60;

// Refresh Tradovate auth tokens every 12 hours from Vercel (different IP from Railway).
// Engines pick up fresh tokens proactively before their current ones expire.

async function refreshToken(mode: "demo" | "live"): Promise<string> {
  const baseUrl = mode === "live"
    ? "https://live.tradovateapi.com/v1"
    : "https://demo.tradovateapi.com/v1";

  const res = await fetch(`${baseUrl}/auth/accesstokenrequest`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      name: process.env.TRADOVATE_USERNAME || "",
      password: process.env.TRADOVATE_PASSWORD || "",
      appId: process.env.TRADOVATE_APP_ID || "esbueno",
      appVersion: process.env.TRADOVATE_APP_VERSION || "1.0",
      deviceId: `esbueno-vercel-refresh-${mode}`,
      cid: parseInt(process.env.TRADOVATE_CID || "0"),
      sec: process.env.TRADOVATE_SEC || "",
    }),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Auth ${mode} failed (${res.status}): ${body}`);
  }

  const data = await res.json() as { accessToken: string };
  const token = data.accessToken;
  const expires = new Date(Date.now() + 23 * 60 * 60 * 1000).toISOString();

  // Get account info
  const acctRes = await fetch(`${baseUrl}/account/list`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const accounts = await acctRes.json() as { id: number; name: string; active: boolean }[];
  const active = accounts.find(a => a.active) || accounts[0];

  // Save as shared token — engines will pick this up on their next proactive refresh check
  const shareKey = mode === "live" ? "tradovate_live_shared_token" : "tradovate_demo_shared_token";
  await prisma.agentConfig.upsert({
    where: { key: shareKey },
    update: {
      value: JSON.stringify({
        token,
        expires,
        accountId: active?.id || 0,
        accountName: active?.name || "",
      }),
    },
    create: {
      key: shareKey,
      value: JSON.stringify({
        token,
        expires,
        accountId: active?.id || 0,
        accountName: active?.name || "",
      }),
    },
  });

  return `${mode}: ${active?.name} (#${active?.id}) — expires ${expires}`;
}

export async function GET(request: Request) {
  const authHeader = request.headers.get("authorization");
  if (!process.env.CRON_SECRET || authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }

  if (!process.env.TRADOVATE_USERNAME || !process.env.TRADOVATE_PASSWORD) {
    return Response.json({ status: "skipped", reason: "No Tradovate credentials on this environment" });
  }

  const results: Record<string, string> = {};

  // Stagger auth calls to avoid rate limiting (demo first, then live after 3s)
  for (const mode of ["demo", "live"] as const) {
    try {
      results[mode] = await refreshToken(mode);
    } catch (err) {
      results[mode] = `FAILED: ${err instanceof Error ? err.message : String(err)}`;
    }
    // Wait 3s between auth calls to avoid rate limiting
    if (mode === "demo") await new Promise(r => setTimeout(r, 3000));
  }

  return Response.json({ status: "refreshed", results });
}
