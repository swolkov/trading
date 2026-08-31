// /fund and /proof (the public futures track record) were unpublished when
// futures trading was retired in Aug 2026 — they now require owner auth.
const PUBLIC_EXACT_PATHS = new Set(["/sign-in"]);
const PUBLIC_PREFIXES = ["/sign-in/", "/api/cron/", "/api/webhook/"];

export function isPublicPath(pathname: string): boolean {
  return PUBLIC_EXACT_PATHS.has(pathname)
    || PUBLIC_PREFIXES.some((prefix) => pathname.startsWith(prefix));
}
