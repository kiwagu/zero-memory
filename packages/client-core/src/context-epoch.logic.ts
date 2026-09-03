/**
 * Context epochs: the client-agnostic notion of "the window the agent can
 * still see".
 *
 * A briefing hook delivers text into the conversation transcript, and the
 * transcript is exactly what compaction discards. So "has this session already
 * been told X" is the wrong question — the right one is "has it been told X in
 * the CURRENT window". A session lives through several such windows, and the
 * client announces each boundary on its session-start event: Claude Code
 * re-fires SessionStart with `source: "compact"` the moment a compaction lands
 * (measured: the hook runs within the same second, without waiting for the
 * user's next prompt).
 *
 * Two things follow, and both are why this exists:
 *   - a new epoch must RE-DELIVER what the old one carried (rules, the task
 *     briefing) — after compaction the agent has neither;
 *   - inside one epoch a second copy adds nothing but tokens.
 */

/**
 * Session-event reasons that mean the previous window is GONE:
 *
 *   - `compact` — the transcript was summarized; injected context is dropped.
 *   - `clear`   — the user wiped the conversation outright.
 *
 * Deliberately NOT here: `startup` (there is no previous window to lose) and
 * `resume` (the transcript is replayed, so earlier injections are still in
 * view). An unknown or absent reason counts as "no boundary" — a client that
 * says nothing must not silently re-arm delivery on every event.
 */
export const EPOCH_BOUNDARY_SOURCES: readonly string[] = ['compact', 'clear'];

/** Does this session-event reason open a new context epoch? */
export const startsNewEpoch = (source: string | undefined): boolean =>
  source !== undefined && EPOCH_BOUNDARY_SOURCES.includes(source);

/**
 * Should this epoch's standing-rule text still be delivered?
 *
 * The comparison is against the epoch whose delivery actually SUCCEEDED, not
 * against an attempt: a session-start briefing can fail on its own (server
 * down, offline cache served) while a later hook in the same epoch succeeds,
 * and a standing rule that silently missed the window is the one failure the
 * rules layer must not have. So the default — no recorded delivery — is to
 * render.
 */
export const rulesNeedDelivery = (state: {
  epoch: number;
  rulesEpoch?: number;
}): boolean => state.rulesEpoch !== state.epoch;
