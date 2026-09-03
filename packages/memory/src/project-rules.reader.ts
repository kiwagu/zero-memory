import type { ContextRule } from '@workspace/contracts';

import type { Scope } from './scope.vo.js';

/**
 * Port: read side of the owner's PROMOTED project-layer rules
 * (rules-incubator output). A rule's project is its explicit address, else
 * its anchor memory's scope, so the reader takes the briefed scopes and
 * returns the rules that apply there — pinned first, since a pinned rule is
 * exempt from the delivery cap. RLS scopes rows to their owner.
 */
export interface IProjectRulesReader {
  listForScopes(scopes: Scope[]): Promise<ContextRule[]>;
}
