import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';
import { getRequestId, runWithContext } from '@workspace/context';
import { newRequestId, type ContextRule } from '@workspace/contracts';
import { entityIdSchemas } from '@workspace/contracts';
import { CommandBus, QueryBus } from '@workspace/cqrs';
import { container } from '@workspace/di';
import { createLogger, runDetached } from '@workspace/logger';
import { buildMcpServer, type IWorkClaims } from '@workspace/mcp';
import {
  incompleteSessionResponse,
  unauthorizedResponse,
} from '@workspace/mcp-auth';
import {
  createAnonClient,
  createUserClient,
  fetchSessionAssurance,
  listPromotedUserRules,
  fetchUserEntityId,
  type SessionAssurance,
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
import type {
  IMcpSessionStore,
  McpSessionRecord,
} from './mcp-session.store.js';

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
  /** Where sessions live between requests. */
  sessions: IMcpSessionStore;
  /**
   * Answer a POST with one JSON body instead of an SSE stream. Both are valid
   * Streamable HTTP; JSON suits a runtime that hands back whole responses.
   */
  jsonResponse?: boolean;
  /** Claims on per-owner background work, when a worker elsewhere runs it. */
  workClaims?: IWorkClaims;
}

/**
 * Streamable HTTP MCP transport (POST/DELETE /mcp) protected by Bearer
 * Supabase JWTs. Every request is authenticated via supabase.auth.getUser and
 * runs inside an AsyncLocalStorage context carrying the user id + token, so
 * the persistence adapters act under that user's RLS — exactly like stdio.
 *
 * The McpServer and its transport are built for each request, in the SDK's
 * stateless mode; the session itself (its id, owner, client name and attached
 * project) is a record in `options.sessions`. A session therefore survives
 * the process that opened it, which is what a server spread over instances
 * that come and go needs. There is no GET stream: the server never pushes a
 * message outside a response, so GET is answered 405, as the spec allows.
 */
export const createMcpHttpRoutes = (options: McpHttpOptions) => {
  const logger = createLogger('mcp-http');
  const { sessions } = options;

  const usageRecorder = container.resolve<IUsageRecorder>(USAGE_RECORDER);
  const auditRecorder = container.resolve<IAuditRecorder>(AUDIT_RECORDER);
  // Audit every command at the composition seam; the generic bus stays clean.
  const commandBus = new AuditedCommandBus(
    container.resolve(CommandBus),
    auditRecorder
  );
  const queryBus = container.resolve(QueryBus);

  /**
   * Network-served rules for the initialize `instructions`: they announce the
   * rules, and carry their full text unless this client is known to truncate
   * that channel (composeInstructions decides from clientName). Fail-open — a
   * rules lookup problem must never block the connection — but LOUD: the
   * client sees base instructions with no signal, so the error log plus the
   * counter (an alertable /metrics series) are the only visible trace.
   */
  const instructionRulesFor = async (
    accessToken: string
  ): Promise<ContextRule[]> => {
    try {
      return await listPromotedUserRules(accessToken);
    } catch (error) {
      incrementCounter('promoted_rules_lookup_failures_total');
      logger.error('promoted rules lookup failed; instructions stay base', {
        error: error instanceof Error ? error.message : String(error),
      });
      return [];
    }
  };

  const serverFor = (
    session: McpSessionRecord,
    accessToken: string,
    instructionRules: ContextRule[]
  ) =>
    buildMcpServer({
      commandBus,
      queryBus,
      workClaims: options.workClaims,
      // The per-request AsyncLocalStorage context (established below) already
      // wraps tool execution, so the tool-context hook is a pass-through.
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
      onChallenge: (memoryId) => recordChallengeMisled(usageRecorder, memoryId),
      instructionRules,
      clientName: session.clientName,
      // Live rules read for the zm://rules resource — same credential the
      // request carries, so a mid-session promote is visible on the next read.
      readPromotedRules: () => listPromotedUserRules(accessToken),
      // How an HTTP session learns its project: a caller passes a
      // `project_hint` (the briefing hook sends the repo root), the read
      // tool resolves it, and the resolved scope attaches to the session so
      // later scope-less writes ride the project. There is no transport-level
      // alternative — MCP deprecated Roots (SEP-2577) and removed the
      // streamable-HTTP GET stream, so the server cannot ask the client for
      // its workspace on its own. The store write is a side write: a runtime
      // that freezes after the response drains it first.
      sessionScope: {
        attachProjectScope: (scope) => {
          session.defaultScope = scope;
          runDetached(
            () => sessions.attachScope(session.sessionId, scope),
            logger,
            'failed to attach the session to its project',
            { sessionId: session.sessionId }
          );
        },
        currentProjectScope: () => session.defaultScope,
      },
      // Refused writes are a caller-contract signal, not a server error:
      // the counter answers whether agents attach on the retry or keep
      // hitting the wall, which is the only way to see if the refusal is
      // teaching anything.
      onWriteRefused: (reason) =>
        incrementCounter('mcp_write_refused_total', { reason }),
    });

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
    // A live token is not yet a complete sign-in. An account with a second
    // factor admits a session to its data once the code was given, or when
    // the authorization server opened the session for an agent; the database
    // applies that rule to every row. Asking first turns what would be empty
    // answers into a refusal that says why.
    let assurance: SessionAssurance;
    try {
      assurance = await fetchSessionAssurance(createUserClient(token));
    } catch (thrown) {
      logger.error('session assurance check failed', {
        error: thrown instanceof Error ? thrown.message : String(thrown),
      });
      return jsonRpcError(
        503,
        -32000,
        'The session could not be checked. Try again.'
      );
    }
    // A token outlives its session by up to an hour; a revoked or signed-out
    // session is told so, which sends the client to authorize again.
    if (!assurance.live) {
      return unauthorizedResponse(
        options.issuer,
        'The session has ended. Authorize the client again.'
      );
    }
    if (!assurance.complete) {
      return incompleteSessionResponse(options.issuer);
    }

    // Resolve the caller's domain user id (usr_) once, so tool execution can
    // attribute ownership by our id while RLS/scope keep the auth uuid.
    const userEntityId = await fetchUserEntityId(
      createUserClient(token),
      data.user.id
    );

    // 2. Session routing per the Streamable HTTP spec. A session belongs to
    // the user who opened it: another user's id is answered exactly like one
    // that was never issued (the same 404), so an id never confirms that it
    // exists.
    const body =
      request.method === 'POST'
        ? await request.json().catch(() => undefined)
        : undefined;
    const sessionId = request.headers.get('mcp-session-id');
    let session: McpSessionRecord;
    let opened = false;
    if (sessionId) {
      const resumed = await sessions.resume(
        sessionId,
        userEntityId,
        Date.now()
      );
      if (!resumed) {
        return jsonRpcError(404, -32001, 'Session not found');
      }
      if (request.method === 'DELETE') {
        await sessions.close(sessionId, userEntityId);
        logger.info('mcp session closed', { sessionId });
        return new Response(null, { status: 200 });
      }
      session = resumed;
    } else {
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
      session = {
        sessionId: entityIdSchemas.mcp_session.create(),
        ownerUserEntityId: userEntityId,
        clientName: initializeClientName(body),
        lastSeenAt: Date.now(),
      };
      opened = true;
    }
    if (request.method !== 'POST') {
      return new Response(null, {
        status: 405,
        headers: { allow: 'POST, DELETE' },
      });
    }

    const server = serverFor(
      session,
      token,
      opened ? await instructionRulesFor(token) : []
    );
    const transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: options.jsonResponse ?? false,
    });
    await server.connect(transport);

    // 3. Execute under the caller's identity (RLS end-to-end). The session's
    // default scope rides along for remember/ingest calls that name no scope.
    const response = await runWithContext(
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
      () => transport.handleRequest(request, { parsedBody: body })
    );
    if (!opened || !response.ok) {
      return response;
    }

    // A successful initialize opens the session: only now is it stored, and
    // its id handed to the client the way a stateful transport would.
    const dropped = await sessions.open(session);
    logger.info('mcp session initialized', { sessionId: session.sessionId });
    for (const droppedId of dropped) {
      logger.warn('dropped an mcp session over the session caps', {
        sessionId: droppedId,
      });
    }
    const headers = new Headers(response.headers);
    headers.set('mcp-session-id', session.sessionId);
    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers,
    });
  };

  return new Elysia({ name: 'mcp-http' }).all('/mcp', ({ request }) =>
    handle(request)
  );
};
