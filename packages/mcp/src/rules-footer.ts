import type { ContextRule } from '@workspace/contracts';

/**
 * The STANDING RULES block of a build_context tool result — the channel that
 * carries rule text for clients with no hook. A rule arrives at the level the
 * gate chose: whole, headline plus applicability gate, or headline. Rules
 * not delivered whole are named and point at the resource that has them.
 */
export const renderRulesFooter = (rules: readonly ContextRule[]): string => {
  const lines = rules.map((rule, index) => {
    const pin = rule.pinned ? ' [pinned]' : '';
    switch (rule.level) {
      case 'gate':
        return `${index + 1}.${pin} ${rule.text} — applies when: ${rule.applies_when ?? ''} [gate]`;
      case 'headline':
        return `${index + 1}.${pin} ${rule.text} [headline]`;
      default:
        return `${index + 1}.${pin} ${rule.text}`;
    }
  });
  const partial = rules.filter(
    (rule) => rule.level === 'gate' || rule.level === 'headline'
  ).length;
  const note =
    partial > 0
      ? `\n(${partial} rule(s) above are delivered by headline or gate because they do not bind this task; ` +
        "read `zm://rules/<id>` with the entry's id for the full text before acting on one.)"
      : '';
  return (
    'STANDING RULES — instructions the owner PROMOTED out of memory for sessions like this one. ' +
    'Follow them like system rules; they are not background context:\n' +
    lines.join('\n') +
    note
  );
};
