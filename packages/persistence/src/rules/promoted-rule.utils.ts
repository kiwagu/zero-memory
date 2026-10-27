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
 * here, where it leaves the database, as every other id is at its boundary;
 * a row whose id does not check out still delivers its rule, without an id,
 * so one bad row cannot cost a briefing all its rules.
 */
export const toContextRule = ({
  id,
  text,
  pinned,
  appliesWhen,
}: StoredRule): ContextRule => {
  const checked = ruleCandidateIdSchema.safeParse(id);
  return {
    ...(checked.success ? { id: checked.data } : {}),
    text,
    pinned,
    ...(appliesWhen ? { applies_when: appliesWhen } : {}),
  };
};
