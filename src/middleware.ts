import { NextResponse } from "next/server";
import type { NextRequest, NextFetchEvent } from "next/server";

// Dynamic import to avoid @clerk/nextjs/server throwing at module load when keys are missing
export default async function middleware(request: NextRequest, event: NextFetchEvent) {
  // If Clerk keys aren't configured, skip auth entirely (site runs without auth)
  if (!process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY || !process.env.CLERK_SECRET_KEY) {
    return NextResponse.next();
  }

  try {
    const { clerkMiddleware, createRouteMatcher } = await import("@clerk/nextjs/server");

    const isPublicRoute = createRouteMatcher([
      "/sign-in(.*)",
      "/api/cron/(.*)",      // Cron jobs use CRON_SECRET, not user auth
      "/api/futures/(.*)",   // Internal engine endpoints
    ]);

    const handler = clerkMiddleware(async (auth, req) => {
      if (!isPublicRoute(req)) {
        await auth.protect();
      }
    });

    return handler(request, event);
  } catch {
    // If Clerk fails for any reason, allow the request through
    return NextResponse.next();
  }
}

export const config = {
  matcher: [
    // Skip Next.js internals and static files
    "/((?!_next|[^?]*\\.(?:html?|css|js(?!on)|jpe?g|webp|png|gif|svg|ttf|woff2?|ico|csv|docx?|xlsx?|zip|webmanifest)).*)",
    // Always run for API routes
    "/(api|trpc)(.*)",
  ],
};
