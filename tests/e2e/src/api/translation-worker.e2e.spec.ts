/**
 * The language-canonicalization backstop, run the way an operator runs it:
 * `scripts/translate-pending.ts --translate` against this stand. A memory the
 * write path could not canonicalize waits as `pending`; the pass translates
 * it, keeps the original beside the English text, embeds it again — its
 * overflow windows included — and marks it done.
 *
 * The stand translates with the deterministic translator, which hands the
 * text back unchanged and reports an undetermined language, so the
 * assertions are about the pipeline rather than a translation. A failing
 * translation (the attempt recorded, the row left pending) is not driven
 * here: the stand's translator never fails, and making it fail would need a
 * switch the product does not have.
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import { expect, test } from '@playwright/test';

import { admin, psql } from '../helpers/board-store.js';
import { e2eEnv } from '../helpers/env.js';
import { entityIdOf, provisionE2EUser } from '../helpers/users.js';

const run = promisify(execFile);

/** Non-Latin, and long enough to need more than one embedding window. */
const ORIGINAL =
  '翻訳ワーカーの検証: 保留中の行は英語に正規化され、原文は保持され、埋め込みは作り直される。'.repeat(
    70
  );

interface Row {
  content: string;
  content_original: string | null;
  content_lang: string | null;
  translation_status: string;
  translation_attempts: number;
  has_embedding: boolean;
}

const rowOf = (id: string): Row =>
  JSON.parse(
    psql(
      `select json_build_object('content', content, ` +
        `'content_original', content_original, 'content_lang', content_lang, ` +
        `'translation_status', translation_status, ` +
        `'translation_attempts', translation_attempts, ` +
        `'has_embedding', embedding is not null) ` +
        `from public.memories where id = '${id}'`
    )
  ) as Row;

/** The memory's overflow windows, as their offsets in the content. */
const windowsOf = (id: string): number[] =>
  psql(
    `select char_start from public.memory_chunks ` +
      `where memory_id = '${id}' order by ord`
  )
    .split('\n')
    .filter(Boolean)
    .map(Number);

test('a pending memory is translated, keeps its original, is embedded again and marked done', async () => {
  test.setTimeout(180_000);
  const user = await provisionE2EUser('translation-worker@zm.e2e');
  const ownerId = await entityIdOf(user.id);

  // The state a failed write-time canonicalization leaves: stored, pending,
  // not embedded yet.
  const { data, error } = await admin()
    .from('memories')
    .insert({
      content: ORIGINAL,
      kind: 'fact',
      scope: `user.${ownerId.replace('.', '_')}`,
      owner_id: ownerId,
      translation_status: 'pending',
    })
    .select('id')
    .single();
  expect(error).toBeNull();
  const id = (data as { id: string }).id;
  expect(rowOf(id)).toMatchObject({
    translation_status: 'pending',
    content_original: null,
    has_embedding: false,
  });
  expect(windowsOf(id)).toEqual([]);

  const { stdout } = await run(
    'bun',
    ['scripts/translate-pending.ts', '--translate'],
    {
      cwd: new URL('../../../../', import.meta.url).pathname,
      env: {
        ...process.env,
        SUPABASE_URL: e2eEnv.supabaseUrl,
        SUPABASE_SERVICE_ROLE_KEY: e2eEnv.supabaseServiceRoleKey,
        ZM_EXTRACTOR: 'deterministic',
      },
    }
  );
  // The pass logs as it goes; its report is the indented object it prints
  // last, which opens with the dry-run flag.
  const report = JSON.parse(
    stdout.slice(stdout.lastIndexOf('{\n  "dryRun"'))
  ) as {
    translate: { translated: number; failed: number };
  };
  expect(report.translate.translated).toBeGreaterThanOrEqual(1);
  expect(report.translate.failed).toBe(0);

  expect(rowOf(id)).toEqual({
    content: ORIGINAL,
    content_original: ORIGINAL,
    content_lang: 'und',
    translation_status: 'done',
    translation_attempts: 0,
    has_embedding: true,
  });
  // The windows past the first are embedded too, each further into the text.
  const windows = windowsOf(id);
  expect(windows.length).toBeGreaterThanOrEqual(1);
  expect(windows[0]).toBeGreaterThan(0);
  expect([...windows].sort((a, b) => a - b)).toEqual(windows);
  expect(new Set(windows).size).toBe(windows.length);
  expect(windows.at(-1)!).toBeLessThan(ORIGINAL.length);
});
