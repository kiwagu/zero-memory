/**
 * Search-quality eval: replays the ROI-benchmark holdout questions against
 * `search_memories` and reports hit@K and MRR of each probe's ground-truth
 * memory, plus the share of reinforced rows in the returned top-K — then
 * replays the brief-holdout probes against `build_context` and reports the
 * pack hit-rate (expected memories present) and the junk share (anti-probe
 * memories present). Run it before and after a ranking or recipe change
 * (same stack, same probes) — the deltas are the regression check.
 *
 * Connection: SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY from the environment
 * (service role bypasses RLS so every owner's probes replay). Embeddings are
 * computed locally with the same model the server uses.
 *
 * Usage: SUPABASE_URL=… SUPABASE_SERVICE_ROLE_KEY=… bun scripts/search-eval.ts
 */
import { spawnSync } from 'node:child_process';

import { createClient } from '@supabase/supabase-js';

// Relative import into the package source: this script lives at the repo root,
// which does not depend on @workspace/embedding, so the bare specifier does
// not resolve. The package's own internal imports resolve from its location.
import { E5SmallEmbeddingService } from '../packages/embedding/src/index.js';

const K = 10;

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

const embedder = new E5SmallEmbeddingService();

/** Ids of memories that are still live (invalidated probes poison metrics). */
const liveMemoryIds = async (ids: string[]): Promise<Set<string>> => {
  if (ids.length === 0) {
    return new Set();
  }
  const { data, error } = await client
    .from('memories')
    .select('id')
    .in('id', [...new Set(ids)])
    .is('invalidated_at', null);
  if (error) {
    throw new Error(`live-memory check failed: ${error.message}`);
  }
  return new Set((data ?? []).map((row) => row.id as string));
};

// ── ROI holdout: search_memories ────────────────────────────────────────────

// Probes whose ground-truth memory is still live: a probe over an
// invalidated memory cannot be found by design and would poison the metric.
const { data: probeRows, error: probeError } = await client
  .from('roi_probes')
  .select('id, question, source_memory_id')
  .is('retired_at', null);
if (probeError) {
  throw new Error(`probe load failed: ${probeError.message}`);
}
const live = await liveMemoryIds(
  (probeRows ?? []).map((row) => row.source_memory_id as string)
);
const probes = (probeRows ?? []).filter((row) =>
  live.has(row.source_memory_id as string)
);
if (probes.length === 0) {
  throw new Error('no live probes found — run benchmark_memory first');
}

const { data: reinforcedRows, error: reinforcedError } = await client
  .from('memory_reinforcement')
  .select('memory_id');
if (reinforcedError) {
  throw new Error(`reinforcement read failed: ${reinforcedError.message}`);
}
const reinforced = new Set(
  (reinforcedRows ?? []).map((row) => row.memory_id as string)
);

const embeddings = await embedder.embed(
  probes.map((probe) => String(probe.question)),
  'query'
);

let hits = 0;
let mrrSum = 0;
let reinforcedShareSum = 0;
const misses: string[] = [];
for (const [index, probe] of probes.entries()) {
  const { data: results, error } = await client.rpc('search_memories', {
    query_embedding: JSON.stringify(embeddings[index]),
    query_text: String(probe.question),
    k: K,
  });
  if (error) {
    throw new Error(`search failed for ${probe.id}: ${error.message}`);
  }
  const ids = ((results ?? []) as Array<{ id: string }>).map((row) => row.id);
  const rank = ids.indexOf(probe.source_memory_id as string) + 1;
  if (rank > 0) {
    hits += 1;
    mrrSum += 1 / rank;
  } else {
    misses.push(probe.id as string);
  }
  if (ids.length > 0) {
    reinforcedShareSum +=
      ids.filter((id) => reinforced.has(id)).length / ids.length;
  }
}

// ── Brief holdout: build_context ─────────────────────────────────────────────

interface BriefProbeRow {
  id: string;
  topic: string;
  scopes: string[] | null;
  memory_id: string;
  expect: 'present' | 'absent';
}

interface BriefGroup {
  topic: string;
  scopes: string[] | null;
  present: BriefProbeRow[];
  absent: BriefProbeRow[];
}

const { data: briefRows, error: briefError } = await client
  .from('brief_probes')
  .select('id, topic, scopes, memory_id, expect')
  .is('retired_at', null);
if (briefError) {
  throw new Error(`brief-probe load failed: ${briefError.message}`);
}

// Both polarities need a live target: a 'present' probe over an invalidated
// memory cannot be found by design, an 'absent' one is trivially satisfied.
const briefLive = await liveMemoryIds(
  (briefRows ?? []).map((row) => row.memory_id as string)
);
const briefProbes = ((briefRows ?? []) as BriefProbeRow[]).filter((row) =>
  briefLive.has(row.memory_id)
);
const briefSkipped = (briefRows ?? []).length - briefProbes.length;

// A probe group is one build_context replay: same topic, same scope filter.
const groups = new Map<string, BriefGroup>();
for (const row of briefProbes) {
  const key = `${JSON.stringify(row.scopes ?? null)}\u0000${row.topic}`;
  const group = groups.get(key) ?? {
    topic: row.topic,
    scopes: row.scopes,
    present: [],
    absent: [],
  };
  group[row.expect].push(row);
  groups.set(key, group);
}

const briefGroups = [...groups.values()];
const topicEmbeddings = await embedder.embed(
  briefGroups.map((group) => group.topic),
  'query'
);

let presentTotal = 0;
let presentHits = 0;
let absentTotal = 0;
let absentInPack = 0;
const briefMisses: string[] = [];
const junk: string[] = [];
for (const [index, group] of briefGroups.entries()) {
  // Probes are briefing expectations, so the replay runs in briefing mode:
  // the recency leg fills and the rules-promoted hard filter applies —
  // exactly what the session/task hooks request.
  const { data: pack, error } = await client.rpc('build_context', {
    topic_embedding: JSON.stringify(topicEmbeddings[index]),
    topic_text: group.topic,
    briefing: true,
    ...(group.scopes ? { scope_filter: group.scopes } : {}),
  });
  if (error) {
    throw new Error(
      `build_context failed for "${group.topic}": ${error.message}`
    );
  }
  // The knowledge legs of the pack. `recent` appears with the recency slice;
  // open_loops stay out — loops are lifecycle reminders, not ranked knowledge.
  const result = pack as {
    memories?: Array<{ id: string }>;
    linked_memories?: Array<{ id: string }>;
    recent?: Array<{ id: string }>;
  };
  const packIds = new Set(
    [
      ...(result.memories ?? []),
      ...(result.linked_memories ?? []),
      ...(result.recent ?? []),
    ].map((memory) => memory.id)
  );
  for (const probe of group.present) {
    presentTotal += 1;
    if (packIds.has(probe.memory_id)) {
      presentHits += 1;
    } else {
      briefMisses.push(probe.id);
    }
  }
  for (const probe of group.absent) {
    absentTotal += 1;
    if (packIds.has(probe.memory_id)) {
      absentInPack += 1;
      junk.push(probe.id);
    }
  }
}

const ratio = (numerator: number, denominator: number): number | null =>
  denominator > 0 ? Number((numerator / denominator).toFixed(3)) : null;

// Stable-keyed measures, kept separate from the human-facing report below:
// these land in public.eval_runs and become a time series, so a renamed key
// silently breaks comparability with every earlier run.
const searchMetrics = {
  k: K,
  probes: probes.length,
  hits,
  hit_rate: ratio(hits, probes.length),
  mrr: Number((mrrSum / probes.length).toFixed(3)),
  reinforced_rows: reinforced.size,
  reinforced_share_topk: Number(
    (reinforcedShareSum / probes.length).toFixed(3)
  ),
};
const briefMetrics = {
  groups: briefGroups.length,
  probes: briefProbes.length,
  skipped_dead: briefSkipped,
  present_total: presentTotal,
  present_hits: presentHits,
  hit_rate: ratio(presentHits, presentTotal),
  absent_total: absentTotal,
  absent_in_pack: absentInPack,
  junk_share: ratio(absentInPack, absentTotal),
};

process.stdout.write(
  `${JSON.stringify(
    {
      // The stored metrics plus the id lists that only help a human reading
      // this run — which probe missed, which anti-probe leaked into a pack.
      search: { ...searchMetrics, misses },
      brief: { ...briefMetrics, misses: briefMisses, junk },
    },
    null,
    2
  )}\n`
);

// Persist the run — deliberately AFTER the report is on stdout. The replay
// above costs real embedding work; if the store rejects the row, the numbers
// this run produced must still reach whoever asked for them.
const corpusSize = await client
  .from('memories')
  .select('*', { count: 'exact', head: true })
  .is('invalidated_at', null);
if (corpusSize.error) {
  throw new Error(`Failed to size the corpus: ${corpusSize.error.message}`);
}

// What was measured. A runner outside a git checkout records nothing rather
// than a plausible-looking guess — a wrong version label would poison exactly
// the before/after comparison these rows exist for.
const revision = spawnSync('git', ['rev-parse', '--short', 'HEAD'], {
  encoding: 'utf8',
});
const engineVersion =
  revision.status === 0 ? revision.stdout.trim() || null : null;

const { error: storeError } = await client.from('eval_runs').insert([
  {
    harness: 'roi',
    metrics: searchMetrics,
    corpus_size: corpusSize.count ?? 0,
    engine_version: engineVersion,
  },
  {
    harness: 'brief',
    metrics: briefMetrics,
    corpus_size: corpusSize.count ?? 0,
    engine_version: engineVersion,
  },
]);
if (storeError) {
  throw new Error(`Failed to store the eval run: ${storeError.message}`);
}
