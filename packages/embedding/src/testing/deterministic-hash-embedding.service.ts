import type { EmbeddingKind, IEmbeddingService } from '../embedding.service.js';

const EMBEDDING_DIMS = 1024;

/** FNV-1a 32-bit hash — stable, dependency-free seed source. */
const fnv1a = (text: string): number => {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
};

/** mulberry32 PRNG — deterministic stream from a 32-bit seed. */
const mulberry32 = (seed: number): (() => number) => {
  let state = seed;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
};

/**
 * TEST-ONLY embedding stub: derives a unit-length 1024-dim vector from a hash
 * of the text. Identical texts get identical vectors (cosine similarity 1),
 * different texts get quasi-orthogonal ones — enough to exercise dedup and
 * search plumbing without a model download.
 *
 * Never wire this into production DI; it carries no semantics.
 */
export class DeterministicHashEmbeddingService implements IEmbeddingService {
  readonly dims = EMBEDDING_DIMS;

  // The `kind` prefix carries no semantics for a hash stub: identical texts
  // must map to identical vectors regardless of query/passage role.
  embed(texts: string[], _kind?: EmbeddingKind): Promise<number[][]> {
    return Promise.resolve(texts.map((text) => this.#vectorFor(text)));
  }

  #vectorFor(text: string): number[] {
    const random = mulberry32(fnv1a(text));
    const vector = Array.from({ length: this.dims }, () => random() * 2 - 1);
    const norm = Math.sqrt(
      vector.reduce((sum, component) => sum + component * component, 0)
    );
    return vector.map((component) => component / norm);
  }
}
