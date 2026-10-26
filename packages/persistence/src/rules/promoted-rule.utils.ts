import { type ContextRule, ruleHeadline } from '@workspace/contracts';

/** What the readers keep of a live promoted rule row, text already trimmed. */
export interface StoredRule {
  id: string;
  text: string;
  pinned: boolean;
  appliesWhen: string | null;
}

/**
 * A promoted rule as it is delivered: its id, its whole text, its pin, the
 * headline every client renders, and the condition of application only when
 * one is stored — never as an `applies_when: undefined` key, so a pack
 * serialises the same whether or not a rule has one.
 */
export const toContextRule = ({
  id,
  text,
  pinned,
  appliesWhen,
}: StoredRule): ContextRule => ({
  id,
  text,
  pinned,
  headline: ruleHeadline(text),
  ...(appliesWhen ? { applies_when: appliesWhen } : {}),
});
