import type {
  ObservedRelease,
  ReleaseCandidate,
  ReleaseSettings,
} from '@workspace/contracts';
import type { Result } from 'oxide.ts';

import type { CardFailure } from './card.errors.js';

export interface ConfigureReleaseParams {
  scope: string;
  versionUrl: string | null;
  versionField?: string;
  tagTemplate?: string;
  tagPattern?: string;
  onRelease?: 'record' | 'record_and_move_done';
}

export interface RecordReleaseParams {
  scope: string;
  version: string;
  build: string | null;
  releaseCommit: string;
  source: 'url' | 'tag';
  cardIds: string[];
  /**
   * Parallel to `cardIds`: the seq of each card's latest landing as the
   * caller checked it. A card that landed again since is skipped.
   */
  landingSeqs?: number[];
  thread?: string;
  agentLabel?: string;
}

export interface RecordedRelease {
  release: ObservedRelease;
  recorded: string[];
  moved: string[];
}

/**
 * Port to a project's release setting and the production states it was seen
 * in. One method per store command: the admin check, "first observer wins"
 * and "one record per card and version" are decided there, under its locks.
 */
export interface IReleaseRepository {
  settings(scope: string): Promise<Result<ReleaseSettings | null, CardFailure>>;
  configure(
    params: ConfigureReleaseParams
  ): Promise<Result<ReleaseSettings | null, CardFailure>>;
  candidates(
    scope: string,
    version: string
  ): Promise<Result<ReleaseCandidate[], CardFailure>>;
  record(
    params: RecordReleaseParams
  ): Promise<Result<RecordedRelease, CardFailure>>;
}
