import { z } from 'zod';

/**
 * How many characters of one tool result a client shows inline. Past its own
 * line a client stops showing the result and saves it to a file the agent has
 * to dig through instead; Claude Code draws that line near 50,000 characters
 * for MCP results. The default stays well below it, so the footer and a
 * growing store still fit.
 *
 * A client can say where its own line is (`max_chars`), and that answer
 * outranks the default for the rest of its session.
 */
export const RESULT_BUDGET = {
  defaultChars: 30_000,
  minChars: 4_000,
  maxChars: 400_000,
} as const;

/**
 * The client's own inline limit, as the agent reports it. Optional feedback,
 * not a tuning knob to probe with: one report holds for the rest of the
 * session.
 */
export const maxCharsSchema = z
  .number()
  .int()
  .min(RESULT_BUDGET.minChars)
  .max(RESULT_BUDGET.maxChars)
  .optional()
  .describe(
    'Optional feedback: the most characters your client shows inline in one ' +
      'tool result. Pass it when a result came back too large (saved to a ' +
      'file, or refused for its size): ZM fits this result, and every later ' +
      'one in this session, to it. Without it a result is held to ' +
      `${RESULT_BUDGET.defaultChars.toLocaleString('en-US')} characters, and ` +
      'what was cut is named in `fit`.'
  );

/** Where the budget a result was fitted to came from. */
export const resultFitSourceSchema = z.enum([
  /** The server's default. */
  'default',
  /** `max_chars` on this call. */
  'call',
  /** `max_chars` an earlier call of this session reported. */
  'session',
]);
export type ResultFitSource = z.infer<typeof resultFitSourceSchema>;

/**
 * Present on a read result that was cut to fit, or that answers a call
 * reporting `max_chars`. It says how large the result was, what it was held
 * to, and what was left out, so the agent can page for the rest instead of
 * mistaking a cut list for the whole one.
 */
export const resultFitSchema = z.object({
  /** The characters the result was held to. */
  budget: z.number().int().positive(),
  source: resultFitSourceSchema,
  /** The result's size before fitting, in characters. */
  chars: z.number().int().nonnegative(),
  /** Its size as delivered. */
  delivered: z.number().int().nonnegative(),
  /** Rows left out, per list. Empty when nothing was dropped. */
  omitted: z.record(z.string(), z.number().int().positive()).default({}),
  /** Memories whose content was shortened (marked `truncated`). */
  clipped: z.number().int().nonnegative().default(0),
});
export type ResultFit = z.infer<typeof resultFitSchema>;
