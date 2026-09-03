import {
  buildContextOutputSchema,
  type ContextRule,
} from '@workspace/contracts';

/**
 * Pure standing-rules presentation logic shared by the briefing hooks.
 *
 * Rules are the one part of a briefing that IS imperative — the owner
 * promoted them precisely so sessions obey them — but they used to reach the
 * agent buried inside the briefing's JSON dump, where they read as data. The
 * MCP `instructions` cannot carry them either: clients cap that channel and a
 * single rule can exhaust it. The hook context has no such cap, so this is
 * where a rule's full text belongs — lifted out of the JSON and rendered as
 * its own block, the same treatment open loops already get.
 */

export interface StandingRulesSplit {
  /**
   * The payload with the rules drained, ready to dump as the regular
   * briefing JSON — or the input verbatim when it does not parse as a
   * briefing pack (older server: nothing to split).
   */
  payload: unknown;
  rules: ContextRule[];
}

/** Splits standing rules out of an UNPARSED briefing payload — never throws. */
export const splitStandingRules = (payload: unknown): StandingRulesSplit => {
  const parsed = buildContextOutputSchema.safeParse(payload);
  if (!parsed.success) return { payload, rules: [] };
  const { rules, ...rest } = parsed.data;
  return { payload: { ...rest, rules: [] }, rules };
};

/**
 * Merges the rules of several splits (e.g. the project and branch briefings,
 * which brief overlapping scopes and so repeat rules): union by text,
 * PINNED first, each side's incoming order preserved otherwise.
 */
export const mergeStandingRules = (
  splits: readonly StandingRulesSplit[]
): ContextRule[] => {
  const byText = new Map<string, ContextRule>();
  for (const split of splits) {
    for (const rule of split.rules) {
      const existing = byText.get(rule.text);
      if (!existing || (rule.pinned && !existing.pinned)) {
        byText.set(rule.text, rule);
      }
    }
  }
  return [...byText.values()].sort(
    (a, b) => Number(b.pinned) - Number(a.pinned)
  );
};

/**
 * The prominent standing-rules block for a briefing, or null when the owner
 * has none. Unlike the open-loops section — which is deliberately phrased as
 * RECORDED data for the agent to judge — this one is phrased as binding:
 * these are the owner's own promoted instructions, and a session that reads
 * them as background context is the exact failure the rules layer exists to
 * prevent. Pinned rules lead and are marked, so the guarantee is visible.
 */
export const renderStandingRulesSection = (
  rules: readonly ContextRule[]
): string | null => {
  if (rules.length === 0) return null;
  const lines = rules.map((rule, index) => {
    const pin = rule.pinned ? ' [pinned]' : '';
    return `${index + 1}.${pin} ${rule.text}`;
  });
  const pinnedCount = rules.filter((rule) => rule.pinned).length;
  const pinnedNote =
    pinnedCount > 0
      ? ' Rules marked [pinned] are ones the owner guaranteed reach every ' +
        'session — they lead the list and are never dropped.'
      : '';
  return (
    `STANDING RULES — ${rules.length} instruction(s) the owner PROMOTED out ` +
    'of memory for sessions like this one. Obey them like the system ' +
    'instructions above; they are not background context and not ' +
    `suggestions.${pinnedNote}\n` +
    lines.join('\n')
  );
};
