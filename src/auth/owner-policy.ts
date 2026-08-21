export type OwnerAuthorizationStatus =
  | "authorized"
  | "unauthenticated"
  | "forbidden"
  | "misconfigured";

export function evaluateOwnerAuthorization(
  userId: string | null | undefined,
  configuredOwnerUserId: string | null | undefined,
): OwnerAuthorizationStatus {
  const ownerUserId = configuredOwnerUserId?.trim();

  if (!ownerUserId) return "misconfigured";
  if (!userId) return "unauthenticated";
  return userId === ownerUserId ? "authorized" : "forbidden";
}
