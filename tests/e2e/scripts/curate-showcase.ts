/**
 * Curates the showcase corpus the documentation screenshots are taken against.
 *
 * WHY IT EXISTS. The dashboard is only worth photographing with real content —
 * invented filler looks invented, and a screen full of "Lorem" says nothing
 * about what the product does. But the maintainer's working corpus is exactly
 * what must never be photographed: it carries absolute paths, private planning
 * markers, other projects' names and real people. So this script READS the
 * local corpus, keeps only what is safe and self-explanatory, and writes the
 * survivors to a reviewable JSON file — which is what the demo seed loads.
 *
 * The output is committed on purpose: a curated set that a human has read is
 * safer than a filter re-run against a corpus that has since grown.
 *
 *   bun scripts/curate-showcase.ts            # rewrite the curated set
 *   bun scripts/curate-showcase.ts --dry-run  # print what would be kept
 *
 * Read-only against the source cluster. It never writes there.
 */
import { spawnSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** The local cluster holding the corpus this project accumulated. */
const SOURCE_CONTAINER = process.env.ZM_SOURCE_DB ?? 'supabase_db_zero-memory';

const OUTPUT = resolve(
  fileURLToPath(import.meta.url),
  '../../fixtures/showcase-corpus.json'
);

/**
 * Content that must never reach a committed screenshot. Deliberately broad:
 * a false positive costs one candidate out of hundreds, a false negative
 * publishes something private.
 */
const FORBIDDEN = [
  'refs/', // the private planning tree
  '/home/', // absolute paths from any machine
  '~/',
  'worktree',
  '.mdc', // internal rule files
  'author/graph', // another project's surface
];

/** Same, as patterns rather than substrings. */
const FORBIDDEN_PATTERNS = [
  /ADR[- ]?\d+/i, // decision-record numbers
  /\b(proflow|undb|ulearn)\b/i, // other projects
  /kiwagu/i, // the maintainer's handle
  /[a-z0-9._-]+@[a-z0-9.-]+\.[a-z]{2,}/i, // addresses
  /\b[0-9a-f]{7,40}\b/, // commit hashes
  /\b(mem|usr|ses|org)_[a-z0-9]/i, // entity ids
  /localhost:|zm\.local/i, // machine-local hosts
  /\n/, // multi-paragraph notes read badly on a card
  // Judgements about other products: fine in a private corpus, needlessly
  // combative printed on a page that documents our own.
  /\b(mem0|zep|graphiti|cognee|basic-memory|letta|memgpt)\b/i,
];

/** How many of each kind to keep — enough to fill a feed, few enough to read. */
const QUOTA: Record<string, number> = {
  decision: 8,
  convention: 6,
  gotcha: 6,
  fact: 6,
  reference: 3,
};

interface Candidate {
  kind: string;
  content: string;
}

const isSafe = (content: string): boolean =>
  !FORBIDDEN.some((needle) => content.toLowerCase().includes(needle)) &&
  !FORBIDDEN_PATTERNS.some((pattern) => pattern.test(content));

/** Reads candidates out of the source cluster, newest first within each kind. */
function readCandidates(): Candidate[] {
  const sql = `
    select kind || E'\\t' || replace(content, E'\\n', ' ')
    from public.memories
    where invalidated_at is null
      and (scope::text like '%zero_memory%' or scope::text like '%.core')
      and char_length(content) between 90 and 320
      and kind in (${Object.keys(QUOTA)
        .map((kind) => `'${kind}'`)
        .join(', ')})
    order by kind, created_at desc
  `;
  const result = spawnSync(
    'docker',
    ['exec', SOURCE_CONTAINER, 'psql', '-U', 'postgres', '-t', '-A', '-c', sql],
    { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }
  );
  if (result.status !== 0) {
    throw new Error(
      `could not read ${SOURCE_CONTAINER}: ${result.stderr.trim()}`
    );
  }
  return result.stdout
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const [kind, ...rest] = line.split('\t');
      return { kind: kind ?? '', content: rest.join('\t').trim() };
    })
    .filter((row) => row.kind && row.content);
}

const dryRun = process.argv.includes('--dry-run');
const candidates = readCandidates();

const kept: Candidate[] = [];
const perKind = new Map<string, number>();
for (const candidate of candidates) {
  const quota = QUOTA[candidate.kind] ?? 0;
  const taken = perKind.get(candidate.kind) ?? 0;
  if (taken >= quota || !isSafe(candidate.content)) {
    continue;
  }
  // Near-duplicates make a feed look padded; one sentence-opening is enough
  // to catch restatements of the same fact.
  const opening = candidate.content.slice(0, 40).toLowerCase();
  if (kept.some((row) => row.content.slice(0, 40).toLowerCase() === opening)) {
    continue;
  }
  kept.push(candidate);
  perKind.set(candidate.kind, taken + 1);
}

const summary = [...perKind.entries()]
  .map(([kind, count]) => `${kind} ${count}`)
  .join(' · ');

if (dryRun) {
  for (const row of kept) {
    process.stdout.write(`[${row.kind}] ${row.content}\n\n`);
  }
  process.stdout.write(
    `\n${kept.length} of ${candidates.length} candidates: ${summary}\n`
  );
} else {
  writeFileSync(OUTPUT, `${JSON.stringify(kept, null, 2)}\n`);
  process.stdout.write(
    `\n✓ Curated ${kept.length} of ${candidates.length} candidates: ${summary}\n` +
      `  → ${OUTPUT}\n  Read it before committing: these become public images.\n\n`
  );
}
