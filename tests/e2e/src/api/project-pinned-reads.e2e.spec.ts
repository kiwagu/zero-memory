/**
 * Project-pinned reads end-to-end: a `build_context` carrying a `project_hint`
 * resolves the project through the server's bindings (first sight creates the
 * scope), reports it as `project_scope`, and stashes it as the SESSION default
 * — so the session's later scope-less `remember` lands in the project. This is
 * the client→server replacement for the MCP roots handshake, which HTTP
 * clients cannot answer.
 *
 * The other half of the contract is the refusal: an UNATTACHED session cannot
 * write without naming a target. Nothing is stored on a guess, so a project
 * fact can never silently accumulate in the personal scope while the agent
 * believes it is writing to the project.
 */
import { expect, test } from '@playwright/test';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';

import { e2eEnv } from '../helpers/env.js';
import { readSeedState } from '../helpers/runtime-state.js';
import { contentText, firstJson, McpTestClient } from '../helpers/mcp.js';
import { passwordGrantToken } from '../helpers/users.js';

const adminClient = (): SupabaseClient =>
  createClient(e2eEnv.supabaseUrl, e2eEnv.supabaseServiceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

/** Usage emits are fire-and-forget; poll for the read's metering row. */
const awaitReadMetering = async (
  query: string,
  timeoutMs = 10_000
): Promise<Record<string, unknown> | null> => {
  const client = adminClient();
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const { data } = await client
      .from('usage_events')
      .select('metadata')
      .eq('event_type', 'mcp_tool_call')
      .eq('metadata->>query', query)
      .order('occurred_at', { ascending: false })
      .limit(1);
    const metadata = (
      data as Array<{ metadata: Record<string, unknown> }> | null
    )?.[0]?.metadata;
    if (metadata || Date.now() > deadline) {
      return metadata ?? null;
    }
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
};

interface Remembered {
  memory_id: string;
  scope?: string;
}

interface Briefed {
  project_scope?: string;
  memories: Array<{ id: string }>;
  /** Attachment state every read now reports; `thread` survives a reconnect. */
  session?: { attached_project: string | null; thread?: string };
}

test.describe('Project-pinned reads over MCP @smoke', () => {
  test('build_context with a project_hint pins the session: first sight, stash, repeat', async () => {
    const seed = await readSeedState();
    const mcp = await McpTestClient.connect(
      await passwordGrantToken(seed.userB)
    );
    try {
      // FIRST SIGHT: the hint path has never been seen — the server creates
      // the scope + binding and reports the pin.
      const briefed = firstJson<Briefed>(
        await mcp.callTool('build_context', {
          topic: 'wombat pipeline',
          project_hint: '/home/someone/repos/wombat-pipeline-e2e',
        })
      );
      expect(briefed.project_scope).toMatch(/^proj\./);
      expect(briefed.project_scope).toContain('wombat');

      // STASH: the same MCP session now carries the project as its default —
      // a scope-less remember (no scope, no hint) must land in the project,
      // not fall back to the personal scope.
      const remembered = firstJson<Remembered>(
        await mcp.callTool('remember', {
          content:
            'e2e project-pin marker: the wombat pipeline retries failed ' +
            'batches with exponential backoff',
        })
      );
      expect(remembered.scope).toBe(briefed.project_scope);

      // REPEAT: the same hint resolves through the binding to the SAME scope
      // (no second scope minted), and a hint-pinned recall finds the fact.
      const again = firstJson<Briefed>(
        await mcp.callTool('build_context', {
          topic: 'wombat pipeline',
          project_hint: '/home/someone/repos/wombat-pipeline-e2e',
        })
      );
      expect(again.project_scope).toBe(briefed.project_scope);

      const recalled = await mcp.callTool('recall', {
        query: 'how does the wombat pipeline handle failed batches?',
        project_hint: '/home/someone/repos/wombat-pipeline-e2e',
        k: 5,
      });
      expect(recalled.isError ?? false).toBe(false);
      const hits = firstJson<{ memories: Array<{ id: string }> }>(recalled);
      expect(hits.memories.map((m) => m.id)).toContain(remembered.memory_id);
    } finally {
      await mcp.close();
    }
  });

  test('an unroutable hint degrades without narrowing and reports no pin', async () => {
    const seed = await readSeedState();
    const mcp = await McpTestClient.connect(
      await passwordGrantToken(seed.userB)
    );
    try {
      // "/" yields no usable slug — routing falls back to the personal scope,
      // which must NOT be reported as a project pin (and must not stash).
      const briefed = firstJson<Briefed>(
        await mcp.callTool('build_context', {
          topic: 'anything at all',
          project_hint: '/',
        })
      );
      expect(briefed.project_scope).toBeUndefined();

      // The session gained no default, and the hint names no project — the
      // write is REFUSED rather than quietly stored in the personal scope.
      const raw = await mcp.callTool('remember', {
        content:
          'e2e project-pin marker: unroutable hints must not invent scopes',
        project_hint: '/',
      });
      expect(raw.isError).toBe(true);
      expect(contentText(raw)).toContain('does not resolve');
    } finally {
      await mcp.close();
    }
  });

  test('an unattached session cannot write without a target, and can once attached', async () => {
    const seed = await readSeedState();
    const mcp = await McpTestClient.connect(
      await passwordGrantToken(seed.userB)
    );
    try {
      // 1. BEFORE the session knows its project, a targetless write is
      // refused — and the refusal names every route out, so the retry needs
      // no guesswork. This is the mechanism that replaced a note in the
      // result: text was read and ignored for a whole session.
      const refused = await mcp.callTool('remember', {
        content:
          'e2e attach marker: the numbat exporter streams rows in pages of 500',
      });
      expect(refused.isError).toBe(true);
      const message = contentText(refused);
      // The three routes out, as the JSON-encoded error carries them.
      expect(message).toContain('project_hint');
      expect(message).toContain('core');
      expect(message).toContain('personal');

      // 2. The SAME session then learns its project (hint-pinned read).
      const briefed = firstJson<Briefed>(
        await mcp.callTool('build_context', {
          topic: 'numbat exporter',
          project_hint: '/home/someone/repos/numbat-exporter-e2e',
        })
      );
      expect(briefed.project_scope).toMatch(/^proj\./);

      // 3. The identical write now succeeds, into the project.
      const stored = firstJson<Remembered>(
        await mcp.callTool('remember', {
          content:
            'e2e attach marker: the numbat exporter streams rows in pages of 500',
        })
      );
      expect(stored.scope).toBe(briefed.project_scope);
    } finally {
      await mcp.close();
    }
  });

  test('a hint-pinned recall attaches the session, exactly like a briefing', async () => {
    const seed = await readSeedState();
    const mcp = await McpTestClient.connect(
      await passwordGrantToken(seed.userB)
    );
    try {
      // The brief promises attachment on "your first zero-memory call" —
      // recall included, since recall is often that call.
      const recalled = firstJson<{ project_scope?: string }>(
        await mcp.callTool('recall', {
          query: 'how does the bettong syncer batch its uploads?',
          project_hint: '/home/someone/repos/bettong-syncer-e2e',
        })
      );
      expect(recalled.project_scope).toMatch(/^proj\./);

      const stored = firstJson<Remembered>(
        await mcp.callTool('remember', {
          content:
            'e2e recall-attach marker: the bettong syncer batches uploads ' +
            'in groups of 25',
        })
      );
      expect(stored.scope).toBe(recalled.project_scope);
    } finally {
      await mcp.close();
    }
  });

  test('reads meter their scope mode and returned origins', async () => {
    const seed = await readSeedState();
    const mcp = await McpTestClient.connect(
      await passwordGrantToken(seed.userB)
    );
    // Distinctive queries: the metering row is found back by its query text.
    const openQuery = `numbat scope audit open ${Date.now()}`;
    const hintQuery = `numbat scope audit hint ${Date.now()}`;
    try {
      // 1. Unattached, unpinned read → the degraded all-visible mode. This is
      // the row the scope-usage audit could not even measure before: the
      // share of 'open'/'all' reads is the return trigger of the parked
      // proximity-ranking design.
      await mcp.callTool('recall', { query: openQuery });
      const open = await awaitReadMetering(openQuery);
      expect(open?.['read_mode']).toBe('open');
      expect(open).not.toHaveProperty('session_scope');
      expect(open).toHaveProperty('returned_by_scope');

      // 2. A hint-pinned read records the pin and, being this session's
      // first attach, no session scope yet at call time.
      const briefed = firstJson<Briefed>(
        await mcp.callTool('build_context', {
          topic: hintQuery,
          project_hint: '/home/someone/repos/numbat-exporter-e2e',
        })
      );
      expect(briefed.project_scope).toMatch(/^proj\./);
      const hinted = await awaitReadMetering(hintQuery);
      expect(hinted?.['read_mode']).toBe('hint');

      // 3. The now-attached session's plain read meters mode 'session' with
      // the attached scope — the anchor every origin distribution needs.
      const sessionQuery = `numbat scope audit session ${Date.now()}`;
      await mcp.callTool('recall', { query: sessionQuery });
      const attached = await awaitReadMetering(sessionQuery);
      expect(attached?.['read_mode']).toBe('session');
      expect(attached?.['session_scope']).toBe(briefed.project_scope);
    } finally {
      await mcp.close();
    }
  });

  test('reading another project does not move where the session writes', async () => {
    const seed = await readSeedState();
    const mcp = await McpTestClient.connect(
      await passwordGrantToken(seed.userB)
    );
    try {
      // The session opens on its own project.
      const home = firstJson<Briefed>(
        await mcp.callTool('build_context', {
          topic: 'dunnart planner',
          project_hint: '/home/someone/repos/dunnart-planner-e2e',
        })
      );
      expect(home.project_scope).toMatch(/dunnart/);

      // Then it looks sideways at ANOTHER project — a first-class move: a
      // decision made there is often the answer here.
      const elsewhere = await mcp.callTool('build_context', {
        topic: 'wombat pipeline',
        project_hint: '/home/someone/repos/wombat-pipeline-e2e',
      });
      const read = firstJson<Briefed>(elsewhere);
      expect(read.project_scope).toMatch(/wombat/);
      // The read is pinned there, and says so — but the pin is a read pin.
      expect(contentText(elsewhere)).toContain('session stays attached');

      // The write still lands at HOME: an answer found elsewhere must not
      // drag the session's writes into the project it came from.
      const stored = firstJson<Remembered>(
        await mcp.callTool('remember', {
          content:
            'e2e drift marker: the dunnart planner batches reminders hourly',
        })
      );
      expect(stored.scope).toBe(home.project_scope);

      // Writing INTO the other project stays possible — named on the write.
      const deliberate = firstJson<Remembered>(
        await mcp.callTool('remember', {
          content:
            'e2e drift marker: the wombat pipeline exposes a retry budget knob',
          project_hint: '/home/someone/repos/wombat-pipeline-e2e',
        })
      );
      expect(deliberate.scope).toBe(read.project_scope);
    } finally {
      await mcp.close();
    }
  });

  test('a fresh connection carries the project on the thread token', async () => {
    const seed = await readSeedState();
    const token = await passwordGrantToken(seed.userB);
    const hint = '/home/someone/repos/bilby-indexer-e2e';

    // Connection 1 stands in for the briefing hook: it resolves the project
    // and the server opens a thread for the conversation.
    let thread: string | undefined;
    let project: string | undefined;
    const hook = await McpTestClient.connect(token);
    try {
      const briefed = firstJson<Briefed>(
        await hook.callTool('build_context', {
          topic: 'bilby indexer',
          briefing: true,
          project_hint: hint,
          conversation_id: 'e2e-thread-conversation',
        })
      );
      expect(briefed.project_scope).toMatch(/^proj\./);
      project = briefed.project_scope;
      thread = briefed.session?.thread;
      expect(thread).toMatch(/^thr_/);
    } finally {
      await hook.close();
    }

    // Connection 2 stands in for the agent AFTER a reconnect: a separate MCP
    // session that inherits nothing from the first. This is the drift the
    // thread exists to stop — the work has not moved, so the write must land
    // in the project rather than be refused for want of a target.
    const agent = await McpTestClient.connect(token);
    try {
      const stored = firstJson<Remembered>(
        await agent.callTool('remember', {
          content: 'e2e thread marker: the bilby indexer shards by prefix',
          thread,
        })
      );
      expect(stored.scope).toBe(project);
    } finally {
      await agent.close();
    }
  });

  test('a targetless write is refused with every route out named', async () => {
    const seed = await readSeedState();
    const agent = await McpTestClient.connect(
      await passwordGrantToken(seed.userB)
    );
    try {
      // No project, no thread, no explicit scope: the server never guesses.
      // The refusal is the contract, so it must name each way to satisfy it.
      const refused = await agent.callTool('remember', {
        content: 'e2e refusal marker: a fact with nowhere to go',
      });
      expect(refused.isError).toBe(true);
      const message = contentText(refused);
      expect(message).toContain('project_hint');
      expect(message).toContain('thread');
      expect(message).toContain('core');
    } finally {
      await agent.close();
    }
  });

  test('move_memories converges a mis-routed memory into the named project', async () => {
    const seed = await readSeedState();
    const mcp = await McpTestClient.connect(
      await passwordGrantToken(seed.userB)
    );
    try {
      // A memory in the personal scope that belongs to a project — the shape
      // legacy mis-routing left behind, now reachable only deliberately.
      const stray = firstJson<Remembered>(
        await mcp.callTool('remember', {
          content:
            'e2e move marker: the quoll scheduler debounces rebuilds by 30s',
          scope: 'personal',
        })
      );
      expect(stray.scope).toMatch(/^user\./);

      const moved = firstJson<{
        scope: string;
        moved: string[];
        failed: Array<{ memory_id: string; error: string }>;
      }>(
        await mcp.callTool('move_memories', {
          memory_ids: [stray.memory_id],
          project_hint: '/home/someone/repos/quoll-scheduler-e2e',
        })
      );
      expect(moved.scope).toMatch(/^proj\./);
      expect(moved.scope).toContain('quoll');
      expect(moved.moved).toEqual([stray.memory_id]);
      expect(moved.failed).toEqual([]);

      // Idempotent: re-moving to the same scope is a no-op success.
      const again = firstJson<{ moved: string[]; failed: unknown[] }>(
        await mcp.callTool('move_memories', {
          memory_ids: [stray.memory_id],
          scope: moved.scope,
        })
      );
      expect(again.moved).toEqual([stray.memory_id]);
      expect(again.failed).toEqual([]);
    } finally {
      await mcp.close();
    }
  });
});
