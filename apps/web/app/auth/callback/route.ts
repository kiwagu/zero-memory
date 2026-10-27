import { NextResponse, type NextRequest } from 'next/server';

import { authFailureOf } from '@/lib/auth-failure';
import { externalOrigin } from '@/lib/external-origin';
import { safeNext } from '@/lib/safe-next';
import { createServerSupabaseClient } from '@/lib/supabase/server';

/**
 * Email-confirmation / OAuth callback. Supabase redirects here with a `code`
 * after the user clicks the confirmation link; we exchange it for a session
 * (the PKCE verifier lives in a cookie set at sign-up) and land on the feed.
 */
export async function GET(request: NextRequest) {
  const { searchParams } = request.nextUrl;
  const origin = externalOrigin(request);
  const code = searchParams.get('code');
  // Attacker-controlled: a provider sign-in carries it through the provider
  // and back, so it is cleaned here the same way the login page cleans it.
  const next = safeNext(searchParams.get('next') ?? undefined);

  // Auth reports a refusal — the person cancelled at the provider, the
  // provider rejected the request — as `error` and `error_code`, plus a
  // readable `error_description`, and no code. The login page must say why,
  // not "missing code", which would describe the symptom and hide the cause;
  // it says so in its own words for the code, because this URL is anyone's to
  // craft and the description would put their text on the login page.
  const refusal = searchParams.get('error');
  if (refusal) {
    const failure = authFailureOf({
      error: refusal,
      errorCode: searchParams.get('error_code'),
    });
    return NextResponse.redirect(`${origin}/login?error=${failure}`);
  }

  if (!code) {
    return NextResponse.redirect(`${origin}/login?error=missing_code`);
  }

  const supabase = await createServerSupabaseClient();
  const { error } = await supabase.auth.exchangeCodeForSession(code);
  if (error) {
    console.warn('auth callback: code exchange failed', {
      error: error.message,
    });
    return NextResponse.redirect(`${origin}/login?error=exchange_failed`);
  }

  return NextResponse.redirect(`${origin}${next}`);
}
