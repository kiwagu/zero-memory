import {
  memoryIdSchema,
  type ForgetOutput,
  type RuleFate,
} from '@workspace/contracts';

import type { RuleFateFact } from './rule-fate.reader.js';

/**
 * The writer's report of a supersede that touched a promoted rule. Each note
 * says what the store did and, when something is left to decide, who decides
 * it and with which call — the writer is the one agent that knows what the
 * successor now says.
 */
export const ruleFateReport = (fact: RuleFateFact): RuleFate => {
  const { memoryId: from, successorId: to } = fact;
  const note = (() => {
    switch (fact.outcome) {
      case 'carried':
        return (
          `The promoted rule anchored to ${from} moved to ${to} and now uses ` +
          `its text, since its text was that memory's own words.`
        );
      case 'carried_text_kept':
        return (
          `The promoted rule anchored to ${from} moved to ${to} but kept its ` +
          `curated text, now flagged for review on /rules. If that text no ` +
          `longer says what ${to} says, set it: ` +
          `promote_rule(memory_id: "${to}", rule_text: "...").`
        );
      case 'not_carried':
        return (
          `The promoted rule anchored to ${from} stayed on it and is still ` +
          `delivered: ${to} ` +
          (fact.successorCandidacy
            ? `already has a rule candidacy of its own ` +
              `(${fact.successorCandidacy}).`
            : `could not take it.`) +
          ` The owner decides on /rules.`
        );
    }
  })();
  return {
    memory_id: memoryIdSchema.parse(from),
    outcome: fact.outcome,
    successor_id: memoryIdSchema.parse(to),
    note,
  };
};

/** The report on a forgotten memory that carries a promoted rule. */
export const keptLiveRule = (
  memoryId: string
): NonNullable<ForgetOutput['rule']> => ({
  outcome: 'kept_live',
  note:
    `The promoted rule anchored to ${memoryId} stays live and keeps ` +
    `reaching sessions: forgetting a memory does not retire its rule. Only ` +
    `the owner revokes a rule, on /rules.`,
});
