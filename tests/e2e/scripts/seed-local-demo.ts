/**
 * Local inspection seed for the ISOLATED e2e stack — so you can explore the
 * dashboard without ever touching the dev/stage stack you use for real work.
 *
 * Provisions a FIXED personal account and representative data:
 *   - a spread of memories across kinds (populates the feed / a memory to open)
 *   - one pending memory-hygiene conflict (populates /review)
 *   - the queues, metrics and graph the documentation screenshots show
 *
 * The content is REAL prose about this product — not lorem filler and not the
 * maintainer's working corpus, which carries private paths and project names
 * that must never reach a committed screenshot.
 *
 * Idempotent — safe to re-run after every `bun run e2e:stack` (which db-resets).
 *
 *   bun run demo:seed          # from tests/e2e (stack must be up)
 *
 * Login it provisions:  e2e@zm.local  /  zmreview
 */
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createClient, type SupabaseClient } from '@supabase/supabase-js';

const DEMO_EMAIL = 'e2e@zm.local';
const DEMO_PASSWORD = 'zmreview';
const WEB_URL = 'http://localhost:3102';
/** Shown in the dashboard chrome instead of the address (see settings → profile). */
const DEMO_NAME = 'Zero Memory Demo';

const workdir = resolve(fileURLToPath(import.meta.url), '../..');

/**
 * The showcase corpus: real memories this project accumulated, curated for
 * publication by `bun scripts/curate-showcase.ts` (which strips private paths,
 * planning markers, other projects and identifiers). Committed and reviewable,
 * because these end up in screenshots.
 *
 * Falls back to the handful of hand-written lines below when the curated file
 * is absent, so a fresh checkout still gets a usable demo.
 */
const CURATED: Array<{ kind: string; content: string }> = (() => {
  try {
    const path = resolve(
      fileURLToPath(import.meta.url),
      '../../fixtures/showcase-corpus.json'
    );
    return JSON.parse(readFileSync(path, 'utf8')) as Array<{
      kind: string;
      content: string;
    }>;
  } catch {
    return [];
  }
})();

/** Fallback feed content: one memory per kind so the dashboard looks real. */
const FALLBACK_MEMORIES: Array<{ kind: string; content: string }> = [
  {
    kind: 'decision',
    content:
      'We chose Bun over Node for the toolchain: faster installs and one binary.',
  },
  {
    kind: 'convention',
    content:
      'Commit messages are a single line: type(scope): subject, no body.',
  },
  {
    kind: 'gotcha',
    content:
      'Turbo runs each package with cwd=package, so Bun loads .env only from that package dir.',
  },
  {
    kind: 'preference',
    content:
      'Prefer static imports over dynamic import() unless a boundary requires it.',
  },
  {
    kind: 'fact',
    content: 'The dashboard is a Next.js app; in dev it serves on port 3100.',
  },
  {
    kind: 'reference',
    content: 'MCP tool contracts and schemas live in the contracts package.',
  },
];

const MEMORIES = CURATED.length > 0 ? CURATED : FALLBACK_MEMORIES;

/**
 * Memories that NAME their entities — the only way the entity graph gets
 * populated, since a direct table insert resolves no mentions.
 */
const GRAPH_MEMORIES: Array<{
  content: string;
  kind: string;
  entities: Array<{ name: string; type: string }>;
}> = [
  {
    content:
      'Retrieval fuses a vector search with full-text search, so an exact ' +
      'identifier still ranks when semantic similarity is weak.',
    kind: 'decision',
    entities: [
      { name: 'zero-memory', type: 'project' },
      { name: 'pgvector', type: 'library' },
    ],
  },
  {
    content:
      'Access control lives in the database as row-level security, not in ' +
      'application middleware — a query cannot forget to apply it.',
    kind: 'decision',
    entities: [
      { name: 'zero-memory', type: 'project' },
      { name: 'Supabase', type: 'service' },
    ],
  },
  {
    content:
      'The watcher captures session transcripts in the background, which is ' +
      'what makes capture zero-effort for the person working.',
    kind: 'fact',
    entities: [
      { name: 'watcher', type: 'service' },
      { name: 'Model Context Protocol', type: 'concept' },
    ],
  },
];

/** Two memories that disagree — the pending conflict shown on /review. */
const CONFLICT = [
  'Rate limiting uses a fixed-window limiter: 30 requests per 60 seconds per IP.',
  'Rate limiting uses a token-bucket limiter: 100 requests per minute per IP.',
];

/** Reads the running e2e stack's URL + service-role key from the CLI. */
function stackEnv(): {
  apiUrl: string;
  anonKey: string;
  serviceRoleKey: string;
} {
  const result = spawnSync(
    'bunx',
    ['supabase', 'status', '-o', 'env', '--workdir', workdir],
    { encoding: 'utf8' }
  );
  if (result.status !== 0) {
    throw new Error('e2e stack is not up — run `bun run e2e:stack` first.');
  }
  const env = new Map<string, string>();
  for (const line of result.stdout.split('\n')) {
    const match = /^([A-Z0-9_]+)="?([^"]*)"?$/.exec(line.trim());
    if (match?.[1] && match[2] !== undefined) {
      env.set(match[1], match[2]);
    }
  }
  const apiUrl = env.get('API_URL');
  const anonKey = env.get('ANON_KEY');
  const serviceRoleKey = env.get('SERVICE_ROLE_KEY');
  if (!apiUrl || !anonKey || !serviceRoleKey) {
    throw new Error(
      'could not read API_URL / ANON_KEY / SERVICE_ROLE_KEY from the stack'
    );
  }
  return { apiUrl, anonKey, serviceRoleKey };
}

/** Inserts a memory if the owner does not already have one with that content. */
async function ensureMemory(
  client: SupabaseClient,
  ownerId: string,
  scope: string,
  kind: string,
  content: string
): Promise<string> {
  const { data: existing } = await client
    .from('memories')
    .select('id')
    .eq('owner_id', ownerId)
    .eq('content', content)
    .is('invalidated_at', null)
    .maybeSingle();
  if (existing) {
    return (existing as { id: string }).id;
  }
  const { data: inserted, error } = await client
    .from('memories')
    .insert({ content, kind, scope, owner_id: ownerId })
    .select('id')
    .single();
  if (error) {
    throw new Error(`insert memory failed: ${error.message}`);
  }
  return (inserted as { id: string }).id;
}

const { apiUrl, anonKey, serviceRoleKey } = stackEnv();
const admin = createClient(apiUrl, serviceRoleKey, {
  auth: { persistSession: false, autoRefreshToken: false },
});

// 1. Fixed account (profile + usr_ auto-provisioned by trigger; idempotent).
const created = await admin.auth.admin.createUser({
  email: DEMO_EMAIL,
  password: DEMO_PASSWORD,
  email_confirm: true,
  user_metadata: { name: DEMO_NAME },
});
if (created.error && !/registered|exists/i.test(created.error.message)) {
  throw new Error(`create user failed: ${created.error.message}`);
}
const { data: list } = await admin.auth.admin.listUsers({
  page: 1,
  perPage: 1000,
});
const authUser = list.users.find((u) => u.email === DEMO_EMAIL);
if (!authUser) {
  throw new Error(`user ${DEMO_EMAIL} not found after provisioning`);
}
// An account created before the profile feature existed keeps its metadata
// until told otherwise, so re-runs set the name too.
await admin.auth.admin.updateUserById(authUser.id, {
  user_metadata: { name: DEMO_NAME },
});

const { data: profile } = await admin
  .from('profiles')
  .select('id')
  .eq('user_id', authUser.id)
  .single();
const ownerId = (profile as { id: string } | null)?.id;
if (!ownerId) {
  throw new Error('profile (usr_) not found for demo user');
}
const scope = `user.${ownerId.replace('.', '_')}`;

// 2. Feed memories.
for (const memory of MEMORIES) {
  await ensureMemory(admin, ownerId, scope, memory.kind, memory.content);
}

// 3. A pending review conflict.
const conflictIds = await Promise.all(
  CONFLICT.map((content) =>
    ensureMemory(admin, ownerId, scope, 'decision', content)
  )
);
const [a, b] = [...conflictIds].sort();
const { error: queueError } = await admin.from('memory_review_queue').upsert(
  {
    memory_a: a,
    memory_b: b,
    verdict: 'contradiction',
    confidence: 0.95,
    rationale:
      'Both describe the rate-limiting algorithm but disagree (fixed-window 30/60s vs token-bucket 100/min).',
    status: 'pending',
  },
  { onConflict: 'memory_a,memory_b', ignoreDuplicates: true }
);
if (queueError) {
  throw new Error(`enqueue failed: ${queueError.message}`);
}

// 4. The rest of the screens the documentation shows. The per-feature seed
// helpers already exist for the behavioural specs, so the demo reuses them
// instead of re-implementing their table writes — one definition of what a
// rule candidate or a reflection looks like, shared by specs and screenshots.
//
// They read the stack's credentials from the environment (lazily, via
// `e2eEnv`), which the CLI resolves from `supabase status` — so publish them
// before the first helper call.
process.env.SUPABASE_URL = apiUrl;
process.env.SUPABASE_ANON_KEY = anonKey;
process.env.SUPABASE_SERVICE_ROLE_KEY = serviceRoleKey;

const demoUser = {
  id: authUser.id,
  email: DEMO_EMAIL,
  password: DEMO_PASSWORD,
};

const { seedInsightsUsage, seedRoiRun } =
  await import('../src/helpers/insights.js');
const { seedRuleCandidate } = await import('../src/helpers/rules.js');
const { seedReflectionCandidate } =
  await import('../src/helpers/reflections.js');
const { seedVersionChain } = await import('../src/helpers/version-history.js');
const { passwordGrantToken } = await import('../src/helpers/users.js');
const { McpTestClient, firstJson } = await import('../src/helpers/mcp.js');

// Insights tiles, the ageing section and the activity log all read usage
// events; the ROI tile needs a completed benchmark run.
const insights = await seedInsightsUsage(demoUser, {
  topFact:
    'Retrieval is hybrid: pgvector similarity fused with full-text rank, so exact identifiers and paraphrases both hit.',
  emptyQuery: 'what is the retry budget for the export job?',
  errorQuery: 'which export run failed last night?',
  agentName: 'claude-code',
});
// The ROI tile reads a completed benchmark run: it needs the owner and one
// memory to have probed.
await seedRoiRun(insights.ownerId, insights.memoryId);

// The rules and reflections queues. The fixture strings are overridden with
// presentable prose: this queue lands in published screenshots, where a
// visible "E2E …" marker would read as staged data.
await seedRuleCandidate(demoUser, {
  content:
    'Commit messages are a single line: `type(scope): subject` — no body, no trailers.',
  ruleText:
    'Always write commit messages as a single line: `type(scope): subject`.',
  rationale:
    'Stated in four sessions over the last month; the wording is stable and already imperative.',
  siblingScope: 'proj.docs-site',
});
const hasReflection = await admin
  .from('reflection_candidates')
  .select('id')
  .eq('owner_id', ownerId)
  .limit(1);
if ((hasReflection.data ?? []).length === 0) {
  // Not idempotent by content: each call makes a fresh cluster, so it runs
  // only when the account has none. Presentable strings, same reason as the
  // rule candidate above.
  await seedReflectionCandidate(demoUser, {
    episodes: [
      'Session log — started moving the export job to the batch runner; retries not wired yet.',
      'Checkpoint — the batch runner handles retries with a dead-letter list after 3 attempts.',
      'Wrap-up — the export job runs only on the batch runner, dead-letter after 3 retries.',
    ],
    draft:
      'The export job runs exclusively on the batch runner, with retries and a dead-letter list after 3 attempts.',
    rationale:
      'Three episodes tell one evolving story; the last states the final configuration.',
  });
}

// A supersede chain, so a memory detail page has version history to show.
// Same reason as above: no fixture marker in content the screenshots carry.
await seedVersionChain(demoUser, {
  old: 'The rate limiter allows 30 requests per minute.',
  current: 'The rate limiter allows 100 requests per minute.',
});

// Entities, provenance badges, the original-language disclosure and open
// loops can only come from the REAL write path: a service-role insert leaves
// no entity graph, no client attribution and no translation record.
const token = await passwordGrantToken(demoUser);
const mcp = await McpTestClient.connect(token);

/**
 * Writes through the real tool and FAILS LOUDLY.
 *
 * A seeding call that is not checked fails in silence and the screen it was
 * meant to populate simply renders empty — which looks like a UI bug rather
 * than a seed that did not run.
 *
 * Every write names its target explicitly: this session has no project
 * attached (it is a script, not an editor), and the server refuses a
 * scope-less write rather than guessing where the memory belongs.
 */
const write = async (
  args: Record<string, unknown>
): Promise<{ memory_id: string }> => {
  const result = await mcp.callTool('remember', args);
  if (result.isError) {
    throw new Error(`seed write failed: ${result.content[0]?.text ?? ''}`);
  }
  return firstJson<{ memory_id: string }>(result);
};

try {
  // Project-scoped, so the scopes screen shows a real project beside the
  // personal one and feed cards carry a project badge.
  for (const memory of GRAPH_MEMORIES) {
    await write({ ...memory, project_hint: 'zero-memory' });
  }
  await write({
    content:
      'Memories are stored in canonical English, and the phrasing they were ' +
      'written in is kept beside them.',
    kind: 'convention',
    verbatim:
      'Los recuerdos se guardan en inglés canónico, junto a su redacción original.',
    scope: 'personal',
  });
  await write({
    content:
      'Open loop: re-shoot the documentation screenshots once the browser ' +
      'frame lands, so every frame is 16:9 with its chrome.',
    kind: 'task',
    scope: 'personal',
  });
  const closing = await write({
    content:
      'Open loop: give the dashboard a profile screen so a shared screen ' +
      'shows a name instead of an address.',
    kind: 'task',
    scope: 'personal',
  });
  const closed = await mcp.callTool('close_loop', {
    memory_id: closing.memory_id,
  });
  // Already-closed on a re-run is the state we want, not a failure.
  if (
    closed.isError &&
    !/not an open loop|already/i.test(closed.content[0]?.text ?? '')
  ) {
    throw new Error(`close_loop failed: ${closed.content[0]?.text ?? ''}`);
  }
} finally {
  await mcp.close();
}

process.stdout.write(
  `\n✓ Local demo ready.\n  URL:   ${WEB_URL}\n  Login: ${DEMO_EMAIL} / ${DEMO_PASSWORD}\n` +
    `  Name:  ${DEMO_NAME}\n` +
    `  Feed:  ${MEMORIES.length} memories + graph, loops and a version chain\n` +
    `  Queues: review · rules · reflections · insights · ROI\n\n`
);
