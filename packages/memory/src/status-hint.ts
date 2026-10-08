import { formatCardLabel, type MemoryKind } from '@workspace/contracts';

/**
 * What a writer is told when a task loop replaces an earlier task loop.
 *
 * WHY: a handover is written once and then closed, while the running status of
 * ongoing work is rewritten again and again. Measured on a production corpus,
 * every re-cut chain of task loops written after the project board arrived was
 * a status checkpoint, one of them rewritten eight times in a day. Status
 * belongs on the work's card. A note there is offered to the next session
 * together with its card, stays with the work after the loop window ends, and
 * accumulates as history instead of retiring the previous cut.
 *
 * WHY THE SIGNAL IS THE RE-CUT, NOT THE CONVERSATION'S BINDING: the status
 * loops came from conversations bound to no card at all, while the loops
 * written from bound conversations were real handovers. Question loops are
 * left alone, because re-cutting one adds evidence to the question, not status.
 */
export const shouldHintStatus = (
  kind: MemoryKind,
  retiredKinds: readonly MemoryKind[]
): boolean => kind === 'task' && retiredKinds.includes('task');

/**
 * The hint itself. `cut` counts this write: the first re-cut is cut 2.
 * `boundCard` is the number of the card the conversation is bound to, or null.
 */
export const statusHint = (cut: number, boundCard: number | null): string =>
  `This task loop replaces an earlier one (cut ${cut} of the same loop). ` +
  'A loop that keeps being re-cut is the status of ongoing work, and status ' +
  "belongs on the work's card: " +
  (boundCard === null
    ? 'run `card promote_loop` on this loop (it stays open, handed to the ' +
      'card), then write each next update as `card_log note` there. '
    : `write the next update as \`card_log note\` on ${formatCardLabel(boundCard)}. `) +
  'Loops are for one-off handovers and questions.';
