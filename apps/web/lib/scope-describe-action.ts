'use server';

import { describeScopeViaServer } from './mcp';
import { createServerSupabaseClient } from './supabase/server';

export type DescribeResult =
  { ok: true; description: string } | { ok: false; error: string };

/**
 * Model-written scope description, drafted by the MCP server (which holds
 * the LLM key) as the signed-in user. The text comes back to the edit form —
 * nothing is saved until the user confirms.
 */
export async function generateScopeDescription(
  scope: string
): Promise<DescribeResult> {
  const supabase = await createServerSupabaseClient();
  const accessToken = (await supabase.auth.getSession()).data.session
    ?.access_token;
  if (!accessToken) {
    return { ok: false, error: 'Not signed in.' };
  }
  try {
    const description = await describeScopeViaServer(accessToken, scope);
    return { ok: true, description };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}
