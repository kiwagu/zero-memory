import { describe, expect, it } from 'vitest';

import { detectLanguage } from './language.js';

describe('detectLanguage', () => {
  it('treats Latin-script English as already English', () => {
    expect(detectLanguage('chose postgres over mysql').isEnglish).toBe(true);
  });

  it('ignores non-letter symbols common in English technical prose', () => {
    // em dash, ≥, curly quotes, arrows, checkmark — punctuation/symbols, not
    // letters, so English text full of them still reads as English.
    expect(
      detectLanguage('use RRF — score ≥ 0.78, prefer “passage” → ✓').isEnglish
    ).toBe(true);
  });

  it('flags text with non-Latin letters as needing translation', () => {
    expect(detectLanguage('短いcommitメッセージ').isEnglish).toBe(false);
  });

  it('flags mixed non-Latin + English as needing translation', () => {
    expect(detectLanguage('watcherは.envをcwdからのみ読み込む').isEnglish).toBe(
      false
    );
  });

  it('flags other non-Latin scripts (Han, Greek)', () => {
    expect(detectLanguage('数据库迁移').isEnglish).toBe(false);
    expect(detectLanguage('Λάμβδα').isEnglish).toBe(false);
  });

  it('leaves Latin-script non-English as English (documented blind spot)', () => {
    // Spanish accents are Latin-script letters, so this heuristic cannot tell
    // Spanish from English — it is not the gap being closed.
    expect(detectLanguage('la conexión está rota').isEnglish).toBe(true);
  });
});
