import { describe, expect, it } from 'vitest';

import { parseCaptureArgs } from './capture-args.js';

describe('parseCaptureArgs', () => {
  it('parses a bare fact with defaults', () => {
    expect(parseCaptureArgs(['the deploy runs at 02:00 UTC'])).toEqual({
      content: 'the deploy runs at 02:00 UTC',
      e2e: false,
    });
  });

  it('joins multiple positionals (unquoted invocations stay forgiving)', () => {
    expect(parseCaptureArgs(['the', 'deploy', 'moved'])).toMatchObject({
      content: 'the deploy moved',
    });
  });

  it('maps --task to kind=task', () => {
    expect(parseCaptureArgs(['--task', 'verify the export'])).toMatchObject({
      content: 'verify the export',
      kind: 'task',
    });
  });

  it('accepts an explicit --kind and --scope', () => {
    expect(
      parseCaptureArgs(['--kind', 'gotcha', '--scope', 'core', 'bun quirk'])
    ).toMatchObject({ content: 'bun quirk', kind: 'gotcha', scope: 'core' });
  });

  it('rejects --task combined with --kind', () => {
    expect(parseCaptureArgs(['--task', '--kind', 'fact', 'x'])).toHaveProperty(
      'error'
    );
  });

  it('rejects an unknown kind with the allowed list', () => {
    const result = parseCaptureArgs(['--kind', 'note', 'x']);
    expect(result).toHaveProperty('error');
    expect((result as { error: string }).error).toContain('task');
  });

  it('rejects unknown flags and empty content', () => {
    expect(parseCaptureArgs(['--verbose', 'x'])).toHaveProperty('error');
    expect(parseCaptureArgs([])).toHaveProperty('error');
    expect(parseCaptureArgs(['--task'])).toHaveProperty('error');
  });

  it('parses --e2e (sandbox target)', () => {
    expect(parseCaptureArgs(['--e2e', 'x'])).toMatchObject({ e2e: true });
  });
});
