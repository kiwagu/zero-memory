import { NextResponse } from 'next/server';

import { isPanelId, isPanelKind } from '@/lib/panel-chain';
import { createServerSupabaseClient } from '@/lib/supabase/server';
import { loadCardView } from '@/lib/views/card.view';
import { loadEntityView } from '@/lib/views/entity.view';
import { loadMemoryView } from '@/lib/views/memory.view';

/**
 * The data behind one panel of the chain: exactly what the resource's own page
 * shows, read under the viewer's session so row-level security decides. A
 * resource the viewer may not read is indistinguishable from one that does not
 * exist.
 */
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ kind: string; id: string }> }
) {
  const { kind, id } = await params;
  const notFound = () =>
    NextResponse.json({ error: 'not_found' }, { status: 404 });
  if (!isPanelKind(kind) || !isPanelId(kind, id)) {
    return notFound();
  }

  const supabase = await createServerSupabaseClient();
  const { data } = await supabase.auth.getClaims();
  if (!data?.claims) {
    return NextResponse.json({ error: 'unauthenticated' }, { status: 401 });
  }

  const view =
    kind === 'memory'
      ? await loadMemoryView(id)
      : kind === 'card'
        ? await loadCardView(id)
        : await loadEntityView(id);
  if (!view) {
    return notFound();
  }
  return NextResponse.json(
    { kind, title: view.title, view },
    { headers: { 'Cache-Control': 'no-store' } }
  );
}
