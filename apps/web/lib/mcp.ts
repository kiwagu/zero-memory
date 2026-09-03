import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

// ZM_SERVER_URL is the FULL MCP endpoint (the watcher/hooks convention), e.g.
// https://memory.example.com/mcp — not a base URL. Do not append `/mcp` here.
// Unset means the server next door: a local dev run, or the compose service
// that injects the in-network address.
const mcpEndpoint = (
  process.env.ZM_SERVER_URL ?? 'http://localhost:8787/mcp'
).replace(/\/$/, '');

interface McpToolResult {
  isError?: boolean;
  content: Array<{ type: string; text?: string }>;
}

/**
 * Human-readable prose out of a failed tool result. The server reports failures
 * as `{error:{code,message}}`, so the raw text is JSON; anything else is passed
 * through as-is. Restated locally rather than imported from the contracts
 * package because Turbopack does not resolve its `.js` specifiers.
 */
function toolErrorMessage(result: McpToolResult, fallback: string): string {
  const text = result.content.find((block) => block.type === 'text')?.text;
  if (text === undefined) {
    return fallback;
  }
  try {
    const body = JSON.parse(text) as { error?: { message?: unknown } };
    return typeof body.error?.message === 'string' ? body.error.message : text;
  } catch {
    return text;
  }
}

/**
 * Calls one MCP tool on the server as the signed-in user (their Supabase JWT is
 * the bearer, the same surface an external MCP client uses). Used for the few
 * operations the web app cannot do directly against Postgres because they need
 * server-only capabilities (embedding, the hygiene judge). Returns the parsed
 * JSON result payload.
 */
async function callServerTool<T>(
  accessToken: string,
  name: string,
  args: Record<string, unknown>
): Promise<T> {
  const transport = new StreamableHTTPClientTransport(new URL(mcpEndpoint), {
    requestInit: { headers: { authorization: `Bearer ${accessToken}` } },
  });
  const client = new Client({ name: 'zm-web', version: '0.1.0' });
  await client.connect(transport);
  try {
    const result = (await client.callTool({
      name,
      arguments: args,
    })) as McpToolResult;
    if (result.isError) {
      throw new Error(toolErrorMessage(result, `${name} failed`));
    }
    const text = result.content.find((block) => block.type === 'text')?.text;
    return JSON.parse(text ?? '{}') as T;
  } finally {
    await client.close().catch(() => undefined);
    await transport.close().catch(() => undefined);
  }
}

/** What `remember` did: the memory's id, and whether a NEW row was written. */
export interface RememberedMemory {
  id: string;
  /**
   * True when the text collapsed onto an EXISTING memory instead of being
   * stored. Callers that record something about the row they just created must
   * check this — the id belongs to an older memory whose own provenance,
   * authorship and history are none of this write's business.
   */
  deduplicated: boolean;
}

/**
 * Creates a memory through the MCP server's `remember` tool — the only path that
 * embeds the content server-side (the web app talks to Postgres directly and
 * cannot run the embedding model).
 */
export async function rememberViaServer(
  accessToken: string,
  content: string,
  scope?: string,
  kind?: string
): Promise<RememberedMemory> {
  const result = await callServerTool<{
    memory_id?: string;
    deduplicated?: boolean;
  }>(accessToken, 'remember', {
    content,
    ...(scope ? { scope } : {}),
    ...(kind ? { kind } : {}),
  });
  if (!result.memory_id) {
    throw new Error('remember returned no memory_id');
  }
  return { id: result.memory_id, deduplicated: result.deduplicated === true };
}

export interface MoveMemoriesResult {
  scope: string;
  moved: string[];
  failed: Array<{ memory_id: string; error: string }>;
}

/**
 * Batch-moves memories into a project scope through the MCP server's
 * `move_memories` tool — the domain rules (owner-only, valid-only, canonical
 * scope) live server-side, so the dashboard never re-implements them.
 */
export async function moveMemoriesViaServer(
  accessToken: string,
  memoryIds: string[],
  targetScope: string
): Promise<MoveMemoriesResult> {
  return callServerTool<MoveMemoriesResult>(accessToken, 'move_memories', {
    memory_ids: memoryIds,
    scope: targetScope,
  });
}

import type { RenderableMemory } from './markdown-memory';

export interface ExportMemoriesResult {
  items: RenderableMemory[];
  count: number;
}

/**
 * Reads every memory the caller can access through the server's audited
 * `export_memories` tool. Routing the bulk read through the server (rather than
 * a direct Postgres select) is what makes the egress land in the audit log —
 * the tool dispatches an audited command. Runs as the signed-in user, so RLS
 * still scopes the result to their own plus shared memories.
 */
export async function exportMemoriesViaServer(
  accessToken: string,
  scopes?: string[]
): Promise<ExportMemoriesResult> {
  return callServerTool<ExportMemoriesResult>(
    accessToken,
    'export_memories',
    scopes && scopes.length > 0 ? { scopes } : {}
  );
}

export interface DeleteAccountResult {
  /** The erased account's `usr_` id. */
  subject: string;
  /** Whether an auth principal was found and removed. */
  auth_deleted: boolean;
  memories: number;
  entities: number;
}

/**
 * Erases the signed-in user's own account through the server's audited
 * `delete_account` tool — the cascade that removes everything they own, their
 * profile, and their sign-in principal. The tool takes no subject: it always
 * erases the authenticated caller, so this bridge cannot target another account.
 * Irreversible; the caller should offer the export first.
 */
export async function deleteAccountViaServer(
  accessToken: string
): Promise<DeleteAccountResult> {
  return callServerTool<DeleteAccountResult>(accessToken, 'delete_account', {});
}

/** Where a re-imported memory lands, mirroring the `import_memory` contract. */
export type ImportTarget = 'personal' | 'core' | 'project';

export interface ImportMemoryArgs {
  content: string;
  kind: string;
  target: ImportTarget;
  /** Required when `target === 'project'`: the `proj.<slug>` slug. */
  projectHint?: string;
  sourcePath: string;
  sourceHash: string;
  verbatim?: string;
}

export interface ImportMemoryResult {
  /** True when `source_hash` was already imported — an idempotent no-op. */
  skipped: boolean;
  /** The stored (or covering) memory id — absent only when skipped. */
  memory_id?: string;
  /** True when an equivalent memory already existed and its id is returned. */
  deduplicated?: boolean;
}

/**
 * Imports one already-atomic memory through the server's `import_memory` tool —
 * the deterministic write path (no LLM extraction) that embeds the content
 * server-side and is idempotent per `source_hash`. Used by the dashboard's
 * Markdown import to re-ingest an exported tree.
 */
export async function importMemoryViaServer(
  accessToken: string,
  args: ImportMemoryArgs
): Promise<ImportMemoryResult> {
  return callServerTool<ImportMemoryResult>(accessToken, 'import_memory', {
    content: args.content,
    kind: args.kind,
    target: args.target,
    ...(args.projectHint ? { project_hint: args.projectHint } : {}),
    source_tool: 'zm-export',
    source_path: args.sourcePath,
    source_hash: args.sourceHash,
    ...(args.verbatim ? { verbatim: args.verbatim } : {}),
  });
}

/**
 * One ranked hit returned by the server's `recall` tool. Re-declared locally
 * (like `RenderableMemory`) because `@workspace/contracts` is not importable
 * from the web bundle.
 */
export interface RecallHit {
  id: string;
  content: string;
  kind: string;
  scope: string;
  visibility: string;
  created_at: string;
  score: number;
  disputed: boolean;
  dispute_id: string | null;
  dispute_with: string | null;
  /** Vector-leg cosine similarity; null when the hit matched only by text. */
  similarity: number | null;
  /** Whether the full-text leg matched this hit. */
  fts_matched: boolean;
}

export interface RecallSearchArgs {
  query: string;
  kinds?: string[];
  scopes?: string[];
  k?: number;
  /**
   * Explicit query-language override (ISO-639-1). Omit for server-side
   * detection; 'en' skips translation, any other code forces it.
   */
}

/**
 * Runs the same hybrid (vector+FTS) ranked search agents get from the `recall`
 * tool — the dashboard's search is deliberately this exact call, so a human
 * query returns the identical ids, order, and scores. The human path always
 * opts into translate-then-search (stored content is canonical English);
 * agent callers never set that flag. Hits arrive ranked — render them in
 * server order.
 */
export interface RecallSearchResult {
  memories: RecallHit[];
}

export async function recallViaServer(
  accessToken: string,
  args: RecallSearchArgs
): Promise<RecallSearchResult> {
  return callServerTool<RecallSearchResult>(accessToken, 'recall', {
    query: args.query,
    ...(args.kinds && args.kinds.length > 0 ? { kinds: args.kinds } : {}),
    ...(args.scopes && args.scopes.length > 0 ? { scopes: args.scopes } : {}),
    ...(args.k ? { k: args.k } : {}),
  });
}

export interface HygieneScanStarted {
  started: boolean;
  reason?: string;
}

/**
 * Starts the hygiene scan over the signed-in user's own memories through the MCP
 * server (which holds the judge's API key and service-role access). The scan
 * runs in the background; this returns as soon as it is queued. Pass `limit` to
 * scan only the N most-recent memories (a cheaper, bounded run).
 */
export async function scanHygieneViaServer(
  accessToken: string,
  limit?: number
): Promise<HygieneScanStarted> {
  return callServerTool<HygieneScanStarted>(
    accessToken,
    'scan_hygiene',
    limit ? { limit } : {}
  );
}

/** Generic budget status: counters only, and only when a ceiling applies. */
export interface BudgetStatus {
  used: number;
  limit: number;
  window_days: number;
  /**
   * When the current window turns over and the counter starts from zero
   * again. Absent/null on servers whose window trails instead of turning
   * over — no reset date exists there and none is claimed.
   */
  window_ends_at?: string | null;
}

/**
 * Reads where the caller's extraction budget stands, through the server's
 * `session_receipt` tool.
 *
 * It goes through the server rather than straight to Postgres because the
 * limit is resolved from several sources, only one of which is a table — a
 * direct query would see part of the picture and confidently report it.
 *
 * Returns null when no ceiling is in force, which is the ordinary case: the
 * caller renders nothing at all rather than announcing an absence of limits.
 */
export async function budgetStatusViaServer(
  accessToken: string
): Promise<BudgetStatus | null> {
  const result = await callServerTool<{ budget: BudgetStatus | null }>(
    accessToken,
    'session_receipt',
    // The window only scopes the value counters, which this caller ignores;
    // the budget line is always current.
    { since: new Date(Date.now() - 60_000).toISOString() }
  );
  return result.budget ?? null;
}

/**
 * Asks the server's `describe_scope` tool to draft a short description of a
 * scope from a sample of its memories (the model writes it; the caller still
 * reviews before saving). Returns the generated text.
 */
export async function describeScopeViaServer(
  accessToken: string,
  scope: string
): Promise<string> {
  const result = await callServerTool<{ description?: string }>(
    accessToken,
    'describe_scope',
    { scope }
  );
  if (!result.description) {
    throw new Error('describe_scope returned no description');
  }
  return result.description;
}
