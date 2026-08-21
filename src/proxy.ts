import { NextResponse } from "next/server";
import type { NextFetchEvent, NextRequest } from "next/server";
import { isPublicPath } from "@/lib/route-access";

export default async function proxy(request: NextRequest, event: NextFetchEvent) {
  if (isPublicPath(request.nextUrl.pathname)) {
    return NextResponse.next();
  }

  // Private routes fail closed. Missing or broken auth must never expose trading controls.
  if (!process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY || !process.env.CLERK_SECRET_KEY) {
    return NextResponse.json(
      { error: "Authentication is not configured" },
      { status: 503 },
    );
  }

  try {
    const { clerkMiddleware } = await import("@clerk/nextjs/server");
    const handler = clerkMiddleware(async (auth) => {
      await auth.protect();
    });
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
    "/((?!_next|[^?]*\\.(?:html?|css|js(?!on)|jpe?g|webp|png|gif|svg|ttf|woff2?|ico|csv|docx?|xlsx?|zip|webmanifest)).*)",
    "/(api|trpc)(.*)",
  ],
};
