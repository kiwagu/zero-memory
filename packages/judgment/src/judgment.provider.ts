import { inject } from '@workspace/di';

import type { ResolvedJudgeCredential } from './judge-credential.js';
import type { IJudgment } from './judgment.port.js';
import { SubqJudgment } from './subq.adapter.js';
import { TypeSafeJudgment } from './typesafe.adapter.js';

/** Builds the adapter a resolved credential names. One place, like the LLM model factory. */
export type JudgmentFactory = (
  credential: ResolvedJudgeCredential
) => IJudgment;

export const defaultJudgmentFactory: JudgmentFactory = (credential) => {
  switch (credential.provider) {
    case 'typesafe':
      return new TypeSafeJudgment({
        apiKey: credential.apiKey,
        model: credential.model,
      });
    case 'subq':
      return new SubqJudgment({
        apiKey: credential.apiKey,
        model: credential.model,
      });
    default:
      // Unreachable for a typed caller; a value from outside the closed set
      // must fail loudly here rather than build no judge at all.
      throw new Error(
        `judgment: unknown provider ${String(credential.provider)}`
      );
  }
};

export const JUDGMENT_FACTORY = Symbol.for('zero-memory:judgment-factory');
export const injectJudgmentFactory = () => inject(JUDGMENT_FACTORY);
