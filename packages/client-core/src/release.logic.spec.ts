import { describe, expect, it } from 'vitest';

import {
  compareVersions,
  isReleaseUrl,
  parseDeployedVersion,
  renderMissingTag,
  renderReleaseKnown,
  renderReleaseNotice,
  renderRollback,
  tagForVersion,
  versionFromTag,
} from './release.logic.js';

describe('parseDeployedVersion', () => {
  it.each([
    [{ version: 'v0.25.0+849d7cac' }, { version: '0.25.0', build: '849d7cac' }],
    [{ version: '0.25.0' }, { version: '0.25.0', build: null }],
    [{ version: 'v1.2.0-rc.1' }, { version: '1.2.0-rc.1', build: null }],
    [{ build: { version: 'v3.0.0+abc' } }, null],
  ])('reads %j', (body, expected) => {
    expect(parseDeployedVersion(body, 'version')).toEqual(expected);
  });

  it('follows a dotted field and refuses what is not a version', () => {
    expect(
      parseDeployedVersion(
        { build: { version: 'v3.0.0+abc' } },
        'build.version'
      )
    ).toEqual({ version: '3.0.0', build: 'abc' });
    expect(parseDeployedVersion('not json', 'version')).toBeNull();
    expect(parseDeployedVersion({ version: 42 }, 'version')).toBeNull();
    expect(parseDeployedVersion({ version: 'v 1' }, 'version')).toBeNull();
    expect(parseDeployedVersion({ version: '' }, 'version')).toBeNull();
  });
});

describe('isReleaseUrl', () => {
  it('reads https anywhere and http only on this machine, never with credentials', () => {
    expect(isReleaseUrl('https://api.example.com/healthz')).toBe(true);
    expect(isReleaseUrl('http://localhost:8788/healthz')).toBe(true);
    expect(isReleaseUrl('http://127.0.0.1/healthz')).toBe(true);
    expect(isReleaseUrl('http://api.example.com/healthz')).toBe(false);
    expect(isReleaseUrl('https://user:pw@api.example.com/healthz')).toBe(false);
    expect(isReleaseUrl('file:///etc/passwd')).toBe(false);
    expect(isReleaseUrl('not a url')).toBe(false);
  });
});

describe('tags and versions', () => {
  it('turns a version into its tag and back', () => {
    expect(tagForVersion('v{version}', '0.25.0')).toBe('v0.25.0');
    expect(tagForVersion('release-{version}', '2.0.0')).toBe('release-2.0.0');
    expect(versionFromTag('v{version}', 'v0.25.0')).toBe('0.25.0');
    expect(versionFromTag('v{version}', 'nightly')).toBeNull();
  });

  it('orders versions numerically, not as text', () => {
    expect(compareVersions('0.25.0', '0.24.3')).toBeGreaterThan(0);
    expect(compareVersions('0.9.0', '0.10.0')).toBeLessThan(0);
    expect(compareVersions('1.2.0', '1.2.0')).toBe(0);
    expect(compareVersions('1.2.0-rc.1', '1.2.0')).toBeLessThan(0);
  });
});

describe('the release lines', () => {
  it('says production took the changes and names every carried card, on one line', () => {
    const line = renderReleaseNotice({
      version: '0.25.0',
      build: '849d7cac',
      policy: 'record',
      moved: [],
      carried: [
        { number: 23, state: 'waiting' },
        { number: 24, state: 'waiting' },
      ],
    });
    expect(line).not.toContain('\n');
    expect(line).toContain('v0.25.0');
    expect(line).toContain('849d7cac');
    expect(line).toContain('ZM-23');
    expect(line).toContain('ZM-24');
    expect(line).toMatch(/until .*accept/u);
  });

  it('names the cards still to act on and counts the rest', () => {
    const line = renderReleaseNotice({
      version: '0.25.0',
      build: null,
      policy: 'record',
      moved: [],
      carried: [
        { number: 23, state: 'waiting' },
        { number: 3, state: 'done' },
        { number: 4, state: 'done' },
      ],
    });
    expect(line).toContain('ZM-23');
    expect(line).not.toContain('ZM-3,');
    expect(line).toContain('2 more cards');
  });

  it('says when nothing on the board rode the release, and when the policy moved cards', () => {
    expect(
      renderReleaseNotice({
        version: '1.0.0',
        build: null,
        policy: 'record',
        moved: [],
        carried: [],
      })
    ).toMatch(/no card/u);
    expect(
      renderReleaseNotice({
        version: '1.0.0',
        build: null,
        policy: 'record_and_move_done',
        moved: [7],
        carried: [{ number: 7, state: 'waiting' }],
      })
    ).toContain('moved ZM-7 to done');
  });

  it('names a missing tag, a rollback, and a state another session already recorded', () => {
    expect(renderMissingTag('0.25.0', 'v0.25.0')).toContain('git fetch --tags');
    expect(renderRollback('0.24.3', '0.25.0')).toContain('back to v0.24.3');
    const known = renderReleaseKnown('0.25.0', '849d7cac');
    expect(known).toContain('v0.25.0');
    expect(known).toMatch(/already recorded/u);
    expect(known).not.toMatch(/no card/u);
  });
});
