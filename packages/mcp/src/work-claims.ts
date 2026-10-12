/**
 * Claims on paid work that runs in the background for one owner — a hygiene
 * scan, a benchmark — so a second request does not start the same work while
 * the first is queued or still running. Whoever runs the work releases the
 * claim when it ends: the request's own background on a long-lived server,
 * the worker the server handed the work to elsewhere. A claim whose work never
 * ended expires instead of blocking the owner for good.
 */
export interface IWorkClaims {
  /** True when the claim was taken; false while someone else holds it. */
  claim(key: string): Promise<boolean>;
  release(key: string): Promise<void>;
}

/** The background work that takes a claim, one per owner at a time. */
export type ClaimedWork = 'hygiene-scan' | 'benchmark';

export const workClaimKey = (work: ClaimedWork, ownerId: string): string =>
  `${work}#${ownerId}`;

/**
 * Claims held in this process: all a long-lived server needs, where the work
 * runs here too and a restart ends both.
 */
export class InProcessWorkClaims implements IWorkClaims {
  readonly #held = new Set<string>();

  claim(key: string): Promise<boolean> {
    if (this.#held.has(key)) {
      return Promise.resolve(false);
    }
    this.#held.add(key);
    return Promise.resolve(true);
  }

  release(key: string): Promise<void> {
    this.#held.delete(key);
    return Promise.resolve();
  }
}
