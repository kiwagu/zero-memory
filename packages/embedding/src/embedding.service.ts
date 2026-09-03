/**
 * Whether a text is embedded as a search query or as a stored passage.
 *
 * e5-family models (multilingual-e5-*) are trained with asymmetric prefixes:
 * `query: <text>` for the thing you search WITH and `passage: <text>` for the
 * thing you search OVER. Matching the prefix to the role is what gives the
 * model its retrieval quality, so callers must state the role explicitly for
 * anything that is stored-then-searched.
 */
export type EmbeddingKind = 'query' | 'passage';

/**
 * Port: turns texts into fixed-size embedding vectors.
 *
 * Behavioral contract (stays a TS interface per zod-schema-first-contracts:
 * ports are behavioral; their boundary data here is primitive arrays).
 */
export interface IEmbeddingService {
  /** Embedding dimensionality every returned vector must have. */
  readonly dims: number;

  /**
   * Embeds each text; result[i] belongs to texts[i]. `kind` selects the e5
   * prefix (defaults to 'query'); adapters without asymmetric prefixes ignore
   * it.
   */
  embed(texts: string[], kind?: EmbeddingKind): Promise<number[][]>;
}
