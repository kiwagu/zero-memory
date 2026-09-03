import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { basename, join, relative } from 'node:path';

import type { IngestSourceKind } from '@workspace/contracts';

/** One extraction unit sent to the server as a single ingest chunk. */
export interface BootstrapChunk {
  content: string;
  sourceKind: Exclude<IngestSourceKind, 'transcript'>;
  /** Repo-relative source path (file, or `git-log#<batch>`). */
  sourcePath: string;
}

/**
 * Chunk-size cap in characters (~6k tokens): large enough that a doc keeps
 * its context, small enough for one extraction call. A larger file is split;
 * a git history is batched under the same cap.
 */
export const MAX_CHUNK_CHARS = 24_000;

/** Commit batch cap — keeps one history chunk to a readable arc. */
export const MAX_COMMITS_PER_BATCH = 100;

/** Default history depth: enough arc for a bootstrap without archaeology. */
export const DEFAULT_HISTORY_DEPTH = 300;

const DOC_DIR_NAMES = new Set(['docs', 'doc']);
const SKIPPED_DIR_PREFIXES = ['.', 'node_modules', 'dist', 'build', 'out'];

const isMarkdown = (name: string): boolean =>
  name.toLowerCase().endsWith('.md');

/** README*.md at the repo root + every *.md under docs/ (recursively). */
export const discoverDocFiles = (repoDir: string): string[] => {
  const files: string[] = [];
  for (const entry of readdirSync(repoDir)) {
    const path = join(repoDir, entry);
    let stats;
    try {
      stats = statSync(path);
    } catch {
      continue; // dangling symlink etc. — skip
    }
    if (stats.isFile() && isMarkdown(entry) && /^readme/i.test(entry)) {
      files.push(path);
    }
    if (stats.isDirectory() && DOC_DIR_NAMES.has(entry.toLowerCase())) {
      collectMarkdownRecursive(path, files);
    }
  }
  return files.sort();
};

const collectMarkdownRecursive = (dir: string, out: string[]): void => {
  for (const entry of readdirSync(dir)) {
    if (SKIPPED_DIR_PREFIXES.some((prefix) => entry.startsWith(prefix))) {
      continue;
    }
    const path = join(dir, entry);
    let stats;
    try {
      stats = statSync(path);
    } catch {
      continue;
    }
    if (stats.isDirectory()) {
      collectMarkdownRecursive(path, out);
    } else if (stats.isFile() && isMarkdown(entry)) {
      out.push(path);
    }
  }
};

/** Splits one text into <= MAX_CHUNK_CHARS parts on paragraph boundaries. */
export const splitText = (text: string, maxChars: number): string[] => {
  if (text.length <= maxChars) {
    return [text];
  }
  const parts: string[] = [];
  let current = '';
  for (const paragraph of text.split(/\n\n+/)) {
    // A single oversized paragraph is hard-split — never emit an over-cap part.
    const pieces =
      paragraph.length > maxChars
        ? (paragraph.match(new RegExp(`[\\s\\S]{1,${maxChars}}`, 'g')) ?? [])
        : [paragraph];
    for (const piece of pieces) {
      if (current.length + piece.length + 2 > maxChars && current.length > 0) {
        parts.push(current);
        current = '';
      }
      current = current.length > 0 ? `${current}\n\n${piece}` : piece;
    }
  }
  if (current.length > 0) {
    parts.push(current);
  }
  return parts;
};

/** Doc files -> document chunks (large files split, parts suffixed `#N`). */
export const collectDocChunks = (repoDir: string): BootstrapChunk[] => {
  const chunks: BootstrapChunk[] = [];
  for (const file of discoverDocFiles(repoDir)) {
    let text: string;
    try {
      text = readFileSync(file, 'utf8');
    } catch {
      continue;
    }
    if (text.trim().length === 0) {
      continue;
    }
    const relPath = relative(repoDir, file);
    const parts = splitText(text, MAX_CHUNK_CHARS);
    parts.forEach((part, index) => {
      chunks.push({
        content: `# Document: ${relPath}\n\n${part}`,
        sourceKind: 'document',
        sourcePath: parts.length > 1 ? `${relPath}#${index}` : relPath,
      });
    });
  }
  return chunks;
};

/**
 * Git history -> history chunks: newest-first `git log` (subject + body),
 * batched by commit count and the chunk-size cap. Returns [] outside a git
 * repository or when git is unavailable.
 */
export const collectHistoryChunks = (
  repoDir: string,
  depth: number = DEFAULT_HISTORY_DEPTH
): BootstrapChunk[] => {
  let log: string;
  try {
    log = execFileSync(
      'git',
      [
        '-C',
        repoDir,
        'log',
        `-n`,
        String(depth),
        '--date=short',
        // %x1e (record separator) delimits commits regardless of body content.
        '--pretty=format:%x1e%h %ad %s%n%b',
      ],
      { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }
    );
  } catch {
    return [];
  }
  const commits = log
    .split('\u001e')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
  if (commits.length === 0) {
    return [];
  }

  const repoName = basename(repoDir);
  const chunks: BootstrapChunk[] = [];
  let batch: string[] = [];
  let batchChars = 0;
  const flush = (): void => {
    if (batch.length === 0) {
      return;
    }
    chunks.push({
      content:
        `# Git history of ${repoName} ` +
        `(batch ${chunks.length}, newest first)\n\n${batch.join('\n\n')}`,
      sourceKind: 'history',
      sourcePath: `git-log#${chunks.length}`,
    });
    batch = [];
    batchChars = 0;
  };
  for (const commit of commits) {
    const entry =
      commit.length > MAX_CHUNK_CHARS
        ? commit.slice(0, MAX_CHUNK_CHARS)
        : commit;
    if (
      batch.length >= MAX_COMMITS_PER_BATCH ||
      batchChars + entry.length > MAX_CHUNK_CHARS
    ) {
      flush();
    }
    batch.push(entry);
    batchChars += entry.length + 2;
  }
  flush();
  return chunks;
};
