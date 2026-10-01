import { NextResponse, type NextRequest } from 'next/server';

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
  // provider rejected the request — as `error` plus a readable
  // `error_description` and no code. That reason is what the login page must
  // show; "missing code" would describe the symptom and hide the cause.
  const refusal = searchParams.get('error');
  if (refusal) {
    const reason = searchParams.get('error_description') ?? refusal;
    return NextResponse.redirect(
      `${origin}/login?error=${encodeURIComponent(reason)}`
    );
  }

  if (!code) {
    return NextResponse.redirect(`${origin}/login?error=missing_code`);
  }

  const supabase = await createServerSupabaseClient();
  const { error } = await supabase.auth.exchangeCodeForSession(code);
  if (error) {
    return NextResponse.redirect(
      `${origin}/login?error=${encodeURIComponent(error.message)}`
    );
  }

  return NextResponse.redirect(`${origin}${next}`);
}
