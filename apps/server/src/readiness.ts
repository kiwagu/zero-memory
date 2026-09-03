import { container } from '@workspace/di';
import {
  E5SmallEmbeddingService,
  EMBEDDING_SERVICE,
} from '@workspace/embedding';
import { Elysia } from 'elysia';
import { z } from 'zod';

/**
 * Embedder readiness is informational, never a failure: 'cold' means the
 * ONNX pipeline has not been initialized yet (it loads lazily on the first
 * embed), 'ready' means it is warm. Probing never forces a model download.
 */
export const embedderStateSchema = z.enum(['ready', 'cold']);
export type EmbedderState = z.infer<typeof embedderStateSchema>;

export const readinessReportSchema = z.object({
  ok: z.boolean(),
  checks: z.object({
    supabase: z.boolean(),
    embedder: embedderStateSchema,
  }),
});
export type ReadinessReport = z.infer<typeof readinessReportSchema>;

/** Downstream probes /readyz aggregates; injectable for tests. */
export interface ReadinessProbes {
  /** True when the Supabase API gateway answers within the probe timeout. */
  supabase: () => Promise<boolean>;
  /** Warm-state of the embedding pipeline (must not trigger a download). */
  embedder: () => EmbedderState;
}

const SUPABASE_PROBE_TIMEOUT_MS = 2000;

/**
 * Cheap upstream ping: GoTrue's unauthenticated health endpoint behind Kong.
 * Any network error, non-2xx or timeout counts as "not ready" — a readiness
 * probe answers with status, it never throws.
 */
export const createSupabaseProbe =
  (options?: { timeoutMs?: number }) => async (): Promise<boolean> => {
    const url = process.env.SUPABASE_URL;
    const anonKey = process.env.SUPABASE_ANON_KEY;
    if (!url || !anonKey) {
      return false;
    }
    try {
      const response = await fetch(`${url.replace(/\/$/, '')}/auth/v1/health`, {
        headers: { apikey: anonKey },
        signal: AbortSignal.timeout(
          options?.timeoutMs ?? SUPABASE_PROBE_TIMEOUT_MS
        ),
      });
      return response.ok;
    } catch {
      return false;
    }
  };

/**
 * Reports the DI-registered embedding service's warm state. Resolution
 * happens per call (the registry wires the container before the server
 * listens). Anything that is not a warm e5 pipeline reports 'cold'.
 */
export const createEmbedderProbe = () => (): EmbedderState => {
  const service = container.resolve(EMBEDDING_SERVICE);
  return service instanceof E5SmallEmbeddingService && service.warm
    ? 'ready'
    : 'cold';
};

export const checkReadiness = async (
  probes: ReadinessProbes
): Promise<ReadinessReport> => {
  const supabase = await probes.supabase();
  const embedder = probes.embedder();
  // A cold embedder is a normal post-boot state (lazy init), so it never
  // gates readiness; only an unreachable Supabase flips /readyz to 503.
  return { ok: supabase, checks: { supabase, embedder } };
};

/** GET /readyz — 200 when downstreams are reachable, 503 otherwise. */
export const createReadinessRoutes = (probes: ReadinessProbes) =>
  new Elysia({ name: 'readiness' }).get('/readyz', async ({ set }) => {
    const report = await checkReadiness(probes);
    set.status = report.ok ? 200 : 503;
    return report;
  });

export const createDefaultReadinessProbes = (): ReadinessProbes => ({
  supabase: createSupabaseProbe(),
  embedder: createEmbedderProbe(),
});
