import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { probeServer, type ServerProbe } from '@workspace/client-runtime';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { HookClient } from '../hook-client.js';
import { runStatus } from './status-runner.js';

vi.mock('@workspace/client-runtime', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@workspace/client-runtime')>()),
  probeServer: vi.fn(),
}));

const SERVER = 'https://memory.example.com/mcp';
const NOW = Date.parse('2026-09-28T12:00:00Z');

const probe = (state: ServerProbe['state'], serverUrl: string | null) => ({
  state,
  detail: state,
  fix: state === 'ok' ? '' : 'restart it',
  serverUrl,
});

/**
 * The prompt trailer probes the server at most once per freshness window, and
 * only answers from its cache for the server this machine talks to now. The
 * probe is the one collaborator faked: whether it is asked is the contract.
 */
describe('runStatus health cache', () => {
  let dir: string;
  const saved: Record<string, string | undefined> = {};
  const env = ['XDG_STATE_HOME', 'XDG_CONFIG_HOME', 'ZM_SERVER_URL'] as const;

  const said: string[] = [];
  const adapter = {
    kind: 'claude',
    readInput: async () => {
      throw new Error('no payload');
    },
    emitTurnContext: (_event: string, text: string) => void said.push(text),
  } as unknown as HookClient;

  /** A verdict this machine already cached, `ageMs` before now. */
  const cached = (ageMs: number, verdict: ServerProbe): void => {
    mkdirSync(join(dir, 'state', 'zero-memory'), { recursive: true });
    writeFileSync(
      join(dir, 'state', 'zero-memory', 'health.json'),
      JSON.stringify({ ts: NOW - ageMs, probe: verdict })
    );
  };

  const probedAt = async (serverUrl: string | null): Promise<boolean> => {
    if (serverUrl === null) delete process.env.ZM_SERVER_URL;
    else process.env.ZM_SERVER_URL = serverUrl;
    vi.mocked(probeServer).mockClear();
    await runStatus(adapter);
    return vi.mocked(probeServer).mock.calls.length > 0;
  };

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'zm-status-'));
    for (const key of env) saved[key] = process.env[key];
    process.env.XDG_STATE_HOME = join(dir, 'state');
    process.env.XDG_CONFIG_HOME = join(dir, 'config');
    delete process.env.ZM_HEALTH_TTL_MS;
    said.length = 0;
    vi.spyOn(Date, 'now').mockReturnValue(NOW);
    vi.mocked(probeServer)
      .mockReset()
      .mockImplementation(async (url) => probe('ok', url ?? null));
  });

  afterEach(() => {
    vi.restoreAllMocks();
    for (const key of env) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
    delete process.env.ZM_HEALTH_TTL_MS;
    rmSync(dir, { recursive: true, force: true });
  });

  it('probes when nothing is cached', async () => {
    expect(await probedAt(SERVER)).toBe(true);
  });

  it('answers from a verdict younger than the default 30s, and warns from it', async () => {
    cached(29_000, probe('server-down', SERVER));
    expect(await probedAt(SERVER)).toBe(false);
    expect(said.join('\n')).toContain('UNREACHABLE');

    cached(31_000, probe('server-down', SERVER));
    expect(await probedAt(SERVER)).toBe(true);
  });

  it('honors the ZM_HEALTH_TTL_MS override', async () => {
    process.env.ZM_HEALTH_TTL_MS = '5000';
    cached(4_000, probe('ok', SERVER));
    expect(await probedAt(SERVER)).toBe(false);

    cached(6_000, probe('ok', SERVER));
    expect(await probedAt(SERVER)).toBe(true);
  });

  it('drops a verdict about a different server, however recent', async () => {
    cached(1_000, probe('ok', 'http://localhost:8787/mcp'));
    expect(await probedAt(SERVER)).toBe(true);

    // An unconfigured machine and a configured one are not the same question
    // either, so neither answers for the other.
    cached(1_000, probe('ok', SERVER));
    expect(await probedAt(null)).toBe(true);
  });
});
