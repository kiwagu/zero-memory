import { afterEach, describe, expect, it } from 'vitest';

import type { ServerProbe } from '@workspace/client-runtime';

import { isFresh } from './status-runner.js';

const SERVER = 'https://memory.example.com/mcp';

const okProbe: ServerProbe = {
  state: 'ok',
  detail: 'up',
  fix: '',
  serverUrl: SERVER,
};
const downProbe: ServerProbe = {
  state: 'server-down',
  detail: 'unreachable',
  fix: 'restart',
  serverUrl: SERVER,
};

describe('isFresh', () => {
  const prev = process.env.ZM_HEALTH_TTL_MS;

  afterEach(() => {
    if (prev === undefined) {
      delete process.env.ZM_HEALTH_TTL_MS;
    } else {
      process.env.ZM_HEALTH_TTL_MS = prev;
    }
  });

  it('is not fresh without a cache', () => {
    expect(isFresh(null, 1000, SERVER)).toBe(false);
  });

  it('honors the default 30s TTL', () => {
    delete process.env.ZM_HEALTH_TTL_MS;
    expect(isFresh({ ts: 0, probe: okProbe }, 29_000, SERVER)).toBe(true);
    expect(isFresh({ ts: 0, probe: okProbe }, 31_000, SERVER)).toBe(false);
  });

  it('honors the ZM_HEALTH_TTL_MS override', () => {
    process.env.ZM_HEALTH_TTL_MS = '5000';
    expect(isFresh({ ts: 0, probe: downProbe }, 4_000, SERVER)).toBe(true);
    expect(isFresh({ ts: 0, probe: downProbe }, 6_000, SERVER)).toBe(false);
  });

  it('drops a verdict about a DIFFERENT server, however recent', () => {
    delete process.env.ZM_HEALTH_TTL_MS;
    expect(isFresh({ ts: 0, probe: okProbe }, 1_000, SERVER)).toBe(true);
    expect(
      isFresh({ ts: 0, probe: okProbe }, 1_000, 'http://localhost:8787/mcp')
    ).toBe(false);
    // An unconfigured machine and a configured one are likewise not the same
    // question, so neither answers for the other.
    expect(isFresh({ ts: 0, probe: okProbe }, 1_000, null)).toBe(false);
  });
});
