import type { TranslationStatus } from '@workspace/contracts';
import { ValueObject } from '@workspace/domain';

export interface TranslationStateProps {
  status: TranslationStatus;
  /**
   * Pre-translation source text. NULL until a translation replaces `content`
   * (and for rows born English). Set only by the async translation worker.
   */
  originalText: string | null;
  /** Detected language of the original text ('ja', 'en', ...). */
  lang: string | null;
  /** Times the worker has attempted translation (bounds retries). */
  attempts: number;
  /** Last translation failure message, for observability. */
  error: string | null;
}

/**
 * Language-canonicalization state of a memory: whether its content is already
 * English ('skipped'), awaiting the async worker ('pending'), or translated
 * ('done'). The write path only ever produces 'skipped' or 'pending' — the
 * transition to 'done' (with the original preserved) is the worker's job.
 */
export class TranslationState extends ValueObject<TranslationStateProps> {
  /** Content is already English: canonical as-is, nothing to translate. */
  static skipped(lang = 'en'): TranslationState {
    return new TranslationState({
      status: 'skipped',
      originalText: null,
      lang,
      attempts: 0,
      error: null,
    });
  }

  /**
   * Content is non-English: `content` holds the original, awaiting the worker.
   * The precise source language is unknown to the cheap write-path detector, so
   * `lang` stays null until the translator reports it.
   */
  static pending(): TranslationState {
    return new TranslationState({
      status: 'pending',
      originalText: null,
      lang: null,
      attempts: 0,
      error: null,
    });
  }

  /** Content has been canonicalized to English; the source is preserved. */
  static done(originalText: string, lang: string): TranslationState {
    return new TranslationState({
      status: 'done',
      originalText,
      lang,
      attempts: 0,
      error: null,
    });
  }

  /** Rebuilds the state from a persisted row. */
  static restore(props: TranslationStateProps): TranslationState {
    return new TranslationState(props);
  }

  get status(): TranslationStatus {
    return this.props.status;
  }

  get originalText(): string | null {
    return this.props.originalText;
  }

  get lang(): string | null {
    return this.props.lang;
  }

  get attempts(): number {
    return this.props.attempts;
  }

  get error(): string | null {
    return this.props.error;
  }
}
