import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  briefStatePath,
  loadBriefState,
  markRulesDelivered,
  markTaskBriefed,
  recordSessionThread,
} from '@workspace/client-runtime';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { HookClient } from '../hook-client.js';
import { runCheckpoint, runPostCompact } from './checkpoint-runner.js';

describe('Codex PostCompact boundary', () => {
  let stateDir: string;
  let workDir: string;
  let previousState: string | undefined;

  beforeEach(() => {
    stateDir = mkdtempSync(join(tmpdir(), 'zm-postcompact-state-'));
    workDir = mkdtempSync(join(tmpdir(), 'zm-postcompact-work-'));
    previousState = process.env.XDG_STATE_HOME;
    process.env.XDG_STATE_HOME = stateDir;
  });

  afterEach(() => {
    if (previousState === undefined) delete process.env.XDG_STATE_HOME;
    else process.env.XDG_STATE_HOME = previousState;
    rmSync(stateDir, { recursive: true, force: true });
    rmSync(workDir, { recursive: true, force: true });
  });

  it('re-arms task/rules, preserves thread, and writes no hook frame', async () => {
    const sessionId = 'sess-postcompact';
    const statePath = briefStatePath();
    recordSessionThread(statePath, sessionId, 'thr_preserved.01a');
    markTaskBriefed(statePath, sessionId);
    markRulesDelivered(statePath, sessionId);
    let emissions = 0;
    const adapter: HookClient = {
      kind: 'codex',
      ingestProvenance: 'test',
      canTaskBrief: true,
      canAnchorCompaction: false,
      readInput: async () => ({
        sessionId,
        cwd: workDir,
        prompt: '',
        transcriptPath: '',
        hookEventName: 'PostCompact',
        toolName: '',
        alreadyContinued: false,
        source: '',
        trigger: 'auto',
      }),
      parse: () => ({ entries: [], recalledIds: [] }),
      emitSessionBrief: () => void emissions++,
      emitTaskBrief: () => void emissions++,
      emitTurnContext: () => void emissions++,
      emitReceipt: () => void emissions++,
      emitCompactionAnchor: () => void emissions++,
    };

    await runPostCompact(adapter);

    const state = loadBriefState(statePath)[sessionId];
    expect(state).toMatchObject({
      epoch: 1,
      task_briefed: false,
      thread: 'thr_preserved.01a',
    });
    expect(state?.rules_epoch).toBeUndefined();
    expect(emissions).toBe(0);
  });

  it('reads a PreCompact payload once and passes it into capture', async () => {
    let reads = 0;
    const adapter: HookClient = {
      kind: 'codex',
      ingestProvenance: 'test',
      canTaskBrief: true,
      canAnchorCompaction: false,
      readInput: async () => {
        reads += 1;
        return {
          sessionId: 'sess-precompact',
          cwd: workDir,
          prompt: '',
          transcriptPath: '',
          hookEventName: 'PreCompact',
          toolName: '',
          alreadyContinued: false,
          source: '',
          trigger: 'manual',
        };
      },
      parse: () => ({ entries: [], recalledIds: [] }),
      emitSessionBrief: () => {},
      emitTaskBrief: () => {},
      emitTurnContext: () => {},
      emitReceipt: () => {},
      emitCompactionAnchor: () => {},
    };

    await runCheckpoint(adapter);

    expect(reads).toBe(1);
  });
});
