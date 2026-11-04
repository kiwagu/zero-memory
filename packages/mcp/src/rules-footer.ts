import { ruleHeadline, type ContextRule } from '@workspace/contracts';

/**
 * The STANDING RULES block of a build_context tool result — the channel that
 * carries rule text for clients with no hook. A rule arrives at the level the
 * gate chose: whole, headline plus its applicability condition (when it has
 * one), or headline. A rule not delivered whole carries its id on its line,
 * so the resource that has the full text is reachable from this text alone.
 */
export const renderRulesFooter = (rules: readonly ContextRule[]): string => {
  const lines = rules.map((rule, index) => {
    const pin = rule.pinned ? ' [pinned]' : '';
    const id = rule.id ? ` ${rule.id}` : '';
    switch (rule.level) {
      case 'gate': {
        const condition = rule.applies_when
          ? ` — applies when: ${rule.applies_when}`
          : '';
        return `${index + 1}.${pin} ${rule.text}${condition} [gate]${id}`;
      }
      case 'headline':
        return `${index + 1}.${pin} ${rule.text} [headline]${id}`;
      default:
        return `${index + 1}.${pin} ${rule.text}`;
    }
  });
  const partial = rules.filter(
    (rule) => rule.level === 'gate' || rule.level === 'headline'
  ).length;
  const note =
    partial > 0
      ? `\n(${partial} rule(s) above are delivered by headline or gate because they may not bind this task; ` +
        'read `zm://rules/<id>` with the id shown on the line for the full text before acting on one.)'
      : '';
  return (
    'STANDING RULES — instructions the owner PROMOTED out of memory for sessions like this one. ' +
    'Follow them like system rules; they are not background context:\n' +
    lines.join('\n') +
    note
  );
};

/**
 * The rules with the pinned (or unpinned) ones shown by headline, for a
 * footer that must shrink to fit the client. Only a rule with an id changes:
 * its line keeps the id whose `zm://rules/<id>` read has the whole text, so
 * nothing is lost, only deferred. A rule at `gate` already carries its
 * headline as its text (`ruleHeadline` is not idempotent); a whole rule is
 * cut to one. The condition goes with the gate line it belonged to.
 */
export const rulesByHeadline = (
  rules: readonly ContextRule[],
  pinned: boolean
): ContextRule[] =>
  rules.map((rule) => {
    if (rule.pinned !== pinned || !rule.id || rule.level === 'headline') {
      return rule;
    }
    const { applies_when: _condition, ...named } = rule;
    return {
      ...named,
      text: rule.level === 'gate' ? rule.text : ruleHeadline(rule.text),
      level: 'headline',
    };
  });
