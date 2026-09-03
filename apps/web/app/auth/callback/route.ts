import { NextResponse, type NextRequest } from 'next/server';

import { externalOrigin } from '@/lib/external-origin';
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
  const next = searchParams.get('next') ?? '/';

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
