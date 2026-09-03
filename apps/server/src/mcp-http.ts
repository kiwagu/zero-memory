import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';
import { getRequestId, runWithContext } from '@workspace/context';
import { newRequestId, type ContextRule } from '@workspace/contracts';
import { entityIdSchemas } from '@workspace/contracts';
import { CommandBus, QueryBus } from '@workspace/cqrs';
import { container } from '@workspace/di';
import { createLogger } from '@workspace/logger';
import { buildMcpServer } from '@workspace/mcp';
import { unauthorizedResponse } from '@workspace/mcp-auth';
import {
  createAnonClient,
  createUserClient,
  listPromotedUserRules,
  fetchUserEntityId,
} from '@workspace/persistence';
import { USAGE_RECORDER, type IUsageRecorder } from '@workspace/usage';
import { AUDIT_RECORDER, type IAuditRecorder } from '@workspace/audit';
import { Elysia } from 'elysia';

import { AuditedCommandBus } from './audited-command-bus.js';
import {
  recordChallengeMisled,
  recordInBandRecallUsed,
  recordRememberResult,
  recordToolError,
  recordToolInvocation,
  recordToolResult,
} from './metering.js';
import { incrementCounter } from './metrics.js';
import { evictSessionsOverCap, maxSessionsFromEnv } from './session-cap.js';
import { sessionForOwner } from './session-ownership.js';

/** Idle sessions are evicted after this long without a request. */
const SESSION_IDLE_TTL_MS = 30 * 60 * 1000;
const SESSION_SWEEP_INTERVAL_MS = 60 * 1000;

interface McpSession {
  transport: WebStandardStreamableHTTPServerTransport;
  server: McpServer;
  lastSeenAt: number;
  /** Project scope attached to this session (from a caller project_hint). */
  defaultScope?: string;
  /** The usr_ id that created this session; a lookup by another user 404s. */
  ownerUserEntityId: string;
}

/**
 * The client's self-declared `clientInfo.name` from a parsed initialize
 * request, or null when absent/malformed. Read defensively: this runs on
 * unvalidated request JSON.
 */
const initializeClientName = (body: unknown): string | null => {
  const params = (body as { params?: unknown } | undefined)?.params;
  const info = (params as { clientInfo?: unknown } | undefined)?.clientInfo;
  const name = (info as { name?: unknown } | undefined)?.name;
  return typeof name === 'string' && name.trim() ? name : null;
};

const jsonRpcError = (
  status: number,
  code: number,
  message: string
): Response =>
  new Response(
    JSON.stringify({
      jsonrpc: '2.0',
      error: { code, message },
      id: null,
    }),
    { status, headers: { 'content-type': 'application/json' } }
  );

export interface McpHttpOptions {
  /** Public base URL (OAuth issuer) used in 401 challenges. */
  issuer: string;
}

/**
 * Streamable HTTP MCP transport (POST/GET/DELETE /mcp) protected by Bearer
 * Supabase JWTs. Every request is authenticated via supabase.auth.getUser and
 * runs inside an AsyncLocalStorage context carrying the user id + token, so
 * the persistence adapters act under that user's RLS — exactly like stdio.
 * Transports are kept per MCP session (mcp-session-id) with TTL eviction.
 */
export const createMcpHttpRoutes = (options: McpHttpOptions) => {
  const logger = createLogger('mcp-http');
  const sessions = new Map<string, McpSession>();
  const maxSessions = maxSessionsFromEnv();

  const usageRecorder = container.resolve<IUsageRecorder>(USAGE_RECORDER);
  const auditRecorder = container.resolve<IAuditRecorder>(AUDIT_RECORDER);
  // Audit every command at the composition seam; the generic bus stays clean.
  const commandBus = new AuditedCommandBus(
    container.resolve(CommandBus),
    auditRecorder
  );
  const queryBus = container.resolve(QueryBus);

  const sweeper = setInterval(() => {
    const cutoff = Date.now() - SESSION_IDLE_TTL_MS;
    for (const [sessionId, session] of sessions) {
      if (session.lastSeenAt < cutoff) {
        sessions.delete(sessionId);
        void session.transport.close().catch(() => undefined);
        logger.debug('evicted idle mcp session', { sessionId });
      }
    }
  }, SESSION_SWEEP_INTERVAL_MS);
  sweeper.unref?.();

  const createSession = async (
    accessToken: string,
    clientName: string | null,
    ownerUserEntityId: string
  ): Promise<McpSession> => {
    // Network-served rules: the initialize `instructions` announce them, and
    // carry their full text unless this client is known to truncate that
    // channel (composeInstructions decides from clientName). Fail-open — a
    // rules lookup problem must never block the connection — but LOUD: the
    // client sees base instructions with no signal, so the error log plus the
    // counter (an alertable /metrics series) are the only visible trace.
    let instructionRules: ContextRule[] = [];
    try {
      instructionRules = await listPromotedUserRules(accessToken);
    } catch (error) {
      incrementCounter('promoted_rules_lookup_failures_total');
      logger.error('promoted rules lookup failed; instructions stay base', {
        error: error instanceof Error ? error.message : String(error),
      });
    }
    const session: McpSession = {
      transport: new WebStandardStreamableHTTPServerTransport({
        sessionIdGenerator: () => entityIdSchemas.mcp_session.create(),
        onsessioninitialized: (sessionId) => {
          sessions.set(sessionId, session);
          logger.info('mcp session initialized', { sessionId });
          // Bounded session map (memory-DoS guard): past the cap, the
          // least-recently-used sessions are evicted and their transports
          // closed. Evicted clients reconnect via a fresh initialize.
          for (const [evictedId, evicted] of evictSessionsOverCap(
            sessions,
            maxSessions
          )) {
            void evicted.transport.close().catch(() => undefined);
            logger.warn('evicted lru mcp session over cap', {
              sessionId: evictedId,
              maxSessions,
            });
          }
        },
        onsessionclosed: (sessionId) => {
          sessions.delete(sessionId);
          logger.info('mcp session closed', { sessionId });
        },
      }),
      // The per-request AsyncLocalStorage context (established below) already
      // wraps tool execution, so the tool-context hook is a pass-through.
      server: buildMcpServer({
        commandBus,
        queryBus,
        runInToolContext: (fn) => fn(),
        onToolInvocation: (tool) => {
          incrementCounter('mcp_tool_calls_total', { tool });
          // Dispatcher-level volume metering. Runs inside the request's
          // execution context, so the actor (usr_) and request id are
          // attributed. Result-attributed read tools are metered post-result
          // instead (recordToolResult). Fire-and-forget.
          recordToolInvocation(usageRecorder, tool);
        },
        onToolResult: (metering) => recordToolResult(usageRecorder, metering),
        onToolError: (metering) => recordToolError(usageRecorder, metering),
        onRememberResult: (metering) =>
          recordRememberResult(usageRecorder, metering),
        onInBandRecallUsed: (usedIds) =>
          recordInBandRecallUsed(usageRecorder, usedIds),
        onChallenge: (memoryId) =>
          recordChallengeMisled(usageRecorder, memoryId),
        instructionRules,
        clientName,
        // Live rules read for the zm://rules resource — same credential the
        // session connected with, so a mid-session promote is visible on the
        // next read without reconnecting.
        readPromotedRules: () => listPromotedUserRules(accessToken),
        // How an HTTP session learns its project: a caller passes a
        // `project_hint` (the briefing hook sends the repo root), the read
        // tool resolves it, and the resolved scope attaches here so later
        // scope-less writes ride the project. There is no transport-level
        // alternative — MCP deprecated Roots (SEP-2577) and removed the
        // streamable-HTTP GET stream, so the server cannot ask the client
        // for its workspace on its own.
        sessionScope: {
          attachProjectScope: (scope) => {
            session.defaultScope = scope;
          },
          currentProjectScope: () => session.defaultScope,
        },
        // Refused writes are a caller-contract signal, not a server error:
        // the counter answers whether agents attach on the retry or keep
        // hitting the wall, which is the only way to see if the refusal is
        // teaching anything.
        onWriteRefused: (reason) =>
          incrementCounter('mcp_write_refused_total', { reason }),
      }),
      lastSeenAt: Date.now(),
      ownerUserEntityId,
    };
    await session.server.connect(session.transport);
    return session;
  };

  const handle = async (request: Request): Promise<Response> => {
    // 1. Authentication: a valid Supabase JWT is required for every verb.
    const authorization = request.headers.get('authorization') ?? '';
    const token = authorization.startsWith('Bearer ')
      ? authorization.slice('Bearer '.length)
      : null;
    if (!token) {
      return unauthorizedResponse(options.issuer, 'Missing bearer token');
    }
    const { data, error } = await createAnonClient().auth.getUser(token);
    if (error || !data.user) {
      return unauthorizedResponse(
        options.issuer,
        'Invalid or expired access token'
      );
    }

    // Resolve the caller's domain user id (usr_) once, so tool execution can
    // attribute ownership by our id while RLS/scope keep the auth uuid.
    const userEntityId = await fetchUserEntityId(
      createUserClient(token),
      data.user.id
    );

    // 2. Session routing per the Streamable HTTP spec.
    const body =
      request.method === 'POST'
        ? await request.json().catch(() => undefined)
        : undefined;
    const sessionId = request.headers.get('mcp-session-id');
    let session = sessionId
      ? sessionForOwner(sessions, sessionId, userEntityId)
      : undefined;

    if (!session) {
      if (sessionId) {
        return jsonRpcError(404, -32001, 'Session not found');
      }
      if (request.method !== 'POST' || !isInitializeRequest(body)) {
        return jsonRpcError(
          400,
          -32000,
          'Bad Request: no valid session ID provided'
        );
      }
      // The initialize body is already parsed here, so the client's
      // self-declared name is available BEFORE the server object (and its
      // instructions) is built — which is what lets the instructions match
      // what this particular client can actually carry.
      session = await createSession(
        token,
        initializeClientName(body),
        userEntityId
      );
    }
    session.lastSeenAt = Date.now();

    // 3. Execute under the caller's identity (RLS end-to-end). The session's
    // default scope (from the roots handshake) rides along for remember/
    // ingest calls that name no scope.
    return runWithContext(
      {
        // Reuse the correlation id the outer observability wrapper already
        // bound for this HTTP request, so tool-execution logs share it.
        requestId: getRequestId() ?? newRequestId(),
        user: { userId: data.user.id, email: data.user.email },
        userEntityId,
        accessToken: token,
        defaultScope: session.defaultScope,
        // The transport session id (present on every non-initialize request)
        // groups this call with the rest of its MCP session in usage_events.
        sessionId: sessionId ?? undefined,
      },
      () => session.transport.handleRequest(request, { parsedBody: body })
    );
  };

  return new Elysia({ name: 'mcp-http' }).all('/mcp', ({ request }) =>
    handle(request)
  );
};
