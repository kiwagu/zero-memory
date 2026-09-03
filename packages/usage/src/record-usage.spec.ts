import { describe, expect, it, vi } from 'vitest';

import { recordUsage } from './record-usage.js';
import type { IUsageRecorder } from './usage-recorder.js';

describe('recordUsage', () => {
  it('forwards the event to the recorder exactly once', async () => {
    const recorder: IUsageRecorder = {
      record: vi.fn().mockResolvedValue(undefined),
    };

    recordUsage(recorder, {
      eventType: 'mcp_tool_call',
      metadata: { tool: 'recall' },
    });

    // The emit is deferred by one microtask (so a synchronous throw is caught),
    // so flush the queue before asserting.
    await Promise.resolve();
    await Promise.resolve();

    expect(recorder.record).toHaveBeenCalledTimes(1);
    expect(recorder.record).toHaveBeenCalledWith({
      eventType: 'mcp_tool_call',
      metadata: { tool: 'recall' },
    });
  });

  it('never throws when the recorder rejects (fire-and-forget)', async () => {
    const recorder: IUsageRecorder = {
      record: vi.fn().mockRejectedValue(new Error('db unreachable')),
    };

    // Must not throw synchronously...
    expect(() =>
      recordUsage(recorder, { eventType: 'embedding', quantity: 3 })
    ).not.toThrow();

    // ...and the swallowed rejection must not surface as an unhandled rejection.
    await Promise.resolve();
    expect(recorder.record).toHaveBeenCalledTimes(1);
  });

  it('never throws when the recorder throws synchronously', () => {
    const recorder: IUsageRecorder = {
      record: vi.fn(() => {
        throw new Error('boom');
      }),
    };

    expect(() =>
      recordUsage(recorder, { eventType: 'llm_extraction', unit: 'tokens' })
    ).not.toThrow();
  });
});
