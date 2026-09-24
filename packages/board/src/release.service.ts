import { singleton } from '@workspace/di';

import type {
  ConfigureReleaseParams,
  IReleaseRepository,
  RecordReleaseParams,
} from './release.repository.js';
import { injectReleaseRepository } from './release.repository.provider.js';

/** Where a project's production lives, and what a production state carried. */
@singleton()
export class ReleaseService {
  constructor(
    @injectReleaseRepository()
    private readonly repository: IReleaseRepository
  ) {}

  settings(scope: string) {
    return this.repository.settings(scope);
  }

  configure(params: ConfigureReleaseParams) {
    return this.repository.configure(params);
  }

  candidates(scope: string, version: string) {
    return this.repository.candidates(scope, version);
  }

  record(params: RecordReleaseParams) {
    return this.repository.record(params);
  }
}
