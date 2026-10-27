import {
  buildContextOutputSchema,
  type ContextRule,
  ruleHeadline,
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
 * Whether two delivered entries are the same rule: by id when both carry one
 * — a judged briefing can deliver a rule by its headline while another
 * briefing delivers it whole, so its text is no key then — and by text for
 * entries from servers that send no id.
 */
const sameRule = (a: ContextRule, b: ContextRule): boolean =>
  a.id !== undefined && b.id !== undefined ? a.id === b.id : a.text === b.text;

/**
 * Merges the rules of several splits (e.g. the project and branch briefings,
 * which brief overlapping scopes and so repeat rules): one entry per rule,
 * PINNED first, each side's incoming order preserved otherwise. A rule two
 * splits share keeps the EARLIER split's entry — the first split is the
 * project briefing, the one the server judges, so the level it chose stands
 * over the unjudged branch briefing's whole text — unless only the later
 * entry is pinned.
 */
export const mergeStandingRules = (
  splits: readonly StandingRulesSplit[]
): ContextRule[] => {
  const merged: ContextRule[] = [];
  for (const split of splits) {
    for (const rule of split.rules) {
      const slot = merged.findIndex((entry) => sameRule(entry, rule));
      if (slot === -1) merged.push(rule);
      else if (rule.pinned && !merged[slot]!.pinned) merged[slot] = rule;
    }
  }
  return merged.sort((a, b) => Number(b.pinned) - Number(a.pinned));
};

/**
 * The prominent standing-rules block for a briefing, or null when the owner
 * has none. Unlike the open-loops section — which is deliberately phrased as
 * RECORDED data for the agent to judge — this one is phrased as binding:
 * these are the owner's own promoted instructions, and a session that reads
 * them as background context is the exact failure the rules layer exists to
 * prevent. Pinned rules lead and are marked, so the guarantee is visible.
 *
 * `budgetChars` is the section's own ceiling. Without one the rules took
 * whatever they wanted and everything after them shared the rest — measured
 * on this project, a 8,455-character rules block left the open loops nothing
 * and then did not fit itself, so the briefing lost both. Within the ceiling:
 * PINNED rules always arrive in full, even past it — that is the guarantee
 * the owner pinned them for. The others arrive in full while they fit, then
 * by headline, so a rule that did not fit is still named and the reader knows
 * where its text is.
 *
 * A rule the server judged for this task arrives at the level it chose: by
 * headline with its applicability condition (`[gate]`), or by headline alone
 * (`[headline]`), whatever the ceiling — the server sent no more of it. A
 * rule at level `full`, or with no level (older servers), follows the
 * ceiling as above. Every line that does not carry a whole rule names the
 * rule's id after its marker, as the build_context result does.
 */
export const renderStandingRulesSection = (
  rules: readonly ContextRule[],
  budgetChars = Number.POSITIVE_INFINITY
): string | null => {
  if (rules.length === 0) return null;
  const pinnedCount = rules.filter((rule) => rule.pinned).length;
  const pinnedNote =
    pinnedCount > 0
      ? ' Rules marked [pinned] are ones the owner guaranteed reach every ' +
        'session — they lead the list and always arrive in full.'
      : '';
  const header =
    `STANDING RULES — ${rules.length} instruction(s) the owner PROMOTED out ` +
    'of memory for sessions like this one. Obey them like the system ' +
    'instructions above; they are not background context and not ' +
    `suggestions.${pinnedNote}\n`;
  const footer = (count: number): string =>
    `\n(${count} rule(s) above are shown by headline or gate — call ` +
    'build_context for their full text before acting on them.)';

  // Reserve the widest footer up front, so adding the last rule can never
  // push the section past its ceiling.
  let spent = header.length + footer(rules.length).length;
  let headlined = 0;
  const fulls = rules.map((rule, index) => {
    const pin = rule.pinned ? ' [pinned]' : '';
    return `${index + 1}.${pin} ${rule.text}`;
  });
  const headlineOf = (rule: ContextRule): string =>
    rule.headline ?? ruleHeadline(rule.text);
  const idOf = (rule: ContextRule): string => (rule.id ? ` ${rule.id}` : '');
  const headlines = rules.map(
    (rule, index) => `${index + 1}. ${headlineOf(rule)} [headline]${idOf(rule)}`
  );
  // The form the server's level fixes, decided before any budget is spent: a
  // gated or headlined rule's text already IS its headline, so the ceiling
  // has nothing longer to choose. Pinned rules are never judged.
  const forced = rules.map((rule, index): string | null => {
    if (rule.pinned) return null;
    if (rule.level === 'gate') {
      const condition = rule.applies_when
        ? ` — applies when: ${rule.applies_when}`
        : '';
      return `${index + 1}. ${headlineOf(rule)}${condition} [gate]${idOf(rule)}`;
    }
    if (rule.level === 'headline') return headlines[index]!;
    return null;
  });
  // What every LATER rule will cost at the least — a pinned rule whole, a
  // rule in the form its level fixes, any other in whichever form is
  // shorter: its headline, or the rule itself when it is short enough that
  // the headline marker would make it longer. A rule is admitted whole only
  // if that is still left afterwards: admitting rules whole while they fit
  // and then naming the rest past the ceiling let eight long unpinned rules
  // overrun a default-budget briefing and push the memory pack out of it
  // entirely.
  const owedAfter = new Array<number>(rules.length).fill(0);
  for (let index = rules.length - 2; index >= 0; index -= 1) {
    const next = index + 1;
    const least =
      forced[next]?.length ??
      (rules[next]!.pinned
        ? fulls[next]!.length
        : Math.min(fulls[next]!.length, headlines[next]!.length));
    owedAfter[index] = owedAfter[next]! + least + 1;
  }
  const lines = rules.map((rule, index) => {
    const fixed = forced[index];
    if (typeof fixed === 'string') {
      headlined += 1;
      spent += fixed.length + 1;
      return fixed;
    }
    const full = fulls[index]!;
    if (
      rule.pinned ||
      spent + full.length + 1 + owedAfter[index]! <= budgetChars
    ) {
      spent += full.length + 1;
      return full;
    }
    headlined += 1;
    const headline = headlines[index]!;
    spent += headline.length + 1;
    return headline;
  });
  return header + lines.join('\n') + (headlined > 0 ? footer(headlined) : '');
};
