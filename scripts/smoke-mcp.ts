/**
 * M1 acceptance smoke test: spawns the MCP stdio server, then drives a real
 * remember -> recall roundtrip through the SDK client.
 *
 * Required env (local stack defaults come from `supabase start` output):
 *   SUPABASE_URL, SUPABASE_ANON_KEY, ZM_EMAIL, ZM_PASSWORD
 *
 * Usage: bun scripts/smoke-mcp.ts
 */
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');

const requiredEnv = [
  'SUPABASE_URL',
  'SUPABASE_ANON_KEY',
  'ZM_EMAIL',
  'ZM_PASSWORD',
];
const missing = requiredEnv.filter((name) => !process.env[name]);
if (missing.length > 0) {
  console.error(`Missing env: ${missing.join(', ')}`);
  process.exit(1);
}

const env: Record<string, string> = {};
for (const [key, value] of Object.entries(process.env)) {
  if (value !== undefined) env[key] = value;
}

const transport = new StdioClientTransport({
  command: 'bun',
  args: [join(repoRoot, 'apps/server/src/mcp-stdio.ts')],
  cwd: repoRoot,
  env,
  stderr: 'inherit',
});

const client = new Client({ name: 'smoke-mcp', version: '0.1.0' });
await client.connect(transport);

const printResult = (label: string, result: unknown): void => {
  console.log(`\n=== ${label} ===`);
  console.log(JSON.stringify(result, null, 2));
};

const tools = await client.listTools();
printResult(
  'tools',
  tools.tools.map((tool) => tool.name)
);

const marker = `smoke-${Date.now()}`;
const remembered = await client.callTool({
  name: 'remember',
  arguments: {
    content: `Smoke test ${marker}: this project prefers bun over npm for all workspace tasks.`,
    kind: 'preference',
  },
});
printResult('remember', remembered);

const rememberedAgain = await client.callTool({
  name: 'remember',
  arguments: {
    content: `Smoke test ${marker}: this project prefers bun over npm for all workspace tasks.`,
    kind: 'preference',
  },
});
printResult('remember (dedup expected)', rememberedAgain);

const recalled = await client.callTool({
  name: 'recall',
  arguments: { query: 'which package manager does this project prefer?', k: 5 },
});
printResult('recall', recalled);

const contentText = (result: unknown): string =>
  (
    (result as { content: Array<{ type: string; text?: string }> }).content ??
    []
  )
    .map((item) => item.text ?? '')
    .join('\n');

// Recall/build_context append a reinforcement footer as a second text block;
// the first block is always the JSON payload.
const firstJson = <T>(result: unknown): T =>
  JSON.parse(
    (result as { content: Array<{ type: string; text?: string }> }).content[0]
      ?.text ?? '{}'
  ) as T;

const memoryId = firstJson<{ memory_id: string }>(remembered).memory_id;

// Forget the smoke memory (ADD-only invalidation) and verify it disappears.
const forgotten = await client.callTool({
  name: 'forget',
  arguments: { memory_id: memoryId, reason: 'smoke cleanup' },
});
printResult('forget', forgotten);

const recalledAfterForget = await client.callTool({
  name: 'recall',
  arguments: { query: 'which package manager does this project prefer?', k: 5 },
});
printResult('recall (after forget)', recalledAfterForget);

// ── M2: knowledge graph — remember with entities, link, entities,
// build_context, include_graph recall. Fresh throwaway names per run keep
// the asserts robust against smoke data left by earlier runs.
const projectName = `alphasmoke${Date.now()}`;

const graphFacts = [
  {
    content: `Project ${projectName} uses postgres for primary storage.`,
    kind: 'fact',
    entities: [
      { name: projectName, type: 'project' },
      { name: 'postgres', type: 'service' },
    ],
  },
  {
    content: `Project ${projectName} prefers bun for all workspace tasks.`,
    kind: 'preference',
    entities: [
      { name: projectName, type: 'project' },
      { name: 'bun', type: 'tool' },
    ],
  },
  {
    content: `Project ${projectName} decided to keep migrations as raw SQL.`,
    kind: 'decision',
    entities: [{ name: projectName, type: 'project' }],
  },
] as const;

const graphMemoryIds: string[] = [];
for (const fact of graphFacts) {
  const stored = await client.callTool({
    name: 'remember',
    arguments: { ...fact, entities: [...fact.entities] },
  });
  printResult(`remember (graph: ${fact.kind})`, stored);
  if (stored.isError) {
    console.error('\nSMOKE FAILED: graph remember errored.');
    process.exit(1);
  }
  graphMemoryIds.push(firstJson<{ memory_id: string }>(stored).memory_id);
}

const linkedUses = await client.callTool({
  name: 'link',
  arguments: { src: projectName, dst: 'postgres', type: 'uses' },
});
printResult('link (uses)', linkedUses);

const linkedPrefers = await client.callTool({
  name: 'link',
  arguments: { src: projectName, dst: 'bun', type: 'prefers' },
});
printResult('link (prefers)', linkedPrefers);

const entitiesListed = await client.callTool({
  name: 'entities',
  arguments: { query: projectName },
});
printResult('entities', entitiesListed);

const briefing = await client.callTool({
  name: 'build_context',
  arguments: { topic: projectName },
});
printResult('build_context', briefing);

const recalledWithGraph = await client.callTool({
  name: 'recall',
  arguments: { query: `${projectName} storage`, k: 5, include_graph: true },
});
printResult('recall (include_graph)', recalledWithGraph);

await client.close();

// Assert on the id: a near-duplicate from an earlier run may have absorbed
// this run's marker via dedup, but recall must surface the returned id.
if (recalled.isError || !contentText(recalled).includes(memoryId)) {
  console.error('\nSMOKE FAILED: recall did not return the remembered memory.');
  process.exit(1);
}
if (forgotten.isError) {
  console.error('\nSMOKE FAILED: forget errored.');
  process.exit(1);
}
if (contentText(recalledAfterForget).includes(memoryId)) {
  console.error('\nSMOKE FAILED: invalidated memory still recalled.');
  process.exit(1);
}

// ── M2 asserts ──────────────────────────────────────────────────────────

if (linkedUses.isError || linkedPrefers.isError) {
  console.error('\nSMOKE FAILED: link errored.');
  process.exit(1);
}
for (const [label, linked] of [
  ['uses', linkedUses],
  ['prefers', linkedPrefers],
] as const) {
  const output = firstJson<{ kind: string }>(linked);
  if (output.kind !== 'entity_edge') {
    console.error(`\nSMOKE FAILED: link (${label}) did not create an edge.`);
    process.exit(1);
  }
}

if (
  entitiesListed.isError ||
  !contentText(entitiesListed).includes(projectName)
) {
  console.error('\nSMOKE FAILED: entities did not list the smoke project.');
  process.exit(1);
}

if (briefing.isError) {
  console.error('\nSMOKE FAILED: build_context errored.');
  process.exit(1);
}
const briefingBody = firstJson<{
  memories: Array<{ id: string; content: string }>;
  entities: Array<{ name: string }>;
  edges: Array<{ src: string; dst: string; type: string }>;
  linked_memories: Array<{ id: string }>;
}>(briefing);
const briefingMemoryIds = new Set([
  ...briefingBody.memories.map((memory) => memory.id),
  ...briefingBody.linked_memories.map((memory) => memory.id),
]);
if (!graphMemoryIds.some((id) => briefingMemoryIds.has(id))) {
  console.error(
    '\nSMOKE FAILED: build_context briefing misses the smoke memories.'
  );
  process.exit(1);
}
const briefingEntityNames = new Set(
  briefingBody.entities.map((entity) => entity.name)
);
if (
  !briefingEntityNames.has(projectName) ||
  !briefingEntityNames.has('postgres')
) {
  console.error(
    '\nSMOKE FAILED: build_context briefing misses the smoke entities.'
  );
  process.exit(1);
}
const hasSmokeEdge = briefingBody.edges.some(
  (edge) =>
    (edge.src === projectName || edge.dst === projectName) &&
    (edge.type === 'uses' || edge.type === 'prefers')
);
if (!hasSmokeEdge) {
  console.error('\nSMOKE FAILED: build_context briefing misses the edges.');
  process.exit(1);
}

if (recalledWithGraph.isError) {
  console.error('\nSMOKE FAILED: include_graph recall errored.');
  process.exit(1);
}
const graphRecallBody = firstJson<{
  memories: Array<{ id: string; entities?: Array<{ name: string }> }>;
}>(recalledWithGraph);
const enrichedHit = graphRecallBody.memories.find(
  (memory) =>
    memory.id === graphMemoryIds[0] &&
    (memory.entities ?? []).some((entity) => entity.name === projectName)
);
if (!enrichedHit) {
  console.error(
    '\nSMOKE FAILED: include_graph recall did not enrich the hit with its entities.'
  );
  process.exit(1);
}

console.log(
  '\nSMOKE OK: remember -> recall -> forget roundtrip and the knowledge ' +
    'graph flow (entities, link, build_context, include_graph) succeeded.'
);
