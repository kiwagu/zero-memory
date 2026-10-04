import { createServerClient } from '@supabase/ssr';
import { NextResponse, type NextRequest } from 'next/server';

import { safeNext } from './lib/safe-next';
import {
  AGENT_SESSION_REFUSAL,
  ASSURANCE_UNAVAILABLE,
  SECOND_FACTOR_REFUSAL,
  assuranceGap,
  sessionAssuranceSchema,
} from './lib/session-assurance';
import { secureCookies } from './lib/supabase/cookie-security';
import { serverSupabaseEnvironment } from './lib/supabase/env';

/**
 * Whether the browser is navigating to a page, as opposed to code fetching an
 * answer: every current browser marks a navigation, and a request that only
 * accepts HTML is one too.
 */
const navigates = (request: NextRequest): boolean =>
  request.headers.get('sec-fetch-mode') === 'navigate' ||
  (request.headers.get('accept') ?? '').includes('text/html');

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
      secure: secureCookies(request.headers),
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

  // A signed-in session is not yet a complete sign-in. On an account with a
  // second factor it sees nothing but the page that asks for the code until
  // the code is given, and a session the authorization server opened for an
  // agent is not a person's at all. Decided here, for every path the
  // dashboard serves — pages, route handlers, server actions — rather than in
  // one layout, which a route handler never passes through. The database
  // applies the same rule to every row; this check only says why.
  if (isAuthenticated && !isPublic) {
    const { data, error } = await supabase.rpc('session_assurance');
    const assurance = error ? null : sessionAssuranceSchema.safeParse(data);
    if (!assurance?.success) {
      return new NextResponse(ASSURANCE_UNAVAILABLE, { status: 503 });
    }
    if (assurance.data.agent) {
      return new NextResponse(AGENT_SESSION_REFUSAL, { status: 403 });
    }
    if (
      pathname !== '/mfa/verify' &&
      assuranceGap(assurance.data.aal, assurance.data.verified_factors) ===
        'verify'
    ) {
      // A person navigating is sent to give the code and brought back; a
      // request made by code — a route handler called from a page, an API
      // route, a server action — gets the refusal itself, since a redirect
      // would hand it a sign-in page where it expected an answer.
      if (!navigates(request)) {
        return new NextResponse(SECOND_FACTOR_REFUSAL, { status: 403 });
      }
      const destination = pathname + request.nextUrl.search;
      const url = request.nextUrl.clone();
      url.pathname = '/mfa/verify';
      url.search = '';
      if (destination !== '/') {
        url.searchParams.set('next', safeNext(destination));
      }
      return NextResponse.redirect(url);
    }
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
