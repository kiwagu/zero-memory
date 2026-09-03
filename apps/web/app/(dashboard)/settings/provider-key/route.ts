import { NextResponse, type NextRequest } from 'next/server';

import { createAdminClient } from '@/lib/supabase/admin';
import { createServerSupabaseClient } from '@/lib/supabase/server';

/**
 * Installing and withdrawing a user's own provider key.
 *
 * A route handler rather than a server action, for one specific reason: Next
 * logs every server-action call with its arguments, so a key passed that way
 * lands in the dev server's log in plaintext. A request body is not logged.
 * The whole point of this surface is that the key reaches Vault without being
 * written down anywhere on the way.
 */

const PROVIDERS = [
  'anthropic',
  'openai',
  'xai',
  'deepseek',
  'moonshot',
  'ollama',
] as const;

/** Providers whose endpoint the user supplies and which carry no key of their own. */
const ENDPOINT_PROVIDERS = new Set(['ollama']);

/**
 * Rough shape check before the key goes any further. Not validation — only
 * the vendor can say whether a key works, and that happens on first use. This
 * catches the paste that went wrong: empty, truncated, or a whole file.
 */
const looksLikeKey = (key: string): boolean =>
  key.length >= 20 && key.length <= 400 && !/\s/.test(key);

/** An endpoint override is only ever an http(s) URL, and only for its provider. */
const looksLikeBaseUrl = (url: string): boolean =>
  /^https?:\/\/\S+$/.test(url) && url.length <= 400;

/**
 * The caller's own `usr_` id.
 *
 * Derived from `getUser()` — which verifies the session against the auth
 * server — and then matched explicitly on `user_id`. Both halves matter: the
 * profiles table is readable by any signed-in user, so a query without that
 * filter would return everybody's rows, not the caller's.
 */
const currentSubjectId = async (): Promise<string | null> => {
  const supabase = await createServerSupabaseClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return null;

  const { data } = await supabase
    .from('profiles')
    .select('id')
    .eq('user_id', user.id)
    .maybeSingle();
  return (data as { id: string } | null)?.id ?? null;
};

export async function POST(request: NextRequest) {
  const body = (await request.json()) as {
    provider?: unknown;
    apiKey?: unknown;
    model?: unknown;
    baseUrl?: unknown;
  };
  const provider = typeof body.provider === 'string' ? body.provider : '';
  const apiKey = typeof body.apiKey === 'string' ? body.apiKey.trim() : '';
  const model = typeof body.model === 'string' ? body.model.trim() : '';
  const baseUrl = typeof body.baseUrl === 'string' ? body.baseUrl.trim() : '';

  if (!(PROVIDERS as readonly string[]).includes(provider)) {
    return NextResponse.json(
      { error: `Unknown provider: "${provider}".` },
      { status: 400 }
    );
  }

  const needsBaseUrl = ENDPOINT_PROVIDERS.has(provider);
  if (needsBaseUrl) {
    // A local endpoint has no key to give, so the key is optional here; the
    // endpoint is what identifies it, and it is only ever an http(s) URL.
    if (!looksLikeBaseUrl(baseUrl)) {
      return NextResponse.json(
        { error: 'That does not look like an http(s) endpoint URL.' },
        { status: 400 }
      );
    }
  } else {
    // A base URL on a fixed-endpoint vendor is rejected outright — the closed
    // set of endpoints is the whole point.
    if (baseUrl !== '') {
      return NextResponse.json(
        { error: 'This provider does not take an endpoint URL.' },
        { status: 400 }
      );
    }
    if (!looksLikeKey(apiKey)) {
      return NextResponse.json(
        { error: 'That does not look like an API key — check it and retry.' },
        { status: 400 }
      );
    }
  }

  const subjectId = await currentSubjectId();
  if (!subjectId) {
    return NextResponse.json({ error: 'Not signed in.' }, { status: 401 });
  }

  const admin = createAdminClient();
  if (!admin) {
    return NextResponse.json(
      { error: 'SUPABASE_SERVICE_ROLE_KEY is not configured on the server.' },
      { status: 500 }
    );
  }

  const { error } = await admin.rpc('set_provider_credential', {
    p_subject_id: subjectId,
    p_provider: provider,
    p_api_key: apiKey,
    p_model: model === '' ? undefined : model,
    p_base_url: needsBaseUrl ? baseUrl : undefined,
  });
  // A database message could quote the argument it was given, so only a fixed
  // string goes back over the wire.
  if (error) {
    return NextResponse.json(
      { error: 'Could not store the key.' },
      { status: 500 }
    );
  }

  return NextResponse.json({ hint: apiKey.slice(-4) });
}

export async function DELETE() {
  const subjectId = await currentSubjectId();
  if (!subjectId) {
    return NextResponse.json({ error: 'Not signed in.' }, { status: 401 });
  }

  const admin = createAdminClient();
  if (!admin) {
    return NextResponse.json(
      { error: 'SUPABASE_SERVICE_ROLE_KEY is not configured on the server.' },
      { status: 500 }
    );
  }

  const { error } = await admin.rpc('revoke_provider_credential', {
    p_subject_id: subjectId,
  });
  if (error) {
    return NextResponse.json(
      { error: 'Could not revoke the key.' },
      { status: 500 }
    );
  }

  return NextResponse.json({ ok: true });
}
