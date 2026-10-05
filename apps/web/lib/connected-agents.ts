import { z } from 'zod';

import { createAdminClient } from './supabase/admin';

/**
 * One OAuth client the person approved and has not revoked, as the database
 * lists it: its name (a client may register without one), the return address
 * the person approved, when, when one of its sessions was last active (null
 * when it holds none) and how many sessions it holds.
 */
export const connectedAgentSchema = z.object({
  client_id: z.string(),
  client_name: z.string().nullable(),
  redirect_uri: z.string(),
  granted_at: z.string(),
  last_used_at: z.string().nullable(),
  sessions: z.number().int().nonnegative(),
});

export type ConnectedAgent = z.infer<typeof connectedAgentSchema>;

/** What the dashboard sends to revoke one agent. */
export const revokeConnectedAgentRequestSchema = z.object({
  clientId: z.string().min(1).max(200),
});

/** What revoking one agent did. */
export const revokeConnectedAgentResultSchema = z.object({
  revoked: z.boolean(),
  sessions_ended: z.number().int().nonnegative(),
});

export type RevokeConnectedAgentResult = z.infer<
  typeof revokeConnectedAgentResultSchema
>;

const serviceClient = () => {
  const admin = createAdminClient();
  if (!admin) {
    throw new Error(
      'Connected agents need SUPABASE_SERVICE_ROLE_KEY on the dashboard server.'
    );
  }
  return admin;
};

/**
 * The agents the person approved, newest use first. The consents and agent
 * sessions are server-only records, so the dashboard server reads them with
 * the service role, for the verified caller only: the subject id comes from
 * the session, never from the request. An agent's session never gets here,
 * because the dashboard refuses agent sessions before any page renders.
 */
export async function readConnectedAgents(
  subjectId: string
): Promise<ConnectedAgent[]> {
  const { data, error } = await serviceClient().rpc('connected_agents', {
    p_user_id: subjectId,
  });
  if (error) {
    throw new Error(`Failed to list connected agents: ${error.message}`);
  }
  return z.array(connectedAgentSchema).parse(data);
}

/**
 * Withdraws the person's approval of one client and ends every session
 * minted for it, in one database step.
 */
export async function revokeConnectedAgent(
  subjectId: string,
  clientId: string
): Promise<RevokeConnectedAgentResult> {
  const { data, error } = await serviceClient().rpc('revoke_connected_agent', {
    p_user_id: subjectId,
    p_client_id: clientId,
  });
  if (error) {
    throw new Error(`Failed to revoke the agent: ${error.message}`);
  }
  return revokeConnectedAgentResultSchema.parse(data);
}
