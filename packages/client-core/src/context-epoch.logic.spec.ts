import { describe, expect, it } from 'vitest';

import {
  EPOCH_BOUNDARY_SOURCES,
  rulesNeedDelivery,
  startsNewEpoch,
} from './context-epoch.logic.js';

describe('startsNewEpoch', () => {
  it('treats a compacted or cleared conversation as a lost window', () => {
    for (const source of EPOCH_BOUNDARY_SOURCES) {
      expect(startsNewEpoch(source)).toBe(true);
    }
  });

  it('does not treat startup or resume as a boundary', () => {
    // startup has no previous window; a resume replays the transcript, so
    // whatever was injected earlier is still in view.
    expect(startsNewEpoch('startup')).toBe(false);
    expect(startsNewEpoch('resume')).toBe(false);
  });

  it('says no when the client reports no reason at all', () => {
    // Silence must never re-arm delivery: a client that sends nothing would
    // otherwise open a new epoch on every single event.
    expect(startsNewEpoch(undefined)).toBe(false);
    expect(startsNewEpoch('')).toBe(false);
    expect(startsNewEpoch('sessionStart')).toBe(false);
  });
});

describe('rulesNeedDelivery', () => {
  it('is true until this epoch has actually carried them', () => {
    expect(rulesNeedDelivery({ epoch: 0 })).toBe(true);
  });

  it('is false once this epoch delivered them', () => {
    expect(rulesNeedDelivery({ epoch: 0, rulesEpoch: 0 })).toBe(false);
  });

  it('is true again in the next epoch', () => {
    // The record is per window, so a compaction owes the rules once more.
    expect(rulesNeedDelivery({ epoch: 1, rulesEpoch: 0 })).toBe(true);
  });
});
