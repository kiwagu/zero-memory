/**
 * MCP stdio entrypoint: `bun run mcp:stdio` (or `bun src/mcp-stdio.ts`).
 *
 * Wires the real adapters, signs in the local user (ZM_EMAIL/ZM_PASSWORD),
 * and serves the remember/recall/forget tools over stdio. Every tool call
 * runs inside an AsyncLocalStorage context carrying the user + access token
 * (refreshed on expiry), so persistence acts under that user's RLS.
 *
 * Default scope: derived from the process cwd at startup (the stdio server
 * is spawned inside the project it serves) and overridden by the client's
 * MCP roots when the client advertises them.
 */
// stdout carries MCP protocol frames — all logs must go to stderr.
process.env.LOG_STDERR = '1';

import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { runWithContext } from '@workspace/context';
import {
  entityIdSchemas,
  newRequestId,
  type ContextRule,
} from '@workspace/contracts';
import { CommandBus, QueryBus } from '@workspace/cqrs';
import { container } from '@workspace/di';
import { createLogger } from '@workspace/logger';
import { buildMcpServer } from '@workspace/mcp';
import { ScopeRoutingService } from '@workspace/memory';
import {
  createUserClient,
  listPromotedUserRules,
  fetchUserEntityId,
  SupabaseSessionManager,
} from '@workspace/persistence';
import { USAGE_RECORDER, type IUsageRecorder } from '@workspace/usage';
import { AUDIT_RECORDER, type IAuditRecorder } from '@workspace/audit';
import { AuditedCommandBus } from './audited-command-bus.js';
import {
  recordChallengeMisled,
  recordInBandRecallUsed,
  recordRememberResult,
  recordToolError,
  recordToolInvocation,
  recordToolResult,
} from './metering.js';
import { register } from './registry/index.js';

const logger = createLogger('mcp-stdio');

const main = async (): Promise<void> => {
  register();

  const sessionManager = new SupabaseSessionManager();
  const authed = await sessionManager.getAuthenticatedUser();
  const userId = authed.userId;
  logger.info('mcp session authenticated', { userId });

  // The caller is fixed for the whole stdio session, so resolve its domain
  // user id (usr_) once and reuse it across every tool-call context.
  const userEntityId = await fetchUserEntityId(
    createUserClient(authed.accessToken),
    authed.userId
  );

  const usageRecorder = container.resolve<IUsageRecorder>(USAGE_RECORDER);
  const auditRecorder = container.resolve<IAuditRecorder>(AUDIT_RECORDER);
  // Audit every command at the composition seam; the generic bus stays clean.
  const commandBus = new AuditedCommandBus(
    container.resolve(CommandBus),
    auditRecorder
  );
  const queryBus = container.resolve(QueryBus);
  const scopeRouting = container.resolve(ScopeRoutingService);

  /** Session default scope: cwd-derived, replaced by the roots handshake. */
  let defaultScope: string | undefined;

  // One stdio process serves exactly one client for its whole lifetime, so a
  // single session id minted at startup groups every tool call it meters —
  // the stdio analogue of the HTTP transport's per-connection session id.
  const sessionId = entityIdSchemas.mcp_session.create();

  const runAsUser = async <T>(fn: () => Promise<T>): Promise<T> => {
    // Fresh token per call: getAuthenticatedUser refreshes near expiry.
    const user = await sessionManager.getAuthenticatedUser();
    return runWithContext(
      {
        requestId: newRequestId(),
        user: { userId: user.userId, email: user.email },
        userEntityId,
        accessToken: user.accessToken,
        defaultScope,
        sessionId,
      },
      fn
    );
  };

  try {
    const scope = await runAsUser(() =>
      scopeRouting.resolveProjectScope(process.cwd())
    );
    defaultScope = scope.path;
    logger.info('default scope resolved from cwd', {
      cwd: process.cwd(),
      scope: defaultScope,
    });
  } catch (error) {
    logger.warn('cwd scope resolution skipped', { error: String(error) });
  }

  // Network-served rules (mirrors the HTTP transport). No clientName here:
  // stdio builds the server BEFORE the initialize handshake, so the client is
  // still unknown — and the capped client we know of (Claude Code) connects
  // over HTTP. The instructions therefore carry the rule texts, as they do
  // for any client not known to truncate them. Fail-open, but LOUD: the
  // client sees base instructions with no signal, so the server log is the
  // only place the degradation is visible.
  let instructionRules: ContextRule[] = [];
  try {
    instructionRules = await listPromotedUserRules(authed.accessToken);
  } catch (error) {
    logger.error('promoted rules lookup failed; instructions stay base', {
      error: error instanceof Error ? error.message : String(error),
    });
  }

  const server = buildMcpServer({
    commandBus,
    queryBus,
    instructionRules,
    // Live rules read for the zm://rules resource (same credential).
    readPromotedRules: () => listPromotedUserRules(authed.accessToken),
    runInToolContext: runAsUser,
    // Single dispatcher-level metering point for every tool call (mirrors the
    // HTTP transport). Fire-and-forget.
    // Volume metering (mirrors the HTTP transport). Result-attributed read
    // tools are metered post-result instead. Fire-and-forget.
    onToolInvocation: (tool) => recordToolInvocation(usageRecorder, tool),
    onToolResult: (metering) => recordToolResult(usageRecorder, metering),
    onToolError: (metering) => recordToolError(usageRecorder, metering),
    onRememberResult: (metering) =>
      recordRememberResult(usageRecorder, metering),
    onInBandRecallUsed: (usedIds) =>
      recordInBandRecallUsed(usageRecorder, usedIds),
    onChallenge: (memoryId) => recordChallengeMisled(usageRecorder, memoryId),
    // A stdio session already resolved its project from `process.cwd()` at
    // startup (above) — deterministic and before any client call, so it is
    // normally the attachment that wins: a `project_hint` on a later call
    // pins that read only (first attach wins, enforced at the call site).
    sessionScope: {
      attachProjectScope: (scope) => {
        defaultScope = scope;
      },
      currentProjectScope: () => defaultScope,
    },
  });

  await server.connect(new StdioServerTransport());
  logger.info('mcp stdio server ready');
};

main().catch((error: unknown) => {
  logger.error('mcp stdio server failed', { error: String(error) });
  process.exit(1);
});
