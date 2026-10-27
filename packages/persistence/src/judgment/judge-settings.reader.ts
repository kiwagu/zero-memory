import { injectContext, type IContext } from '@workspace/context';
import { singleton } from '@workspace/di';
import {
  JudgeSettingsUnavailableError,
  JUDGE_PROVIDER_NAMES,
  JUDGE_SETTINGS_OFF,
  type IJudgeSettingsReader,
  type JudgeProviderName,
  type JudgeSettings,
} from '@workspace/judgment';
import { createLogger } from '@workspace/logger';

import { createUserClient } from '../supabase.client.js';

const logger = createLogger('judge-settings-reader');

/**
 * The caller's own rule-gate choice, read under their RLS: off without a
 * token or a row, and `JudgeSettingsUnavailableError` when the read fails.
 */
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
    if (error) {
      // The message only: nothing about the account's settings reaches the
      // log. A failed read is not "off": the gate reports the call as
      // unavailable.
      logger.warn('could not read judge settings', { error: error.message });
      throw new JudgeSettingsUnavailableError(
        `judge settings read failed: ${error.message}`
      );
    }
    if (!data) return JUDGE_SETTINGS_OFF;
    const provider = (JUDGE_PROVIDER_NAMES as readonly string[]).includes(
      String(data.provider)
    )
      ? (data.provider as JudgeProviderName)
      : null;
    return { enabled: data.enabled === true, provider };
  }
}
