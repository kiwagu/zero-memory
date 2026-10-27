import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
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

  it('never throws on a write it cannot make', () => {
    // Best-effort: losing the persist only costs the offline PROJECT line.
    writeFileSync(join(dir, 'blocker'), '');
    expect(() =>
      recordProjectScope(join(dir, 'blocker', 'state.json'), '/x', 'proj.y')
    ).not.toThrow();
  });
});
