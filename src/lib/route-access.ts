const PUBLIC_EXACT_PATHS = new Set(["/sign-in", "/fund", "/proof"]);
const PUBLIC_PREFIXES = ["/sign-in/", "/api/cron/", "/fund/", "/proof/", "/api/fund/"];

export function isPublicPath(pathname: string): boolean {
  return PUBLIC_EXACT_PATHS.has(pathname)
    || PUBLIC_PREFIXES.some((prefix) => pathname.startsWith(prefix));
}
