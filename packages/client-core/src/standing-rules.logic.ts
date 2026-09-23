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

/** A headline never runs past this, whatever the rule's first sentence. */
const HEADLINE_MAX_CHARS = 160;

/**
 * A rule's headline: its opening clause, up to the first sentence break. The
 * owner writes rules headline-first ("NO PRIVATE REFERENCES IN COMMITTED
 * ARTIFACTS (every project) — …"), so the opening names the rule even when
 * its body cannot be carried. A break inside an open parenthesis does not
 * count — it would leave the headline with an unclosed aside.
 */
export const ruleHeadline = (text: string): string => {
  const flat = text.replace(/\s+/gu, ' ').trim();
  let cut = flat.length;
  for (const match of flat.matchAll(/[.:](?=\s|$)|\s—\s/gu)) {
    const at = match.index;
    if (at < 20) continue;
    const head = flat.slice(0, at);
    const opened = head.split('(').length - head.split(')').length;
    if (opened === 0) {
      cut = at;
      break;
    }
  }
  const clause = flat.slice(0, cut);
  return clause.length > HEADLINE_MAX_CHARS
    ? `${clause.slice(0, HEADLINE_MAX_CHARS).trimEnd()}…`
    : clause;
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
    `\n(${count} rule(s) above are shown by headline only — call ` +
    'build_context for their full text before acting on them.)';

  // Reserve the widest footer up front, so adding the last rule can never
  // push the section past its ceiling.
  let spent = header.length + footer(rules.length).length;
  let headlined = 0;
  const fulls = rules.map((rule, index) => {
    const pin = rule.pinned ? ' [pinned]' : '';
    return `${index + 1}.${pin} ${rule.text}`;
  });
  const headlines = rules.map(
    (rule, index) => `${index + 1}. ${ruleHeadline(rule.text)} [headline]`
  );
  // What every LATER rule will cost at the least — a pinned rule whole, any
  // other in whichever form is shorter: its headline, or the rule itself when
  // it is short enough that the headline marker would make it longer. A rule
  // is admitted whole only if that is still left afterwards: admitting rules
  // whole while they fit and then naming the rest past the ceiling let eight
  // long unpinned rules overrun a default-budget briefing and push the memory
  // pack out of it entirely.
  const owedAfter = new Array<number>(rules.length).fill(0);
  for (let index = rules.length - 2; index >= 0; index -= 1) {
    const next = index + 1;
    const least = rules[next]!.pinned
      ? fulls[next]!.length
      : Math.min(fulls[next]!.length, headlines[next]!.length);
    owedAfter[index] = owedAfter[next]! + least + 1;
  }
  const lines = rules.map((rule, index) => {
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
