import { parseCodexTranscript } from '@workspace/client-adapter-codex';
import { describe, expect, it } from 'vitest';

import { recalledIdsField } from './ingest-hook-runner.js';

describe('recalledIdsField', () => {
  it('carries the surfaced ids into the ingest payload', () => {
    expect(recalledIdsField(['mem_4yea92da91x38wav.01kychgcj4'])).toEqual({
      recalled_ids: ['mem_4yea92da91x38wav.01kychgcj4'],
    });
  });

  // Absent and empty are different claims: the server gates the judge on the
  // field's presence, so an empty array would ask it to score nothing.
  it('omits the field entirely when the slice surfaced nothing', () => {
    expect(recalledIdsField([])).toEqual({});
  });

  /**
   * The end-to-end shape of the Codex path in one assertion: a real rollout
   * slice goes through the client's parser and comes out as a populated
   * `recalled_ids`. This is the join that used to be missing — the hook runner
   * read only `.entries` off the parse result, so even a correct parser
   * measured nothing.
   */
  it('threads a Codex recall through the parser into the payload', () => {
    const callId = 'call_mxUAmc1sfoFvLupE1yclHn8e';
    const recalledId = 'mem_4yea92da91x38wav.01kychgcj4';
    const rollout = [
      JSON.stringify({
        type: 'response_item',
        payload: {
          type: 'function_call',
          name: 'recall',
          namespace: 'mcp__zero_memory',
          arguments: '{"query":"open loops"}',
          call_id: callId,
        },
      }),
      JSON.stringify({
        type: 'response_item',
        payload: {
          type: 'function_call_output',
          call_id: callId,
          output: `Wall time: 2.0 seconds\nOutput:\n${JSON.stringify([
            {
              type: 'text',
              text: JSON.stringify({ memories: [{ id: recalledId }] }),
            },
          ])}`,
        },
      }),
    ].join('\n');

    const parsed = parseCodexTranscript(rollout);
    expect(recalledIdsField(parsed.recalledIds)).toEqual({
      recalled_ids: [recalledId],
    });
  });
});
