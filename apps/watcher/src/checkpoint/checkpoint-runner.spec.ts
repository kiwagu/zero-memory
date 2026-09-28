import { briefStatePath, loadBriefState } from '@workspace/client-runtime';
import { describe, expect, it } from 'vitest';

import { fakeHookClient, hookInput } from '../testing/hook-client.fake.js';
import { useStateDirs } from '../testing/state-dir.fixture.js';
import { runCheckpoint, runPostCompact } from './checkpoint-runner.js';

describe('Codex PostCompact boundary', () => {
  const dirs = useStateDirs('zm-postcompact');

  // What a boundary re-arms (task, rules, the window's tail) and keeps (the
  // thread) is the state module's own contract; this pins the wiring alone:
  // the hook opens a new epoch for its session, and prints nothing.
  it('opens a new context epoch and writes no hook frame', async () => {
    const sessionId = 'sess-postcompact';
    const client = fakeHookClient({
      sessionId,
      cwd: dirs.work,
      hookEventName: 'PostCompact',
      trigger: 'auto',
    });

    await runPostCompact(client);

    expect(loadBriefState(briefStatePath())[sessionId]?.epoch).toBe(1);
    expect(client.emitted).toEqual([]);
  });

  it('reads a PreCompact payload once and passes it into capture', async () => {
    let reads = 0;
    const client = fakeHookClient(
      {},
      {
        readInput: async () => {
          reads += 1;
          return hookInput({
            sessionId: 'sess-precompact',
            cwd: dirs.work,
            hookEventName: 'PreCompact',
            trigger: 'manual',
          });
        },
      }
    );

    await runCheckpoint(client);

    expect(reads).toBe(1);
  });
});
