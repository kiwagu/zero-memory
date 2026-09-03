/**
 * Full-path dogfood of the external re-verification detector against a
 * DISPOSABLE stack (the e2e sandbox): seeds two overdue core-scope facts —
 * one still true, one visibly outdated — runs the detector with the REAL
 * Anthropic server-side web search, and verifies the honest outcomes: the
 * true fact stamped `current` in the freshness ledger, the outdated one
 * raised as a stale_suspect review dispute (never auto-superseded), both
 * checks audited and metered.
 *
 * Connection: SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY from the environment
 * (point them at a disposable stack — the script writes and then cleans up).
 * The search + verdict need ANTHROPIC_API_KEY. Costs a handful of web
 * searches and a few thousand tokens on that key.
 *
 * Usage: SUPABASE_URL=… SUPABASE_SERVICE_ROLE_KEY=… ANTHROPIC_API_KEY=… \
 *          bun scripts/dogfood-reverify.ts
 */
import { createClient } from '@supabase/supabase-js';

// Relative imports into the package sources: this script lives at the repo
// root, which does not depend on these workspaces, so bare specifiers do not
// resolve. The packages' own internal imports resolve fine.
import { ReverifyDetector } from '../packages/hygiene/src/index.js';
import {
  AiSdkProvider,
  EnvCredentialResolver,
  GuardedLlmGateway,
  setLlmGateway,
} from '../packages/llm/src/index.js';
import { BudgetGuard } from '../packages/policy/src/index.js';

const required = (name: string): string => {
  const value = process.env[name];
  if (!value) {
    throw new Error(`${name} must be set`);
  }
  return value;
};
required('ANTHROPIC_API_KEY');

const client = createClient(
  required('SUPABASE_URL'),
  required('SUPABASE_SERVICE_ROLE_KEY'),
  { auth: { persistSession: false, autoRefreshToken: false } }
);

// Standalone bootstrap (mirrors the server's composition root, minus the
// container): platform key, no policy providers — an empty provider list
// means no ceiling, which is fine for a two-check dogfood.
setLlmGateway(
  new GuardedLlmGateway(
    new AiSdkProvider(),
    new BudgetGuard([], { spent: () => Promise.resolve(0) }),
    new EnvCredentialResolver(),
    () => null
  )
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
const coreScope = `user.${ownerId.replace(/[-.]/g, '_')}.core`;

// Overdue by construction: created a year ago, no verification row.
const overdue = new Date(Date.now() - 365 * 86_400_000).toISOString();

const insert = async (content: string): Promise<string> => {
  const { data, error } = await client
    .from('memories')
    .insert({
      content,
      kind: 'fact',
      scope: coreScope,
      owner_id: ownerId,
      created_at: overdue,
    })
    .select('id')
    .single();
  if (error || !data) {
    throw new Error(`seed insert failed: ${error?.message}`);
  }
  return (data as { id: string }).id;
};

const currentId = await insert(
  'Git is a distributed version control system, originally created by ' +
    'Linus Torvalds in 2005 for Linux kernel development.'
);
const outdatedId = await insert(
  'The most recent major version of Node.js is Node 16, released in 2021.'
);
console.log(`seeded current-fact ${currentId}, outdated-fact ${outdatedId}`);

try {
  const detector = new ReverifyDetector(client);
  const result = await detector.detect();
  console.log(JSON.stringify(result));

  const { data: ledger } = await client
    .from('memory_verification')
    .select('memory_id, verdict, checks')
    .in('memory_id', [currentId, outdatedId]);
  const { data: dispute } = await client
    .from('memory_review_queue')
    .select('memory_a, verdict, status, rationale')
    .eq('memory_a', outdatedId)
    .is('memory_b', null);
  const { data: audits } = await client
    .from('audit_log')
    .select('command')
    .like('command', 'reverify.%')
    .order('occurred_at', { ascending: false })
    .limit(10);

  const checks = {
    currentStamped:
      ledger?.some(
        (row) => row.memory_id === currentId && row.verdict === 'current'
      ) ?? false,
    outdatedDisputed: (dispute?.length ?? 0) > 0,
    outdatedNotStamped: !ledger?.some((row) => row.memory_id === outdatedId),
    audited: (audits?.length ?? 0) > 0,
  };
  console.log(JSON.stringify({ ledger, dispute, checks }, null, 2));
  if (!Object.values(checks).every(Boolean)) {
    process.exitCode = 1;
    console.error('dogfood FAILED — see checks above');
  } else {
    console.log('dogfood OK — all checks green');
  }
} finally {
  // Cleanup: the dispute row references the memory; remove it first.
  await client.from('memory_review_queue').delete().eq('memory_a', outdatedId);
  await client.from('memories').delete().in('id', [currentId, outdatedId]);
  console.log('cleaned up seeds');
}
