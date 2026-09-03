import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import type {
  IngestConversationInput,
  IngestConversationOutput,
} from '@workspace/contracts';

import {
  parseBootstrapArgs,
  runBootstrap,
  type BootstrapClientLike,
} from './bootstrap-runner.js';
import { DEFAULT_HISTORY_DEPTH } from './repo-source.js';

let repoDir: string | null = null;

const makeRepo = (): string => {
  repoDir = mkdtempSync(join(tmpdir(), 'zm-bootstrap-run-spec-'));
  writeFileSync(join(repoDir, 'README.md'), '# spec repo\n\na durable fact');
  return repoDir;
};

afterEach(() => {
  if (repoDir) {
    rmSync(repoDir, { recursive: true, force: true });
    repoDir = null;
  }
  vi.restoreAllMocks();
});

const okOutput = (created: number): IngestConversationOutput => ({
  duplicate: false,
  memories_created: created,
  memory_ids: [],
});

const clientOf = (
  sendChunk: (
    input: IngestConversationInput
  ) => Promise<IngestConversationOutput>
): BootstrapClientLike & { closed: () => boolean } => {
  let closed = false;
  return {
    sendChunk,
    close: async () => {
      closed = true;
    },
    closed: () => closed,
  };
};

describe('parseBootstrapArgs', () => {
  it('defaults to cwd, both sources, and the default depth', () => {
    const options = parseBootstrapArgs([]);
    expect(options.repoDir).toBe(process.cwd());
    expect(options.dryRun).toBe(false);
    expect(options.depth).toBe(DEFAULT_HISTORY_DEPTH);
    expect(options.only).toBeUndefined();
  });

  it('parses repo, depth, source restriction, and dry-run', () => {
    const options = parseBootstrapArgs([
      '--repo',
      '/tmp/x',
      '--depth',
      '42',
      '--history-only',
      '--dry-run',
    ]);
    expect(options.repoDir).toBe('/tmp/x');
    expect(options.depth).toBe(42);
    expect(options.only).toBe('history');
    expect(options.dryRun).toBe(true);
  });

  it('takes a bare token as the repo dir (`bootstrap ./repo`)', () => {
    expect(parseBootstrapArgs(['/tmp/x']).repoDir).toBe('/tmp/x');
    // Resolved against cwd, so a relative path works from anywhere.
    expect(parseBootstrapArgs(['.']).repoDir).toBe(process.cwd());
  });

  it('splits --exclude into trimmed, non-empty globs', () => {
    expect(
      parseBootstrapArgs(['--exclude', 'docs/diagrams/*, *-ja.md ,']).exclude
    ).toEqual(['docs/diagrams/*', '*-ja.md']);
  });

  it('rejects an unknown flag (with usage) and a bad depth', () => {
    expect(() => parseBootstrapArgs(['--nope'])).toThrow(/Unknown/);
    expect(() => parseBootstrapArgs(['--nope'])).toThrow(/--exclude/);
    expect(() => parseBootstrapArgs(['--depth', '0'])).toThrow(/positive/);
  });

  it('flags --help/-h instead of running anything', () => {
    expect(parseBootstrapArgs(['--help']).help).toBe(true);
    expect(parseBootstrapArgs(['-h']).help).toBe(true);
  });
});

describe('runBootstrap', () => {
  it('sends doc chunks with bootstrap identity and tallies results', async () => {
    const dir = makeRepo();
    const seen: IngestConversationInput[] = [];
    const client = clientOf(async (input) => {
      seen.push(input);
      return okOutput(2);
    });

    const tally = await runBootstrap({
      repoDir: dir,
      dryRun: false,
      depth: 5,
      only: 'docs',
      client,
    });

    expect(tally).toMatchObject({
      chunks: 1,
      sent: 1,
      memoriesCreated: 2,
      duplicates: 0,
      failed: 0,
      aborted: false,
    });
    expect(seen[0]!.client).toBe('zm-bootstrap');
    expect(seen[0]!.source_kind).toBe('document');
    expect(seen[0]!.source_path).toBe('README.md');
    expect(seen[0]!.project_hint).toBe(dir);
    expect(seen[0]!.chunk_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(client.closed()).toBe(true);
  });

  it('counts server-side duplicates separately (idempotent re-run)', async () => {
    const dir = makeRepo();
    const client = clientOf(async () => ({
      duplicate: true,
      memories_created: 0,
      memory_ids: [],
    }));

    const tally = await runBootstrap({
      repoDir: dir,
      dryRun: false,
      depth: 5,
      only: 'docs',
      client,
    });
    expect(tally.duplicates).toBe(1);
    expect(tally.sent).toBe(0);
  });

  it('--exclude drops sources before they cost an extraction call', async () => {
    const dir = makeRepo();
    mkdirSync(join(dir, 'docs'));
    writeFileSync(join(dir, 'docs', 'guide-ja.md'), '# translated duplicate');
    writeFileSync(join(dir, 'docs', 'diagrams.md'), '# huge diagrams');
    const seen: IngestConversationInput[] = [];
    const client = clientOf(async (input) => {
      seen.push(input);
      return okOutput(1);
    });

    const tally = await runBootstrap({
      repoDir: dir,
      dryRun: false,
      depth: 5,
      only: 'docs',
      // One glob matched on the basename, one on the full source path.
      exclude: ['*-ja.md', 'docs/diagrams.md'],
      client,
    });

    expect(tally.chunks).toBe(1);
    expect(seen.map((i) => i.source_path)).toEqual(['README.md']);
  });

  it('--help prints usage and discovers nothing', async () => {
    const client = clientOf(async () => okOutput(1));
    const tally = await runBootstrap({
      repoDir: makeRepo(),
      dryRun: false,
      depth: 5,
      help: true,
      client,
    });

    expect(tally.chunks).toBe(0);
    expect(client.closed()).toBe(false);
  });

  it('dry-run probes the ledger without content and never ingests', async () => {
    const dir = makeRepo();
    const seen: IngestConversationInput[] = [];
    const sendChunk = vi.fn().mockImplementation((input) => {
      seen.push(input);
      return Promise.resolve({
        duplicate: false,
        memories_created: 0,
        memory_ids: [],
      });
    });

    const tally = await runBootstrap({
      repoDir: dir,
      dryRun: true,
      depth: 5,
      only: 'docs',
      client: clientOf(sendChunk),
    });

    expect(tally.chunks).toBe(1);
    // Probe only: same hash, no content on the wire, nothing written.
    expect(seen).toHaveLength(1);
    expect(seen[0]!.probe).toBe(true);
    expect(seen[0]!.transcript_chunk).toBe('');
    expect(seen[0]!.chunk_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(tally.sent).toBe(0);
    expect(tally.memoriesCreated).toBe(0);
  });

  it('dry-run counts already-ingested chunks as the honest cost preview', async () => {
    const dir = makeRepo();
    mkdirSync(join(dir, 'docs'));
    writeFileSync(join(dir, 'docs', 'fresh.md'), '# not ingested yet');
    // The README hash is known to the ledger; the new doc is not.
    const sendChunk = vi.fn().mockImplementation((input) =>
      Promise.resolve({
        duplicate: input.source_path === 'README.md',
        memories_created: 0,
        memory_ids: [],
      })
    );

    const tally = await runBootstrap({
      repoDir: dir,
      dryRun: true,
      depth: 5,
      only: 'docs',
      client: clientOf(sendChunk),
    });

    expect(tally.chunks).toBe(2);
    expect(tally.duplicates).toBe(1);
    expect(tally.failed).toBe(0);
  });

  it('dry-run degrades to a listing when the ledger is unreachable', async () => {
    const dir = makeRepo();
    mkdirSync(join(dir, 'docs'));
    for (const name of ['a.md', 'b.md', 'c.md', 'd.md']) {
      writeFileSync(join(dir, 'docs', name), `# ${name}`);
    }
    const sendChunk = vi.fn().mockRejectedValue(new Error('unreachable'));

    const tally = await runBootstrap({
      repoDir: dir,
      dryRun: true,
      depth: 5,
      only: 'docs',
      client: clientOf(sendChunk),
    });

    // Gives up probing after the streak, still lists every chunk — and a
    // preview never aborts: nothing was going to be written anyway.
    expect(tally.chunks).toBe(5);
    expect(tally.failed).toBe(3);
    expect(tally.aborted).toBe(false);
    expect(sendChunk).toHaveBeenCalledTimes(3);
  });

  it('aborts on a consecutive-failure streak (circuit breaker)', async () => {
    const dir = makeRepo();
    // Four doc chunks; the breaker trips after the third straight failure,
    // so the fourth is never attempted.
    mkdirSync(join(dir, 'docs'));
    writeFileSync(join(dir, 'docs', 'a.md'), 'alpha');
    writeFileSync(join(dir, 'docs', 'b.md'), 'beta');
    writeFileSync(join(dir, 'docs', 'c.md'), 'gamma');
    const sendChunk = vi.fn().mockRejectedValue(new Error('unreachable'));
    const client = clientOf(sendChunk);

    const tally = await runBootstrap({
      repoDir: dir,
      dryRun: false,
      depth: 10,
      only: 'docs',
      client,
    });
    expect(tally.chunks).toBe(4);
    expect(tally.failed).toBe(3);
    expect(tally.aborted).toBe(true);
    expect(sendChunk).toHaveBeenCalledTimes(3);
    expect(client.closed()).toBe(true);
  });
});
