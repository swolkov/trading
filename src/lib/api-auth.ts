import { auth } from "@clerk/nextjs/server";

/**
 * Defense-in-depth authorization for state-changing API routes.
 * Proxy protects the surrounding route tree, but money and accounting mutations
 * also verify a user session at the handler boundary.
 */
export async function requireAuthenticatedUser(): Promise<Response | null> {
  if (!process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY || !process.env.CLERK_SECRET_KEY) {
    return Response.json(
      { error: "Authentication is not configured" },
      { status: 503 },
    );
  }

  try {
    const { userId } = await auth();
    if (!userId) {
      return Response.json({ error: "Unauthorized" }, { status: 401 });
    }
    return null;
  } catch {
    return Response.json(
      { error: "Authentication is temporarily unavailable" },
      { status: 503 },
    );
  }
}
