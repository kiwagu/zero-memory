import { NextResponse } from 'next/server';

import { buildVersion } from '@/lib/build-version';
import { serverReachability } from '@/lib/server-reachability';

export const dynamic = 'force-dynamic';

/**
 * Readiness of the dashboard itself. "The page loads" is not the same as "the
 * dashboard works": every operation it cannot do against Postgres directly —
 * account deletion, export, budget status — goes to the MCP server over the
 * container network, and that leg has failed in a deployment while every
 * outside check stayed green. Unauthenticated on purpose: it reports only
 * whether the leg answers, never what it holds.
 */
export async function GET() {
  const server = await serverReachability();
  return NextResponse.json(
    { ok: server.reachable, version: buildVersion(), server },
    { status: server.reachable ? 200 : 503 }
  );
}
