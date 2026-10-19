import { NextRequest, NextResponse } from "next/server";

// Fast redirect only. The dashboard layout validates the session against SQLite.
export function middleware(request: NextRequest) {
  if (!request.cookies.has("xi.session_token") && !request.cookies.has("__Secure-xi.session_token")) {
    return NextResponse.redirect(new URL("/auth/login", request.url));
  }
  return NextResponse.next();
}

export const config = { matcher: ["/dashboard/:path*"] };
