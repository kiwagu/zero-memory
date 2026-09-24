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
import { checkRelease } from './release-runner.js';

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
    vi.mocked(fetchDeployedVersion).mockResolvedValue(null);
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
    expect(fetchDeployedVersion).not.toHaveBeenCalled();

    vi.mocked(callRelease)
      .mockImplementationOnce(async () => ({ settings }))
      .mockRejectedValueOnce(new Error('timeout')); // the candidates
    expect(await checkRelease(repo, { now: T0 + MIN })).toBeNull();
    expect(await checkRelease(repo, { now: T0 + 5 * MIN })).toBeNull(); // inside the retry pause
    expect(calls('candidates')).toHaveLength(1);

    expect(await checkRelease(repo, { now: T0 + 12 * MIN })).toContain(
      'PRODUCTION IS AT v0.25.0'
    );
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
});
