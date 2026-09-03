import type { AuditEvent, IAuditRecorder } from '@workspace/audit';
import type { ICommandBus } from '@workspace/cqrs';
import { Command } from '@workspace/domain';
import { describe, expect, it, vi } from 'vitest';

import { AuditedCommandBus } from './audited-command-bus.js';

class FakeCommand extends Command {
  constructor(public readonly content: string) {
    super({});
  }
}

const makeRecorder = (): IAuditRecorder => ({
  record: vi.fn().mockResolvedValue(undefined),
});

const flush = async (): Promise<void> => {
  await Promise.resolve();
  await Promise.resolve();
};

const lastEvent = (recorder: IAuditRecorder): AuditEvent =>
  vi.mocked(recorder.record).mock.calls.at(-1)?.[0] as AuditEvent;

describe('AuditedCommandBus', () => {
  it('delegates to the inner bus and returns its result unchanged', async () => {
    const inner: ICommandBus = { execute: vi.fn().mockResolvedValue('result') };
    const recorder = makeRecorder();
    const bus = new AuditedCommandBus(inner, recorder);

    const result = await bus.execute(new FakeCommand('hello'));

    expect(result).toBe('result');
    expect(inner.execute).toHaveBeenCalledTimes(1);
  });

  it('records an ok entry with the command name, payload and duration', async () => {
    const inner: ICommandBus = {
      execute: vi.fn().mockResolvedValue(undefined),
    };
    const recorder = makeRecorder();
    const bus = new AuditedCommandBus(inner, recorder);

    await bus.execute(new FakeCommand('chose bun'));
    await flush();

    const event = lastEvent(recorder);
    expect(event.command).toBe('FakeCommand');
    expect(event.outcome).toBe('ok');
    expect(event.error).toBeUndefined();
    expect(event.payload).toMatchObject({ content: 'chose bun' });
    expect(typeof event.durationMs).toBe('number');
  });

  it('records an error entry and re-throws the original exception unchanged', async () => {
    const failure = new Error('handler blew up');
    const inner: ICommandBus = {
      execute: vi.fn().mockRejectedValue(failure),
    };
    const recorder = makeRecorder();
    const bus = new AuditedCommandBus(inner, recorder);

    await expect(bus.execute(new FakeCommand('boom'))).rejects.toBe(failure);
    await flush();

    const event = lastEvent(recorder);
    expect(event.command).toBe('FakeCommand');
    expect(event.outcome).toBe('error');
    expect(event.error).toBe('handler blew up');
  });

  it('still completes the command when the audit recorder rejects', async () => {
    const inner: ICommandBus = { execute: vi.fn().mockResolvedValue('ok') };
    const recorder: IAuditRecorder = {
      record: vi.fn().mockRejectedValue(new Error('audit sink down')),
    };
    const bus = new AuditedCommandBus(inner, recorder);

    await expect(bus.execute(new FakeCommand('x'))).resolves.toBe('ok');
  });
});
