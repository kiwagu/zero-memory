/**
 * Retro-scan of the memory corpus for secrets. REPORT-ONLY: the store is
 * add-only, so this script never mutates a row — it prints every hit and
 * leaves the decision (forget / supersede with a redacted version) to the
 * owner.
 *
 * Two detector tiers:
 *   - the write-path detectors (known credential formats) — anything they hit
 *     would be REJECTED by today's content guard;
 *   - loose scan-only heuristics (password/key-assignment phrasing) — too
 *     false-positive-prone to block writes, but useful leads in a report a
 *     human reviews.
 *
 *   SUPABASE_URL=… SUPABASE_SERVICE_ROLE_KEY=… bun scripts/scan-secrets.ts
 */
// Relative imports into package sources: this script lives at the repo root,
// which does not depend on the workspace packages, so bare specifiers do not
// resolve here.
import { detectSecrets } from '../packages/memory/src/content-guard.js';
import { createServiceRoleClient } from '../packages/persistence/src/index.js';

const PAGE = 1000;

/**
 * Scan-only heuristics. A match is a LEAD, not a verdict: "password rotation
 * policy" style prose is filtered by the stopword list, but review is human.
 */
const LOOSE_HEURISTICS: Array<{ id: string; pattern: RegExp }> = [
  {
    id: 'password-mention',
    pattern:
      /\b(?:password|passwd|passphrase)\s+(?:is\s+)?['"`«]?(?!(?:rotation|policy|manager|reset|change|login|field|column|hash|hashing|grant|protected|required|strength|expiry|prompt|auth)\b)[\w!@#$%^&*.-]{4,}/i,
  },
  {
    id: 'key-assignment',
    pattern:
      /\b(?:api[_-]?key|secret|token|password|passwd)\s*[:=]\s*['"`]?[\w./+-]{8,}/i,
  },
];

interface Hit {
  memory_id: string;
  scope: string;
  field: string;
  detector: string;
  tier: 'write-path' | 'loose';
  sample: string;
  invalidated: boolean;
}

type Row = {
  id: string;
  scope: string;
  content: string;
  content_original: string | null;
  source: Record<string, unknown> | null;
  invalidated_at: string | null;
};

const mask = (match: string): string => `${match.slice(0, 6)}…`;

const stringLeaves = (
  value: unknown,
  path: string
): Array<{ path: string; text: string }> => {
  if (typeof value === 'string') {
    return [{ path, text: value }];
  }
  if (Array.isArray(value)) {
    return value.flatMap((item, index) =>
      stringLeaves(item, `${path}[${index}]`)
    );
  }
  if (value !== null && typeof value === 'object') {
    return Object.entries(value).flatMap(([key, nested]) =>
      stringLeaves(nested, `${path}.${key}`)
    );
  }
  return [];
};

const scanRow = (row: Row): Hit[] => {
  const fields = [
    { path: 'content', text: row.content },
    ...(row.content_original
      ? [{ path: 'content_original', text: row.content_original }]
      : []),
    ...(row.source ? stringLeaves(row.source, 'source') : []),
  ];
  const hits: Hit[] = [];
  for (const { path, text } of fields) {
    for (const finding of detectSecrets(text, path)) {
      hits.push({
        memory_id: row.id,
        scope: row.scope,
        field: finding.field,
        detector: finding.detector,
        tier: 'write-path',
        sample: finding.sample,
        invalidated: row.invalidated_at !== null,
      });
    }
    for (const heuristic of LOOSE_HEURISTICS) {
      const match = heuristic.pattern.exec(text);
      if (match) {
        hits.push({
          memory_id: row.id,
          scope: row.scope,
          field: path,
          detector: heuristic.id,
          tier: 'loose',
          sample: mask(match[0]),
          invalidated: row.invalidated_at !== null,
        });
      }
    }
  }
  return hits;
};

const client = createServiceRoleClient();
const hits: Hit[] = [];
let scanned = 0;

for (let offset = 0; ; offset += PAGE) {
  const { data, error } = await client
    .from('memories')
    .select('id, scope, content, content_original, source, invalidated_at')
    .order('id')
    .range(offset, offset + PAGE - 1);
  if (error) {
    throw new Error(
      `memories page failed at offset ${offset}: ${error.message}`
    );
  }
  const rows = (data ?? []) as Row[];
  scanned += rows.length;
  for (const row of rows) {
    hits.push(...scanRow(row));
  }
  if (rows.length < PAGE) {
    break;
  }
}

const summary = {
  scanned,
  hits: hits.length,
  writePathHits: hits.filter((hit) => hit.tier === 'write-path').length,
  looseHits: hits.filter((hit) => hit.tier === 'loose').length,
};
process.stdout.write(
  `${JSON.stringify({ summary, findings: hits }, null, 2)}\n`
);
