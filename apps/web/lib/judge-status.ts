// The decorator-free subpath: the package root would load the DI container
// and decorator metadata into the Next bundle.
import { SUBQ_ADAPTER_AVAILABLE } from '@workspace/judgment/availability';

import { createServerSupabaseClient } from '@/lib/supabase/server';

type JudgeProvider = 'typesafe' | 'subq';

/** What a user may know about their own rule-delivery judge. Never the key. */
export interface JudgeStatus {
  enabled: boolean;
  /** The account's choice; null leaves it to the instance default. */
  provider: JudgeProvider | null;
  platformDefault: JudgeProvider;
  /** The account's own key by provider, last four characters and model. */
  credential: { provider: string; hint: string; model: string | null } | null;
  /** Whether this build can run SubQ Snap, so whether it is offered. */
  subqAvailable: boolean;
}

const asProvider = (value: unknown): JudgeProvider | null =>
  value === 'typesafe' || value === 'subq' ? value : null;

/**
 * The caller's rule-gate choice and key metadata, through their own session:
 * the row-level policy is what scopes both reads. Writing either is the route
 * handler under settings/judge-provider.
 */
export async function readJudgeStatus(): Promise<JudgeStatus> {
  const supabase = await createServerSupabaseClient();
  const [{ data: settings }, { data: credential }] = await Promise.all([
    supabase.from('judge_settings').select('enabled, provider').maybeSingle(),
    supabase
      .from('judge_credentials')
      .select('provider, hint, model')
      .maybeSingle(),
  ]);
  return {
    enabled: settings?.enabled === true,
    provider: asProvider(settings?.provider),
    platformDefault:
      process.env.ZM_JUDGE_PROVIDER === 'subq' ? 'subq' : 'typesafe',
    credential: credential
      ? {
          provider: credential.provider,
          hint: credential.hint,
          model: credential.model,
        }
      : null,
    subqAvailable: SUBQ_ADAPTER_AVAILABLE,
  };
}
