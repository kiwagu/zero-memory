import { NextResponse, type NextRequest } from 'next/server';

// The decorator-free subpath: the package root would load the DI container
// and decorator metadata into the Next bundle.
import { SUBQ_ADAPTER_AVAILABLE } from '@workspace/judgment/availability';

import { notFromDashboard, refusedOrigin } from '@/lib/dashboard-origin';
import { secondFactorRefusal } from '@/lib/mfa';
import { currentSubjectId } from '@/lib/subject';
import { createAdminClient } from '@/lib/supabase/admin';
import { createServerSupabaseClient } from '@/lib/supabase/server';

/**
 * The rule-delivery judge of the signed-in account: on or off and which
 * provider (PATCH), and its own decision-model key (POST installs, DELETE
 * withdraws).
 *
 * A route handler rather than a server action for the reason the provider-key
 * route gives: Next logs server-action arguments, so a key passed that way
 * would land in the dev server's log in plaintext. A request body is not
 * logged. The settings travel the same way so the panel has one endpoint.
 */

const PROVIDERS = ['typesafe', 'subq'] as const;
type JudgeProvider = (typeof PROVIDERS)[number];

/** A provider this build can run: SubQ Snap only when its adapter ships. */
const isProvider = (value: unknown): value is JudgeProvider =>
  (PROVIDERS as readonly unknown[]).includes(value) &&
  (value !== 'subq' || SUBQ_ADAPTER_AVAILABLE);

/**
 * Rough shape check before the key goes any further. Not validation — only
 * the vendor can say whether a key works. This catches the paste that went
 * wrong: empty, truncated, or a whole file.
 */
const looksLikeKey = (key: string): boolean =>
  key.length >= 16 && key.length <= 400 && !/\s/.test(key);

/** A model name is a short identifier, never free text. */
const looksLikeModel = (model: string): boolean =>
  model.length <= 100 && !/\s/.test(model);

const badRequest = (error: string) =>
  NextResponse.json({ error }, { status: 400 });

/** Read the JSON body; a body that is not a JSON object reads as empty. */
const readBody = async (
  request: NextRequest
): Promise<Record<string, unknown>> => {
  const body: unknown = await request.json().catch(() => null);
  return typeof body === 'object' && body !== null && !Array.isArray(body)
    ? (body as Record<string, unknown>)
    : {};
};

/**
 * The signed-in account, refused when the session still owes its second
 * factor: these writes go past the page gate (the key with the service role,
 * the settings straight to the table), so they hold the same line.
 */
const signedInSubject = async (): Promise<
  { subjectId: string } | { refusal: NextResponse }
> => {
  const subjectId = await currentSubjectId();
  if (!subjectId) {
    return {
      refusal: NextResponse.json({ error: 'Not signed in.' }, { status: 401 }),
    };
  }
  const refused = await secondFactorRefusal(await createServerSupabaseClient());
  if (refused) {
    return {
      refusal: NextResponse.json(
        { error: await refused.text() },
        { status: refused.status }
      ),
    };
  }
  return { subjectId };
};

const missingServiceRole = () =>
  NextResponse.json(
    { error: 'SUPABASE_SERVICE_ROLE_KEY is not configured on the server.' },
    { status: 500 }
  );

export async function PATCH(request: NextRequest) {
  if (notFromDashboard(request, true)) {
    return refusedOrigin();
  }
  const { enabled, provider } = await readBody(request);
  if (enabled === undefined && provider === undefined) {
    return badRequest('Nothing to change: send "enabled" or "provider".');
  }
  if (enabled !== undefined && typeof enabled !== 'boolean') {
    return badRequest('"enabled" must be true or false.');
  }
  if (provider !== undefined && provider !== null && !isProvider(provider)) {
    return badRequest('Unknown judge provider.');
  }

  const signedIn = await signedInSubject();
  if ('refusal' in signedIn) {
    return signedIn.refusal;
  }

  // The settings row holds no secret, so it is written as the signed-in user
  // and the row-level policy is what keeps it theirs.
  const supabase = await createServerSupabaseClient();
  const { error } = await supabase.from('judge_settings').upsert(
    {
      subject_id: signedIn.subjectId,
      ...(typeof enabled === 'boolean' && { enabled }),
      ...(provider !== undefined && { provider }),
      updated_at: new Date().toISOString(),
    },
    { onConflict: 'subject_id' }
  );
  if (error) {
    return NextResponse.json(
      { error: 'Could not save the judge settings.' },
      { status: 500 }
    );
  }
  return NextResponse.json({ ok: true });
}

export async function POST(request: NextRequest) {
  if (notFromDashboard(request, true)) {
    return refusedOrigin();
  }
  const body = await readBody(request);
  const provider = body.provider;
  const apiKey = typeof body.apiKey === 'string' ? body.apiKey.trim() : '';
  const model = typeof body.model === 'string' ? body.model.trim() : '';

  if (!isProvider(provider)) {
    return badRequest('Unknown judge provider.');
  }
  if (!looksLikeKey(apiKey)) {
    return badRequest(
      'That does not look like an API key — check it and retry.'
    );
  }
  if (!looksLikeModel(model)) {
    return badRequest('That does not look like a model name.');
  }

  const signedIn = await signedInSubject();
  if ('refusal' in signedIn) {
    return signedIn.refusal;
  }
  const admin = createAdminClient();
  if (!admin) {
    return missingServiceRole();
  }

  const { error } = await admin.rpc('set_judge_credential', {
    p_subject_id: signedIn.subjectId,
    p_provider: provider,
    p_api_key: apiKey,
    p_model: model === '' ? undefined : model,
  });
  // A database message could quote the argument it was given, so only a fixed
  // string goes back over the wire.
  if (error) {
    return NextResponse.json(
      { error: 'Could not store the key.' },
      { status: 500 }
    );
  }

  // An own key wins over the chosen provider, so the choice follows the key:
  // what the settings show and what judging runs on cannot disagree.
  const supabase = await createServerSupabaseClient();
  const { error: settingsError } = await supabase.from('judge_settings').upsert(
    {
      subject_id: signedIn.subjectId,
      provider,
      updated_at: new Date().toISOString(),
    },
    { onConflict: 'subject_id' }
  );
  if (settingsError) {
    return NextResponse.json(
      { error: 'The key is stored, but the provider choice was not saved.' },
      { status: 500 }
    );
  }

  return NextResponse.json({ hint: apiKey.slice(-4) });
}

export async function DELETE(request: NextRequest) {
  if (notFromDashboard(request, false)) {
    return refusedOrigin();
  }
  const signedIn = await signedInSubject();
  if ('refusal' in signedIn) {
    return signedIn.refusal;
  }
  const admin = createAdminClient();
  if (!admin) {
    return missingServiceRole();
  }

  // The provider choice stays as it is: withdrawing a key does not choose.
  const { error } = await admin.rpc('revoke_judge_credential', {
    p_subject_id: signedIn.subjectId,
  });
  if (error) {
    return NextResponse.json(
      { error: 'Could not revoke the key.' },
      { status: 500 }
    );
  }

  return NextResponse.json({ ok: true });
}
