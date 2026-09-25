import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  callCardBranches,
  landingCheckDue,
  landingCheckStatePath,
  projectScopeStatePath,
  recordProjectScope,
} from '@workspace/client-runtime';
import { cardIdSchema } from '@workspace/contracts';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { HookClient, HookInput } from '../hook-client.js';
import { resolveProjectHint } from '../project-hint-resolver.js';
import { checkRelease } from '../release/release-runner.js';
import { landingDriftFor, runLanding } from './landing-runner.js';

vi.mock('@workspace/client-runtime', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@workspace/client-runtime')>()),
  callCardBranches: vi.fn(),
}));
vi.mock('../release/release-runner.js', () => ({ checkRelease: vi.fn() }));

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

const CARD = {
  id: cardIdSchema.parse('crd_0000000000000019.0000000000'),
  number: 19,
  state: 'active' as const,
};

describe('runLanding', () => {
  let state: string;
  let repo: string;
  let previous: string | undefined;
  let said: string[];

  const adapter = (cwd?: string): HookClient => ({
    kind: 'claude',
    ingestProvenance: 'test',
    canTaskBrief: true,
    canAnchorCompaction: false,
    readInput: async (): Promise<HookInput> => ({
      sessionId: 's1',
      cwd: cwd ?? repo,
      prompt: '',
      transcriptPath: '',
      hookEventName: 'PostToolUse',
      toolName: 'Bash',
      alreadyContinued: false,
      source: '',
      trigger: '',
    }),
    parse: () => {
      throw new Error('unused');
    },
    emitSessionBrief: () => {},
    emitTaskBrief: () => {},
    emitTurnContext: (_event, text) => {
      said.push(text);
    },
    emitReceipt: () => {},
    emitCompactionAnchor: () => {},
  });

  beforeEach(() => {
    previous = process.env.XDG_STATE_HOME;
    state = mkdtempSync(join(tmpdir(), 'zm-landing-state-'));
    process.env.XDG_STATE_HOME = state;
    repo = mkdtempSync(join(tmpdir(), 'zm-landing-repo-'));
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
    said = [];
    vi.mocked(callCardBranches).mockReset();
    vi.mocked(checkRelease).mockReset().mockResolvedValue(null);
  });
  afterEach(() => {
    process.env.XDG_STATE_HOME = previous;
    rmSync(state, { recursive: true, force: true });
    rmSync(repo, { recursive: true, force: true });
  });

  it('stays silent and asks nobody after an ordinary commit', async () => {
    commit(repo, 'b', 'fix: a typo');
    await runLanding(adapter());
    expect(said).toEqual([]);
    expect(callCardBranches).not.toHaveBeenCalled();
  });

  it('reminds once about a squash the card has no record of, even under a release commit', async () => {
    const squash = commit(
      repo,
      'b',
      'feat: the work',
      'Squashed-from: feature/x (abcdef1) ZM-19'
    );
    commit(repo, 'c', 'chore(release): 0.30.0');
    vi.mocked(callCardBranches).mockResolvedValue({ card: CARD, branches: [] });

    await runLanding(adapter());
    expect(said).toHaveLength(1);
    expect(said[0]).toContain('"card_id":"crd_0000000000000019.0000000000"');
    expect(said[0]).toContain(`"squash_sha":"${squash.slice(0, 7)}"`);
    expect(said[0]).toContain('"repo":"acme/memory-service"');
    expect(said[0]).toContain('"target":"main"');

    await runLanding(adapter());
    expect(said).toHaveLength(1);
    expect(callCardBranches).toHaveBeenCalledTimes(1);
  });

  it('stays silent when the board already holds the landing', async () => {
    const squash = commit(
      repo,
      'b',
      'feat: the work',
      'Squashed-from: feature/x (abcdef1) #19'
    );
    vi.mocked(callCardBranches).mockResolvedValue({
      card: CARD,
      branches: [
        {
          repo: 'acme/memory-service',
          branch: 'feature/x',
          state: 'landed',
          squash_sha: squash.slice(0, 7),
          target: 'main',
          landed_at: 'x',
          attached_at: 'x',
          landings: [],
        },
      ],
    });
    await runLanding(adapter());
    expect(said).toEqual([]);
  });

  it('stays silent about the earlier squash of a branch that landed again', async () => {
    // A bug fixed in the branch that brought it: the branch lands twice, and
    // its row names only the second squash.
    const first = commit(
      repo,
      'b',
      'feat: the work',
      'Squashed-from: feature/x (abcdef1) ZM-19'
    );
    const second = commit(
      repo,
      'c',
      'fix: the bug, in the same branch',
      'Squashed-from: feature/x (abcdef2) ZM-19'
    );
    vi.mocked(callCardBranches).mockResolvedValue({
      card: CARD,
      branches: [
        {
          repo: 'acme/memory-service',
          branch: 'feature/x',
          state: 'landed',
          squash_sha: second.slice(0, 7),
          target: 'main',
          landed_at: 'x',
          attached_at: 'x',
          landings: [
            { squash_sha: first.slice(0, 7), target: 'main', landed_at: 'x' },
            { squash_sha: second.slice(0, 7), target: 'main', landed_at: 'x' },
          ],
        },
      ],
    });
    await runLanding(adapter());
    expect(said).toEqual([]);
  });

  it('asks about every card a squash names', async () => {
    commit(
      repo,
      'b',
      'feat: two cards',
      'Squashed-from: feature/x (abcdef1) ZM-17 ZM-16'
    );
    vi.mocked(callCardBranches).mockImplementation(async (_scope, number) => ({
      card: { ...CARD, id: `crd_00000000000000${number}.0000000000`, number },
      branches: [],
    }));
    await runLanding(adapter());
    expect(said).toHaveLength(1);
    expect(said[0]!.split('\n')).toHaveLength(2);
  });

  it('never throws and retries later when the server cannot answer', async () => {
    commit(
      repo,
      'b',
      'feat: the work',
      'Squashed-from: feature/x (abcdef1) ZM-19'
    );
    vi.mocked(callCardBranches).mockRejectedValue(new Error('ECONNREFUSED'));
    await expect(runLanding(adapter())).resolves.toBeUndefined();
    await runLanding(adapter());
    expect(said).toEqual([]);
    expect(callCardBranches).toHaveBeenCalledTimes(1);
  });

  it('bounds a stalled server and records the attempt before asking', async () => {
    commit(
      repo,
      'b',
      'feat: the work',
      'Squashed-from: feature/x (abcdef1) ZM-19'
    );
    let recordedBeforeAsking = false;
    vi.mocked(callCardBranches).mockImplementation(() => {
      // A process killed by the host's hook timeout must still leave the
      // attempt behind, or every later command stalls on the same squash.
      recordedBeforeAsking = !landingCheckDue(
        landingCheckStatePath(),
        `${git(repo, 'rev-parse', 'HEAD')}#19`
      );
      return new Promise(() => {});
    });
    const started = Date.now();
    await runLanding(adapter(), { lookupTimeoutMs: 200 });
    expect(Date.now() - started).toBeLessThan(2000);
    expect(recordedBeforeAsking).toBe(true);
    expect(said).toEqual([]);
  });

  it('shares one budget across its lookups, and leaves the rest for the next command', async () => {
    const keys = [31, 32, 33, 34].map(
      (number) =>
        `${commit(
          repo,
          `w${number}`,
          `feat: work ${number}`,
          `Squashed-from: feature/x${number} (abcdef1) ZM-${number}`
        )}#${number}`
    );
    vi.mocked(callCardBranches).mockImplementation(() => new Promise(() => {}));
    const started = Date.now();
    await runLanding(adapter(), { lookupTimeoutMs: 200, budgetMs: 450 });
    expect(Date.now() - started).toBeLessThan(1500);
    const asked = vi.mocked(callCardBranches).mock.calls.length;
    expect(asked).toBeGreaterThan(0);
    expect(asked).toBeLessThan(keys.length);
    // What it had no time for was never marked, so the next command asks it.
    const stillDue = keys.filter((key) =>
      landingCheckDue(landingCheckStatePath(), key)
    );
    expect(stillDue).toHaveLength(keys.length - asked);

    // Ten minutes on, the attempted ones are due again too — and the ones
    // never asked go first, so a stalled server cannot starve them.
    const firstAsked = vi
      .mocked(callCardBranches)
      .mock.calls.map(([, number]) => number);
    const neverAsked = [31, 32, 33, 34].filter(
      (number) => !firstAsked.includes(number)
    );
    const path = landingCheckStatePath();
    const aged = Object.fromEntries(
      Object.entries(
        JSON.parse(readFileSync(path, 'utf8')) as Record<
          string,
          { outcome: string; checked_at: number }
        >
      ).map(([key, entry]) => [
        key,
        { ...entry, checked_at: entry.checked_at - 11 * 60 * 1000 },
      ])
    );
    writeFileSync(path, JSON.stringify(aged));
    vi.mocked(callCardBranches).mockClear();
    await runLanding(adapter(), { lookupTimeoutMs: 200, budgetMs: 450 });
    const secondAsked = vi
      .mocked(callCardBranches)
      .mock.calls.map(([, number]) => number);
    expect(secondAsked.slice(0, neverAsked.length).sort()).toEqual(
      [...neverAsked].sort()
    );
  });

  it('names the branch the squash landed on, not the one checked out after it', async () => {
    commit(
      repo,
      'b',
      'feat: the work',
      'Squashed-from: feature/x (abcdef1) ZM-19'
    );
    git(repo, 'checkout', '-q', '-b', 'feature/next');
    vi.mocked(callCardBranches).mockResolvedValue({ card: CARD, branches: [] });
    await runLanding(adapter());
    expect(said).toHaveLength(1);
    expect(said[0]).toContain('"target":"main"');
  });

  it('notices a squash made from another worktree of the repository', async () => {
    const worktree = `${repo}-wt`;
    git(repo, 'worktree', 'add', '-q', '-b', 'feature/y', worktree);
    try {
      commit(
        repo,
        'b',
        'feat: landed from the main checkout',
        'Squashed-from: feature/y (1234567) ZM-19'
      );
      vi.mocked(callCardBranches).mockResolvedValue({
        card: CARD,
        branches: [],
      });
      await runLanding(adapter(worktree));
      expect(said).toHaveLength(1);
      expect(said[0]).toContain('"name":"feature/y"');
      expect(said[0]).toContain('"target":"main"');
    } finally {
      git(repo, 'worktree', 'remove', '--force', worktree);
    }
  });

  it('says what production took even when no squash is fresh', async () => {
    const line =
      'PRODUCTION TOOK THE CHANGES: v1.0.0 carries ZM-7; the release is recorded on each.';
    vi.mocked(checkRelease).mockResolvedValue(line);
    await runLanding(adapter());
    expect(said).toEqual([line]);
    expect(callCardBranches).not.toHaveBeenCalled();
  });

  it('asks nobody about a folder the user ignored', async () => {
    writeFileSync(join(repo, '.zero-memory-ignore'), '');
    commit(
      repo,
      'b',
      'feat: the work',
      'Squashed-from: feature/x (abcdef1) ZM-19'
    );
    vi.mocked(callCardBranches).mockResolvedValue({ card: CARD, branches: [] });
    vi.mocked(checkRelease).mockResolvedValue(
      'PRODUCTION TOOK THE CHANGES: v1.0.0 carries ZM-19; the release is recorded on each.'
    );
    await runLanding(adapter());
    expect(said).toEqual([]);
    expect(callCardBranches).not.toHaveBeenCalled();
    expect(checkRelease).not.toHaveBeenCalled();
  });

  it('says nothing about a project it has never briefed', async () => {
    rmSync(projectScopeStatePath(), { force: true });
    commit(
      repo,
      'b',
      'feat: the work',
      'Squashed-from: feature/x (abcdef1) ZM-19'
    );
    await runLanding(adapter());
    expect(said).toEqual([]);
    expect(callCardBranches).not.toHaveBeenCalled();
  });
});

describe('landingDriftFor', () => {
  let repo: string;

  beforeEach(() => {
    repo = mkdtempSync(join(tmpdir(), 'zm-drift-repo-'));
    git(repo, 'init', '-q', '-b', 'main');
    git(
      repo,
      'remote',
      'add',
      'origin',
      'git@github.com:acme/memory-service.git'
    );
    commit(repo, 'a', 'chore: start');
  });
  afterEach(() => rmSync(repo, { recursive: true, force: true }));

  it('names an open branch of this repository whose squash is already here', () => {
    const squash = commit(
      repo,
      'b',
      'feat: the work',
      'Squashed-from: feature/x (abcdef1) ZM-19'
    );
    const drift = landingDriftFor(repo, {
      bound_card: null,
      active: 1,
      waiting: 0,
      lead: [],
      open_branches: [
        {
          card_id: CARD.id,
          number: 19,
          state: 'active',
          repo: 'acme/memory-service',
          branch: 'feature/x',
        },
        {
          card_id: CARD.id,
          number: 19,
          state: 'active',
          repo: 'acme/other',
          branch: 'feature/x',
        },
        {
          card_id: CARD.id,
          number: 20,
          state: 'active',
          repo: 'acme/memory-service',
          branch: 'feature/not-yet',
        },
      ],
    });
    expect(drift).toEqual([
      {
        cardId: CARD.id,
        cardNumber: 19,
        state: 'active',
        repo: 'acme/memory-service',
        branch: 'feature/x',
        squashSha: squash,
        target: 'main',
      },
    ]);
  });
});
