import { describe, expect, it, vi } from 'vitest';

import type {
  ImportMemoryInput,
  ImportMemoryOutput,
} from '@workspace/contracts';

import {
  parseImportArgs,
  runImport,
  type ImportClientLike,
} from './import-runner.js';
import type { ImportItem, MemorySourceAdapter } from './source-adapter.js';

/** Test-only brand cast: specs fake server replies, not real memory ids. */
const memId = (value: string): ImportMemoryOutput['memory_id'] =>
  value as ImportMemoryOutput['memory_id'];

const adapterOf = (items: ImportItem[]): MemorySourceAdapter => ({
  tool: 'claude-code',
  label: 'Claude Code',
  discover: () => Promise.resolve(items),
});

class FakeClient implements ImportClientLike {
  readonly inputs: ImportMemoryInput[] = [];
  closed = false;
  scans = 0;
  constructor(
    private readonly reply: (input: ImportMemoryInput) => ImportMemoryOutput
  ) {}
  importMemory(input: ImportMemoryInput): Promise<ImportMemoryOutput> {
    this.inputs.push(input);
    return Promise.resolve(this.reply(input));
  }
  scanHygiene(): Promise<{ started: boolean }> {
    this.scans += 1;
    return Promise.resolve({ started: true });
  }
  close(): Promise<void> {
    this.closed = true;
    return Promise.resolve();
  }
}

const item = (overrides: Partial<ImportItem>): ImportItem => ({
  content: 'A durable fact.',
  kind: 'fact',
  target: 'personal',
  sourcePath: '/home/u/.claude/projects/x/memory/a.md',
  ...overrides,
});

describe('parseImportArgs', () => {
  it('parses flags and defaults', () => {
    const options = parseImportArgs([
      '--dry-run',
      '--home',
      '/h',
      '--cwd',
      '/c',
      '--project',
      '/repo',
      '--server',
      'http://x/mcp',
    ]);
    expect(options).toMatchObject({
      dryRun: true,
      homeDir: '/h',
      cwd: '/c',
      projectHintOverride: '/repo',
      serverUrl: 'http://x/mcp',
    });
  });

  it('--e2e targets the local e2e sandbox; an explicit later --server wins', () => {
    expect(parseImportArgs(['--e2e']).serverUrl).toBe(
      'http://localhost:8788/mcp'
    );
    expect(
      parseImportArgs(['--e2e', '--server', 'http://x/mcp']).serverUrl
    ).toBe('http://x/mcp');
  });

  it('rejects an unknown flag and a value-less flag', () => {
    expect(() => parseImportArgs(['--nope'])).toThrow(/Unknown import flag/);
    expect(() => parseImportArgs(['--home'])).toThrow(/requires a value/);
  });
});

describe('runImport', () => {
  it('tallies imported / deduplicated / already-imported and closes the client', async () => {
    const client = new FakeClient((input) => {
      if (input.source_path.endsWith('dup.md')) {
        return {
          skipped: false,
          deduplicated: true,
          memory_id: memId('mem_1'),
        };
      }
      if (input.source_path.endsWith('seen.md')) {
        return { skipped: true };
      }
      return { skipped: false, memory_id: memId('mem_2') };
    });
    const adapter = adapterOf([
      item({ sourcePath: '/m/new.md' }),
      item({ sourcePath: '/m/dup.md' }),
      item({ sourcePath: '/m/seen.md' }),
    ]);

    const tally = await runImport({
      dryRun: false,
      homeDir: '/h',
      cwd: '/c',
      adapters: [adapter],
      client,
    });

    expect(tally).toEqual({
      discovered: 3,
      imported: 1,
      deduplicated: 1,
      skipped: 1,
      failed: 0,
      aborted: false,
    });
    expect(client.closed).toBe(true);
  });

  it('aborts on a consecutive-failure streak instead of grinding the list', async () => {
    const client = new FakeClient(() => {
      throw new Error('Not authenticated');
    });
    const tally = await runImport({
      dryRun: false,
      homeDir: '/h',
      cwd: '/c',
      adapters: [
        adapterOf(
          Array.from({ length: 10 }, (_, i) =>
            item({ sourcePath: `/m/${i}.md` })
          )
        ),
      ],
      client,
    });
    expect(tally.aborted).toBe(true);
    expect(tally.failed).toBe(3); // stopped at the streak, not all 10
    expect(client.closed).toBe(true);
  });

  it('counts a per-item failure without aborting the rest', async () => {
    const client = new FakeClient((input) => {
      if (input.source_path.endsWith('bad.md')) {
        throw new Error('boom');
      }
      return { skipped: false, memory_id: memId('mem_ok') };
    });
    const tally = await runImport({
      dryRun: false,
      homeDir: '/h',
      cwd: '/c',
      adapters: [
        adapterOf([
          item({ sourcePath: '/m/bad.md' }),
          item({ sourcePath: '/m/ok.md' }),
        ]),
      ],
      client,
    });
    expect(tally.failed).toBe(1);
    expect(tally.imported).toBe(1);
  });

  it('computes a stable source_hash for the same (tool, path, content)', async () => {
    const reply = (): ImportMemoryOutput => ({
      skipped: false,
      memory_id: memId('m'),
    });
    const one = new FakeClient(reply);
    const two = new FakeClient(reply);
    const items = [item({ sourcePath: '/m/a.md', content: 'same' })];
    await runImport({
      dryRun: false,
      homeDir: '/h',
      cwd: '/c',
      adapters: [adapterOf(items)],
      client: one,
    });
    await runImport({
      dryRun: false,
      homeDir: '/h',
      cwd: '/c',
      adapters: [adapterOf(items)],
      client: two,
    });
    expect(one.inputs[0]!.source_hash).toBe(two.inputs[0]!.source_hash);
    expect(one.inputs[0]!.source_tool).toBe('claude-code');
  });

  it('auto-triggers a hygiene scan only when the run imported something', async () => {
    const imported = new FakeClient(() => ({
      skipped: false,
      memory_id: memId('m'),
    }));
    await runImport({
      dryRun: false,
      homeDir: '/h',
      cwd: '/c',
      adapters: [adapterOf([item({})])],
      client: imported,
    });
    expect(imported.scans).toBe(1);

    const allSkipped = new FakeClient(() => ({ skipped: true }));
    await runImport({
      dryRun: false,
      homeDir: '/h',
      cwd: '/c',
      adapters: [adapterOf([item({})])],
      client: allSkipped,
    });
    expect(allSkipped.scans).toBe(0); // idempotent re-run — nothing new to judge

    const optedOut = new FakeClient(() => ({
      skipped: false,
      memory_id: memId('m'),
    }));
    await runImport({
      dryRun: false,
      scan: false,
      homeDir: '/h',
      cwd: '/c',
      adapters: [adapterOf([item({})])],
      client: optedOut,
    });
    expect(optedOut.scans).toBe(0); // --no-scan
  });

  it('never calls the client in dry-run', async () => {
    const importMemory = vi.fn();
    const client: ImportClientLike = {
      importMemory,
      scanHygiene: () => Promise.resolve({ started: true }),
      close: () => Promise.resolve(),
    };
    const tally = await runImport({
      dryRun: true,
      homeDir: '/h',
      cwd: '/c',
      adapters: [adapterOf([item({})])],
      client,
    });
    expect(importMemory).not.toHaveBeenCalled();
    expect(tally.discovered).toBe(1);
  });
});
