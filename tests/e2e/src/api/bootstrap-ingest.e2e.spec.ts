/**
 * Repo-bootstrap ingest over MCP: `ingest_conversation` with a bootstrap
 * source kind (document/history) runs the extraction pipeline, stamps the
 * created memories with bootstrap provenance (agent_name + source.kind), and
 * stays idempotent per chunk_hash. Extraction itself is a live LLM call, so
 * the assertions are structural (acceptance, idempotency, provenance of
 * whatever was created) — not about the extracted content.
 */
import { expect, test } from '@playwright/test';

import { firstJson, McpTestClient } from '../helpers/mcp.js';
import {
  passwordGrantToken,
  provisionE2EUser,
  userRestClient,
} from '../helpers/users.js';

interface IngestOutput {
  duplicate: boolean;
  memories_created: number;
  memory_ids: string[];
}

const DOCUMENT_CHUNK = [
  '# Document: README.md',
  '',
  '## Conventions',
  '',
  'BOOTSTRAP-E2E: this project pins its toolchain to Bun; npm, pnpm and yarn',
  'are deliberately not supported because the lockfile is bun.lock only.',
  'All database identifiers use snake_case — a deliberate convention the',
  'linters do not enforce.',
].join('\n');

test.describe('ingest_conversation with a bootstrap source', () => {
  test('accepts a document chunk, stamps bootstrap provenance, idempotent per hash', async () => {
    // A dedicated user: live-LLM extraction writes unpredictable content, and
    // other specs (running concurrently in the web project) assert invariants
    // over the shared seed users' datasets.
    const user = await provisionE2EUser('bootstrap-ingest@zm.e2e');
    const token = await passwordGrantToken(user);
    const mcp = await McpTestClient.connect(token);
    try {
      const args = {
        transcript_chunk: DOCUMENT_CHUNK,
        chunk_hash: 'e2e-bootstrap-doc-0001',
        client: 'zm-bootstrap',
        conversation_id: 'bootstrap:/home/e2e/repo:README.md',
        project_hint: '/home/e2e/repo',
        source_kind: 'document',
        source_path: 'README.md',
      };

      const first = firstJson<IngestOutput>(
        await mcp.callTool('ingest_conversation', args)
      );
      expect(first.duplicate).toBe(false);

      // Idempotent re-run: identical chunk_hash → duplicate, no re-extraction.
      const again = firstJson<IngestOutput>(
        await mcp.callTool('ingest_conversation', args)
      );
      expect(again.duplicate).toBe(true);
      expect(again.memories_created).toBe(0);

      // Whatever the extractor CREATED must carry bootstrap provenance,
      // stamped server-side. `memory_ids` may also hold dedup hits — ids of
      // pre-existing memories the chunk collapsed into — which keep their own
      // provenance, so only bootstrap-stamped rows are asserted (and cleaned).
      const rest = userRestClient(token);
      const { data: rows } = await rest
        .from('memories')
        .select('id, agent_name, source')
        .in('id', first.memory_ids);
      const bootstrapRows = (rows ?? []).filter(
        (row) => row.agent_name === 'bootstrap'
      );
      for (const row of bootstrapRows) {
        const source = (row.source ?? {}) as Record<string, unknown>;
        expect(source.kind).toBe('bootstrap');
        expect(source.path).toBe('README.md');
        expect(source.hash).toBe('e2e-bootstrap-doc-0001');
      }

      // Cleanup: live-LLM extraction writes unpredictable kinds/content into
      // the shared e2e dataset — forget the created rows so the seed
      // invariants other specs rely on (e.g. "no episode memories exist")
      // keep holding. Dedup-absorbed seed memories are deliberately left
      // alone: forgetting them would corrupt the shared dataset.
      for (const row of bootstrapRows) {
        await mcp.callTool('forget', { memory_id: row.id });
      }
    } finally {
      await mcp.close();
    }
  });

  test('probe reports ledger state without claiming the hash or writing', async () => {
    const user = await provisionE2EUser('bootstrap-probe@zm.e2e');
    const token = await passwordGrantToken(user);
    const mcp = await McpTestClient.connect(token);
    try {
      const hash = 'e2e-bootstrap-probe-0001';
      const probeArgs = {
        // A probe carries the hash, not the content — that is the point.
        transcript_chunk: '',
        chunk_hash: hash,
        client: 'zm-bootstrap',
        conversation_id: 'bootstrap:/home/e2e/repo:PROBE.md',
        probe: true,
      };

      const before = firstJson<IngestOutput>(
        await mcp.callTool('ingest_conversation', probeArgs)
      );
      expect(before.duplicate).toBe(false);
      expect(before.memories_created).toBe(0);

      // The probe must NOT have claimed the hash: a preview that poisoned the
      // ledger would turn the real run into a silent no-op.
      const rest = userRestClient(token);
      const { data: afterProbe } = await rest
        .from('ingest_log')
        .select('chunk_hash')
        .eq('chunk_hash', hash);
      expect(afterProbe ?? []).toHaveLength(0);

      // So the real ingest still does the work…
      const real = firstJson<IngestOutput>(
        await mcp.callTool('ingest_conversation', {
          ...probeArgs,
          probe: false,
          transcript_chunk: DOCUMENT_CHUNK,
          source_kind: 'document',
          source_path: 'PROBE.md',
        })
      );
      expect(real.duplicate).toBe(false);

      // …and a probe afterwards reports it as already ingested.
      const after = firstJson<IngestOutput>(
        await mcp.callTool('ingest_conversation', probeArgs)
      );
      expect(after.duplicate).toBe(true);

      const { data: rows } = await rest
        .from('memories')
        .select('id, agent_name')
        .in('id', real.memory_ids);
      for (const row of (rows ?? []).filter(
        (r) => r.agent_name === 'bootstrap'
      )) {
        await mcp.callTool('forget', { memory_id: row.id });
      }
    } finally {
      await mcp.close();
    }
  });
});
