import { z } from 'zod';

/**
 * `delete_account` — erase the caller's own account and everything the ownership
 * map attributes to it (memories, entities, edges, links, per-user operational
 * rows), sever surviving references others hold into that data, and remove the
 * profile and auth principal. Irreversible and self-only: the subject is the
 * authenticated caller resolved server-side from the request context — this tool
 * takes no subject, so a caller can never target another account. Dispatched as
 * a COMMAND so the bulk erasure is recorded in the audit log.
 */
export const deleteAccountInputSchema = z.object({});
export type DeleteAccountInput = z.infer<typeof deleteAccountInputSchema>;

/** Result of the erasure cascade — the counts it removed, for the audit trail. */
export const deleteAccountOutputSchema = z.object({
  /** The erased account's domain id (`usr_`). */
  subject: z.string(),
  /** Whether an auth principal was found and removed (false on a repeat call). */
  auth_deleted: z.boolean(),
  memories: z.number().int().nonnegative(),
  entities: z.number().int().nonnegative(),
});
export type DeleteAccountOutput = z.infer<typeof deleteAccountOutputSchema>;
