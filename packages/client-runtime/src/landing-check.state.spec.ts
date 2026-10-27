import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  LANDING_RETRY_MS,
  landingCheckDue,
  landingCheckedAt,
  recordLandingCheck,
} from './landing-check.state.js';

describe('landing checks', () => {
  let dir: string;
  let path: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'zm-landing-'));
    path = join(dir, 'landing-checks.json');
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('is due until checked, and then never again', () => {
    expect(landingCheckDue(path, 'abc#19')).toBe(true);
    recordLandingCheck(path, 'abc#19', 'reminded', 1000);
    expect(landingCheckDue(path, 'abc#19', 10_000_000)).toBe(false);
    recordLandingCheck(path, 'def#20', 'recorded', 1000);
    expect(landingCheckDue(path, 'def#20', 10_000_000)).toBe(false);
  });

  it('says when a pair was last asked about, and nothing for one never asked', () => {
    expect(landingCheckedAt(path, 'abc#19')).toBeUndefined();
    recordLandingCheck(path, 'abc#19', 'error', 1234);
    expect(landingCheckedAt(path, 'abc#19')).toBe(1234);
  });

  it('retries a check the server could not answer, but not at once', () => {
    recordLandingCheck(path, 'abc#19', 'error', 1000);
    expect(landingCheckDue(path, 'abc#19', 1000 + LANDING_RETRY_MS - 1)).toBe(
      false
    );
    expect(landingCheckDue(path, 'abc#19', 1000 + LANDING_RETRY_MS)).toBe(true);
  });
});
