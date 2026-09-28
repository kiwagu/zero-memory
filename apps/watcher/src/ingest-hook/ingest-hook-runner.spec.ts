import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { IngestConversationInput } from '@workspace/contracts';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { hookClient, type HookInput } from '../hook-client.js';
import { flushTranscriptDelta } from './ingest-hook-runner.js';

const { sent } = vi.hoisted(() => ({
  sent: [] as IngestConversationInput[],
}));

// The one network edge: what the flush hands the server is the contract.
vi.mock('@workspace/client-runtime', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@workspace/client-runtime')>()),
  IngestClient: class {
    sendChunk(input: IngestConversationInput) {
      sent.push(input);
      return Promise.resolve({
        duplicate: false,
        memories_created: 0,
        memory_ids: [],
      });
    }
    close() {
      return Promise.resolve();
    }
  },
}));

const RECALLED_ID = 'mem_4yea92da91x38wav.01kychgcj4';
const CALL_ID = 'call_mxUAmc1sfoFvLupE1yclHn8e';

/** A Codex rollout line carrying the user's own words. */
const userLine = JSON.stringify({
  type: 'event_msg',
  payload: { type: 'user_message', message: 'where did we leave the loops?' },
});

/** A real-shaped Codex recall: the call, then its output naming one memory. */
const recallLines = [
  JSON.stringify({
    type: 'response_item',
    payload: {
      type: 'function_call',
      name: 'recall',
      namespace: 'mcp__zero_memory',
      arguments: '{"query":"open loops"}',
      call_id: CALL_ID,
    },
  }),
  JSON.stringify({
    type: 'response_item',
    payload: {
      type: 'function_call_output',
      call_id: CALL_ID,
      output: `Wall time: 2.0 seconds\nOutput:\n${JSON.stringify([
        {
          type: 'text',
          text: JSON.stringify({ memories: [{ id: RECALLED_ID }] }),
        },
      ])}`,
    },
  }),
];

/**
 * The flush end to end for a Codex session: the real client parser reads the
 * rollout, and the payload the server receives is the assertion. The judge
 * channel is the join under test — the runner used to read only `.entries`
 * off the parse result, so even a correct parser measured nothing.
 */
describe('flushTranscriptDelta', () => {
  let dir: string;
  let previousState: string | undefined;
  let previousConsent: string | undefined;

  const flush = (lines: string[]) => {
    const transcriptPath = join(dir, 'rollout.jsonl');
    writeFileSync(transcriptPath, `${lines.join('\n')}\n`);
    const input: HookInput = {
      sessionId: 'codex-session',
      cwd: dir,
      prompt: '',
      transcriptPath,
      hookEventName: 'Stop',
      toolName: '',
      alreadyContinued: false,
      source: '',
      trigger: '',
    };
    return flushTranscriptDelta(hookClient('codex'), 'stop', input);
  };

  beforeEach(() => {
    sent.length = 0;
    dir = mkdtempSync(join(tmpdir(), 'zm-ingest-hook-'));
    previousState = process.env.XDG_STATE_HOME;
    previousConsent = process.env.ZM_INGEST_CONFIG;
    process.env.XDG_STATE_HOME = join(dir, 'state');
    process.env.ZM_INGEST_CONFIG = join(dir, 'ingest.json');
    writeFileSync(process.env.ZM_INGEST_CONFIG, '{"allowlist":["*"]}');
  });

  afterEach(() => {
    if (previousState === undefined) delete process.env.XDG_STATE_HOME;
    else process.env.XDG_STATE_HOME = previousState;
    if (previousConsent === undefined) delete process.env.ZM_INGEST_CONFIG;
    else process.env.ZM_INGEST_CONFIG = previousConsent;
    rmSync(dir, { recursive: true, force: true });
  });

  it('sends the ids a Codex recall surfaced as recalled_ids', async () => {
    expect(await flush([userLine, ...recallLines])).toMatch(/^sent:/);

    expect(sent).toHaveLength(1);
    expect(sent[0]?.recalled_ids).toEqual([RECALLED_ID]);
  });

  // Absent and empty are different claims: the server gates the judge on the
  // field's presence, so an empty array would ask it to score nothing.
  it('omits recalled_ids entirely when the slice surfaced nothing', async () => {
    expect(await flush([userLine])).toMatch(/^sent:/);

    expect(sent).toHaveLength(1);
    expect(sent[0]).not.toHaveProperty('recalled_ids');
  });
});
