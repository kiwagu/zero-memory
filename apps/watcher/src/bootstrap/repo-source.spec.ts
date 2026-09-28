import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { git } from '../testing/git-repo.fixture.js';
import { collectDocChunks, collectHistoryChunks } from './repo-source.js';

/** The chunk-size cap a bootstrap holds every chunk to (~6k tokens). */
const CHUNK_CAP = 24_000;
/** The most commits one history chunk carries. */
const COMMITS_PER_BATCH = 100;

const HEADER = (path: string): string => `# Document: ${path}\n\n`;

let repoDir: string | null = null;

const makeRepo = (): string => {
  repoDir = mkdtempSync(join(tmpdir(), 'zm-bootstrap-spec-'));
  return repoDir;
};

afterEach(() => {
  if (repoDir) {
    rmSync(repoDir, { recursive: true, force: true });
    repoDir = null;
  }
});

describe('collectDocChunks', () => {
  it('reads root READMEs and docs/**/*.md, skipping hidden and build dirs', () => {
    const dir = makeRepo();
    writeFileSync(join(dir, 'README.md'), '# root');
    writeFileSync(join(dir, 'CHANGELOG.md'), 'not a readme');
    mkdirSync(join(dir, 'docs', 'guides'), { recursive: true });
    writeFileSync(join(dir, 'docs', 'intro.md'), 'intro');
    writeFileSync(join(dir, 'docs', 'guides', 'setup.md'), 'setup');
    writeFileSync(join(dir, 'docs', 'diagram.png'), 'binary');
    mkdirSync(join(dir, 'docs', 'node_modules'), { recursive: true });
    writeFileSync(join(dir, 'docs', 'node_modules', 'dep.md'), 'dep');
    mkdirSync(join(dir, 'docs', '.hidden'), { recursive: true });
    writeFileSync(join(dir, 'docs', '.hidden', 'x.md'), 'hidden');

    expect(collectDocChunks(dir).map((chunk) => chunk.sourcePath)).toEqual([
      'README.md',
      'docs/guides/setup.md',
      'docs/intro.md',
    ]);
  });

  it('labels chunks with repo-relative paths and skips empty files', () => {
    const dir = makeRepo();
    writeFileSync(join(dir, 'README.md'), '# proj\n\ninteresting');
    mkdirSync(join(dir, 'docs'));
    writeFileSync(join(dir, 'docs', 'empty.md'), '   \n');

    const chunks = collectDocChunks(dir);
    expect(chunks.length).toBe(1);
    expect(chunks[0]!.sourceKind).toBe('document');
    expect(chunks[0]!.sourcePath).toBe('README.md');
    expect(chunks[0]!.content).toContain('# Document: README.md');
    expect(chunks[0]!.content).toContain('interesting');
  });

  it('splits an oversized file on paragraph boundaries, suffixing its parts', () => {
    const dir = makeRepo();
    const first = 'a'.repeat(15_000);
    const second = 'b'.repeat(15_000);
    writeFileSync(join(dir, 'README.md'), `${first}\n\n${second}`);

    expect(collectDocChunks(dir)).toEqual([
      {
        content: `${HEADER('README.md')}${first}`,
        sourceKind: 'document',
        sourcePath: 'README.md#0',
      },
      {
        content: `${HEADER('README.md')}${second}`,
        sourceKind: 'document',
        sourcePath: 'README.md#1',
      },
    ]);
  });

  it('hard-splits a single paragraph past the cap, never emitting an over-cap part', () => {
    const dir = makeRepo();
    const paragraph = 'x'.repeat(2 * CHUNK_CAP + 1_000);
    writeFileSync(join(dir, 'README.md'), paragraph);

    const parts = collectDocChunks(dir).map((chunk) =>
      chunk.content.slice(HEADER('README.md').length)
    );
    expect(parts).toHaveLength(3);
    expect(parts.every((part) => part.length <= CHUNK_CAP)).toBe(true);
    expect(parts.join('')).toBe(paragraph);
  });
});

describe('collectHistoryChunks', () => {
  it('returns [] outside a git repository', () => {
    const dir = makeRepo();
    expect(collectHistoryChunks(dir)).toEqual([]);
  });

  it('batches commits newest-first with subjects and bodies', () => {
    const dir = makeRepo();
    git(dir, 'init', '-q');
    writeFileSync(join(dir, 'a.txt'), '1');
    git(dir, 'add', '.');
    git(dir, 'commit', '-q', '-m', 'feat: first', '-m', 'because reasons');
    writeFileSync(join(dir, 'a.txt'), '2');
    git(dir, 'commit', '-q', '-am', 'fix: second');

    const chunks = collectHistoryChunks(dir, 10);
    expect(chunks.length).toBe(1);
    const chunk = chunks[0]!;
    expect(chunk.sourceKind).toBe('history');
    expect(chunk.sourcePath).toBe('git-log#0');
    expect(chunk.content).toContain('fix: second');
    expect(chunk.content).toContain('feat: first');
    expect(chunk.content).toContain('because reasons');
    expect(chunk.content.indexOf('fix: second')).toBeLessThan(
      chunk.content.indexOf('feat: first')
    );
  });

  it('respects the depth limit and the commit batch cap', () => {
    const dir = makeRepo();
    git(dir, 'init', '-q');
    // History collection reads only commit messages, so empty commits keep
    // this hundred-commit fixture within slow CI runners' spawn budget.
    for (let index = 0; index < COMMITS_PER_BATCH + 5; index += 1) {
      git(dir, 'commit', '-q', '--allow-empty', '-m', `chore: commit ${index}`);
    }

    const shallow = collectHistoryChunks(dir, 3);
    expect(shallow.length).toBe(1);
    expect(shallow[0]!.content).not.toContain('chore: commit 0\n');

    const deep = collectHistoryChunks(dir, COMMITS_PER_BATCH + 5);
    expect(deep.length).toBe(2);
    expect(deep[1]!.sourcePath).toBe('git-log#1');
  }, 30_000);
});
