/**
 * M4 acceptance smoke test: drives the auto-population pipeline end to end
 * against the running Supabase stack.
 *
 * Flow:
 *   1. provision a FRESH user (avoids data-accumulation flakes),
 *   2. spawn the MCP stdio server as that user; extraction runs against the
 *      real Anthropic API when ANTHROPIC_API_KEY is set, otherwise via the
 *      deterministic extractor (ZM_EXTRACTOR=deterministic DI override),
 *   3. ingest a synthetic non-English transcript chunk (one clear decision, one
 *      preference, noise) with a project hint,
 *   4. assert: memories stored with the right kinds and scopes (decision ->
 *      project scope, preference -> personal scope), the same chunk re-sent
 *      is a duplicate no-op, and recall finds the decision.
 *
 * Required env: SUPABASE_URL, SUPABASE_ANON_KEY, SUPABASE_SERVICE_ROLE_KEY.
 * Usage: bun scripts/smoke-ingest.ts
 */
import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { createClient } from '@supabase/supabase-js';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');

const requiredEnv = [
  'SUPABASE_URL',
  'SUPABASE_ANON_KEY',
  'SUPABASE_SERVICE_ROLE_KEY',
];
const missing = requiredEnv.filter((name) => !process.env[name]);
if (missing.length > 0) {
  console.error(`Missing env: ${missing.join(', ')}`);
  process.exit(1);
}

const SUPABASE_URL = process.env.SUPABASE_URL!;
const ANON_KEY = process.env.SUPABASE_ANON_KEY!;
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY!;
const useRealExtractor = Boolean(process.env.ANTHROPIC_API_KEY);

const fail = (message: string): never => {
  console.error(`\nSMOKE-INGEST FAILED: ${message}`);
  process.exit(1);
};

const step = (message: string): void => {
  console.log(`\n=== ${message} ===`);
};

// ── 1. fresh user ────────────────────────────────────────────────────────

const runId = Date.now();
const user = {
  email: `ingest-${runId}@zero-memory.local`,
  password: `smoke-ingest-${runId}`,
};

step(`provision fresh user ${user.email}`);
const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});
const created = await admin.auth.admin.createUser({
  email: user.email,
  password: user.password,
  email_confirm: true,
});
if (created.error || !created.data.user) {
  fail(`could not provision user: ${created.error?.message}`);
}
const userId = created.data.user!.id;

// ── 2. spawn the MCP stdio server as that user ──────────────────────────

step(
  `spawn mcp stdio server (extractor: ${useRealExtractor ? 'anthropic' : 'deterministic'})`
);
const env: Record<string, string> = {};
for (const [key, value] of Object.entries(process.env)) {
  if (value !== undefined) env[key] = value;
}
env.ZM_EMAIL = user.email;
env.ZM_PASSWORD = user.password;
if (!useRealExtractor) {
  env.ZM_EXTRACTOR = 'deterministic';
}

const transport = new StdioClientTransport({
  command: 'bun',
  args: [join(repoRoot, 'apps/server/src/mcp-stdio.ts')],
  cwd: repoRoot,
  env,
  stderr: 'inherit',
});
const client = new Client({ name: 'smoke-ingest', version: '0.1.0' });
await client.connect(transport);

const contentText = (result: unknown): string =>
  (
    (result as { content: Array<{ type: string; text?: string }> }).content ??
    []
  )
    .map((item) => item.text ?? '')
    .join('\n');

const firstJson = <T>(result: unknown): T => {
  // The first text block is the payload; a reminder block may follow.
  const blocks = (result as { content: Array<{ type: string; text?: string }> })
    .content;
  return JSON.parse(blocks[0]?.text ?? '{}') as T;
};

// ── 3. ingest a synthetic non-English transcript ────────────────────────

const projectSlug = `ingestproj${runId}`;
const projectHint = `/tmp/smoke-projects/${projectSlug}`;
// Expected scopes are owner-namespaced (proj.<owner>.<slug>); the owner
// segment is the profile entity id, resolved after the profile exists.

const transcript = [
  'user: プロジェクトの議論の結果をまとめましょう。',
  'assistant: はい、本日決めたことは次のとおりです。',
  `DECISION: We chose PostgreSQL over MySQL for ${projectSlug} because we need the ltree and pgvector extensions for scopes and semantic search.`,
  'PREF: ユーザーは type(scope): subject 形式の一行コミットメッセージを好み、本文は書きません。',
  'user: ありがとう！ところで今日の天気は？',
  'assistant: さっぱりです — 私はターミナルを見ているだけなので :)',
  'user: わかりました、15:00の通話も忘れずに（これは重要ではないので覚えなくてよい）',
].join('\n');

const chunkHash = createHash('sha256').update(transcript, 'utf8').digest('hex');
const ingestArgs = {
  transcript_chunk: transcript,
  chunk_hash: chunkHash,
  client: 'smoke-ingest',
  conversation_id: `smoke-conv-${runId}`,
  project_hint: projectHint,
};

step('ingest_conversation (first send)');
const ingested = await client.callTool({
  name: 'ingest_conversation',
  arguments: ingestArgs,
});
console.log(contentText(ingested));
if (ingested.isError) {
  fail('ingest_conversation errored.');
}
const ingestOutput = firstJson<{
  duplicate: boolean;
  memories_created: number;
  memory_ids: string[];
}>(ingested);
if (ingestOutput.duplicate) {
  fail('first send reported duplicate=true.');
}
if (ingestOutput.memories_created < 2) {
  fail(
    `expected >= 2 memories (decision + preference), got ${ingestOutput.memories_created}.`
  );
}

// ── 4. duplicate send is a no-op ─────────────────────────────────────────

step('ingest_conversation (same chunk re-sent)');
const resent = await client.callTool({
  name: 'ingest_conversation',
  arguments: ingestArgs,
});
console.log(contentText(resent));
const resentOutput = firstJson<{
  duplicate: boolean;
  memories_created: number;
}>(resent);
if (resent.isError || !resentOutput.duplicate) {
  fail('re-sent chunk was not reported as duplicate.');
}
if (resentOutput.memories_created !== 0) {
  fail('duplicate send created memories.');
}

// ── 5. kinds + scopes in the store ───────────────────────────────────────

step('verify kinds and scopes (as the fresh user)');
const { data: ownerProfile, error: profileError } = await admin
  .from('profiles')
  .select('id')
  .eq('user_id', userId)
  .single();
if (profileError || !ownerProfile) {
  fail(`could not read the owner profile: ${profileError?.message}`);
}
const ownerSegment = String(ownerProfile!.id).replace(/\./g, '_');
const projectScope = `proj.${ownerSegment}.${projectSlug}`;
const personalScope = `user.${ownerSegment}`;
const userClient = createClient(SUPABASE_URL, ANON_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});
const signedIn = await userClient.auth.signInWithPassword(user);
if (signedIn.error) {
  fail(`user sign-in failed: ${signedIn.error.message}`);
}
const { data: rows, error: rowsError } = await userClient
  .from('memories')
  .select('id, kind, scope, content')
  .in('id', ingestOutput.memory_ids);
if (rowsError) {
  fail(`could not read memories back: ${rowsError.message}`);
}
console.log(JSON.stringify(rows, null, 2));

const decisionRow = (rows ?? []).find((row) => row.kind === 'decision');
const preferenceRow = (rows ?? []).find((row) => row.kind === 'preference');
if (!decisionRow) {
  fail('no decision memory was stored.');
}
if (!preferenceRow) {
  fail('no preference memory was stored.');
}
if (String(decisionRow!.scope) !== projectScope) {
  fail(
    `decision landed in "${String(decisionRow!.scope)}", expected "${projectScope}".`
  );
}
if (String(preferenceRow!.scope) !== personalScope) {
  fail(
    `preference landed in "${String(preferenceRow!.scope)}", expected "${personalScope}".`
  );
}

// The duplicate protection also proves the ingest_log row exists.
const { data: logRows, error: logError } = await userClient
  .from('ingest_log')
  .select('chunk_hash, processed_at, memories_created')
  .eq('chunk_hash', chunkHash);
if (logError || (logRows ?? []).length !== 1) {
  fail(`ingest_log row missing: ${logError?.message ?? 'no row'}`);
}
if (!logRows![0]!.processed_at) {
  fail('ingest_log row was not marked processed.');
}

// ── 6. recall finds the decision ─────────────────────────────────────────

step('recall the decision');
const recalled = await client.callTool({
  name: 'recall',
  arguments: {
    query: `why did ${projectSlug} choose PostgreSQL over MySQL?`,
    k: 8,
    // Reads are project-isolated; pin the ingest project the same way the
    // ingest call did, or the decision sits outside the session's default.
    project_hint: projectHint,
  },
});
console.log(contentText(recalled));
if (recalled.isError) {
  fail('recall errored.');
}
const recallOutput = firstJson<{ memories: Array<{ id: string }> }>(recalled);
if (!recallOutput.memories.some((memory) => memory.id === decisionRow!.id)) {
  fail('recall did not surface the ingested decision.');
}

await client.close();

console.log(
  `\nSMOKE-INGEST OK: extraction (${useRealExtractor ? 'anthropic' : 'deterministic'}), ` +
    'routing (decision -> project scope, preference -> personal scope), ' +
    'idempotent re-send, and recall all passed.'
);
