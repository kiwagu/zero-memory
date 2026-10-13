/**
 * Drives one MCP session against a server URL and measures it: initialize,
 * tools/list, a briefing that attaches a project, a write, a run of recalls,
 * then DELETE. Checks the session semantics a server spread over instances
 * must keep: the id survives every request, a closed id answers 404, and
 * another user's token cannot resume it.
 *
 *   bun scripts/lambda-spike/session.probe.ts <mcp-url> [recalls=20]
 *
 * Env: SUPABASE_URL, SUPABASE_ANON_KEY, SUPABASE_SERVICE_ROLE_KEY of the
 * stand; two throwaway users are minted on it.
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const [mcpUrl, recallsArg] = process.argv.slice(2);
if (!mcpUrl) {
  console.error('usage: session.probe.ts <mcp-url> [recalls]');
  process.exit(2);
}
const recalls = Number(recallsArg ?? 20);
const supabaseUrl = process.env.SUPABASE_URL as string;
const anonKey = process.env.SUPABASE_ANON_KEY as string;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY as string;

const mintToken = async (label: string): Promise<string> => {
  const email = `lambda-spike-${label}-${Date.now()}@example.test`;
  const password = `Spike-${crypto.randomUUID()}`;
  const created = await fetch(`${supabaseUrl}/auth/v1/admin/users`, {
    method: 'POST',
    headers: {
      apikey: serviceKey,
      authorization: `Bearer ${serviceKey}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({ email, password, email_confirm: true }),
  });
  if (!created.ok) {
    throw new Error(`create user: ${created.status} ${await created.text()}`);
  }
  const signedIn = await fetch(
    `${supabaseUrl}/auth/v1/token?grant_type=password`,
    {
      method: 'POST',
      headers: { apikey: anonKey, 'content-type': 'application/json' },
      body: JSON.stringify({ email, password }),
    }
  );
  if (!signedIn.ok) {
    throw new Error(`sign in: ${signedIn.status} ${await signedIn.text()}`);
  }
  return ((await signedIn.json()) as { access_token: string }).access_token;
};

const timed = async <T>(fn: () => Promise<T>): Promise<[T, number]> => {
  const started = performance.now();
  const value = await fn();
  return [value, performance.now() - started];
};

const percentile = (values: number[], p: number): number => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[
    Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))
  ] as number;
};

const round = (n: number) => Math.round(n);

/** `session.attached_project` from a read tool's JSON text result. */
const attachedProject = (result: { content?: unknown }): string | null => {
  const items = Array.isArray(result.content) ? result.content : [];
  for (const item of items as Array<{ type?: string; text?: string }>) {
    if (item.type !== 'text' || !item.text) continue;
    try {
      const parsed = JSON.parse(item.text) as {
        session?: { attached_project?: string | null };
      };
      if (parsed.session) return parsed.session.attached_project ?? null;
    } catch {
      // not the JSON body
    }
  }
  return null;
};

const tokenA = await mintToken('a');
const tokenB = await mintToken('b');
const transport = new StreamableHTTPClientTransport(new URL(mcpUrl), {
  requestInit: { headers: { authorization: `Bearer ${tokenA}` } },
});
const client = new Client({ name: 'lambda-spike-probe', version: '0.0.0' });

const timings: Record<string, number> = {};
[, timings.initialize] = await timed(() => client.connect(transport));
const sessionId = transport.sessionId;
if (!sessionId) {
  throw new Error('no Mcp-Session-Id after initialize');
}
const [tools, listMs] = await timed(() => client.listTools());
timings.tools_list = listMs;

const projectHint = '/tmp/zm-lambda-spike-probe';
const [briefing, briefingMs] = await timed(() =>
  client.callTool({
    name: 'build_context',
    arguments: {
      topic: 'lambda spike probe',
      briefing: true,
      project_hint: projectHint,
    },
  })
);
timings.build_context = briefingMs;
const attachedAtBriefing = attachedProject(briefing);
const [remembered, rememberMs] = await timed(() =>
  client.callTool({
    name: 'remember',
    arguments: {
      content: `The lambda spike probe stores one fact at ${new Date().toISOString()} to measure a write.`,
      kind: 'fact',
    },
  })
);
timings.remember_scope_less = rememberMs;

const recallMs: number[] = [];
const attachedAtRecall = new Set<string | null>();
for (let i = 0; i < recalls; i += 1) {
  const [found, ms] = await timed(() =>
    client.callTool({
      name: 'recall',
      arguments: { query: 'lambda spike probe fact' },
    })
  );
  recallMs.push(ms);
  attachedAtRecall.add(attachedProject(found));
}
const sameSessionThroughout = transport.sessionId === sessionId;

// Another user presenting this session id is told it does not exist.
const foreign = await fetch(mcpUrl, {
  method: 'POST',
  headers: {
    authorization: `Bearer ${tokenB}`,
    'content-type': 'application/json',
    accept: 'application/json, text/event-stream',
    'mcp-session-id': sessionId,
    'mcp-protocol-version': '2025-06-18',
  },
  body: JSON.stringify({ jsonrpc: '2.0', id: 99, method: 'tools/list' }),
});

[, timings.delete] = await timed(() => transport.terminateSession());
const afterClose = await fetch(mcpUrl, {
  method: 'POST',
  headers: {
    authorization: `Bearer ${tokenA}`,
    'content-type': 'application/json',
    accept: 'application/json, text/event-stream',
    'mcp-session-id': sessionId,
    'mcp-protocol-version': '2025-06-18',
  },
  body: JSON.stringify({ jsonrpc: '2.0', id: 100, method: 'tools/list' }),
});
await client.close();

const rememberText = JSON.stringify(remembered.content).slice(0, 160);
console.log(
  JSON.stringify(
    {
      mcpUrl,
      sessionId,
      tools: tools.tools.length,
      ms: Object.fromEntries(
        Object.entries(timings).map(([k, v]) => [k, round(v)])
      ),
      recall_ms: {
        n: recallMs.length,
        p50: round(percentile(recallMs, 50)),
        p95: round(percentile(recallMs, 95)),
        max: round(Math.max(...recallMs)),
      },
      checks: {
        same_session_throughout: sameSessionThroughout,
        attached_at_briefing: attachedAtBriefing,
        attached_at_every_recall: [...attachedAtRecall],
        remember_succeeded: !remembered.isError,
        remember_said: rememberText,
        foreign_user_status: foreign.status,
        after_delete_status: afterClose.status,
      },
    },
    null,
    2
  )
);
