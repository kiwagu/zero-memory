import { describe, expect, it, vi } from 'vitest';

import type { IAuditRecorder } from './audit-recorder.js';
import { recordAudit } from './record-audit.js';

const okEvent = {
  command: 'RememberCommand',
  payload: { kind: 'decision' },
  outcome: 'ok' as const,
  durationMs: 5,
};

describe('recordAudit', () => {
  it('forwards the event to the recorder exactly once', async () => {
    const recorder: IAuditRecorder = {
      record: vi.fn().mockResolvedValue(undefined),
    };

    recordAudit(recorder, okEvent);

    await Promise.resolve();
    await Promise.resolve();

    expect(recorder.record).toHaveBeenCalledTimes(1);
    expect(recorder.record).toHaveBeenCalledWith(okEvent);
  });

  it('never throws when the recorder rejects (fire-and-forget)', async () => {
    const recorder: IAuditRecorder = {
      record: vi.fn().mockRejectedValue(new Error('db down')),
    };

    expect(() => recordAudit(recorder, okEvent)).not.toThrow();
    await Promise.resolve();
    expect(recorder.record).toHaveBeenCalledTimes(1);
  });

  it('never throws when the recorder throws synchronously', () => {
    const recorder: IAuditRecorder = {
      record: vi.fn(() => {
        throw new Error('boom');
      }),
    };

    expect(() => recordAudit(recorder, okEvent)).not.toThrow();
  });
});
