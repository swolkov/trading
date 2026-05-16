import { prisma } from "@/lib/db";
import { auth } from "@clerk/nextjs/server";

export async function POST(request: Request) {
  const { userId } = await auth();
  if (!userId) return Response.json({ error: "Unauthorized" }, { status: 401 });

  const body = await request.json();
  const { username, password, appId, cid, secret, environment } = body;

  if (!username || !password) {
    return Response.json({ error: "Username and password required" }, { status: 400 });
  }

  // Test the credentials by authenticating with Tradovate
  const baseUrl = environment === "live"
    ? "https://live.tradovateapi.com/v1"
    : "https://demo.tradovateapi.com/v1";

  try {
    const authRes = await fetch(`${baseUrl}/auth/accesstokenrequest`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      signal: AbortSignal.timeout(15000),
      body: JSON.stringify({
        name: username,
        password,
        appId: appId || "TradeBot",
        appVersion: "1.0",
        cid: cid || "",
        sec: secret || "",
      }),
    });

    if (!authRes.ok) {
      const error = await authRes.text();
      return Response.json({ error: `Tradovate auth failed: ${error}` }, { status: 400 });
    }

    const authData = await authRes.json();
    if (!authData.accessToken) {
      return Response.json({ error: "No access token returned" }, { status: 400 });
    }

    // Get account info
    const accountsRes = await fetch(`${baseUrl}/account/list`, {
      headers: { Authorization: `Bearer ${authData.accessToken}` },
    });
    const accounts = await accountsRes.json();
    const account = accounts?.[0];

    // Store connection in DB
    await prisma.brokerConnection.upsert({
      where: { userId_broker_environment: { userId, broker: "tradovate", environment: environment || "demo" } },
      update: {
        accessToken: authData.accessToken,
        tokenExpires: new Date(Date.now() + 23 * 60 * 60 * 1000),
        accountId: account?.id || null,
        accountName: account?.name || null,
        status: "connected",
        lastUsedAt: new Date(),
      },
      create: {
        userId,
        broker: "tradovate",
        environment: environment || "demo",
        accessToken: authData.accessToken,
        tokenExpires: new Date(Date.now() + 23 * 60 * 60 * 1000),
        accountId: account?.id || null,
        accountName: account?.name || null,
        status: "connected",
        lastUsedAt: new Date(),
      },
    });

    return Response.json({
      success: true,
      account: { id: account?.id, name: account?.name },
      environment,
    });
  } catch (error) {
    return Response.json({ error: `Connection failed: ${error instanceof Error ? error.message : "Unknown"}` }, { status: 500 });
  }
}

export async function GET() {
  const { userId } = await auth();
  if (!userId) return Response.json({ error: "Unauthorized" }, { status: 401 });

  const connections = await prisma.brokerConnection.findMany({
    where: { userId },
    select: {
      id: true, broker: true, environment: true, status: true,
      accountId: true, accountName: true, lastUsedAt: true, createdAt: true,
    },
  });

  return Response.json({ connections });
}

export async function DELETE(request: Request) {
  const { userId } = await auth();
  if (!userId) return Response.json({ error: "Unauthorized" }, { status: 401 });

  const { connectionId } = await request.json();
  await prisma.brokerConnection.deleteMany({
    where: { id: connectionId, userId },
  });

  return Response.json({ success: true });
}
