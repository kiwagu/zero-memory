/**
 * Re-embeds every stored vector with the current embedding model.
 *
 * An embedding-model change moves all vectors into a NEW space: old vectors are
 * meaningless to the new model, so they must be recomputed or search silently
 * degrades. When the model's dimensionality also changes, run the schema
 * migration that widens the vector columns FIRST, then this re-embed.
 *
 * It recomputes, matching how the app embeds each field:
 *   - memories.embedding      from content            as 'passage'
 *   - memory_chunks.embedding from the overflow windows of long content
 *   - entities.name_embedding from normalized_name    as 'query'
 * (see MemoryService.remember and EntityResolutionService.)
 *
 * The overflow windows are rebuilt here too, and dropped for rows that no
 * longer need any: a model change moves EVERY vector into the new space, and
 * a window left behind would answer queries from the old one.
 *
 * Connection: DB_URL from the environment, else derived from
 * `bunx supabase status -o env` (local stack). Uses the service-role Postgres
 * connection directly, bypassing RLS, to touch every row.
 *
 * Usage: bun scripts/reembed.ts
 */
// Relative import into the package source: this script lives at the repo root,
// which does not depend on @workspace/embedding, so the bare specifier does not
// resolve. The package's own internal imports still resolve from its location.
import {
  E5SmallEmbeddingService,
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

const BATCH = 32;

const main = async (): Promise<void> => {
  const dbUrl = await resolveDbUrl();
  const sql = new Bun.SQL(dbUrl);
  const embedder = new E5SmallEmbeddingService();

  // --- memories: content -> 'passage' -------------------------------------
  const memories = (await sql`
    select id, content from public.memories order by created_at
  `) as { id: string; content: string }[];

  let memoriesUpdated = 0;
  for (let i = 0; i < memories.length; i += BATCH) {
    const slice = memories.slice(i, i + BATCH);
    // One flat batch of segments, then split back per row: a long row
    // contributes two texts, a short one contributes a single head.
    const windows = slice.map((row) => passageWindows(row.content));
    const vectors = await embedder.embed(
      windows.flat().map((window) => window.text),
      'passage'
    );
    let taken = 0;
    for (const [j, row] of slice.entries()) {
      const own = vectors.slice(taken, taken + windows[j]!.length);
      taken += windows[j]!.length;
      await sql`
        update public.memories
        set embedding = ${toVector(own[0]!)}::extensions.vector
        where id = ${row.id}
      `;
      await sql`delete from public.memory_chunks where memory_id = ${row.id}`;
      for (const [ord, embedding] of own.slice(1).entries()) {
        await sql`
          insert into public.memory_chunks (memory_id, ord, char_start, embedding)
          values (
            ${row.id}, ${ord}, ${windows[j]![ord + 1]!.charStart},
            ${toVector(embedding)}::extensions.vector
          )
        `;
      }
      memoriesUpdated += 1;
    }
    console.log(`  memories ${memoriesUpdated}/${memories.length}`);
  }

  // --- entities: normalized_name -> 'query' -------------------------------
  const entities = (await sql`
    select id, normalized_name from public.entities order by created_at
  `) as { id: string; normalized_name: string }[];

  let entitiesUpdated = 0;
  for (let i = 0; i < entities.length; i += BATCH) {
    const slice = entities.slice(i, i + BATCH);
    const vectors = await embedder.embed(
      slice.map((row) => row.normalized_name),
      'query'
    );
    for (const [j, row] of slice.entries()) {
      await sql`
        update public.entities
        set name_embedding = ${toVector(vectors[j]!)}::extensions.vector
        where id = ${row.id}
      `;
      entitiesUpdated += 1;
    }
    console.log(`  entities ${entitiesUpdated}/${entities.length}`);
  }

  await sql.end();

  console.log('\nRe-embed complete.');
  console.log(`  memories re-embedded: ${memoriesUpdated}`);
  console.log(`  entities re-embedded: ${entitiesUpdated}`);
};

await main();
