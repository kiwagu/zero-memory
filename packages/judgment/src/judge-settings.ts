import { inject } from '@workspace/di';

import type { JudgeProviderName } from './judgment.port.js';

/** An account's choice: whether the rule gate runs for it, and on which provider (null = platform default). */
export interface JudgeSettings {
  readonly enabled: boolean;
  readonly provider: JudgeProviderName | null;
}

export interface IJudgeSettingsReader {
  /**
   * The settings of `subjectId`. The Supabase reader reads under the caller's
   * access token, so it returns the row of that token's owner whatever is
   * passed: the caller must pass the same account as `subjectId`.
   */
  read(subjectId: string): Promise<JudgeSettings>;
}

export const JUDGE_SETTINGS_READER = Symbol.for(
  'zero-memory:judge-settings-reader'
);
export const injectJudgeSettingsReader = () => inject(JUDGE_SETTINGS_READER);
export const JUDGE_SETTINGS_OFF: JudgeSettings = {
  enabled: false,
  provider: null,
};
