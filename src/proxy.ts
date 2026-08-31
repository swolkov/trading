import { NextResponse } from "next/server";
import type { NextFetchEvent, NextRequest } from "next/server";
import { evaluateOwnerAuthorization } from "@/auth/owner-policy";
import { isPublicPath } from "@/lib/route-access";

// Pages retired with futures trading (Aug 2026). Their code remains in the repo
// for reversibility, but they are unlinked from the nav and redirect home.
const RETIRED_PREFIXES = [
  "/futures",
  "/kraken",          // old BTC/ETH trend bot — disabled Aug 31 2026, capital parked in coins
  "/demo-vs-live",
  "/connect",
  "/performance",
  "/backtest",
  "/agents",
  "/admin",
  "/edges",
  "/journal",
  "/fund",
  "/proof",
];

export default async function proxy(request: NextRequest, event: NextFetchEvent) {
  const { pathname } = request.nextUrl;
  if (RETIRED_PREFIXES.some((p) => pathname === p || pathname.startsWith(p + "/"))) {
    return NextResponse.redirect(new URL("/", request.url));
  }

  if (isPublicPath(pathname)) {
    return NextResponse.next();
  }

  // Private routes fail closed. Missing or broken auth must never expose trading controls.
  if (
    !process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY
    || !process.env.CLERK_SECRET_KEY
    || !process.env.CLERK_OWNER_USER_ID?.trim()
  ) {
    return NextResponse.json(
      { error: "Authentication is not configured" },
      { status: 503 },
    );
  }

  try {
    const { clerkMiddleware } = await import("@clerk/nextjs/server");
    const handler = clerkMiddleware(
      async (auth) => {
        const { userId } = await auth.protect();
        const status = evaluateOwnerAuthorization(userId, process.env.CLERK_OWNER_USER_ID);

        if (status !== "authorized") {
          return NextResponse.json({ error: "Forbidden" }, { status: 403 });
        }
      },
      { frontendApiProxy: { enabled: true } },
    );
    return handler(request, event);
  } catch {
    return NextResponse.json(
      { error: "Authentication is temporarily unavailable" },
      { status: 503 },
    );
  }
}

export const config = {
  matcher: [
    "/__clerk(.*)",
    "/((?!_next|[^?]*\\.(?:html?|css|js(?!on)|jpe?g|webp|png|gif|svg|ttf|woff2?|ico|csv|docx?|xlsx?|zip|webmanifest)).*)",
    "/(api|trpc)(.*)",
  ],
};
