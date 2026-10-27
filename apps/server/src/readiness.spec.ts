import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  createReadinessRoutes,
  createSupabaseProbe,
  readinessReportSchema,
  type ReadinessProbes,
} from './readiness.js';

const probes = (
  supabase: boolean,
  embedder: 'ready' | 'cold'
): ReadinessProbes => ({
  supabase: () => Promise.resolve(supabase),
  embedder: () => embedder,
});

const getReadyz = (p: ReadinessProbes): Promise<Response> =>
  createReadinessRoutes(p).handle(new Request('http://localhost/readyz'));

describe('GET /readyz', () => {
  it('returns 200 with the report when supabase answers, however cold the embedder', async () => {
    // A cold embedder is the normal post-boot state (it loads lazily), so it
    // must never gate readiness.
    const response = await getReadyz(probes(true, 'cold'));
    expect(response.status).toBe(200);
    const body = readinessReportSchema.parse(await response.json());
    expect(body).toEqual({
      ok: true,
      checks: { supabase: true, embedder: 'cold' },
    });
  });

  it('returns 503 with supabase:false when the probe fails, however warm the embedder', async () => {
    const response = await getReadyz(probes(false, 'ready'));
    expect(response.status).toBe(503);
    const body = readinessReportSchema.parse(await response.json());
    expect(body).toEqual({
      ok: false,
      checks: { supabase: false, embedder: 'ready' },
    });
  });
});

describe('createSupabaseProbe', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('fails closed (false, no throw) when the target does not answer', async () => {
    vi.stubEnv('SUPABASE_URL', 'http://127.0.0.1:59999');
    vi.stubEnv('SUPABASE_ANON_KEY', 'test-key');
    const probe = createSupabaseProbe({ timeoutMs: 300 });
    await expect(probe()).resolves.toBe(false);
  });

  it('reports false when the environment is not configured', async () => {
    vi.stubEnv('SUPABASE_URL', '');
    vi.stubEnv('SUPABASE_ANON_KEY', '');
    await expect(createSupabaseProbe()()).resolves.toBe(false);
  });
});
