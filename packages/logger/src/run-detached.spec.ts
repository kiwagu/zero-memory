import { describe, expect, it, vi } from 'vitest';

import { runDetached, type Logger } from './index.js';

const spyLogger = (): Logger => {
  const logger: Logger = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: () => logger,
  };
  return logger;
};

/** The task starts one microtask late; let the chain settle. */
const settled = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('runDetached', () => {
  it('runs the task exactly once, after the caller has moved on', async () => {
    const task = vi.fn().mockResolvedValue(undefined);

    runDetached(task, spyLogger(), 'failed to record');
    expect(task).not.toHaveBeenCalled();
    await settled();

    expect(task).toHaveBeenCalledTimes(1);
  });

  it('never throws when the task rejects, and logs the failure at warn', async () => {
    const logger = spyLogger();

    expect(() =>
      runDetached(
        () => Promise.reject(new Error('db unreachable')),
        logger,
        'failed to record usage event',
        { eventType: 'embedding' }
      )
    ).not.toThrow();
    await settled();

    expect(logger.warn).toHaveBeenCalledWith('failed to record usage event', {
      eventType: 'embedding',
      error: 'db unreachable',
    });
  });

  it('never throws when the task throws synchronously', async () => {
    const logger = spyLogger();

    expect(() =>
      runDetached(
        () => {
          throw new Error('boom');
        },
        logger,
        'failed to record audit event'
      )
    ).not.toThrow();
    await settled();

    expect(logger.warn).toHaveBeenCalledWith('failed to record audit event', {
      error: 'boom',
    });
  });
});
