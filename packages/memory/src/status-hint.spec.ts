import type { MemoryKind } from '@workspace/contracts';
import { describe, expect, it } from 'vitest';

import { shouldHintStatus, statusHint } from './status-hint.js';

describe('shouldHintStatus', () => {
  it.each<[MemoryKind, MemoryKind[], boolean]>([
    // A task that retires a task loop is a re-cut: the running status of work.
    ['task', ['task'], true],
    ['task', ['decision', 'task'], true],
    // A first cut retires nothing, and retiring a non-loop is no re-cut.
    ['task', [], false],
    ['task', ['decision'], false],
    // A question re-cut adds evidence to the question, not status.
    ['open-question', ['open-question'], false],
    ['open-question', ['task'], false],
    ['task', ['open-question'], false],
  ])('%s retiring %j → %s', (kind, retired, expected) => {
    expect(shouldHintStatus(kind, retired)).toBe(expected);
  });
});

describe('statusHint', () => {
  it('numbers the cut and names the bound card to write the next update on', () => {
    const hint = statusHint(3, 19);
    expect(hint).toContain('cut 3 of the same loop');
    expect(hint).toContain('`card_log note` on ZM-19');
    expect(hint).not.toContain('promote_loop');
  });

  it('asks to put the work on a card when the conversation is bound to none', () => {
    const hint = statusHint(2, null);
    expect(hint).toContain('cut 2 of the same loop');
    expect(hint).toContain('`card promote_loop` on this loop');
    // Promoting hands the loop over; the writer must not read it as closing.
    expect(hint).toContain('it stays open');
  });
});
