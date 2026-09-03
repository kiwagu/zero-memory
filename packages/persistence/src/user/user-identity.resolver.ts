import type { Client } from '../supabase.client.js';

/**
 * Reads one profile's `usr_` id for an auth uuid. Used at request setup
 * (mcp-http / mcp-stdio), before an execution context exists, so the caller
 * passes an explicit client. The domain columns now store `usr_` directly, so
 * this is the only auth-uuid -> usr_ translation the runtime needs.
 */
export const fetchUserEntityId = async (
  client: Client,
  authUserId: string
): Promise<string> => {
  const { data, error } = await client
    .from('profiles')
    .select('id')
    .eq('user_id', authUserId)
    .maybeSingle();
  if (error) {
    throw new Error(
      `Failed to resolve profile for ${authUserId}: ${error.message}`
    );
  }
  if (!data) {
    throw new Error(`No profile row for auth user ${authUserId}.`);
  }
  return data.id;
};
