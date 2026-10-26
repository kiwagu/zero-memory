import { injectContext, type IContext } from '@workspace/context';
import { singleton } from '@workspace/di';
import {
  JUDGE_PROVIDER_NAMES,
  JUDGE_SETTINGS_OFF,
  type IJudgeSettingsReader,
  type JudgeProviderName,
  type JudgeSettings,
} from '@workspace/judgment';

import { createUserClient } from '../supabase.client.js';

/** The caller's own rule-gate choice, read under their RLS; off when no row. */
@singleton()
export class SupabaseJudgeSettingsReader implements IJudgeSettingsReader {
  constructor(
    @injectContext()
    private readonly context: IContext
  ) {}

  async read(_subjectId: string): Promise<JudgeSettings> {
    const accessToken = this.context.getAccessToken();
    if (!accessToken) return JUDGE_SETTINGS_OFF;
    const { data, error } = await createUserClient(accessToken)
      .from('judge_settings')
      .select('enabled, provider')
      .maybeSingle();
    if (error || !data) return JUDGE_SETTINGS_OFF;
    const provider = (JUDGE_PROVIDER_NAMES as readonly string[]).includes(
      String(data.provider)
    )
      ? (data.provider as JudgeProviderName)
      : null;
    return { enabled: data.enabled === true, provider };
  }
}
