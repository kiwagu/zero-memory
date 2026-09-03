import { inject } from '@workspace/di';

export interface ContextUser {
  userId: string | null;
  email?: string;
}

export interface ExecuteContext {
  requestId: string;
  user?: ContextUser;
  /**
   * The caller's domain user id (`usr_`, public.profiles.id), a 1:1 mirror of
   * `user.userId` (the auth uuid). Resolved once at request setup so the domain
   * attributes ownership by our id while RLS/scope keep the auth uuid.
   */
  userEntityId?: string;
  accessToken?: string;
  scopes?: string[];
  /**
   * Scope memories default into when the caller supplies none — resolved
   * from the client's MCP roots or the server's cwd via project bindings.
   */
  defaultScope?: string;
  /**
   * The MCP transport session id (`ses_`) grouping every tool call made over
   * one client connection. Stamped onto usage events as
   * `metadata.mcp_session_id` so a session's calls can be grouped after the
   * fact (e.g. recalls-per-session). Distinct from the request id (one per
   * request) and from the Claude conversation id the watcher threads on
   * ingest/briefing — those live in different id spaces. Absent for calls
   * made outside a transport session (background passes).
   */
  sessionId?: string;
}

export type SetContextValue = <K extends keyof ExecuteContext>(
  key: K,
  value: ExecuteContext[K]
) => void;

export interface IContext {
  setContextValue: SetContextValue;
  mustGetCurrentUserId(): string;
  getCurrentUserId(): string | undefined;
  mustGetCurrentUserEntityId(): string;
  getCurrentUserEntityId(): string | undefined;
  getAccessToken(): string | undefined;
  getScopes(): string[];
  getDefaultScope(): string | undefined;
  /** MCP transport session id (`ses_`) of the current request, if any. */
  getCurrentSessionId(): string | undefined;
}

export const CONTEXT_TOKEN = Symbol.for('zero-memory:context');

export const injectContext = () => inject(CONTEXT_TOKEN);
