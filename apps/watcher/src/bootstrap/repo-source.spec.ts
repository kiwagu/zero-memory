import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  MAX_CHUNK_CHARS,
  MAX_COMMITS_PER_BATCH,
  collectDocChunks,
  collectHistoryChunks,
  discoverDocFiles,
  splitText,
} from './repo-source.js';

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

const git = (dir: string, ...args: string[]): void => {
  execFileSync('git', ['-C', dir, ...args], {
    encoding: 'utf8',
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'spec',
      GIT_AUTHOR_EMAIL: 'spec@example.invalid',
      GIT_COMMITTER_NAME: 'spec',
      GIT_COMMITTER_EMAIL: 'spec@example.invalid',
    },
  });
};

describe('discoverDocFiles', () => {
  it('finds root READMEs and docs/**/*.md, skipping hidden and build dirs', () => {
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

    const files = discoverDocFiles(dir).map((file) =>
      file.slice(dir.length + 1)
    );
    expect(files).toEqual([
      'README.md',
      'docs/guides/setup.md',
      'docs/intro.md',
    ]);
  });
});

describe('splitText', () => {
  it('returns small text as a single part', () => {
    expect(splitText('hello', 100)).toEqual(['hello']);
  });

  it('splits on paragraph boundaries under the cap', () => {
    const parts = splitText(`${'a'.repeat(60)}\n\n${'b'.repeat(60)}`, 80);
    expect(parts).toEqual(['a'.repeat(60), 'b'.repeat(60)]);
  });

  it('hard-splits a single oversized paragraph', () => {
    const parts = splitText('x'.repeat(250), 100);
    expect(parts.length).toBe(3);
    expect(parts.every((part) => part.length <= 100)).toBe(true);
    expect(parts.join('')).toBe('x'.repeat(250));
  });
});

describe('collectDocChunks', () => {
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

  it('suffixes the parts of a split oversized file', () => {
    const dir = makeRepo();
    const paragraphs = Array.from(
      { length: 40 },
      (_, index) => `paragraph ${index} ${'x'.repeat(1000)}`
    ).join('\n\n');
    writeFileSync(join(dir, 'README.md'), paragraphs);
    expect(paragraphs.length).toBeGreaterThan(MAX_CHUNK_CHARS);

    const chunks = collectDocChunks(dir);
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.map((chunk) => chunk.sourcePath)).toEqual(
      chunks.map((_, index) => `README.md#${index}`)
    );
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
    for (let index = 0; index < MAX_COMMITS_PER_BATCH + 5; index += 1) {
      git(dir, 'commit', '-q', '--allow-empty', '-m', `chore: commit ${index}`);
    }

    const shallow = collectHistoryChunks(dir, 3);
    expect(shallow.length).toBe(1);
    expect(shallow[0]!.content).not.toContain('chore: commit 0\n');

    const deep = collectHistoryChunks(dir, MAX_COMMITS_PER_BATCH + 5);
    expect(deep.length).toBe(2);
    expect(deep[1]!.sourcePath).toBe('git-log#1');
  }, 30_000);
});
