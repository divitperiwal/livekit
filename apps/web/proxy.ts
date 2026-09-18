/**
 * Sends anyone without a session to the sign-in page.
 *
 * `proxy.ts` rather than `middleware.ts`: the latter is deprecated in Next 16
 * and only the file and export names changed.
 *
 * This checks that a cookie is *present*, not that it is valid -- validating
 * would mean a Redis round trip on every navigation. The API checks properly
 * on every request, so the worst a forged cookie achieves is reaching a page
 * that then fails to load any data. This is a redirect for convenience, not a
 * security boundary.
 */

import { NextResponse, type NextRequest } from "next/server";

const SESSION_COOKIE = "automitra_session";

export function proxy(request: NextRequest) {
  const signedIn = Boolean(request.cookies.get(SESSION_COOKIE)?.value);
  const { pathname } = request.nextUrl;
  const onLoginPage = pathname === "/login";

  if (!signedIn && !onLoginPage) {
    const url = request.nextUrl.clone();
    url.pathname = "/login";
    // So signing in returns to wherever they were headed.
    if (pathname !== "/") url.searchParams.set("next", pathname);
    return NextResponse.redirect(url);
  }

  if (signedIn && onLoginPage) {
    const url = request.nextUrl.clone();
    url.pathname = "/calls";
    url.search = "";
    return NextResponse.redirect(url);
  }

  return NextResponse.next();
}

export const config = {
  // Everything except Next's own assets and the favicon.
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
