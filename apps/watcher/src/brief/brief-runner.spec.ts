import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';

import {
  briefStatePath,
  callBuildContext,
  loadBriefState,
  markRulesDelivered,
  markTaskBriefed,
  projectScopeStatePath,
  recordProjectScope,
  recordSessionThread,
  stampSessionStart,
} from '@workspace/client-runtime';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { branchNameToTopic, runBrief } from './brief-runner.js';
import type { HookClient } from '../hook-client.js';
import { resolveProjectHint } from '../project-hint-resolver.js';

vi.mock('@workspace/client-runtime', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@workspace/client-runtime')>()),
  callBuildContext: vi.fn(),
}));

describe('branchNameToTopic', () => {
  it('turns a feature branch into a space-separated topic', () => {
    expect(branchNameToTopic('feature/ui-extractor-settings')).toBe(
      'ui extractor settings'
    );
  });

  it('normalizes slashes and dashes to single spaces', () => {
    expect(branchNameToTopic('feature/watcher-brief/hooks')).toBe(
      'watcher brief hooks'
    );
  });

  it('keeps a non-feature branch name as its topic', () => {
    expect(branchNameToTopic('spike-oauth')).toBe('spike oauth');
  });

  it.each(['main', 'dev', 'stage', 'master'])(
    'skips the trunk branch %s (briefing == project briefing)',
    (branch) => {
      expect(branchNameToTopic(branch)).toBeNull();
    }
  );

  it('skips a detached HEAD and empty names', () => {
    expect(branchNameToTopic('HEAD')).toBeNull();
    expect(branchNameToTopic('')).toBeNull();
  });
});

/**
 * The per-message assertion, driven end to end through `runBrief('task', …)`.
 *
 * An acknowledgement prompt is deliberate: the runner emits the banner and
 * then returns before any server call, so these exercise the real wiring —
 * which state the banner reads — with no network and no stubs in between.
 */
describe('per-message project/thread banner', () => {
  let stateDir: string;
  let workDir: string;
  let previousState: string | undefined;

  const bannerFor = async (sessionId: string): Promise<string | null> => {
    let emitted: string | null = null;
    const adapter: HookClient = {
      kind: 'claude',
      ingestProvenance: 'test',
      canTaskBrief: true,
      readInput: async () => ({
        sessionId,
        cwd: workDir,
        prompt: 'ok',
        transcriptPath: '',
        hookEventName: 'UserPromptSubmit',
        toolName: '',
        alreadyContinued: false,
        source: '',
        trigger: '',
      }),
      parse: () => {
        throw new Error('the banner path never parses a transcript');
      },
      emitSessionBrief: () => {},
      emitTaskBrief: (context) => {
        emitted = context;
      },
      emitTurnContext: () => {},
      emitReceipt: () => {},
      emitCompactionAnchor: () => {},
      canAnchorCompaction: false,
    };
    await runBrief('task', adapter);
    return emitted;
  };

  beforeEach(() => {
    stateDir = mkdtempSync(join(tmpdir(), 'zm-banner-state-'));
    workDir = mkdtempSync(join(tmpdir(), 'zm-banner-work-'));
    previousState = process.env.XDG_STATE_HOME;
    process.env.XDG_STATE_HOME = stateDir;
    recordProjectScope(
      projectScopeStatePath(),
      resolveProjectHint(workDir),
      'proj.usr_x.demo'
    );
  });

  afterEach(() => {
    vi.mocked(callBuildContext).mockReset();
    if (previousState === undefined) delete process.env.XDG_STATE_HOME;
    else process.env.XDG_STATE_HOME = previousState;
    rmSync(stateDir, { recursive: true, force: true });
    rmSync(workDir, { recursive: true, force: true });
  });

  it('gives each conversation in one repo its own token', async () => {
    recordSessionThread(briefStatePath(), 'sess-1', 'thr_one.01a');
    recordSessionThread(briefStatePath(), 'sess-2', 'thr_two.01b');

    // The regression: with the token kept per project, the session briefed
    // last owned the slot and BOTH banners quoted 'thr_two'.
    expect(await bannerFor('sess-1')).toContain('THREAD: thr_one.01a');
    expect(await bannerFor('sess-2')).toContain('THREAD: thr_two.01b');
    expect(await bannerFor('sess-1')).not.toContain('thr_two.01b');
  });

  it('states the project alone when this session has no token yet', async () => {
    recordSessionThread(briefStatePath(), 'sess-other', 'thr_other.01c');

    const banner = await bannerFor('sess-fresh');
    expect(banner).toContain('PROJECT: proj.usr_x.demo');
    expect(banner).not.toContain('THREAD:');
  });

  it('says nothing at all until the repo has a resolved project', async () => {
    rmSync(projectScopeStatePath(), { force: true });

    expect(await bannerFor('sess-1')).toBeNull();
  });

  it('tells the agent to make the task lookup itself', async () => {
    // The hook stopped guessing a topic from the prompt, so the pack it
    // carries is the PROJECT's. This line is what replaces the guess — and it
    // has to survive, which is why it sits ahead of the droppable sections.
    const sessionId = 'sess-instruct';
    recordSessionThread(briefStatePath(), sessionId, 'thr_instruct.01e');
    vi.mocked(callBuildContext).mockResolvedValue({
      memories: [
        {
          id: 'mem_0000000000000002.0000000000',
          content: 'a project-level fact',
          kind: 'fact',
          scope: 'proj.usr_x.demo',
          created_at: '2026-08-18T00:00:00Z',
          score: 0.5,
        },
      ],
      entities: [],
      edges: [],
      linked_memories: [],
      project_scope: 'proj.usr_x.demo',
    });

    let emitted: string | null = null;
    const adapter: HookClient = {
      kind: 'claude',
      ingestProvenance: 'test',
      canTaskBrief: true,
      canAnchorCompaction: false,
      readInput: async () => ({
        sessionId,
        cwd: workDir,
        prompt:
          'add a retry with backoff to the ingest worker, it drops chunks',
        transcriptPath: '',
        hookEventName: 'UserPromptSubmit',
        toolName: '',
        alreadyContinued: false,
        source: '',
        trigger: '',
      }),
      parse: () => {
        throw new Error('the task path never parses a transcript');
      },
      emitSessionBrief: () => {},
      emitTaskBrief: (context) => {
        emitted = context;
      },
      emitTurnContext: () => {},
      emitReceipt: () => {},
      emitCompactionAnchor: () => {},
    };

    await runBrief('task', adapter);

    const text = emitted as string | null;
    expect(text).toContain('call build_context yourself');
    expect(text).toContain('English topic');
    // And the pack is labelled for what it actually is — the project — rather
    // than for a task nobody looked up.
    expect(text).toContain(basename(workDir));
    // The prompt itself never reaches the server.
    const sent = vi.mocked(callBuildContext).mock.calls[0]?.[0];
    expect(sent?.topic).toBe(basename(workDir));
  });

  it('rebriefs after compaction and emits one Codex frame with the same thread', async () => {
    const sessionId = 'sess-compact';
    recordSessionThread(briefStatePath(), sessionId, 'thr_compact.01d');
    markTaskBriefed(briefStatePath(), sessionId);
    markRulesDelivered(briefStatePath(), sessionId);
    stampSessionStart(briefStatePath(), sessionId, 200, 'compact');
    vi.mocked(callBuildContext).mockResolvedValue({
      memories: [
        {
          id: 'mem_0000000000000001.0000000000',
          content: 'context restored after compaction',
          kind: 'fact',
          scope: 'proj.usr_x.demo',
          created_at: '2026-08-17T00:00:00Z',
          score: 0.5,
        },
      ],
      entities: [],
      edges: [],
      linked_memories: [],
      project_scope: 'proj.usr_x.demo',
      session: {
        attached_project: 'proj.usr_x.demo',
        thread: 'thr_compact.01d',
      },
    });

    const emitted: string[] = [];
    const adapter: HookClient = {
      kind: 'codex',
      ingestProvenance: 'test',
      canTaskBrief: true,
      canAnchorCompaction: false,
      readInput: async () => ({
        sessionId,
        cwd: workDir,
        prompt: 'restore the exact working context after compaction',
        transcriptPath: '',
        hookEventName: 'UserPromptSubmit',
        toolName: '',
        alreadyContinued: false,
        source: '',
        trigger: '',
      }),
      parse: () => ({ entries: [], recalledIds: [] }),
      emitSessionBrief: () => {},
      emitTaskBrief: (context) => void emitted.push(context),
      emitTurnContext: () => {},
      emitReceipt: () => {},
      emitCompactionAnchor: () => {},
    };

    await runBrief('task', adapter);

    expect(emitted).toHaveLength(1);
    expect(emitted[0]).toContain('THREAD: thr_compact.01d');
    expect(emitted[0]).toContain('context restored after compaction');
    expect(loadBriefState(briefStatePath())[sessionId]?.task_briefed).toBe(
      true
    );
  });
});
