import { entityIdSchemas, type IdOf } from '@workspace/contracts';

/**
 * Claims on paid work that runs in the background for one owner — a hygiene
 * scan, a benchmark — so a second request does not start the same work while
 * the first is queued or still running. Taking a claim returns a token that
 * travels with the work; whoever runs the work releases the claim with it
 * when the work ends: the request's own background on a long-lived server,
 * the worker the server handed the work to elsewhere. A release with a stale
 * token (the claim expired and someone else took it since) changes nothing,
 * and a claim whose work never ended expires instead of blocking for good.
 */
export interface IWorkClaims {
  /** The token of the claim just taken; null while someone else holds it. */
  claim(key: string): Promise<WorkClaimToken | null>;
  /** Ends the claim, if it is still the one `token` names. */
  release(key: string, token: WorkClaimToken): Promise<void>;
}

/** A claim's token: a `wcl_` entity id, fresh for every claim taken. */
export type WorkClaimToken = IdOf<'work_claim'>;

export const workClaimTokenSchema = entityIdSchemas.work_claim.schema;

export const newWorkClaimToken = (): WorkClaimToken =>
  entityIdSchemas.work_claim.create();

/** The background work that takes a claim, one per owner at a time. */
export type ClaimedWork = 'hygiene-scan' | 'benchmark';

export const workClaimKey = (work: ClaimedWork, ownerId: string): string =>
  `${work}#${ownerId}`;

/**
 * Claims held in this process: all a long-lived server needs, where the work
 * runs here too and a restart ends both.
 */
export class InProcessWorkClaims implements IWorkClaims {
  readonly #held = new Map<string, WorkClaimToken>();

  claim(key: string): Promise<WorkClaimToken | null> {
    if (this.#held.has(key)) {
      return Promise.resolve(null);
    }
    const token = newWorkClaimToken();
    this.#held.set(key, token);
    return Promise.resolve(token);
  }

  release(key: string, token: WorkClaimToken): Promise<void> {
    if (this.#held.get(key) === token) {
      this.#held.delete(key);
    }
    return Promise.resolve();
  }
}
