import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  dispatchBackgroundTo,
  drainDetached,
  runDetached,
  runInBackground,
  type Logger,
} from './index.js';

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

describe('drainDetached', () => {
  it('returns only after a write still in flight has finished', async () => {
    let finished = false;
    runDetached(
      () =>
        new Promise<void>((resolve) =>
          setTimeout(() => {
            finished = true;
            resolve();
          }, 20)
        ),
      spyLogger(),
      'failed to record'
    );

    const left = await drainDetached(1_000);

    expect(finished).toBe(true);
    expect(left).toBe(0);
  });

  it('gives up at the deadline and reports how many writes are still pending', async () => {
    let release: () => void = () => undefined;
    runDetached(
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
      spyLogger(),
      'failed to record'
    );

    const left = await drainDetached(10);
    release();
    await drainDetached(1_000);

    expect(left).toBe(1);
  });
});

describe('runInBackground', () => {
  afterEach(() => dispatchBackgroundTo(undefined));

  const task = { kind: 'hygiene-one', args: { memoryId: 'mem_1' } };

  it('runs the work in this process when no runtime installed a dispatcher', async () => {
    const work = vi.fn().mockResolvedValue(undefined);

    await runInBackground(task, work, spyLogger(), 'check failed');

    expect(work).toHaveBeenCalledTimes(1);
  });

  it('hands the task to the installed dispatcher instead, and never runs the work here', async () => {
    const dispatched: unknown[] = [];
    dispatchBackgroundTo((handed) => {
      dispatched.push(handed);
      return Promise.resolve();
    });
    const work = vi.fn().mockResolvedValue(undefined);

    await runInBackground(task, work, spyLogger(), 'check failed');

    expect(work).not.toHaveBeenCalled();
    expect(dispatched).toEqual([task]);
  });

  it('never rejects, and logs a failed work or hand-off at error', async () => {
    const logger = spyLogger();
    dispatchBackgroundTo(() => Promise.reject(new Error('throttled')));

    await expect(
      runInBackground(task, vi.fn(), logger, 'check failed', { id: 'mem_1' })
    ).resolves.toBeUndefined();

    expect(logger.error).toHaveBeenCalledWith('check failed', {
      id: 'mem_1',
      task: 'hygiene-one',
      error: 'throttled',
    });
  });

  it('is a side write the drain waits for', async () => {
    let finished = false;
    void runInBackground(
      task,
      () =>
        new Promise<void>((resolve) =>
          setTimeout(() => {
            finished = true;
            resolve();
          }, 20)
        ),
      spyLogger(),
      'check failed'
    );

    expect(await drainDetached(1000)).toBe(0);
    expect(finished).toBe(true);
  });
});
