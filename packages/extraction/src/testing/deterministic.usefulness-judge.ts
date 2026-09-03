import { singleton } from '@workspace/di';

import type { IUsefulnessJudge, RecalledFact } from '../usefulness-judge.js';
import type { UsefulnessVerdict } from '../usefulness-judge.schema.js';

/**
 * Deterministic usefulness judge for smoke/e2e (no API key). A recalled fact
 * counts as used when a distinctive word (>= 4 chars) from its content appears
 * in the transcript — a crude but stable proxy that lets specs exercise the
 * emit path without a live model.
 */
@singleton()
export class DeterministicUsefulnessJudge implements IUsefulnessJudge {
  judge(
    transcript: string,
    facts: RecalledFact[]
  ): Promise<UsefulnessVerdict[]> {
    const haystack = transcript.toLowerCase();
    const verdicts = facts.map((fact) => {
      const useful = fact.content
        .toLowerCase()
        .split(/[^a-z0-9]+/)
        .some((word) => word.length >= 4 && haystack.includes(word));
      // The crude proxy cannot separate the two axes; used ⇒ relevant holds.
      return {
        mem_id: fact.id,
        useful,
        relevant: useful,
        confidence: useful ? 1 : 0,
      };
    });
    return Promise.resolve(verdicts);
  }
}
