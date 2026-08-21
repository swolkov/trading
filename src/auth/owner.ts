import { auth } from "@clerk/nextjs/server";
import { evaluateOwnerAuthorization } from "@/auth/owner-policy";

type OwnerAuthorizationResult =
  | { userId: string; response: null }
  | { userId: null; response: Response };

function authorizationFailure(status: ReturnType<typeof evaluateOwnerAuthorization>): Response {
  if (status === "misconfigured") {
    return Response.json(
      { error: "Owner authorization is not configured" },
      { status: 503 },
    );
  }

  if (status === "unauthenticated") {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }

  return Response.json({ error: "Forbidden" }, { status: 403 });
}

export async function authorizeOwnerRequest(): Promise<OwnerAuthorizationResult> {
  if (!process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY || !process.env.CLERK_SECRET_KEY) {
    return {
      userId: null,
      response: Response.json(
        { error: "Authentication is not configured" },
        { status: 503 },
      ),
    };
  }

  try {
    const { userId } = await auth();
    const status = evaluateOwnerAuthorization(userId, process.env.CLERK_OWNER_USER_ID);

    if (status !== "authorized" || !userId) {
      return { userId: null, response: authorizationFailure(status) };
    }

    return { userId, response: null };
  } catch {
    return {
      userId: null,
      response: Response.json(
        { error: "Authentication is temporarily unavailable" },
        { status: 503 },
      ),
    };
  }
}

/**
 * Defense-in-depth authorization for state-changing API routes.
 * Proxy protects the route tree, while mutations also verify the configured
 * owner at the handler boundary.
 */
export async function requireOwnerUser(): Promise<Response | null> {
  const result = await authorizeOwnerRequest();
  return result.response;
}
