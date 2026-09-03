import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { readProjectScope, recordProjectScope } from './project-scope.state.js';

describe('project-scope state', () => {
  let dir: string;
  let statePath: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'zm-project-scope-'));
    statePath = join(dir, 'project-scopes.json');
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('round-trips a scope per repo root', () => {
    recordProjectScope(statePath, '/home/u/repos/alpha', 'proj.usr_x.alpha');
    recordProjectScope(statePath, '/home/u/repos/beta', 'proj.usr_x.beta');

    expect(readProjectScope(statePath, '/home/u/repos/alpha')).toBe(
      'proj.usr_x.alpha'
    );
    expect(readProjectScope(statePath, '/home/u/repos/beta')).toBe(
      'proj.usr_x.beta'
    );
    expect(readProjectScope(statePath, '/home/u/repos/unknown')).toBeNull();
  });

  it('a re-record overwrites (folder move heals one session behind)', () => {
    recordProjectScope(statePath, '/home/u/repos/alpha', 'proj.usr_x.alpha', 1);
    recordProjectScope(
      statePath,
      '/home/u/repos/alpha',
      'proj.usr_x.alpha_two',
      2
    );

    expect(readProjectScope(statePath, '/home/u/repos/alpha')).toBe(
      'proj.usr_x.alpha_two'
    );
  });

  it('caps the state by dropping the oldest entries', () => {
    for (let i = 0; i < 205; i += 1) {
      recordProjectScope(
        statePath,
        `/home/u/repos/p${i}`,
        `proj.usr_x.p${i}`,
        i
      );
    }

    // The newest survive, the oldest were dropped at the cap.
    expect(readProjectScope(statePath, '/home/u/repos/p204')).toBe(
      'proj.usr_x.p204'
    );
    expect(readProjectScope(statePath, '/home/u/repos/p0')).toBeNull();
  });

  it('never throws on a missing or corrupt state file', () => {
    expect(readProjectScope('/nonexistent/state.json', '/x')).toBeNull();
    expect(() =>
      recordProjectScope('/nonexistent/dir/state.json', '/x', 'proj.y')
    ).not.toThrow();
  });
});
