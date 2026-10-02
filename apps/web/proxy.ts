import { createServerClient } from '@supabase/ssr';
import { NextResponse, type NextRequest } from 'next/server';

import { safeNext } from './lib/safe-next';
import { serverSupabaseEnvironment } from './lib/supabase/env';

/**
 * Session refresh + route protection. Everything except /login requires a
 * signed-in user; a signed-in user hitting /login is bounced to the feed.
 * `getClaims` verifies the JWT against the project JWKS (no per-request
 * round-trip to the auth server after the key set is cached).
 */
export async function proxy(request: NextRequest) {
  // Server layouts cannot read the URL; the dashboard layout needs the path
  // to send an account back to it after a one-time acceptance. Set on the
  // REQUEST so every `NextResponse.next({ request })` below forwards it.
  request.headers.set(
    'x-pathname',
    request.nextUrl.pathname + request.nextUrl.search
  );
  let response = NextResponse.next({ request });
  const { url, anonKey, authCookieName } = serverSupabaseEnvironment();

  const supabase = createServerClient(url, anonKey, {
    cookieOptions: {
      name: authCookieName,
    },
    cookies: {
      getAll() {
        return request.cookies.getAll();
      },
      setAll(cookiesToSet) {
        cookiesToSet.forEach(({ name, value }) =>
          request.cookies.set(name, value)
        );
        response = NextResponse.next({ request });
        cookiesToSet.forEach(({ name, value, options }) =>
          response.cookies.set(name, value, options)
        );
      },
    },
  });

  const { data } = await supabase.auth.getClaims();
  const isAuthenticated = Boolean(data?.claims);
  const { pathname } = request.nextUrl;
  const isLoginPage = pathname === '/login';
  // Public routes that work without a session: login, password-reset request,
  // and the email callback (which exchanges its code before a session exists).
  // `/reset-password` MUST be public: it is where a recovery link lands, and
  // the whole point of that link is that the person cannot sign in. Guarding
  // it bounces the arrival to /login and the recovery silently does nothing.
  const isPublic =
    isLoginPage ||
    pathname === '/forgot-password' ||
    pathname === '/reset-password' ||
    pathname.startsWith('/auth/');

  if (!isAuthenticated && !isPublic) {
    // Keep where the guest was going: after sign-in the login page sends them
    // back there. The dashboard root is the default and needs no parameter.
    const destination = pathname + request.nextUrl.search;
    const url = request.nextUrl.clone();
    url.pathname = '/login';
    url.search = '';
    if (destination !== '/') {
      url.searchParams.set('next', destination);
    }
    return NextResponse.redirect(url);
  }

  if (isAuthenticated && isLoginPage) {
    const next = safeNext(
      request.nextUrl.searchParams.get('next') ?? undefined
    );
    const url = request.nextUrl.clone();
    url.pathname = '/';
    url.search = '';
    const target = new URL(next, url);
    // `safeNext` already refused anything that could resolve elsewhere; the
    // origin check is the second lock on the same door.
    return NextResponse.redirect(target.origin === url.origin ? target : url);
  }

  return response;
}

export const config = {
  matcher: [
    // `healthz` is excluded for the same reason as the templates below: it
    // is a machine endpoint with no session, and a guard redirect would turn
    // "the dashboard is unreachable" into a 307 that reads as success.
    // `email-templates/` is excluded deliberately, not for performance: a
    // self-hosted Auth FETCHES the authentication templates from this server
    // over HTTP, with no session of any kind. Left to the session check below,
    // the fetch gets a 307 to /login, Auth silently falls back to its built-in
    // templates, and every user gets a mail we did not write. Static assets
    // under public/ are also matched by extension only, so an `.html` there
    // would otherwise not be excluded either.
    '/((?!_next/static|_next/image|favicon.ico|healthz|email-templates/|.*\\.(?:svg|png|jpg|jpeg|gif|webp|ico)$).*)',
  ],
};
