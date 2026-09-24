import { describe, expect, it } from 'vitest';

import {
  releaseInputSchema,
  releaseOutputSchema,
  releaseVersionSchema,
} from './release.schema.js';
import {
  boardCardSchema,
  briefingWorkSchema,
  cardEventTypeSchema,
} from './card.schema.js';

describe('the release tool contract', () => {
  it('takes the four actions with what each needs', () => {
    expect(
      releaseInputSchema.safeParse({ action: 'settings', scope: 'proj.x' })
        .success
    ).toBe(true);
    expect(
      releaseInputSchema.safeParse({
        action: 'configure',
        scope: 'proj.x',
        version_url: 'https://api.example.com/healthz',
      }).success
    ).toBe(true);
    expect(
      releaseInputSchema.safeParse({
        action: 'candidates',
        scope: 'proj.x',
        version: '0.25.0',
      }).success
    ).toBe(true);
    expect(
      releaseInputSchema.safeParse({
        action: 'record',
        scope: 'proj.x',
        version: '0.25.0',
        build: '849d7cac',
        release_commit: '096e4e1',
        source: 'url',
        card_ids: [],
      }).success
    ).toBe(true);
    // Which fields an action needs is the handler's check (Task 4); the
    // schema refuses only what is malformed for every action.
    expect(
      releaseInputSchema.safeParse({
        action: 'record',
        scope: 'proj.x',
        version: 'v 1',
      }).success
    ).toBe(false);
    expect(
      releaseInputSchema.safeParse({
        action: 'configure',
        scope: 'proj.x',
        on_release: 'move_everything',
      }).success
    ).toBe(false);
  });

  it('reads a server that predates releases as having none', () => {
    const tile = boardCardSchema.parse({
      id: 'crd_0000000000000001.0000000000',
      scope: 'proj.x',
      number: 1,
      title: 't',
      state: 'waiting',
      updated_at: 'x',
      archived_at: null,
      refs: 0,
      last_event: null,
    });
    expect(tile.released_in).toBeNull();
    const work = briefingWorkSchema.parse({
      bound_card: null,
      active: 0,
      waiting: 0,
      lead: [],
    });
    expect(work.production ?? null).toBeNull();
  });

  it('keeps what a record answered', () => {
    const out = releaseOutputSchema.parse({
      release: {
        version: '0.25.0',
        build: '849d7cac',
        release_commit: '096e4e1',
        source: 'url',
        observed_at: '2026-09-24T06:48:00Z',
        first_observed: true,
      },
      recorded: ['crd_0000000000000023.0000000000'],
      moved: [],
    });
    expect(out.release?.first_observed).toBe(true);
  });

  it('refuses a version with a leading v', () => {
    expect(releaseVersionSchema.safeParse('v0.25.0').success).toBe(false);
    expect(releaseVersionSchema.safeParse('0.25.0').success).toBe(true);
    expect(releaseVersionSchema.safeParse('1.2.0-rc.1').success).toBe(true);
  });

  it('parses "released" as a card event type', () => {
    expect(cardEventTypeSchema.parse('released')).toBe('released');
    const tile = boardCardSchema.parse({
      id: 'crd_0000000000000001.0000000000',
      scope: 'proj.x',
      number: 1,
      title: 't',
      state: 'waiting',
      updated_at: 'x',
      archived_at: null,
      refs: 0,
      last_event: { type: 'released', reason: null, created_at: 'x' },
    });
    expect(tile.last_event?.type).toBe('released');
  });
});
