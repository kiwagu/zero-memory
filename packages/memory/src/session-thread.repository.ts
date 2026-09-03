import type { Option, Result } from 'oxide.ts';

import type { Scope } from './scope.vo.js';

/** One conversation's durable identity and the project it works in. */
export interface SessionThread {
  /** Row id — the token the hook delivers and the agent echoes. */
  token: string;
  /** The client's conversation id (Claude Code `session_id` and friends). */
  conversationId: string;
  /** Project scope this thread works in. */
  scope: Scope;
}

/**
 * Port: the SESSION THREAD — the durable identity behind a conversation.
 *
 * WHY A THREAD RATHER THAN A VARIABLE ON THE SESSION. Project drift had one
 * root: the truth about "which project is this" lived on the transport
 * session and was refreshed only when the AGENT chose to send a hint. It was
 * therefore lost two ways — the connection was re-established (a fresh
 * session starts blank) or the agent simply did not send one, and the next
 * scope-less write had to be refused for want of a target. A thread inverts
 * that: the client hook asserts it on every user message, which happens
 * regardless of what the model decides to do.
 *
 * A thread is a CONVERSATION, not a repository: two sessions in one repo are
 * two threads that happen to share a project.
 *
 * The token is a state selector, never a credential: every lookup here is
 * additionally scoped to the CALLER's own owner id, so another account's
 * token resolves to nothing.
 */
export interface ISessionThreadRepository {
  /**
   * Opens the thread of a conversation, or refreshes the one that exists, and
   * returns it. Idempotent per (owner, conversation): the hook calls this on
   * every message, so it must be cheap and must not stack rows.
   *
   * The scope is rewritten on purpose. The hook derives it from the working
   * directory, which is what the owner is actually doing — so when the two
   * disagree the environment wins and the thread follows.
   */
  open(
    conversationId: string,
    scope: Scope
  ): Promise<Result<SessionThread, string>>;

  /** The live thread a token addresses, if any. */
  findByToken(token: string): Promise<Option<SessionThread>>;

  /** The live thread of a conversation id, if any. */
  findByConversation(conversationId: string): Promise<Option<SessionThread>>;
}
