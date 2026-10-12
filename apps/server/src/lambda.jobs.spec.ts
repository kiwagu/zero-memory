import { describe, expect, it } from 'vitest';

import {
  isDirectInvocation,
  jobsFunctionDispatcher,
  parseJobEvent,
} from './lambda.jobs.js';

const job = (name: string, args?: unknown) => ({
  zeroMemory: 'job',
  job: name,
  ...(args === undefined ? {} : { args }),
});

describe('parseJobEvent', () => {
  it('accepts the scheduled jobs, which take no arguments', () => {
    for (const name of ['usage-upkeep', 'translation', 'hygiene']) {
      expect(parseJobEvent(job(name))).toMatchObject({ job: name });
    }
  });

  it('accepts the work the server hands off, with its arguments', () => {
    const handedOff = [
      job('translate-one', { memoryId: 'mem_1' }),
      job('hygiene-one', { memoryId: 'mem_1' }),
      job('hygiene-scan', { ownerId: 'usr_1', limit: null, claimToken: 't' }),
      job('hygiene-scan', { ownerId: 'usr_1', limit: 50, claimToken: 't' }),
      job('benchmark-probes', { ownerId: 'usr_1', claimToken: 't' }),
      job('benchmark-run', {
        ownerId: 'usr_1',
        claimToken: 't',
        recalled: [{ probeId: 'prb_1', surfacedIds: ['mem_a'] }],
      }),
    ];
    for (const event of handedOff) {
      expect(parseJobEvent(event)).not.toBeNull();
    }
  });

  it('refuses an unknown job, missing or wrong arguments, and anything from the function URL', () => {
    expect(parseJobEvent(job('drop-tables'))).toBeNull();
    expect(parseJobEvent({ zeroMemory: 'job' })).toBeNull();
    expect(parseJobEvent({ zeroMemory: 'warm-up' })).toBeNull();
    expect(parseJobEvent(job('hygiene-one'))).toBeNull();
    expect(parseJobEvent(job('translate-one', {}))).toBeNull();
    expect(parseJobEvent(job('hygiene-one', { memoryId: '' }))).toBeNull();
    expect(parseJobEvent(job('hygiene-scan', { ownerId: 'usr_1' }))).toBeNull();
    // A claimed job without its claim's token cannot prove it still holds it.
    expect(
      parseJobEvent(job('benchmark-probes', { ownerId: 'usr_1' }))
    ).toBeNull();
    expect(
      parseJobEvent({
        ...job('usage-upkeep'),
        requestContext: { http: { method: 'POST' } },
      })
    ).toBeNull();
    expect(parseJobEvent(null)).toBeNull();
  });
});

describe('jobsFunctionDispatcher', () => {
  it('hands a task to the jobs function asynchronously, as a job that function accepts', async () => {
    const sent: { input: Record<string, unknown> }[] = [];
    const client = {
      send: (command: { input: Record<string, unknown> }) => {
        sent.push(command);
        return Promise.resolve({});
      },
    };
    const dispatch = jobsFunctionDispatcher(
      'zero-memory-stand-Jobs',
      client as never
    );

    await dispatch({ kind: 'hygiene-one', args: { memoryId: 'mem_1' } });

    expect(sent).toHaveLength(1);
    const { FunctionName, InvocationType, Payload } = sent[0]!.input;
    expect(FunctionName).toBe('zero-memory-stand-Jobs');
    expect(InvocationType).toBe('Event');
    const event = JSON.parse(
      new TextDecoder().decode(Payload as Uint8Array)
    ) as unknown;
    expect(parseJobEvent(event)).toMatchObject({
      job: 'hygiene-one',
      args: { memoryId: 'mem_1' },
    });
  });
});

describe('isDirectInvocation', () => {
  it('tells a direct invocation from a request through the function URL', () => {
    expect(isDirectInvocation({ zeroMemory: 'job', job: 'nope' })).toBe(true);
    expect(isDirectInvocation({})).toBe(true);
    expect(
      isDirectInvocation({ requestContext: { http: { method: 'GET' } } })
    ).toBe(false);
    expect(isDirectInvocation(null)).toBe(false);
  });
});
