/**
 * Positive-path dogfood of the loop-closure detector against a DISPOSABLE
 * stack (the e2e sandbox): seeds one open loop plus a newer memory that
 * explicitly asserts its completion (embeddings computed locally with the
 * server's model), runs the detector, and verifies the loop auto-closed —
 * reversible invalidation, evidence stamped as successor, supersedes link,
 * spent re-judge guard row.
 *
 * Connection: SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY from the environment
 * (point them at a disposable stack — the script writes and then cleans up).
 * The judge needs ANTHROPIC_API_KEY.
 *
 * Usage: SUPABASE_URL=… SUPABASE_SERVICE_ROLE_KEY=… ANTHROPIC_API_KEY=… \
 *          bun scripts/dogfood-loop-closure.ts
 */
import { createClient } from '@supabase/supabase-js';

// Relative imports into the package sources: this script lives at the repo
// root, which does not depend on these workspaces, so bare specifiers do not
// resolve. The packages' own internal imports resolve fine.
import { E5SmallEmbeddingService } from '../packages/embedding/src/index.js';
import { LoopClosureDetector } from '../packages/hygiene/src/index.js';

const required = (name: string): string => {
  const value = process.env[name];
  if (!value) {
    throw new Error(`${name} must be set`);
  }
  return value;
};

const client = createClient(
  required('SUPABASE_URL'),
  required('SUPABASE_SERVICE_ROLE_KEY'),
  { auth: { persistSession: false, autoRefreshToken: false } }
);

const { data: profile } = await client
  .from('profiles')
  .select('id')
  .limit(1)
  .single();
if (!profile) {
  throw new Error('no profile in the target DB — seed a user first');
}
const ownerId = (profile as { id: string }).id;
const scope = `user.${ownerId.replace('.', '_')}`;

const embedder = new E5SmallEmbeddingService();
const loopContent =
  'TASK (loop-closure dogfood): repaint the bikeshed door in RAL 6005 ' +
  'green and rehang it.';
const evidenceContent =
  'Loop-closure dogfood outcome: the bikeshed door has been repainted in ' +
  'RAL 6005 green and rehung — the task is fully complete, nothing remains.';

const insert = async (
  content: string,
  kind: string,
  createdAt: string
): Promise<string> => {
  const { data, error } = await client
    .from('memories')
    .insert({
      content,
      kind,
      scope,
      owner_id: ownerId,
      embedding: JSON.stringify(
        (await embedder.embed([content], 'passage'))[0]
      ),
      created_at: createdAt,
    })
    .select('id')
    .single();
  if (error || !data) {
    throw new Error(`seed insert failed: ${error?.message}`);
  }
  return (data as { id: string }).id;
};

const loopId = await insert(
  loopContent,
  'task',
  new Date(Date.now() - 60_000).toISOString()
);
const evidenceId = await insert(
  evidenceContent,
  'fact',
  new Date().toISOString()
);
console.log(`seeded loop ${loopId}, evidence ${evidenceId}`);

try {
  const result = await new LoopClosureDetector(client).detect(ownerId);
  console.log(JSON.stringify(result));

  const { data: closedLoop } = await client
    .from('memories')
    .select('invalidated_at, invalidated_by_agent, superseded_by')
    .eq('id', loopId)
    .single();
  const { data: guard } = await client
    .from('loop_closure_checks')
    .select('loop_id')
    .eq('loop_id', loopId);
  const { data: link } = await client
    .from('memory_links')
    .select('type')
    .eq('src', evidenceId)
    .eq('dst', loopId);

  const checks = {
    closed: closedLoop?.invalidated_at !== null,
    attributed: closedLoop?.invalidated_by_agent === 'loop-closure',
    successor: closedLoop?.superseded_by === evidenceId,
    guardSpent: (guard?.length ?? 0) === 0,
    linked: link?.[0]?.type === 'supersedes',
  };
  console.log(JSON.stringify(checks));
  if (!Object.values(checks).every(Boolean)) {
    process.exitCode = 1;
    console.error('DOGFOOD FAILED: see checks above');
  } else {
    console.log('DOGFOOD OK: loop auto-closed with full provenance');
  }
} finally {
  // Disposable stack, but leave it as found anyway.
  await client.from('memories').delete().in('id', [loopId, evidenceId]);
}
