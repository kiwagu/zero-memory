import {
  buildContextOutputSchema,
  contextRuleSchema,
  type ContextRule,
  ruleDeliveryLevelSchema,
  ruleGateBlockSchema,
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

/**
 * The briefing as the split reads it: the contract, except that a rule level
 * or a `rule_gate` block this build does not know — a newer server's — reads
 * as absent instead of failing the whole pack, which would put every rule
 * back into the JSON dump. Such a rule renders as an unjudged one; the block
 * is the server's own record, and nothing on this side reads it.
 */
const briefingPackSchema = buildContextOutputSchema.extend({
  rules: contextRuleSchema
    .extend({ level: ruleDeliveryLevelSchema.optional().catch(undefined) })
    .array()
    .default([]),
  rule_gate: ruleGateBlockSchema.optional().catch(undefined),
});

/** Splits standing rules out of an UNPARSED briefing payload — never throws. */
export const splitStandingRules = (payload: unknown): StandingRulesSplit => {
  const parsed = briefingPackSchema.safeParse(payload);
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
 * A rule the server judged for this task arrives at the level it chose, as
 * the server sent no more of it: a gated rule by headline with its
 * applicability condition (`[gate]`) while that fits the ceiling and by
 * headline (`[headline]`) otherwise, a headlined rule by headline. A rule at
 * level `full` follows the ceiling as above. A line of a rule the server
 * levelled names the rule's id after its marker, as the build_context result
 * does, and the footer then says where that id is read. A rule with no level
 * renders exactly as it did before levels existed, id or not.
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
  const footer = (count: number, named: boolean): string =>
    `\n(${count} rule(s) above are shown by headline or gate — call ` +
    'build_context for their full text' +
    (named ? ', or read zm://rules/<id> with the id on its line,' : '') +
    ' before acting on them.)';

  // Only a rule the server levelled is named by id: current servers send an
  // id on every rule, also when the gate is off, and printing it on a rule
  // with no level would change that briefing and the budget behind it.
  const levelled = (rule: ContextRule): boolean => rule.level !== undefined;
  // At gate and headline the server already sent the headline as the text;
  // cutting it again would mark a capped headline twice.
  const headlineOf = (rule: ContextRule): string =>
    rule.level === 'gate' || rule.level === 'headline'
      ? rule.text
      : ruleHeadline(rule.text);
  const idOf = (rule: ContextRule): string =>
    levelled(rule) && rule.id ? ` ${rule.id}` : '';

  // Reserve the widest footer up front, so adding the last rule can never
  // push the section past its ceiling.
  const mayName = rules.some((rule) => !rule.pinned && idOf(rule) !== '');
  let spent = header.length + footer(rules.length, mayName).length;
  let headlined = 0;
  let named = false;
  const fulls = rules.map((rule, index) => {
    const pin = rule.pinned ? ' [pinned]' : '';
    return `${index + 1}.${pin} ${rule.text}`;
  });
  const headlines = rules.map(
    (rule, index) => `${index + 1}. ${headlineOf(rule)} [headline]${idOf(rule)}`
  );
  // A gated rule's line: its headline and the condition the gate judged.
  // Pinned rules are never judged.
  const gates = rules.map((rule, index): string | null => {
    if (rule.pinned || rule.level !== 'gate') return null;
    const condition = rule.applies_when
      ? ` — applies when: ${rule.applies_when}`
      : '';
    return `${index + 1}. ${headlineOf(rule)}${condition} [gate]${idOf(rule)}`;
  });
  // The least a rule can cost — a pinned rule whole; a gated or headlined
  // one, whose text already IS its headline, in its shortest named form; any
  // other in whichever form is shorter: its headline, or the rule itself when
  // it is short enough that the headline marker would make it longer.
  const leastOf = (index: number): number => {
    const rule = rules[index]!;
    if (rule.pinned) return fulls[index]!.length;
    const headline = headlines[index]!.length;
    const gate = gates[index];
    if (typeof gate === 'string') return Math.min(gate.length, headline);
    if (rule.level === 'headline') return headline;
    return Math.min(fulls[index]!.length, headline);
  };
  // What every LATER rule will cost at the least. A rule gets more than its
  // least only if that is still left afterwards: admitting rules whole while
  // they fit and then naming the rest past the ceiling let eight long
  // unpinned rules overrun a default-budget briefing and push the memory pack
  // out of it entirely.
  const owedAfter = new Array<number>(rules.length).fill(0);
  for (let index = rules.length - 2; index >= 0; index -= 1) {
    owedAfter[index] = owedAfter[index + 1]! + leastOf(index + 1) + 1;
  }
  const emit = (rule: ContextRule, line: string, whole: boolean): string => {
    spent += line.length + 1;
    if (!whole) {
      headlined += 1;
      if (idOf(rule) !== '') named = true;
    }
    return line;
  };
  const lines = rules.map((rule, index) => {
    const fits = (line: string): boolean =>
      spent + line.length + 1 + owedAfter[index]! <= budgetChars;
    const full = fulls[index]!;
    const headline = headlines[index]!;
    const gate = gates[index];
    if (rule.pinned) return emit(rule, full, true);
    if (typeof gate === 'string') {
      // A condition runs to a few hundred characters: the gate line goes in
      // while it fits, and the rule is named by its headline otherwise.
      const shorter = gate.length <= headline.length;
      return emit(rule, shorter || fits(gate) ? gate : headline, false);
    }
    if (rule.level !== 'headline' && fits(full)) return emit(rule, full, true);
    return emit(rule, headline, false);
  });
  return (
    header + lines.join('\n') + (headlined > 0 ? footer(headlined, named) : '')
  );
};
