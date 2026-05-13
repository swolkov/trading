import { prisma } from "@/lib/db";

export const maxDuration = 60;

// ============ VAULT SYNC API ============
// Syncs VaultDocument DB rows ↔ local Obsidian files.
// Called by the local sync script running on your machine.

// GET: Returns all vault documents (or those updated since ?since=timestamp)
export async function GET(request: Request) {
  const authHeader = request.headers.get("authorization");
  if (process.env.CRON_SECRET && authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }

  const url = new URL(request.url);
  const since = url.searchParams.get("since");

  const where = since ? { updatedAt: { gte: new Date(since) } } : {};

  const docs = await prisma.vaultDocument.findMany({
    where,
    orderBy: { updatedAt: "desc" },
  });

  return Response.json({ documents: docs, count: docs.length });
}

// POST: Upsert vault documents from local Obsidian files
export async function POST(request: Request) {
  const authHeader = request.headers.get("authorization");
  if (process.env.CRON_SECRET && authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }

  const body = await request.json();
  const documents: { path: string; content: string }[] = body.documents || [];

  let upserted = 0;
  for (const doc of documents) {
    await prisma.vaultDocument.upsert({
      where: { path: doc.path },
      create: { path: doc.path, content: doc.content, updatedBy: "obsidian-sync" },
      update: { content: doc.content, updatedBy: "obsidian-sync" },
    });
    upserted++;
  }

  return Response.json({ status: "ok", upserted });
}
