import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  callRelease,
  fetchDeployedVersion,
  projectScopeStatePath,
  recordProjectScope,
} from '@workspace/client-runtime';
import {
  cardIdSchema,
  type ReleaseCandidate,
  type ReleaseInput,
  type ReleaseSettings,
} from '@workspace/contracts';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { resolveProjectHint } from '../project-hint-resolver.js';
import { checkRelease, runRelease } from './release-runner.js';

vi.mock('@workspace/client-runtime', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@workspace/client-runtime')>()),
  callRelease: vi.fn(),
  fetchDeployedVersion: vi.fn(),
}));

const env = {
  GIT_AUTHOR_NAME: 't',
  GIT_AUTHOR_EMAIL: 't@t',
  GIT_COMMITTER_NAME: 't',
  GIT_COMMITTER_EMAIL: 't@t',
};
const git = (cwd: string, ...args: string[]): string =>
  execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, ...env },
  }).trim();
const commit = (cwd: string, file: string, ...messages: string[]): string => {
  writeFileSync(join(cwd, file), file);
  git(cwd, 'add', file);
  git(cwd, 'commit', '-q', ...messages.flatMap((m) => ['-m', m]));
  return git(cwd, 'rev-parse', 'HEAD');
};

const REPO = 'acme/memory-service';
const T0 = Date.parse('2026-09-24T08:00:00Z');
const MIN = 60 * 1000;
const cardId = (n: number) =>
  cardIdSchema.parse(`crd_${String(n).padStart(16, '0')}.0000000000`);
const candidate = (n: number, squash: string): ReleaseCandidate => ({
  id: cardId(n),
  number: n,
  title: `card ${n}`,
  state: 'waiting',
  landings: [{ repo: REPO, branch: `feature/${n}`, squash_sha: squash }],
});

describe('checkRelease', () => {
  let state: string;
  let repo: string;
  let previous: string | undefined;
  let settings: ReleaseSettings | null;
  let candidates: ReleaseCandidate[];
  let firstObserved: boolean;

  const settingsWith = (
    over: Partial<ReleaseSettings> = {}
  ): ReleaseSettings => ({
    scope: 'proj.usr_x.demo',
    version_url: 'https://api.example.com/healthz',
    version_field: 'version',
    tag_template: 'v{version}',
    tag_pattern: 'v*',
    on_release: 'record',
    updated_at: '2026-09-24T00:00:00Z',
    ...over,
  });
  const calls = (action: ReleaseInput['action']) =>
    vi
      .mocked(callRelease)
      .mock.calls.filter(([input]) => input.action === action);

  beforeEach(() => {
    previous = process.env.XDG_STATE_HOME;
    state = mkdtempSync(join(tmpdir(), 'zm-release-state-'));
    process.env.XDG_STATE_HOME = state;
    repo = mkdtempSync(join(tmpdir(), 'zm-release-repo-'));
    git(repo, 'init', '-q', '-b', 'main');
    git(
      repo,
      'remote',
      'add',
      'origin',
      'git@github.com:acme/memory-service.git'
    );
    commit(repo, 'a', 'chore: start');
    recordProjectScope(
      projectScopeStatePath(),
      resolveProjectHint(repo),
      'proj.usr_x.demo'
    );
    settings = settingsWith();
    candidates = [];
    firstObserved = true;
    vi.mocked(callRelease)
      .mockReset()
      .mockImplementation(async (input) => {
        if (input.action === 'settings') return { settings };
        if (input.action === 'candidates') return { cards: candidates };
        return {
          release: {
            version: input.version ?? '',
            build: input.build ?? null,
            release_commit: input.release_commit ?? '',
            source: input.source ?? 'url',
            observed_at: '2026-09-24T08:00:00Z',
            first_observed: firstObserved,
          },
          recorded: firstObserved ? (input.card_ids ?? []) : [],
          moved: [],
        };
      });
    vi.mocked(fetchDeployedVersion).mockReset();
  });
  afterEach(() => {
    process.env.XDG_STATE_HOME = previous;
    rmSync(state, { recursive: true, force: true });
    rmSync(repo, { recursive: true, force: true });
  });

  it('records the release on every card it carries and says so once', async () => {
    const landed = commit(
      repo,
      'b',
      'feat: the work',
      'Squashed-from: feature/23 (abcdef1) ZM-23'
    );
    const release = commit(repo, 'c', 'chore(release): 0.25.0');
    git(repo, 'tag', 'v0.25.0', release);
    const later = commit(
      repo,
      'd',
      'feat: after the release',
      'Squashed-from: feature/26 (abcdef2) ZM-26'
    );
    candidates = [candidate(23, landed), candidate(26, later)];
    vi.mocked(fetchDeployedVersion).mockResolvedValue({
      version: '0.25.0',
      build: '849d7cac',
    });

    const line = await checkRelease(repo, { now: T0 });
    expect(line).toContain(
      'PRODUCTION TOOK THE CHANGES: v0.25.0 (build 849d7cac)'
    );
    expect(line).toContain('ZM-23');
    expect(line).not.toContain('ZM-26');
    expect(calls('record')[0]?.[0]).toMatchObject({
      version: '0.25.0',
      build: '849d7cac',
      release_commit: release,
      source: 'url',
      card_ids: [cardId(23)],
    });

    expect(await checkRelease(repo, { now: T0 + 1000 })).toBeNull(); // url not asked again yet
    expect(await checkRelease(repo, { now: T0 + 3 * MIN })).toBeNull(); // asked, same state
    expect(calls('record')).toHaveLength(1);
    expect(fetchDeployedVersion).toHaveBeenCalledTimes(2);
  });

  it('asks the url at most every two minutes, and nothing at all when no production is named', async () => {
    vi.mocked(fetchDeployedVersion).mockResolvedValue({
      version: '0.25.0',
      build: null,
    });
    await checkRelease(repo, { now: T0 });
    await checkRelease(repo, { now: T0 + MIN });
    expect(fetchDeployedVersion).toHaveBeenCalledTimes(1);
    await checkRelease(repo, { now: T0 + 2 * MIN });
    expect(fetchDeployedVersion).toHaveBeenCalledTimes(2);

    settings = null;
    await checkRelease(repo, { now: T0 + 11 * MIN }); // the setting is read again after ten minutes
    await checkRelease(repo, { now: T0 + 30 * MIN });
    expect(fetchDeployedVersion).toHaveBeenCalledTimes(2);
    expect(calls('candidates')).toHaveLength(0);
  });

  it('drives nothing from a url that failed to answer, and asks it again only after ten minutes', async () => {
    const landed = commit(
      repo,
      'b',
      'feat: the work',
      'Squashed-from: feature/23 (abcdef1) ZM-23'
    );
    git(repo, 'tag', 'v0.25.0', landed);
    candidates = [candidate(23, landed)];
    vi.mocked(fetchDeployedVersion).mockResolvedValueOnce({
      version: '0.25.0',
      build: null,
    });
    vi.mocked(callRelease)
      .mockImplementationOnce(async () => ({ settings }))
      .mockRejectedValueOnce(new Error('timeout')); // the candidates
    expect(await checkRelease(repo, { now: T0 })).toBeNull();
    expect(calls('candidates')).toHaveLength(1);

    // The url fails once the version's retry pause is over: the version it
    // answered before must not drive a record on the next command.
    vi.mocked(fetchDeployedVersion).mockResolvedValue(null);
    expect(await checkRelease(repo, { now: T0 + 10 * MIN })).toBeNull();
    expect(fetchDeployedVersion).toHaveBeenCalledTimes(2);
    expect(await checkRelease(repo, { now: T0 + 11 * MIN })).toBeNull();
    expect(calls('candidates')).toHaveLength(1);
    expect(calls('record')).toHaveLength(0);

    // A url that failed is asked again after ten minutes, not two.
    expect(await checkRelease(repo, { now: T0 + 12 * MIN })).toBeNull();
    expect(await checkRelease(repo, { now: T0 + 19 * MIN })).toBeNull();
    expect(fetchDeployedVersion).toHaveBeenCalledTimes(2);
    expect(await checkRelease(repo, { now: T0 + 20 * MIN })).toBeNull();
    expect(fetchDeployedVersion).toHaveBeenCalledTimes(3);

    // Once it answers again, the check goes on and the two-minute pace returns.
    vi.mocked(fetchDeployedVersion).mockResolvedValue({
      version: '0.25.0',
      build: null,
    });
    expect(await checkRelease(repo, { now: T0 + 30 * MIN })).toContain('ZM-23');
    expect(await checkRelease(repo, { now: T0 + 32 * MIN })).toBeNull();
    expect(fetchDeployedVersion).toHaveBeenCalledTimes(5);
  });

  it('names a missing tag once per version, stays quiet on the retry, and records once the tag appears', async () => {
    const landed = commit(
      repo,
      'b',
      'feat: the work',
      'Squashed-from: feature/23 (abcdef1) ZM-23'
    );
    candidates = [candidate(23, landed)];
    vi.mocked(fetchDeployedVersion).mockResolvedValue({
      version: '0.25.0',
      build: null,
    });

    expect(await checkRelease(repo, { now: T0 })).toContain(
      'tag v0.25.0 is not in this repository'
    );
    expect(await checkRelease(repo, { now: T0 + 3 * MIN })).toBeNull(); // inside the retry pause
    expect(await checkRelease(repo, { now: T0 + 11 * MIN })).toBeNull(); // retried, still no tag
    git(repo, 'tag', 'v0.25.0', landed);
    expect(await checkRelease(repo, { now: T0 + 22 * MIN })).toContain('ZM-23');
    expect(calls('record')).toHaveLength(1);
  });

  it('reports a rollback and changes no card', async () => {
    git(repo, 'tag', 'v0.24.3', commit(repo, 'b', 'chore(release): 0.24.3'));
    git(repo, 'tag', 'v0.25.0', commit(repo, 'c', 'chore(release): 0.25.0'));
    vi.mocked(fetchDeployedVersion).mockResolvedValueOnce({
      version: '0.25.0',
      build: null,
    });
    await checkRelease(repo, { now: T0 });
    vi.mocked(fetchDeployedVersion).mockResolvedValueOnce({
      version: '0.24.3',
      build: null,
    });

    expect(await checkRelease(repo, { now: T0 + 3 * MIN })).toContain(
      'back to v0.24.3'
    );
    expect(calls('record')).toHaveLength(2);
    expect(calls('record')[1]?.[0]).toMatchObject({
      version: '0.24.3',
      card_ids: [],
    });
    expect(calls('candidates')).toHaveLength(1);
  });

  it('stays silent and tries again later when the server cannot answer', async () => {
    git(repo, 'tag', 'v0.25.0', commit(repo, 'b', 'chore(release): 0.25.0'));
    vi.mocked(fetchDeployedVersion).mockResolvedValue({
      version: '0.25.0',
      build: null,
    });

    vi.mocked(callRelease).mockRejectedValueOnce(new Error('server down')); // the setting
    expect(await checkRelease(repo, { now: T0 })).toBeNull();
    expect(await checkRelease(repo, { now: T0 + MIN })).toBeNull(); // inside the setting's pause
    expect(callRelease).toHaveBeenCalledTimes(1);
    expect(fetchDeployedVersion).not.toHaveBeenCalled();

    vi.mocked(callRelease)
      .mockImplementationOnce(async () => ({ settings }))
      .mockRejectedValueOnce(new Error('timeout')); // the candidates
    expect(await checkRelease(repo, { now: T0 + 2 * MIN })).toBeNull();
    expect(await checkRelease(repo, { now: T0 + 5 * MIN })).toBeNull(); // inside the retry pause
    expect(calls('candidates')).toHaveLength(1);

    expect(await checkRelease(repo, { now: T0 + 12 * MIN })).toContain(
      'PRODUCTION IS AT v0.25.0'
    );
  });

  it('a stalled server is asked for the setting at most every two minutes', async () => {
    vi.mocked(callRelease).mockRejectedValue(new Error('no answer'));
    for (const at of [0, 30 * 1000, 90 * 1000, 2 * MIN]) {
      expect(await checkRelease(repo, { now: T0 + at })).toBeNull();
    }
    expect(calls('settings')).toHaveLength(2);
  });

  it('takes the newest release tag as the state when the project has no url', async () => {
    settings = settingsWith({ version_url: null });
    const landed = commit(
      repo,
      'b',
      'feat: the work',
      'Squashed-from: feature/23 (abcdef1) ZM-23'
    );
    git(repo, 'tag', 'v0.9.0', landed);
    const release = commit(repo, 'c', 'chore(release): 0.10.0');
    git(repo, 'tag', 'v0.10.0', release);
    git(repo, 'tag', 'nightly', release);
    candidates = [candidate(23, landed)];

    const line = await checkRelease(repo, { now: T0 });
    expect(fetchDeployedVersion).not.toHaveBeenCalled();
    expect(line).toContain('v0.10.0');
    expect(calls('record')[0]?.[0]).toMatchObject({
      version: '0.10.0',
      source: 'tag',
      release_commit: release,
    });
  });

  it('says the state is known, without claiming no card, when another session recorded it first', async () => {
    git(repo, 'tag', 'v0.25.0', commit(repo, 'b', 'chore(release): 0.25.0'));
    vi.mocked(fetchDeployedVersion).mockResolvedValue({
      version: '0.25.0',
      build: '849d7cac',
    });
    firstObserved = false;

    const line = await checkRelease(repo, { now: T0 });
    expect(line).toContain('already recorded');
    expect(line).not.toContain('no card');
  });

  it('marks a return to an earlier state as a rollback, and forward again as known', async () => {
    git(repo, 'tag', 'v0.24.3', commit(repo, 'b', 'chore(release): 0.24.3'));
    git(repo, 'tag', 'v0.25.0', commit(repo, 'c', 'chore(release): 0.25.0'));
    const at = (version: string) =>
      vi
        .mocked(fetchDeployedVersion)
        .mockResolvedValueOnce({ version, build: null });
    at('0.24.3');
    await checkRelease(repo, { now: T0 });
    at('0.25.0');
    await checkRelease(repo, { now: T0 + 3 * MIN });
    at('0.24.3');
    expect(await checkRelease(repo, { now: T0 + 6 * MIN })).toContain(
      'back to v0.24.3'
    );
    expect(calls('record')).toHaveLength(3);
    expect(calls('record')[2]?.[0]).toMatchObject({
      version: '0.24.3',
      card_ids: [],
    });
    firstObserved = false;
    at('0.25.0');
    expect(await checkRelease(repo, { now: T0 + 9 * MIN })).toContain(
      'already recorded'
    );
    expect(calls('record')).toHaveLength(4);
    at('0.25.0');
    expect(await checkRelease(repo, { now: T0 + 12 * MIN })).toBeNull();
    expect(calls('record')).toHaveLength(4);
  });

  it('does not mark a card whose newest landing is not yet in the release', async () => {
    const first = commit(
      repo,
      'b',
      'feat: the work',
      'Squashed-from: feature/23 (abcdef1) ZM-23'
    );
    const release = commit(repo, 'c', 'chore(release): 1.0.0');
    git(repo, 'tag', 'v1.0.0', release);
    const followUp = commit(
      repo,
      'd',
      'fix: the follow-up',
      'Squashed-from: feature/23b (abcdef3) ZM-23'
    );
    candidates = [
      {
        ...candidate(23, first),
        landings: [
          { repo: REPO, branch: 'feature/23', squash_sha: first },
          { repo: REPO, branch: 'feature/23b', squash_sha: followUp },
        ],
      },
    ];
    vi.mocked(fetchDeployedVersion).mockResolvedValue({
      version: '1.0.0',
      build: null,
    });
    const line = await checkRelease(repo, { now: T0 });
    expect(line).not.toContain('ZM-23');
    expect(calls('record')[0]?.[0]).toMatchObject({ card_ids: [] });
  });

  it('a forced check names a missing tag each time and records inside the pause once the tag exists', async () => {
    const landed = commit(
      repo,
      'b',
      'feat: the work',
      'Squashed-from: feature/23 (abcdef1) ZM-23'
    );
    candidates = [candidate(23, landed)];
    vi.mocked(fetchDeployedVersion).mockResolvedValue({
      version: '0.25.0',
      build: null,
    });

    expect(await checkRelease(repo, { now: T0 })).toContain(
      'tag v0.25.0 is not in this repository'
    );
    expect(await checkRelease(repo, { now: T0 + MIN, force: true })).toContain(
      'tag v0.25.0 is not in this repository'
    );
    git(repo, 'tag', 'v0.25.0', landed);
    expect(await checkRelease(repo, { now: T0 + 2 * MIN })).toBeNull(); // the hook waits out the pause
    expect(
      await checkRelease(repo, { now: T0 + 3 * MIN, force: true })
    ).toContain('ZM-23');
    expect(calls('record')).toHaveLength(1);
  });

  it('lets each checkout of a project mark the cards it carries, and a manual run records a recorded state again', async () => {
    const other = mkdtempSync(join(tmpdir(), 'zm-release-repo-b-'));
    try {
      git(other, 'init', '-q', '-b', 'main');
      git(
        other,
        'remote',
        'add',
        'origin',
        'git@github.com:acme/edge-proxy.git'
      );
      commit(other, 'a', 'chore: start');
      recordProjectScope(
        projectScopeStatePath(),
        resolveProjectHint(other),
        'proj.usr_x.demo'
      );
      const landedHere = commit(
        repo,
        'b',
        'feat: the work',
        'Squashed-from: feature/23 (abcdef1) ZM-23'
      );
      git(repo, 'tag', 'v1.0.0', landedHere);
      const landedThere = commit(
        other,
        'b',
        'feat: the proxy',
        'Squashed-from: feature/30 (abcdef4) ZM-30'
      );
      git(other, 'tag', 'v1.0.0', landedThere);
      candidates = [
        candidate(23, landedHere),
        {
          ...candidate(30, landedThere),
          landings: [
            {
              repo: 'acme/edge-proxy',
              branch: 'feature/30',
              squash_sha: landedThere,
            },
          ],
        },
      ];
      vi.mocked(fetchDeployedVersion).mockResolvedValue({
        version: '1.0.0',
        build: null,
      });

      expect(await checkRelease(repo, { now: T0 })).toContain('ZM-23');
      // The same state, seen from the other checkout of the project: its own
      // card is marked there, though this machine already handled the state.
      const there = await checkRelease(other, { now: T0 + 1000 });
      expect(there).toContain('ZM-30');
      expect(there).not.toContain('ZM-23');
      expect(calls('record')[1]?.[0]).toMatchObject({
        version: '1.0.0',
        card_ids: [cardId(30)],
      });

      // By hand, a recorded state is recorded again: a landing whose record
      // came late is reconciled then. The hook still leaves it alone.
      await checkRelease(repo, { now: T0 + 2000, force: true });
      expect(calls('record')).toHaveLength(3);
      expect(calls('record')[2]?.[0]).toMatchObject({
        version: '1.0.0',
        card_ids: [cardId(23)],
      });
      expect(await checkRelease(repo, { now: T0 + 3000 })).toBeNull();
      expect(calls('record')).toHaveLength(3);
    } finally {
      rmSync(other, { recursive: true, force: true });
    }
  });

  it('leaves a folder the user ignored alone', async () => {
    writeFileSync(join(repo, '.zero-memory-ignore'), '');
    git(repo, 'tag', 'v0.25.0', commit(repo, 'b', 'chore(release): 0.25.0'));
    vi.mocked(fetchDeployedVersion).mockResolvedValue({
      version: '0.25.0',
      build: null,
    });
    expect(await checkRelease(repo, { now: T0 })).toBeNull();
    expect(await checkRelease(repo, { now: T0, force: true })).toBeNull();
    expect(callRelease).not.toHaveBeenCalled();
    expect(fetchDeployedVersion).not.toHaveBeenCalled();
  });
});

describe('runRelease', () => {
  let state: string;
  let repo: string;
  let previous: string | undefined;
  let printed: string[];

  const settings: ReleaseSettings = {
    scope: 'proj.usr_x.demo',
    version_url: 'https://api.example.com/healthz',
    version_field: 'version',
    tag_template: 'v{version}',
    tag_pattern: 'v*',
    on_release: 'record',
    updated_at: '2026-09-24T00:00:00Z',
  };
  const answer = (value: ReleaseSettings | null) =>
    vi.mocked(callRelease).mockImplementation(async (input) => {
      if (input.action === 'settings') return { settings: value };
      if (input.action === 'candidates') return { cards: [] };
      return {
        release: {
          version: input.version ?? '',
          build: input.build ?? null,
          release_commit: input.release_commit ?? '',
          source: input.source ?? 'url',
          observed_at: '2026-09-24T08:00:00Z',
          first_observed: true,
        },
        recorded: [],
        moved: [],
      };
    });
  const run = async (): Promise<string> => {
    printed = [];
    await runRelease(repo);
    return printed.join('');
  };

  beforeEach(() => {
    previous = process.env.XDG_STATE_HOME;
    state = mkdtempSync(join(tmpdir(), 'zm-release-run-state-'));
    process.env.XDG_STATE_HOME = state;
    repo = mkdtempSync(join(tmpdir(), 'zm-release-run-repo-'));
    git(repo, 'init', '-q', '-b', 'main');
    git(
      repo,
      'remote',
      'add',
      'origin',
      'git@github.com:acme/memory-service.git'
    );
    git(repo, 'tag', 'v0.25.0', commit(repo, 'a', 'chore(release): 0.25.0'));
    recordProjectScope(
      projectScopeStatePath(),
      resolveProjectHint(repo),
      'proj.usr_x.demo'
    );
    vi.mocked(callRelease).mockReset();
    answer(settings);
    vi.mocked(fetchDeployedVersion).mockReset().mockResolvedValue({
      version: '0.25.0',
      build: null,
    });
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
      printed.push(String(chunk));
      return true;
    });
  });
  afterEach(() => {
    vi.mocked(process.stdout.write).mockRestore();
    process.env.XDG_STATE_HOME = previous;
    rmSync(state, { recursive: true, force: true });
    rmSync(repo, { recursive: true, force: true });
  });

  it('prints what it found', async () => {
    expect(await run()).toBe(
      'PRODUCTION IS AT v0.25.0: no card on the board carries a landing in it.\n'
    );
  });

  it('says so when this folder is not a briefed project', async () => {
    rmSync(projectScopeStatePath(), { force: true });
    expect(await run()).toBe('release: this folder is not a briefed project\n');
  });

  it('says so when the project names no production state', async () => {
    answer(null);
    expect(await run()).toBe(
      'release: this project names no production state\n'
    );
  });

  it('says so when the server could not be asked', async () => {
    vi.mocked(callRelease).mockRejectedValue(new Error('server down'));
    expect(await run()).toBe(
      'release: the server could not be asked — try again later\n'
    );
  });

  it('records a recorded state again when asked by hand', async () => {
    await run();
    expect(await run()).toBe(
      'PRODUCTION IS AT v0.25.0: no card on the board carries a landing in it.\n'
    );
    expect(
      vi
        .mocked(callRelease)
        .mock.calls.filter(([input]) => input.action === 'record')
    ).toHaveLength(2);
  });

  it('says there is nothing new when no release tag names a state', async () => {
    answer({ ...settings, version_url: null, tag_pattern: 'release-*' });
    expect(await run()).toBe('release: nothing new for this project\n');
  });

  it("says so when production's version could not be read", async () => {
    vi.mocked(fetchDeployedVersion).mockReset().mockResolvedValue(null);
    expect(await run()).toBe(
      "release: production's version could not be read (the version url did not answer with one)\n"
    );
  });

  it('says so when this folder is not a git checkout', async () => {
    const bare = mkdtempSync(join(tmpdir(), 'zm-release-run-nogit-'));
    try {
      recordProjectScope(
        projectScopeStatePath(),
        resolveProjectHint(bare),
        'proj.usr_x.demo'
      );
      printed = [];
      await runRelease(bare);
      expect(printed.join('')).toBe(
        'release: this folder is not a git checkout\n'
      );
    } finally {
      rmSync(bare, { recursive: true, force: true });
    }
  });

  it('says so when a tag-mode project is not a git checkout', async () => {
    answer({ ...settings, version_url: null });
    const bare = mkdtempSync(join(tmpdir(), 'zm-release-run-nogit-tag-'));
    try {
      recordProjectScope(
        projectScopeStatePath(),
        resolveProjectHint(bare),
        'proj.usr_x.demo'
      );
      printed = [];
      await runRelease(bare);
      expect(printed.join('')).toBe(
        'release: this folder is not a git checkout\n'
      );
    } finally {
      rmSync(bare, { recursive: true, force: true });
    }
  });

  it('says so when the user ignored this folder', async () => {
    writeFileSync(join(repo, '.zero-memory-ignore'), '');
    expect(await run()).toBe(
      'release: this folder is ignored (.zero-memory-ignore); nothing was checked\n'
    );
    expect(callRelease).not.toHaveBeenCalled();
  });
});
