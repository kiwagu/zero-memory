import { describe, expect, it } from 'vitest';

import { ALL_BOARDS, resolveBoardScope, type BoardScope } from './board';

const board = (scope: string): BoardScope => ({
  scope,
  cards: 1,
  last_activity_at: '2026-09-20T00:00:00Z',
});

const BOARDS = [board('proj.usr_a.alpha'), board('proj.usr_a.beta')];

describe('resolveBoardScope', () => {
  it('opens the board that moved last when the address says nothing', () => {
    // The rows arrive newest-activity-first, so the first one IS the default.
    expect(resolveBoardScope(undefined, BOARDS)).toEqual({
      selected: 'proj.usr_a.alpha',
      value: '',
    });
  });

  it('keeps the default out of the URL so a bare link still means "latest"', () => {
    expect(resolveBoardScope(undefined, BOARDS).value).toBe('');
  });

  it('honours an explicit board', () => {
    expect(resolveBoardScope('proj.usr_a.beta', BOARDS)).toEqual({
      selected: 'proj.usr_a.beta',
      value: 'proj.usr_a.beta',
    });
  });

  it('treats the all-boards sentinel as a deliberate, addressable choice', () => {
    expect(resolveBoardScope(ALL_BOARDS, BOARDS)).toEqual({
      selected: null,
      value: ALL_BOARDS,
    });
  });

  it('honours a board with nothing on it instead of showing another one', () => {
    // An empty board is a true answer. Substituting a different board would
    // tell the reader the address they are on holds work it does not.
    expect(resolveBoardScope('proj.usr_a.empty', BOARDS)).toEqual({
      selected: 'proj.usr_a.empty',
      value: 'proj.usr_a.empty',
    });
  });

  it('shows everything rather than nothing when there are no boards', () => {
    expect(resolveBoardScope(undefined, [])).toEqual({
      selected: null,
      value: '',
    });
  });
});
