/**
 * Backfills the overflow embedding windows of memories written before them.
 *
 * The embedding model truncates its input to a fixed window without saying so,
 * which leaves every long memory searchable by its opening alone. New writes
 * store as many overflow windows as the content needs; the rows already in the
 * store need this pass to get theirs.
 *
 * Primary vectors are NOT touched: `memories.embedding` is still the whole
 * content handed to the same model, so it already means what it meant. That
 * makes this pass additive — it can only give a long memory a better distance,
 * never move an existing one.
 *
 * Re-runnable by construction: it compares the number of windows each memory
 * NEEDS against the number it HAS and rebuilds only where they differ, so a
 * second run is a no-op, an interrupted run resumes, and a memory whose
 * content later changed is corrected rather than left half-covered.
 *
 * Connection: DB_URL from the environment, else derived from
 * `bunx supabase status -o env` (local stack). Uses the service-role Postgres
 * connection directly, bypassing RLS, to touch every row.
 *
 * Usage: bun scripts/backfill-chunk-embeddings.ts [--dry-run]
 */
// Relative import into the package source: this script lives at the repo root,
// which does not depend on @workspace/embedding, so the bare specifier does not
// resolve. The package's own internal imports still resolve from its location.
import {
  E5SmallEmbeddingService,
  overflowWindowCount,
  passageCoverageShortfall,
  passageWindows,
} from '../packages/embedding/src/index.js';

const resolveDbUrl = async (): Promise<string> => {
  if (process.env.DB_URL) {
    return process.env.DB_URL;
  }
  const status = await Bun.$`bunx supabase status -o env`.text();
  const match = status.match(/^DB_URL="?([^"\n]+)"?/m);
  if (!match) {
    throw new Error(
      'DB_URL not set and not found in `supabase status` output.'
    );
  }
  return match[1]!;
};

const toVector = (values: number[]): string => `[${values.join(',')}]`;

const BATCH = 16;

const main = async (): Promise<void> => {
  const dryRun = process.argv.includes('--dry-run');
  const dbUrl = await resolveDbUrl();
  const sql = new Bun.SQL(dbUrl);

  // Invalidated rows are excluded on purpose: search never returns them.
  const rows = (await sql`
    select
      m.id,
      m.content,
      coalesce(c.window_count, 0)::int as stored_windows
    from public.memories as m
    left join (
      select memory_id, count(*) as window_count
      from public.memory_chunks
      group by memory_id
    ) as c on c.memory_id = m.id
    where m.invalidated_at is null
    order by m.created_at
  `) as { id: string; content: string; stored_windows: number }[];

  const pending = rows.filter(
    (row) => overflowWindowCount(row.content) !== row.stored_windows
  );
  const shortfalls = rows.filter(
    (row) => passageCoverageShortfall(row.content) > 0
  );

  console.log(`live memories: ${rows.length}`);
  console.log(`rows whose windows are missing or stale: ${pending.length}`);
  // Never a silent cap: a record too long for the window budget is named here
  // rather than quietly losing its ending.
  if (shortfalls.length > 0) {
    console.log(
      `\nrows too long for the window budget — their ENDING stays unsearchable:`
    );
    for (const row of shortfalls) {
      console.log(
        `  ${row.id} (${row.content.length} chars, ` +
          `${passageCoverageShortfall(row.content)} uncovered)`
      );
    }
  }
  if (dryRun) {
    console.log('\n--dry-run: nothing written.');
    await sql.end();
    return;
  }

  const embedder = new E5SmallEmbeddingService();
  let rebuilt = 0;
  let windows = 0;
  for (let i = 0; i < pending.length; i += BATCH) {
    const slice = pending.slice(i, i + BATCH);
    // Only the OVERFLOW windows are embedded — the primary vector stands.
    const overflow = slice.map((row) => passageWindows(row.content).slice(1));
    const vectors = await embedder.embed(
      overflow.flat().map((window) => window.text),
      'passage'
    );
    let taken = 0;
    for (const [j, row] of slice.entries()) {
      const own = vectors.slice(taken, taken + overflow[j]!.length);
      taken += overflow[j]!.length;
      await sql`delete from public.memory_chunks where memory_id = ${row.id}`;
      for (const [ord, embedding] of own.entries()) {
        await sql`
          insert into public.memory_chunks (memory_id, ord, char_start, embedding)
          values (
            ${row.id}, ${ord}, ${overflow[j]![ord]!.charStart},
            ${toVector(embedding)}::extensions.vector
          )
        `;
      }
      rebuilt += 1;
      windows += own.length;
    }
    console.log(`  rebuilt ${rebuilt}/${pending.length}`);
  }

  await sql.end();

  console.log('\nBackfill complete.');
  console.log(`  memories rebuilt: ${rebuilt}`);
  console.log(`  overflow windows written: ${windows}`);
};

await main();
