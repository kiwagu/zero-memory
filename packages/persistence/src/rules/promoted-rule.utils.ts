import { type ContextRule, ruleCandidateIdSchema } from '@workspace/contracts';

/** What the readers keep of a live promoted rule row, text already trimmed. */
export interface StoredRule {
  id: string;
  text: string;
  pinned: boolean;
  appliesWhen: string | null;
}

/**
 * A promoted rule as the readers hand it on: its id, its whole text, its pin
 * and the condition of application only when one is stored — never as an
 * `applies_when: undefined` key, so a pack serialises the same whether or not
 * a rule has one. The condition is for the judge and for a full read of the
 * rule; a briefing decides whether the agent is sent it. The id is checked
 * here, where it leaves the database, as every other id is at its boundary.
 */
export const toContextRule = ({
  id,
  text,
  pinned,
  appliesWhen,
}: StoredRule): ContextRule => ({
  id: ruleCandidateIdSchema.parse(id),
  text,
  pinned,
  ...(appliesWhen ? { applies_when: appliesWhen } : {}),
});
