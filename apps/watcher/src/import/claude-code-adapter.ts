import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { basename, join } from 'node:path';

import { parseTranscript } from '@workspace/client-adapter-claude';
import type { ImportMemoryTarget, MemoryKind } from '@workspace/contracts';
import { createLogger } from '@workspace/logger';

import { decodeProjectDir } from '../watcher.js';
import { resolveProjectHint } from '../project-hint-resolver.js';
import { splitClaudeMdSections } from './claude-md.js';
import { parseMemoryFile } from './parse-memory-file.js';
import type {
  DiscoveryContext,
  ImportItem,
  MemorySourceAdapter,
} from './source-adapter.js';

/** The index file is a table of contents, not a fact — never imported. */
const MEMORY_INDEX_FILE = 'MEMORY.md';

/**
 * Maps a Claude Code auto-memory `metadata.type` to a memory kind. `project`
 * splits on the presence of a `**Why:**` marker (a decision-with-why) vs a
 * plain fact — the same heuristic the memory-file convention encodes.
 */
export const mapKind = (type: string | undefined, body: string): MemoryKind => {
  switch (type) {
    case 'user':
      return 'preference';
    case 'feedback':
      return 'convention';
    case 'project':
      return /\*\*Why:\*\*/.test(body) ? 'decision' : 'fact';
    case 'reference':
      return 'reference';
    default:
      return 'fact';
  }
};

/**
 * Routes an auto-memory by `metadata.type`: user/feedback are ABOUT the user
 * (personal); project/reference (and anything untyped in a project's memory
 * dir) are ABOUT the project.
 */
export const mapTarget = (type: string | undefined): ImportMemoryTarget =>
  type === 'user' || type === 'feedback' ? 'personal' : 'project';

/**
 * Source adapter for Claude Code: its per-project auto-memory files and the
 * user-global / project CLAUDE.md prose sections. The `.cursor/rules` and
 * `@`-rule imports are deliberately NOT a source here — that distilled layer is
 * owned elsewhere and importing it would duplicate.
 */
export class ClaudeCodeSourceAdapter implements MemorySourceAdapter {
  readonly tool = 'claude-code';
  readonly label = 'Claude Code (auto-memory + CLAUDE.md)';
  readonly #logger = createLogger('ClaudeCodeSourceAdapter');

  async discover(ctx: DiscoveryContext): Promise<ImportItem[]> {
    return [
      ...this.#discoverAutoMemories(ctx),
      ...this.#discoverUserGlobalClaudeMd(ctx),
      ...this.#discoverProjectClaudeMd(ctx),
    ];
  }

  /** `<home>/.claude/projects/<projdir>/memory/*.md` (excluding the index). */
  #discoverAutoMemories(ctx: DiscoveryContext): ImportItem[] {
    const projectsRoot = join(ctx.homeDir, '.claude', 'projects');
    if (!existsSync(projectsRoot)) {
      return [];
    }
    const items: ImportItem[] = [];
    for (const entry of readdirSync(projectsRoot)) {
      const projectDir = join(projectsRoot, entry);
      const memoryDir = join(projectDir, 'memory');
      if (!existsSync(memoryDir) || !statSync(memoryDir).isDirectory()) {
        continue;
      }
      const projectPath =
        ctx.projectHintOverride ?? this.#resolveProjectPath(projectDir);
      for (const file of readdirSync(memoryDir)) {
        if (!file.endsWith('.md') || file === MEMORY_INDEX_FILE) {
          continue;
        }
        const sourcePath = join(memoryDir, file);
        const parsed = parseMemoryFile(readFileSync(sourcePath, 'utf8'));
        if (parsed.body.length === 0) {
          continue;
        }
        const kind = mapKind(parsed.type, parsed.body);
        // Route by type — but a project item with no resolvable project scope
        // degrades to personal so a memory is never lost or misfiled.
        const wantsProject = mapTarget(parsed.type) === 'project';
        const target: ImportMemoryTarget =
          wantsProject && projectPath ? 'project' : 'personal';
        items.push({
          content: parsed.body,
          kind,
          target,
          ...(target === 'project' && projectPath
            ? { projectHint: projectPath }
            : {}),
          sourcePath,
        });
      }
    }
    return items;
  }

  /** `<home>/.claude/CLAUDE.md` — the user's global working conventions. */
  #discoverUserGlobalClaudeMd(ctx: DiscoveryContext): ImportItem[] {
    const file = join(ctx.homeDir, '.claude', 'CLAUDE.md');
    if (!existsSync(file)) {
      return [];
    }
    return splitClaudeMdSections(readFileSync(file, 'utf8')).map((section) => ({
      content: section.content,
      kind: 'convention' as const,
      target: 'personal' as const,
      sourcePath: `${file}#${section.slug}`,
    }));
  }

  /** `<cwd>/.claude/CLAUDE.md` — the current project's committed conventions. */
  #discoverProjectClaudeMd(ctx: DiscoveryContext): ImportItem[] {
    const file = join(ctx.cwd, '.claude', 'CLAUDE.md');
    if (!existsSync(file)) {
      return [];
    }
    const projectHint = ctx.projectHintOverride ?? resolveProjectHint(ctx.cwd);
    return splitClaudeMdSections(readFileSync(file, 'utf8')).map((section) => ({
      content: section.content,
      kind: 'convention' as const,
      target: 'project' as const,
      projectHint,
      sourcePath: `${file}#${section.slug}`,
    }));
  }

  /**
   * Resolves a `~/.claude/projects/<projdir>` back to its real project path via
   * the `cwd` recorded in a transcript (the same hint the watcher uses), so the
   * project scope matches the watcher's. Falls back to the lossy directory-name
   * decode, then to the raw directory name — always a stable value.
   */
  #resolveProjectPath(projectDir: string): string | undefined {
    const transcripts = readdirSync(projectDir)
      .filter((file) => file.endsWith('.jsonl'))
      .map((file) => join(projectDir, file));
    let newest: { path: string; mtimeMs: number } | undefined;
    for (const path of transcripts) {
      const mtimeMs = statSync(path).mtimeMs;
      if (!newest || mtimeMs > newest.mtimeMs) {
        newest = { path, mtimeMs };
      }
    }
    if (newest) {
      try {
        const { cwd } = parseTranscript(readFileSync(newest.path, 'utf8'));
        if (cwd) {
          return cwd;
        }
      } catch (error) {
        this.#logger.debug('failed to read transcript cwd', {
          path: newest.path,
          error: String(error),
        });
      }
    }
    return decodeProjectDir(basename(projectDir)) ?? undefined;
  }
}
