import { z } from 'zod';

import type { Client } from '../supabase.client.js';

/**
 * The calling session's standing, as the database states it in one answer:
 * the assurance level of its token, how many verified factors its account
 * has, whether the authorization server opened it for an agent, whether the
 * session still exists (a revoked or signed-out session's token stays valid
 * until it expires, but reaches nothing), and whether it may reach the data
 * at all.
 */
export const sessionAssuranceSchema = z.object({
  aal: z.string(),
  verified_factors: z.number().int().nonnegative(),
  agent: z.boolean(),
  live: z.boolean(),
  complete: z.boolean(),
});

export type SessionAssurance = z.infer<typeof sessionAssuranceSchema>;

/**
 * Asks the database, as the caller, whether this session may reach the data.
 * The same rule the row-level policies apply; asking first lets the endpoint
 * refuse with a reason instead of answering with empty rows. Throws when the
 * database cannot say: a check that fails must never read as a pass.
 */
export const fetchSessionAssurance = async (
  client: Client
): Promise<SessionAssurance> => {
  const { data, error } = await client.rpc('session_assurance');
  if (error) {
    throw new Error(`Failed to check the session: ${error.message}`);
  }
  return sessionAssuranceSchema.parse(data);
};
