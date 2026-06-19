import { vaultReadMultiple } from "@/lib/vault";

// ============ VAULT BRIEF API ============
// Read-only endpoint for the admin Brief page. Returns the daily intelligence
// artifacts (morning brief + market chronicle) from the DB-backed vault.
// Paths are whitelisted so this can never be used to read arbitrary vault docs.

const ALLOWED_PATHS: Record<string, string> = {
  "morning-brief": "Brain/morning-brief.md",
  "market-history": "Brain/market-history.md",
};

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const paths = Object.values(ALLOWED_PATHS);
    const docs = await vaultReadMultiple(paths);
    return Response.json({
      morningBrief: docs["Brain/morning-brief.md"] ?? null,
      marketHistory: docs["Brain/market-history.md"] ?? null,
    });
  } catch (error) {
    return Response.json(
      { error: error instanceof Error ? error.message : "Failed to read vault" },
      { status: 500 }
    );
  }
}
