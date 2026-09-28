import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

import type { IngestConversationInput } from '@workspace/contracts';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { hookClient } from '../hook-client.js';
import { hookInput } from '../testing/hook-client.fake.js';
import { restoreEnv, useStateDirs } from '../testing/state-dir.fixture.js';
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
  const dirs = useStateDirs('zm-ingest-hook');
  let previousConsent: string | undefined;

  const flush = (lines: string[]) => {
    const transcriptPath = join(dirs.work, 'rollout.jsonl');
    writeFileSync(transcriptPath, `${lines.join('\n')}\n`);
    return flushTranscriptDelta(
      hookClient('codex'),
      'stop',
      hookInput({
        sessionId: 'codex-session',
        cwd: dirs.work,
        transcriptPath,
        hookEventName: 'Stop',
      })
    );
  };

  beforeEach(() => {
    sent.length = 0;
    // Capture is off by default: this project consents to it.
    previousConsent = process.env.ZM_INGEST_CONFIG;
    process.env.ZM_INGEST_CONFIG = join(dirs.state, 'ingest.json');
    writeFileSync(process.env.ZM_INGEST_CONFIG, '{"allowlist":["*"]}');
  });

  afterEach(() => restoreEnv('ZM_INGEST_CONFIG', previousConsent));

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
