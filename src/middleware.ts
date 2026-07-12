import { NextResponse } from "next/server";
import NextAuth from "next-auth";
import { authConfig } from "@/auth.config";
import { impersonationGatesPass } from "@/lib/devImpersonation";

const { auth } = NextAuth(authConfig);

// Edge-safe middleware: uses the adapter-less authConfig.
export default auth((req) => {
  const { pathname } = req.nextUrl;
  const isPublic =
    pathname === "/" ||
    pathname.startsWith("/login") ||
    pathname.startsWith("/register") ||
    pathname.startsWith("/api/auth") ||
    pathname.startsWith("/api/mcp") ||
    pathname === "/api/health" ||
    pathname.startsWith("/_next") ||
    pathname.startsWith("/favicon") ||
    /\.(png|jpg|jpeg|svg|webp|ico|gif|woff2?)$/i.test(pathname);

  if (isPublic) return NextResponse.next();
  // Dev impersonation: when env opt-in and header present + allowed, skip the
  // login redirect. Server-side auth() will reconstruct the session.
  if (impersonationGatesPass(req.headers)) return NextResponse.next();
  if (!req.auth) {
    const url = req.nextUrl.clone();
    url.pathname = "/login";
    url.searchParams.set("next", pathname);
    return NextResponse.redirect(url);
  }
  return NextResponse.next();
});

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
