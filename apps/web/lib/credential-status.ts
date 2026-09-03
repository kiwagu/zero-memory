import { createServerSupabaseClient } from '@/lib/supabase/server';

/** What a user may know about their own stored key. Never the key. */
export interface CredentialStatus {
  provider: string;
  model: string | null;
  /** Endpoint for a non-fixed-location provider (Ollama); null otherwise. */
  baseUrl: string | null;
  /** Last four characters, for recognition only. */
  hint: string;
}

/**
 * Reads the status of the caller's own credential.
 *
 * Goes through the user's own session, so the row-level policy is what scopes
 * it — the same guarantee the rest of the dashboard leans on, rather than a
 * filter this code has to remember. Writing a key is deliberately elsewhere:
 * see the route handler under settings/provider-key.
 */
export async function readCredentialStatus(): Promise<CredentialStatus | null> {
  const supabase = await createServerSupabaseClient();
  const { data } = await supabase
    .from('provider_credentials')
    .select('provider, model, base_url, hint')
    .maybeSingle();
  if (!data) return null;

  const row = data as {
    provider: string;
    model: string | null;
    base_url: string | null;
    hint: string;
  };
  return {
    provider: row.provider,
    model: row.model,
    baseUrl: row.base_url,
    hint: row.hint,
  };
}
