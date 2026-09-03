import { E5SmallEmbeddingService, passageWindows } from '@workspace/embedding';
import { detectLanguage } from '@workspace/memory';
import { createLogger } from '@workspace/logger';
import { createServiceRoleClient, type Client } from '@workspace/persistence';

import { LlmTranslator } from './llm.translator.js';
import type { ITranslator } from '@workspace/memory';

const DEFAULT_BATCH = 25;
const DEFAULT_MAX_ATTEMPTS = 5;
// PostgREST caps a single select response (default 1000 rows), so the classify
// scan must page through the table rather than trust one round-trip.
const CLASSIFY_PAGE = 1000;

export interface ClassifyResult {
  /** Rows examined (every not-yet-translated row). */
  scanned: number;
  /** Rows flipped to 'pending' (non-English, needs translation). */
  markedPending: number;
  /** Rows confirmed 'skipped' (already English). */
  markedSkipped: number;
  dryRun: boolean;
}

export interface TranslateResult {
  /** Rows translated to English and marked 'done'. */
  translated: number;
  /** Rows whose translation failed this run (attempt recorded, still pending). */
  failed: number;
  /** Eligible pending rows seen (for a dry run, what WOULD be translated). */
  eligible: number;
  dryRun: boolean;
}

export interface TranslationWorkerOptions {
  batchSize?: number;
  maxAttempts?: number;
  /** Preview only: never call the model, never write. */
  dryRun?: boolean;
}

type ClassifyRow = { id: string; content: string; translation_status: string };
type PendingRow = { id: string; content: string; translation_attempts: number };

/**
 * Service-role, out-of-band language-canonicalization worker. Runs independently
 * of the (optional) watcher — triggered on the server (nightly cron) or on
 * demand — and touches every owner's rows through the privileged client, the
 * same posture as the hygiene scanner.
 *
 * Two passes, both idempotent:
 *   - classify(): the cheap, model-free step. Runs the write-path detector over
 *     not-yet-translated rows and sets translation_status to 'pending'
 *     (non-English) or 'skipped' (English). This is what turns the pre-existing
 *     backlog into a queue; new rows are already classified on write.
 *   - translate(): the paid step. Drains 'pending' rows (bounded retries):
 *     translate -> content_original := old content, content := English,
 *     content_lang := reported source language, re-embed, status := 'done'.
 *     A failure records the attempt and leaves the row pending for a later run.
 *
 * A dry run previews both without a model call or a write.
 */
export class TranslationWorker {
  readonly #logger = createLogger('TranslationWorker');

  constructor(
    private readonly translator: ITranslator = new LlmTranslator(),
    private readonly embedder: E5SmallEmbeddingService = new E5SmallEmbeddingService(),
    private readonly client: Client = createServiceRoleClient()
  ) {}

  /** Model-free: classify not-yet-translated rows into pending / skipped. */
  async classify(
    options: TranslationWorkerOptions = {}
  ): Promise<ClassifyResult> {
    const dryRun = options.dryRun ?? false;

    let scanned = 0;
    let markedPending = 0;
    let markedSkipped = 0;
    // Page over a stable order: a classify update keeps a row in the
    // not-done set and never changes created_at, so range offsets stay valid.
    for (let from = 0; ; from += CLASSIFY_PAGE) {
      const { data, error } = await this.client
        .from('memories')
        .select('id, content, translation_status')
        .neq('translation_status', 'done')
        .order('created_at', { ascending: true })
        .range(from, from + CLASSIFY_PAGE - 1);
      if (error) {
        throw new Error(`Failed to load rows to classify: ${error.message}`);
      }
      const rows = (data ?? []) as ClassifyRow[];
      scanned += rows.length;

      for (const row of rows) {
        const shouldSkip = detectLanguage(row.content).isEnglish;
        const target = shouldSkip ? 'skipped' : 'pending';
        if (row.translation_status === target) {
          continue;
        }
        if (shouldSkip) {
          markedSkipped += 1;
        } else {
          markedPending += 1;
        }
        if (dryRun) {
          continue;
        }
        const updated = await this.client
          .from('memories')
          .update({ translation_status: target })
          .eq('id', row.id);
        if (updated.error) {
          throw new Error(
            `Failed to classify ${row.id}: ${updated.error.message}`
          );
        }
      }

      if (rows.length < CLASSIFY_PAGE) {
        break;
      }
    }

    const result: ClassifyResult = {
      scanned,
      markedPending,
      markedSkipped,
      dryRun,
    };
    this.#logger.info('classify pass complete', { ...result });
    return result;
  }

  /** Paid: drain pending rows through the translator and re-embed. */
  async translate(
    options: TranslationWorkerOptions = {}
  ): Promise<TranslateResult> {
    const dryRun = options.dryRun ?? false;
    const batchSize = options.batchSize ?? DEFAULT_BATCH;
    const maxAttempts = options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;

    if (dryRun) {
      const { count, error } = await this.client
        .from('memories')
        .select('id', { count: 'exact', head: true })
        .eq('translation_status', 'pending')
        .lt('translation_attempts', maxAttempts);
      if (error) {
        throw new Error(`Failed to count pending rows: ${error.message}`);
      }
      const eligible = count ?? 0;
      this.#logger.info('translate dry run', { eligible });
      return { translated: 0, failed: 0, eligible, dryRun: true };
    }

    let translated = 0;
    let failed = 0;
    let eligible = 0;
    // Successful rows leave the pending set (-> done) and failures raise their
    // attempt count past the cap, so the eligible set strictly shrinks and the
    // loop terminates without keyset paging.
    for (;;) {
      const { data, error } = await this.client
        .from('memories')
        .select('id, content, translation_attempts, owner_id')
        .eq('translation_status', 'pending')
        .lt('translation_attempts', maxAttempts)
        .order('created_at', { ascending: true })
        .limit(batchSize);
      if (error) {
        throw new Error(`Failed to load pending rows: ${error.message}`);
      }
      const rows = (data ?? []) as PendingRow[];
      if (rows.length === 0) {
        break;
      }
      eligible += rows.length;
      for (const row of rows) {
        const outcome = await this.#translateRow(row);
        if (outcome === 'translated') {
          translated += 1;
        } else {
          failed += 1;
        }
      }
    }

    const result: TranslateResult = { translated, failed, eligible, dryRun };
    this.#logger.info('translate pass complete', { ...result });
    return result;
  }

  /** classify() then translate() — the full canonicalization pass. */
  async run(
    options: TranslationWorkerOptions = {}
  ): Promise<{ classify: ClassifyResult; translate: TranslateResult }> {
    const classify = await this.classify(options);
    const translate = await this.translate(options);
    return { classify, translate };
  }

  /**
   * Rebuilds a memory's overflow embedding windows after its content changed.
   *
   * The English rendering can need a different NUMBER of windows than the
   * original did, so the old set is dropped rather than overwritten by index.
   * A failure here is logged, not thrown: the translation itself has landed,
   * and a memory missing its windows is searchable by its opening — degraded,
   * not wrong, and repairable by the backfill pass.
   */
  async #replaceChunks(
    memoryId: string,
    overflow: Array<{ embedding: number[]; charStart: number }>
  ): Promise<void> {
    const { error: deleteError } = await this.client
      .from('memory_chunks')
      .delete()
      .eq('memory_id', memoryId);
    if (deleteError) {
      this.#logger.warn('stale overflow windows left behind', {
        id: memoryId,
        error: deleteError.message,
      });
      return;
    }
    if (overflow.length === 0) {
      return;
    }
    const { error } = await this.client.from('memory_chunks').insert(
      overflow.map((window, ord) => ({
        memory_id: memoryId,
        ord,
        char_start: window.charStart,
        embedding: JSON.stringify(window.embedding),
      }))
    );
    if (error) {
      this.#logger.warn('translated memory left without its overflow windows', {
        id: memoryId,
        windows: overflow.length,
        error: error.message,
      });
    }
  }

  async #translateRow(row: PendingRow): Promise<'translated' | 'failed'> {
    try {
      const { text, sourceLang } = await this.translator.translateToEnglish(
        row.content,
        // The background pass runs outside any request, so the owner has to be
        // named — otherwise their memory would be canonicalized on the
        // platform's key rather than their own.
        (row as { owner_id?: string }).owner_id
      );
      const windows = passageWindows(text);
      const [embedding, ...overflowVectors] = await this.embedder.embed(
        windows.map((window) => window.text),
        'passage'
      );
      if (!embedding) {
        throw new Error('Embedding service returned no vector.');
      }
      const { error } = await this.client
        .from('memories')
        .update({
          content: text,
          content_original: row.content,
          content_lang: sourceLang,
          translation_status: 'done',
          translation_error: null,
          embedding: JSON.stringify(embedding),
        })
        .eq('id', row.id);
      if (error) {
        throw new Error(error.message);
      }
      await this.#replaceChunks(
        row.id,
        overflowVectors.map((vector, index) => ({
          embedding: vector,
          charStart: windows[index + 1]!.charStart,
        }))
      );
      return 'translated';
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.#logger.warn('translation failed; will retry', {
        id: row.id,
        attempt: row.translation_attempts + 1,
        error: message,
      });
      const { error: updateError } = await this.client
        .from('memories')
        .update({
          translation_attempts: row.translation_attempts + 1,
          translation_error: message,
        })
        .eq('id', row.id);
      if (updateError) {
        this.#logger.error('failed to record translation failure', {
          id: row.id,
          error: updateError.message,
        });
      }
      return 'failed';
    }
  }
}
