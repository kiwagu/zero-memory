import type { ContextRule } from '@workspace/contracts';

/**
 * Port: read side of the owner's PROMOTED user-layer (General) rules
 * (rules-incubator output). The MCP `instructions` only ANNOUNCE that these
 * exist — clients cap that channel — so the briefing is what carries their
 * text in full, and it is also what makes a rule promoted MID-session
 * visible without reconnecting. Pinned rules come first. RLS scopes rows to
 * their owner.
 */
export interface IUserRulesReader {
  listPromoted(): Promise<ContextRule[]>;
}
