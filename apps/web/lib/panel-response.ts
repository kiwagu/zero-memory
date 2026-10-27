import { NextResponse } from 'next/server';

import type { PanelKind } from '@/lib/panel-chain';

/**
 * How the panel API answers: the view when there is one; 404 when the viewer
 * may not read it or it does not exist (indistinguishable on purpose); 500
 * when reading failed, so the panel offers a retry instead of "not available".
 */
export async function panelResponse(
  kind: PanelKind,
  load: () => Promise<{ title: string } | null>
): Promise<Response> {
  let view: { title: string } | null;
  try {
    view = await load();
  } catch (error) {
    // The viewer gets a retry; the cause stays on the server.
    console.error(`panel ${kind}:`, error);
    return NextResponse.json({ error: 'internal' }, { status: 500 });
  }
  if (!view) {
    return NextResponse.json({ error: 'not_found' }, { status: 404 });
  }
  return NextResponse.json(
    { kind, title: view.title, view },
    { headers: { 'Cache-Control': 'no-store' } }
  );
}
