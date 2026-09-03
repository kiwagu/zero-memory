import { describe, expect, it } from 'vitest';

import { TranslationState } from './translation-state.vo.js';

describe('TranslationState', () => {
  it('skipped() marks already-English content canonical as-is', () => {
    const state = TranslationState.skipped();
    expect(state.status).toBe('skipped');
    expect(state.lang).toBe('en');
    expect(state.originalText).toBeNull();
    expect(state.attempts).toBe(0);
    expect(state.error).toBeNull();
  });

  it('pending() queues non-English content with no known source language', () => {
    const state = TranslationState.pending();
    expect(state.status).toBe('pending');
    expect(state.lang).toBeNull();
    expect(state.originalText).toBeNull();
    expect(state.attempts).toBe(0);
  });

  it('restore() round-trips a persisted, translated row', () => {
    const state = TranslationState.restore({
      status: 'done',
      originalText: '短いcommitメッセージ',
      lang: 'ja',
      attempts: 1,
      error: null,
    });
    expect(state.status).toBe('done');
    expect(state.originalText).toBe('短いcommitメッセージ');
    expect(state.lang).toBe('ja');
    expect(state.attempts).toBe(1);
  });
});
