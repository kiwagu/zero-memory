/** A headline never runs past this, whatever the rule's first sentence. */
const HEADLINE_MAX_CHARS = 160;

/**
 * A rule's headline: its opening clause, up to the first sentence break. The
 * owner writes rules headline-first ("ONE-LINE COMMITS (every project) — the
 * subject names the goal…"), so the opening names the rule even when
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
