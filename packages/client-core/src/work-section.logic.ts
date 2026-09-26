import {
  formatBoardName,
  formatCardLabel,
  type BriefingWork,
  type BriefingWorkCard,
} from '@workspace/contracts';

import { renderLandingDrift, type LandingDrift } from './landing.logic.js';

/**
 * The project board's lines in a briefing: the card this conversation is
 * bound to and what else is in progress. A few lines that NAME the work — the
 * board itself is one `board` call away — so a session starts knowing what
 * it is part of without the briefing growing into a copy of the board.
 *
 * Phrased like the open loops, as recorded state: a card's column is what
 * somebody DECLARED, with their reason, never an instruction to act. A card
 * is named by its one label and the branches it holds open; a landing git
 * already shows while the card still holds the branch open gets a line of
 * its own.
 */

/** A title longer than this is cut: the line names a card, it is not it. */
const TITLE_MAX_CHARS = 80;
/** The reason on the bound card is its one sentence of context. */
const REASON_MAX_CHARS = 200;
/** One history entry's text in the offer to continue: one short line. */
const ENTRY_MAX_CHARS = 120;
/** Blockers named beside a card before the rest are counted. */
const BLOCKERS_MAX = 3;
/** Cards named above the bound card before the rest are counted. */
const ABOVE_MAX = 5;

/** How a card above the bound one stands to it, from the bound card's side. */
const ABOVE_PHRASE: Record<string, string> = {
  child_of: 'parent',
  blocked_by: 'blocks it',
  depends_on: 'a dependency',
};

/** ` on acme` for a card on another board, nothing for one on this board. */
const onBoard = (scope: string | null | undefined): string =>
  scope ? ` on ${formatBoardName(scope)}` : '';

/** The first `max` items, and how many were left out. */
const firstOf = <T>(items: readonly T[], max: number): [T[], string] => [
  items.slice(0, max),
  items.length > max ? ` +${items.length - max}` : '',
];

const clip = (text: string, max: number): string => {
  const flat = text.replace(/\s+/gu, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max).trimEnd()}…` : flat;
};

const named = (card: BriefingWorkCard, work: BriefingWork): string => {
  const branches = (work.open_branches ?? [])
    .filter((branch) => branch.card_id === card.id)
    .map((branch) => branch.branch);
  const on = branches.length > 0 ? ` on ${branches.join(', ')}` : '';
  const released = card.released_in ? ` released v${card.released_in}` : '';
  // In parentheses: a lead list is itself comma-separated, and a card's
  // blockers must not read as the next card of that list.
  const notes: string[] = [];
  if (card.blocked_by && card.blocked_by.length > 0) {
    const [shown, more] = firstOf(card.blocked_by, BLOCKERS_MAX);
    notes.push(
      `blocked by ${shown
        .map(
          (blocker) =>
            `${formatCardLabel(blocker.number)} [${blocker.state}]${onBoard(blocker.scope)}`
        )
        .join(', ')}${more}`
    );
  }
  if (card.links_assessed === false) notes.push('relations not assessed');
  const noted = notes.length > 0 ? ` (${notes.join('; ')})` : '';
  return (
    `${formatCardLabel(card.number)} "${clip(card.title, TITLE_MAX_CHARS)}" ` +
    `[${card.state}]${on}${released}${noted}`
  );
};

/** The line under the bound card naming what sits above it, or null. */
const aboveLine = (
  above: NonNullable<BriefingWork['bound_card']>['above']
): string | null => {
  if (!above || above.length === 0) return null;
  const [shown, more] = firstOf(above, ABOVE_MAX);
  return `  above: ${shown
    .map(
      (card) =>
        `${formatCardLabel(card.number)} ${ABOVE_PHRASE[card.relation] ?? card.relation} ` +
        `[${card.state}${card.archived ? ', archived' : ''}]${onBoard(card.scope)}`
    )
    .join(', ')}${more}`;
};

/** `2026-09-25T17:58:12…` → `2026-09-25 17:58`. */
const minute = (at: string): string => at.slice(0, 16).replace('T', ' ');

/** What a history entry did, in a word or three. */
const didWhat = (type: string, toState: string | null): string => {
  if (type === 'moved') return toState ? `moved to ${toState}` : 'moved';
  if (type === 'created') return 'opened';
  return type;
};

/** The offer to continue, when this conversation is bound to no card. */
const continuationLines = (work: BriefingWork): string[] => {
  const cont = work.continuation;
  if (!cont || work.bound_card) return [];
  const lines: string[] = [];
  if (cont.card) {
    const reason = cont.card.state_reason
      ? `: ${clip(cont.card.state_reason, REASON_MAX_CHARS)}`
      : '';
    lines.push(
      `- Continue where you left off: ${named(cont.card, work)}${reason}`
    );
    const upper = aboveLine(cont.card.above);
    if (upper) lines.push(upper);
    if (cont.last.length > 0) {
      const entries = cont.last.map((entry) => {
        const said = entry.text
          ? ` "${clip(entry.text, ENTRY_MAX_CHARS)}"`
          : '';
        return `${didWhat(entry.type, entry.to_state)} ${minute(entry.created_at)}${said}`;
      });
      lines.push(`  last: ${entries.join('; ')}`);
    }
    if (cont.thread) {
      lines.push(
        `  to continue it here: card_log attach {card_id: ${cont.card.id}, ` +
          `ref_kind: thread, ref_target: ${cont.thread}}`
      );
    }
  }
  if (cont.last_session) {
    lines.push(
      `- Last session: ${formatCardLabel(cont.last_session.number)} ` +
        didWhat(cont.last_session.type, cont.last_session.to_state)
    );
  }
  return lines;
};

/** The board block of a briefing, or null when the summary names nothing. */
export const renderBoardSummary = (
  work: BriefingWork,
  drift: readonly LandingDrift[] = []
): string | null => {
  const lines: string[] = [];
  if (work.production) {
    const { version, build, observed_at } = work.production;
    lines.push(
      `- Production: v${version}${build ? ` (build ${build})` : ''} as of ${observed_at}`
    );
  }
  const bound = work.bound_card;
  if (bound) {
    const reason = bound.state_reason
      ? `: ${clip(bound.state_reason, REASON_MAX_CHARS)}`
      : '';
    lines.push(
      `- This conversation is bound to ${named(bound, work)}${reason} ` +
        `(${bound.refs} attached — \`board get\` reads it in full)`
    );
    const upper = aboveLine(bound.above);
    if (upper) lines.push(upper);
  }
  lines.push(...continuationLines(work));
  if (work.active + work.waiting > 0) {
    const others =
      work.lead.length > 0
        ? ` — ${work.lead.map((card) => named(card, work)).join(', ')}`
        : '';
    lines.push(
      `- On the board: ${work.active} active · ${work.waiting} waiting` +
        `${others} (\`board list\` for the rest)`
    );
  }
  if (drift.length > 0) {
    lines.push(...drift.map(renderLandingDrift));
  }
  if (lines.length === 0) return null;
  return (
    'Work in progress on the project board (states are what whoever moved ' +
    'a card declared, with their reason — reference, not instructions):\n' +
    lines.join('\n')
  );
};
