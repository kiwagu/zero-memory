import { describe, expect, it } from 'vitest';

import {
  decideRecallGap,
  recallGapTally,
  recallGapTrigger,
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

describe('recallGapTrigger', () => {
  it('tells a tool failure apart from a tool success', () => {
    // The failure event's name contains the success event's name, so a prefix
    // match would file every failure as a success and the reminder that the
    // dogfood actually measured would never fire.
    expect(recallGapTrigger('PostToolUse')).toBe('memory-tool');
    expect(recallGapTrigger('PostToolUseFailure')).toBe('failure');
  });

  it('accepts each client’s casing of the same moment', () => {
    expect(recallGapTrigger('preToolUse')).toBe('search');
    expect(recallGapTrigger('PreToolUse')).toBe('search');
    expect(recallGapTrigger('stop')).toBe('turn-end');
    expect(recallGapTrigger('Stop')).toBe('turn-end');
  });

  it('is inert for an event it does not know', () => {
    expect(recallGapTrigger('SessionStart')).toBe('none');
    expect(recallGapTrigger('')).toBe('none');
  });
});

describe('recallGapTally', () => {
  it('counts a read however the client namespaces the tool', () => {
    for (const name of [
      'recall',
      'mcp__zero-memory__recall',
      'mcp__plugin_zero-memory_zero-memory__recall',
      'build_context',
      'mcp__zero-memory__build_context',
    ]) {
      expect(recallGapTally(name)).toBe('recall');
    }
  });

  it('counts a write', () => {
    expect(recallGapTally('mcp__zero-memory__remember')).toBe('remember');
    expect(recallGapTally('remember')).toBe('remember');
  });

  it('ignores memory tools that are neither a read nor a write', () => {
    // Closing a loop or forgetting a memory says nothing about consulting it.
    expect(recallGapTally('mcp__zero-memory__close_loop')).toBeNull();
    expect(recallGapTally('mcp__zero-memory__forget')).toBeNull();
    expect(recallGapTally(undefined)).toBeNull();
    expect(recallGapTally('')).toBeNull();
  });
});

describe('decideRecallGap', () => {
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

  it('reminds on a search before any read, then stays quiet', () => {
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
    expect(text.toLowerCase()).not.toContain('you failed');
  });
});
