/**
 * Cheap, dependency-free "is this already English?" test for the write path.
 *
 * The canonical language of stored memory content is English; anything else is
 * queued for asynchronous translation. Deciding that does NOT need a model: a
 * script check is enough. Text that contains a letter from a non-Latin script
 * (e.g. Cyrillic, Greek, Han, Arabic) is treated as non-English; text written
 * in the Latin alphabet is treated as English.
 *
 * Punctuation and symbols (em dash, ≥, ✓, currency) are not letters, so
 * English prose full of them still reads as English. The known blind spot is
 * Latin-script non-English (e.g. Spanish): it looks English to this test and is
 * left as-is. The precise source language is not guessed here — the translator
 * reports it when a memory is actually translated.
 */

const LETTER = /\p{L}/u;
const LATIN_LETTER = /\p{Script=Latin}/u;

/** True when the text has a letter from a script other than Latin. */
const hasNonLatinLetter = (text: string): boolean => {
  for (const ch of text) {
    if (LETTER.test(ch) && !LATIN_LETTER.test(ch)) {
      return true;
    }
  }
  return false;
};

export interface DetectedLanguage {
  /** Whether the text is already in the canonical language (English). */
  isEnglish: boolean;
}

/** Detects whether text is already English or needs translation. */
export function detectLanguage(text: string): DetectedLanguage {
  return { isEnglish: !hasNonLatinLetter(text) };
}
