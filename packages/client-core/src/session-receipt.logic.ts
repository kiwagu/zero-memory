/**
 * Rendering for the end-of-session receipt line — the one chat-visible
 * summary of what a session put into and got out of memory. Pure counters in,
 * one string (or silence) out, so the format is unit-testable away from hooks.
 */

export interface ReceiptCounters {
  /** Memories created by the session's ingested chunks. */
  captured: number;
  /** Distinct recalled memories confirmed useful in the session window. */
  fired: number;
  /** Open loops created in the window. */
  loopsCreated: number;
  /** Open loops closed in the window. */
  loopsClosed: number;
  /** Briefing saved-tokens estimate for the window (0 when unknown). */
  savedTokens: number;
  /**
   * Prior memories the session was about to rewrite blind but memory surfaced
   * as supersede candidates in time (rediscovery prevented). 0 when unknown.
   */
  alreadyKnew: number;
}

/** `1234` -> `~1.2k`; small counts stay exact. */
const formatTokens = (tokens: number): string =>
  tokens >= 1000 ? `~${(tokens / 1000).toFixed(1)}k` : `~${Math.round(tokens)}`;

/**
 * The receipt line, or null for silence. A session that neither captured nor
 * fired anything and touched no loops gets NO receipt — the saved-tokens
 * estimate alone (every briefed session has one) must not produce chat noise.
 */
export const formatReceiptLine = (counters: ReceiptCounters): string | null => {
  const {
    captured,
    fired,
    loopsCreated,
    loopsClosed,
    savedTokens,
    alreadyKnew,
  } = counters;
  if (captured + fired + loopsCreated + loopsClosed + alreadyKnew === 0) {
    return null;
  }
  const parts: string[] = [];
  if (captured > 0) {
    parts.push(`captured ${captured}`);
  }
  if (fired > 0) {
    parts.push(`${fired} recalled ${fired === 1 ? 'fact' : 'facts'} fired`);
  }
  if (alreadyKnew > 0) {
    // Memory-positive framing: the value memory added, never agent blame.
    parts.push(
      `already knew ${alreadyKnew} ${alreadyKnew === 1 ? 'fact' : 'facts'} you re-wrote`
    );
  }
  if (loopsCreated > 0 || loopsClosed > 0) {
    parts.push(`loops +${loopsCreated}/−${loopsClosed}`);
  }
  if (savedTokens > 0) {
    parts.push(`${formatTokens(savedTokens)} tokens saved (est.)`);
  }
  return `🧾 zero-memory session receipt: ${parts.join(' · ')}`;
};
