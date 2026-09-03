import type { ITranslator, TranslationResult } from '@workspace/memory';

/**
 * TEST-ONLY translator: no model involved. Returns the input unchanged and
 * reports an undetermined source language, so key-free smoke / e2e runs can
 * exercise the whole pending -> done pipeline (status flip, original preserved,
 * re-embed) without an API key. Never wire this into production DI.
 */
export class DeterministicTranslator implements ITranslator {
  translateToEnglish(text: string): Promise<TranslationResult> {
    return Promise.resolve({ text, sourceLang: 'und' });
  }
}
