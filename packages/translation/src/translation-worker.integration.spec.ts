import { E5SmallEmbeddingService } from '@workspace/embedding';
import { createServiceRoleClient } from '@workspace/persistence';
import { describe, expect, it } from 'vitest';

import { DeterministicTranslator } from './testing/deterministic.translator.js';
import { TranslationWorker } from './translation-worker.js';

// Live-DB integration: runs only when a service-role connection is configured
// (a dedicated integration run), and is skipped in the default unit run.
const hasDb = Boolean(
  process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY
);

// Non-Latin content (Greek + Han) so classify/translate treat it as non-English.
const PROBE = 'ZZINT λ 数据 integration probe';

describe.skipIf(!hasDb)('TranslationWorker (integration, live DB)', () => {
  it('drains a pending row: original preserved, re-embedded, marked done', async () => {
    // Client is built inside the test so a skipped run never needs the env.
    const client = createServiceRoleClient();

    // translate() drains the WHOLE pending set, so only run in isolation — a DB
    // that already has a real backlog is left untouched (precondition, not a
    // failure).
    const backlog = await client
      .from('memories')
      .select('id', { count: 'exact', head: true })
      .eq('translation_status', 'pending');
    if ((backlog.count ?? 0) > 0) {
      return;
    }

    // Borrow a valid owner + scope from any existing row (both are NOT NULL and
    // owner_id is an FK, so a bare insert would fail).
    const sample = await client
      .from('memories')
      .select('owner_id, scope')
      .limit(1)
      .single();
    expect(sample.error).toBeNull();

    const inserted = await client
      .from('memories')
      .insert({
        content: PROBE,
        kind: 'fact',
        scope: sample.data!.scope,
        owner_id: sample.data!.owner_id,
        translation_status: 'pending',
      })
      .select('id')
      .single();
    expect(inserted.error).toBeNull();
    const id = inserted.data!.id;

    try {
      const worker = new TranslationWorker(
        new DeterministicTranslator(),
        new E5SmallEmbeddingService(),
        client
      );
      const result = await worker.translate();
      expect(result.translated).toBe(1);

      const row = await client
        .from('memories')
        .select('content_original, content_lang, translation_status, embedding')
        .eq('id', id)
        .single();
      expect(row.data!.translation_status).toBe('done');
      // The deterministic translator is a no-op, so the original is preserved
      // verbatim and the source language is reported as undetermined.
      expect(row.data!.content_original).toBe(PROBE);
      expect(row.data!.content_lang).toBe('und');
      expect(row.data!.embedding).not.toBeNull();
    } finally {
      await client.from('memories').delete().eq('id', id);
    }
  });
});
