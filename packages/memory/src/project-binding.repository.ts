import type { Option, Result } from 'oxide.ts';

import type { ProjectMatchKind } from './project-hint.vo.js';
import type { Scope } from './scope.vo.js';

export interface ProjectBinding {
  kind: ProjectMatchKind;
  key: string;
  scope: Scope;
}

/**
 * Port: persistence of project -> scope bindings used by ingestion routing
 * and the MCP roots handshake. Bindings are stable routing facts: insert
 * once, never updated through the application (see the table migration).
 */
export interface IProjectBindingRepository {
  /** Scope bound to a normalized (kind, key) project identity, if any. */
  findScope(kind: ProjectMatchKind, key: string): Promise<Option<Scope>>;

  /**
   * Records a binding. Racing inserts of the same (kind, key) are fine: the
   * unique constraint makes the second one a no-op success.
   */
  insert(binding: ProjectBinding): Promise<Result<void, string>>;
}
