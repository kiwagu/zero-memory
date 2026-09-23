import {
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

const clip = (text: string, max: number): string => {
  const flat = text.replace(/\s+/gu, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max).trimEnd()}…` : flat;
};

const named = (card: BriefingWorkCard, work: BriefingWork): string => {
  const branches = (work.open_branches ?? [])
    .filter((branch) => branch.card_id === card.id)
    .map((branch) => branch.branch);
  const on = branches.length > 0 ? ` on ${branches.join(', ')}` : '';
  return (
    `${formatCardLabel(card.number)} "${clip(card.title, TITLE_MAX_CHARS)}" ` +
    `[${card.state}]${on}`
  );
};

/** The board block of a briefing, or null when the summary names nothing. */
export const renderBoardSummary = (
  work: BriefingWork,
  drift: readonly LandingDrift[] = []
): string | null => {
  const lines: string[] = [];
  const bound = work.bound_card;
  if (bound) {
    const reason = bound.state_reason
      ? `: ${clip(bound.state_reason, REASON_MAX_CHARS)}`
      : '';
    lines.push(
      `- This conversation is bound to ${named(bound, work)}${reason} ` +
        `(${bound.refs} attached — \`board get\` reads it in full)`
    );
  }
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
