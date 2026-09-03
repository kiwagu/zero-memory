/** Outcome of translating memory content into canonical English. */
export interface TranslationResult {
  /** The English rendering (input returned unchanged when already English). */
  text: string;
  /** Detected source language of the input (BCP-47-ish, e.g. 'ja', 'es', 'en'). */
  sourceLang: string;
}

/**
 * Port: renders text into canonical English and reports its source language.
 * Behavioral interface (boundary data is primitive). The model-backed adapter
 * lives in `@workspace/translation`; a deterministic no-op double serves
 * key-free tests / smoke runs. Injected into the write path so a non-English
 * memory is canonicalized shortly after it is written.
 */
export interface ITranslator {
  /**
   * `ownerId` names whom the work is for when there is no ambient user to
   * read — the background canonicalization pass. It is what puts the owner's
   * own key behind the translation of their own memory.
   */
  translateToEnglish(
    text: string,
    ownerId?: string
  ): Promise<TranslationResult>;
}
