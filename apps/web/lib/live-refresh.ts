/**
 * Turns nudges into page refreshes. A burst (an agent writing several
 * memories, a card and its stream entry) lands as one refresh once it
 * settles, and a steady stream that never settles still refreshes at least
 * every `maxWaitMs`, so a busy board does not freeze on screen.
 */
export function refreshScheduler(
  refresh: () => void,
  { settleMs, maxWaitMs }: { settleMs: number; maxWaitMs: number }
): () => void {
  let settle: ReturnType<typeof setTimeout> | undefined;
  let pendingSince: number | null = null;
  const flush = () => {
    pendingSince = null;
    refresh();
  };
  return () => {
    const now = Date.now();
    pendingSince ??= now;
    clearTimeout(settle);
    const left = maxWaitMs - (now - pendingSince);
    settle = setTimeout(flush, Math.max(0, Math.min(settleMs, left)));
  };
}
