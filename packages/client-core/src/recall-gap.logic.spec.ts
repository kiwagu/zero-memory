import { describe, expect, it } from 'vitest';

import {
  decideRecallGap,
  SEARCH_REMINDER,
  SURPRISE_REMINDER,
  turnEndReminder,
  type RecallGapCounters,
} from './recall-gap.logic.js';

const fresh: RecallGapCounters = {
  recalls: 0,
  remembers: 0,
  remindedOnFailure: false,
  remindedOnTurnEnd: false,
  remindedOnSearch: false,
};

describe('decideRecallGap', () => {
  // What a memory-tool call counts as, however the client spells the event
  // or mounts the tool: a read gates every reminder, a write feeds the
  // turn-end one, and closing a loop or forgetting consults nothing.
  it.each([
    ['PostToolUse', 'recall', { kind: 'count', tally: 'recall' }],
    ['PostToolUse', 'build_context', { kind: 'count', tally: 'recall' }],
    [
      'postToolUse',
      'mcp__plugin_zero-memory_zero-memory__recall',
      { kind: 'count', tally: 'recall' },
    ],
    ['PostToolUse', 'remember', { kind: 'count', tally: 'remember' }],
    [
      'PostToolUse',
      'mcp__zero-memory__remember',
      { kind: 'count', tally: 'remember' },
    ],
    ['PostToolUse', 'mcp__zero-memory__close_loop', { kind: 'silent' }],
    ['PostToolUse', 'mcp__zero-memory__forget', { kind: 'silent' }],
    ['PostToolUse', '', { kind: 'silent' }],
    ['PostToolUse', undefined, { kind: 'silent' }],
  ])('on %s, counts %s as %j', (event, toolName, action) => {
    expect(decideRecallGap({ event, counters: fresh, toolName })).toEqual(
      action
    );
  });

  it('accepts each client’s casing of the reminder moments', () => {
    expect(decideRecallGap({ event: 'preToolUse', counters: fresh })).toEqual({
      kind: 'remind',
      trigger: 'search',
      text: SEARCH_REMINDER,
    });
    expect(
      decideRecallGap({ event: 'stop', counters: { ...fresh, remembers: 1 } })
        .kind
    ).toBe('remind');
  });

  it('counts a read on the memory-tool event', () => {
    expect(
      decideRecallGap({
        event: 'PostToolUse',
        counters: fresh,
        toolName: 'mcp__zero-memory__recall',
      })
    ).toEqual({ kind: 'count', tally: 'recall' });
  });

  it('reminds on a failing tool when the session has not read memory', () => {
    expect(
      decideRecallGap({
        event: 'PostToolUseFailure',
        counters: fresh,
        toolName: 'Bash',
      })
    ).toEqual({ kind: 'remind', trigger: 'failure', text: SURPRISE_REMINDER });
  });

  it('goes quiet for the rest of the session after a single read', () => {
    // The gate that keeps this from becoming noise: one read is enough evidence
    // that the habit is present.
    const read = { ...fresh, recalls: 1, remembers: 3 };
    for (const event of ['PostToolUseFailure', 'PreToolUse', 'Stop']) {
      expect(decideRecallGap({ event, counters: read }).kind).toBe('silent');
    }
  });

  it('reminds at most once per session on each trigger', () => {
    expect(
      decideRecallGap({
        event: 'PostToolUseFailure',
        counters: { ...fresh, remindedOnFailure: true },
      }).kind
    ).toBe('silent');
    expect(
      decideRecallGap({
        event: 'PreToolUse',
        counters: { ...fresh, remindedOnSearch: true },
      }).kind
    ).toBe('silent');
    expect(
      decideRecallGap({
        event: 'Stop',
        counters: { ...fresh, remembers: 2, remindedOnTurnEnd: true },
      }).kind
    ).toBe('silent');
  });

  it('names the gap at turn end only when something was written', () => {
    expect(
      decideRecallGap({ event: 'Stop', counters: { ...fresh, remembers: 2 } })
    ).toEqual({
      kind: 'remind',
      trigger: 'turn-end',
      text: turnEndReminder(2),
    });
    // Nothing written means nothing could have been rediscovered.
    expect(decideRecallGap({ event: 'Stop', counters: fresh }).kind).toBe(
      'silent'
    );
  });

  it('never speaks into a turn the client has already continued', () => {
    expect(
      decideRecallGap({
        event: 'Stop',
        counters: { ...fresh, remembers: 5 },
        alreadyContinued: true,
      }).kind
    ).toBe('silent');
  });

  it('reminds on a search before any read', () => {
    expect(decideRecallGap({ event: 'PreToolUse', counters: fresh })).toEqual({
      kind: 'remind',
      trigger: 'search',
      text: SEARCH_REMINDER,
    });
  });

  it('says nothing on an event it has no opinion about', () => {
    expect(
      decideRecallGap({ event: 'SessionStart', counters: fresh }).kind
    ).toBe('silent');
  });
});

describe('turnEndReminder', () => {
  it('agrees with itself grammatically', () => {
    expect(turnEndReminder(1)).toContain('1 memory');
    expect(turnEndReminder(4)).toContain('4 memories');
  });

  it('frames the count as what memory may already hold, not as blame', () => {
    const text = turnEndReminder(3);
    expect(text).toContain('memory may already hold it');
  });
});
