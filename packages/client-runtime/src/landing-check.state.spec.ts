import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  LANDING_RETRY_MS,
  landingCheckDue,
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

  it('retries a check the server could not answer, but not at once', () => {
    recordLandingCheck(path, 'abc#19', 'error', 1000);
    expect(landingCheckDue(path, 'abc#19', 1000 + LANDING_RETRY_MS - 1)).toBe(
      false
    );
    expect(landingCheckDue(path, 'abc#19', 1000 + LANDING_RETRY_MS)).toBe(true);
  });

  it('treats an unreadable file as nothing checked yet', () => {
    writeFileSync(path, 'not json');
    expect(landingCheckDue(path, 'abc#19')).toBe(true);
    recordLandingCheck(path, 'abc#19', 'reminded', 1);
    expect(landingCheckDue(path, 'abc#19', 2)).toBe(false);
  });

  it('keeps the newest entries when it grows past its cap', () => {
    for (let i = 0; i < 510; i += 1)
      recordLandingCheck(path, `k${i}`, 'recorded', i);
    expect(landingCheckDue(path, 'k0', 10_000)).toBe(true);
    expect(landingCheckDue(path, 'k509', 10_000)).toBe(false);
  });
});
