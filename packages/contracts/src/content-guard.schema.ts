import { z } from 'zod';

/**
 * Stable error-code prefix for a write rejected by the content guard. Clients
 * (agents, import tooling, tests) match on this prefix rather than on the
 * human-readable remainder of the message.
 */
export const SECRET_CONTENT_REJECTED = 'secret_content_rejected';

/** Known secret formats the deterministic content guard detects. */
export const secretDetectorIdSchema = z.enum([
  'pem-private-key',
  'github-token',
  'aws-access-key-id',
  'slack-token',
  'jwt',
  'url-credentials',
  'anthropic-api-key',
  'openai-api-key',
  'stripe-api-key',
  'google-api-key',
]);
export type SecretDetectorId = z.infer<typeof secretDetectorIdSchema>;

/**
 * One secret hit: which detector fired, in which guarded field (`content`,
 * `verbatim`, or a `source.<key>` path), and a masked sample safe to echo
 * back — never the secret itself.
 */
export const secretFindingSchema = z.object({
  detector: secretDetectorIdSchema,
  field: z.string().min(1),
  sample: z.string().min(1),
});
export type SecretFinding = z.infer<typeof secretFindingSchema>;

/**
 * Renders the typed rejection message for a guarded write. The message never
 * contains the matched secret — only the detector name and a masked sample.
 */
export const secretContentRejectedMessage = (finding: SecretFinding): string =>
  `${SECRET_CONTENT_REJECTED}: ${finding.field} contains what looks like a ` +
  `secret (${finding.detector}, "${finding.sample}"). Memories must never ` +
  'store secrets or credentials — rephrase the fact without the secret value.';
