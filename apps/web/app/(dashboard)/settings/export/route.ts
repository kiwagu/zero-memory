import { memoryFilePath, renderMemoryFile } from '@/lib/markdown-memory';
import { exportMemoriesViaServer } from '@/lib/mcp';
import { createZip, type ZipEntry } from '@/lib/zip';
import { createServerSupabaseClient } from '@/lib/supabase/server';

// Reads the caller's session, so it can never be statically cached.
export const dynamic = 'force-dynamic';

/**
 * Streams the caller's accessible memories as a downloadable ZIP of a Markdown
 * tree — one file per memory under `<scope>/<slug>.md`, superseded/invalidated
 * ones under `archive/`. The memories are read through the server's audited
 * `export_memories` tool (not a direct Postgres select), so this bulk egress is
 * recorded in the audit log; the byte-stable render means an unchanged memory
 * re-exports to an identical file.
 */
export async function GET(request: Request): Promise<Response> {
  const supabase = await createServerSupabaseClient();
  const accessToken = (await supabase.auth.getSession()).data.session
    ?.access_token;
  if (!accessToken) {
    return new Response('Not signed in.', { status: 401 });
  }

  // Optional `?scope=` (repeatable) restricts the export to those scopes — used
  // by the per-scope download on the scopes page.
  const scopes = new URL(request.url).searchParams.getAll('scope');

  let items;
  try {
    ({ items } = await exportMemoriesViaServer(
      accessToken,
      scopes.length > 0 ? scopes : undefined
    ));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return new Response(`Export failed: ${message}`, { status: 500 });
  }

  const entries: ZipEntry[] = items.map((memory) => ({
    path: memoryFilePath(memory),
    content: renderMemoryFile(memory),
  }));
  const zip = createZip(entries);

  // UTC timestamp in the filename so successive exports are distinct and sort
  // chronologically; a single-scope export names the scope too.
  const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
  const scopeTag =
    scopes.length === 1 ? `-${scopes[0]!.replace(/[^a-z0-9._-]/gi, '_')}` : '';
  const filename = `zm-memory-export${scopeTag}-${stamp}.zip`;

  return new Response(zip as BodyInit, {
    headers: {
      'content-type': 'application/zip',
      'content-disposition': `attachment; filename="${filename}"`,
      // Lets the client render a determinate download progress bar as it reads
      // the streamed body.
      'content-length': String(zip.length),
      'cache-control': 'no-store',
      'x-memory-count': String(items.length),
    },
  });
}
