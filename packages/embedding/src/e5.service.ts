import { mkdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { singleton } from '@workspace/di';
import { createLogger } from '@workspace/logger';
import {
  injectUsageRecorder,
  recordUsage,
  type IUsageRecorder,
} from '@workspace/usage';

import type { EmbeddingKind, IEmbeddingService } from './embedding.service.js';
import { ensureSharpLibvips } from './ensure-sharp-libvips.js';

const EMBEDDING_DIMS = 1024;

/**
 * English e5-large-v2 (1024 dims). Now that stored content is canonicalized to
 * English (and search queries are steered to English), the multilingual
 * constraint is gone, so we use a stronger English-specialized model instead of
 * the multilingual e5-small it replaces. Higher dimensionality → a one-time
 * vector(384)->vector(1024) schema migration + re-embed.
 */
const MODEL_ID = 'Xenova/e5-large-v2';

/** Structural view of the transformers.js feature-extraction pipeline. */
type FeatureExtractionPipeline = (
  texts: string[],
  options: { pooling: 'mean'; normalize: boolean }
) => Promise<{ tolist(): number[][] }>;

const resolveCacheDir = (): string =>
  process.env.ZM_MODEL_CACHE_DIR ??
  join(homedir(), '.cache', 'zero-memory', 'models');

/**
 * transformers.js (onnxruntime) adapter for the embedding port.
 *
 * Model: intfloat/e5-large-v2 via the ONNX weights published as
 * Xenova/e5-large-v2 (1024 dims). e5 models expect asymmetric
 * prefixes — `query:` for search queries, `passage:` for stored documents —
 * which this adapter prepends per {@link EmbeddingKind}. Mean pooling +
 * L2-normalization are done by the pipeline. The model is downloaded once into
 * the cache dir and the pipeline is initialized lazily on first use.
 */
@singleton()
export class E5SmallEmbeddingService implements IEmbeddingService {
  readonly dims = EMBEDDING_DIMS;

  readonly #logger = createLogger(E5SmallEmbeddingService.name);

  #pipeline: Promise<FeatureExtractionPipeline> | null = null;

  // Optional so the service can be constructed outside the DI container (e.g.
  // the re-embed and translation-worker scripts, which have no request context
  // to attribute usage to); metering is simply skipped there.
  constructor(
    @injectUsageRecorder()
    private readonly usage?: IUsageRecorder
  ) {}

  /**
   * Whether pipeline initialization has been kicked off (readiness probe
   * input). Reading it never triggers a model download: `false` means "cold —
   * the model loads lazily on first embed", not "broken".
   */
  get warm(): boolean {
    return this.#pipeline !== null;
  }

  async embed(
    texts: string[],
    kind: EmbeddingKind = 'query'
  ): Promise<number[][]> {
    if (texts.length === 0) {
      return [];
    }
    const pipeline = await this.#init();
    const prefixed = texts.map((text) => `${kind}: ${text}`);
    const startedAt = performance.now();
    const output = await pipeline(prefixed, {
      pooling: 'mean',
      normalize: true,
    });
    this.#logger.debug('embedded texts', {
      count: texts.length,
      kind,
      duration_ms: Math.round(performance.now() - startedAt),
    });
    // Meter one embedding event per batch, counted by number of texts
    // (fire-and-forget: a metering failure never breaks embedding). Skipped when
    // constructed without a recorder (outside the DI container).
    if (this.usage) {
      recordUsage(this.usage, {
        eventType: 'embedding',
        quantity: texts.length,
        metadata: { kind },
      });
    }
    return output.tolist();
  }

  #init(): Promise<FeatureExtractionPipeline> {
    // Lazy singleton: the ONNX session is built once and shared; a failed
    // init is not cached so the next call can retry.
    this.#pipeline ??= this.#load().catch((error: unknown) => {
      this.#pipeline = null;
      throw error;
    });
    return this.#pipeline;
  }

  async #load(): Promise<FeatureExtractionPipeline> {
    const cacheDir = resolveCacheDir();
    await mkdir(cacheDir, { recursive: true });
    // Must run before transformers is imported: it statically pulls in sharp,
    // whose native addon fails to load under Bun without this pre-mapping.
    await ensureSharpLibvips();
    const { env, pipeline } = await import('@huggingface/transformers');
    // Not every transformers.js download honors the per-pipeline `cache_dir`:
    // the onnxruntime-wasm binary is cached via the global `env.cacheDir`,
    // which defaults to a `.cache` dir inside the installed package — read-only
    // for the non-root user in the production container, so the binary would
    // be re-downloaded on every cold start. Point the global at our cache dir
    // so all artifacts land on the persistent volume.
    env.cacheDir = cacheDir;
    this.#logger.debug('initializing e5 model', { model: MODEL_ID, cacheDir });
    const extractor = await pipeline('feature-extraction', MODEL_ID, {
      cache_dir: cacheDir,
      // Quantized weights keep the model tiny and fast on CPU; quality loss is
      // negligible for retrieval.
      dtype: 'q8',
    });
    return extractor as unknown as FeatureExtractionPipeline;
  }
}
