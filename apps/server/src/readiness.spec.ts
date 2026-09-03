import { describe, expect, it } from 'vitest';

import {
  checkReadiness,
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

describe('checkReadiness', () => {
  it('is ok when supabase answers, regardless of a cold embedder', async () => {
    await expect(checkReadiness(probes(true, 'cold'))).resolves.toEqual({
      ok: true,
      checks: { supabase: true, embedder: 'cold' },
    });
  });

  it('is not ok when supabase is unreachable', async () => {
    await expect(checkReadiness(probes(false, 'ready'))).resolves.toEqual({
      ok: false,
      checks: { supabase: false, embedder: 'ready' },
    });
  });
});

describe('GET /readyz', () => {
  it('returns 200 with the report when downstreams are up', async () => {
    const response = await getReadyz(probes(true, 'ready'));
    expect(response.status).toBe(200);
    const body = readinessReportSchema.parse(await response.json());
    expect(body).toEqual({
      ok: true,
      checks: { supabase: true, embedder: 'ready' },
    });
  });

  it('returns 503 with supabase:false when the probe fails', async () => {
    const response = await getReadyz(probes(false, 'cold'));
    expect(response.status).toBe(503);
    const body = readinessReportSchema.parse(await response.json());
    expect(body).toEqual({
      ok: false,
      checks: { supabase: false, embedder: 'cold' },
    });
  });
});

describe('createSupabaseProbe', () => {
  it('fails closed (false, no throw) when the target does not answer', async () => {
    process.env.SUPABASE_URL = 'http://127.0.0.1:59999';
    process.env.SUPABASE_ANON_KEY = 'test-key';
    const probe = createSupabaseProbe({ timeoutMs: 300 });
    await expect(probe()).resolves.toBe(false);
  });

  it('reports false when the environment is not configured', async () => {
    delete process.env.SUPABASE_URL;
    delete process.env.SUPABASE_ANON_KEY;
    await expect(createSupabaseProbe()()).resolves.toBe(false);
  });
});
