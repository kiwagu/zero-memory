import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { ClaudeCodeSourceAdapter } from './claude-code-adapter.js';

describe('ClaudeCodeSourceAdapter.discover', () => {
  let home: string;

  const memoryFile = (type: string, body: string): string =>
    [
      '---',
      'name: n',
      'description: d',
      'metadata:',
      `  type: ${type}`,
      '---',
      body,
    ].join('\n');

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'zm-import-'));
  });
  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
  });

  it('discovers auto-memory files, resolves project scope from a transcript, and excludes MEMORY.md', async () => {
    const projectDir = join(
      home,
      '.claude',
      'projects',
      '-home-dev-repos-alpha'
    );
    const memoryDir = join(projectDir, 'memory');
    mkdirSync(memoryDir, { recursive: true });
    writeFileSync(join(memoryDir, 'MEMORY.md'), '# index\n- a\n');
    writeFileSync(
      join(memoryDir, 'profile.md'),
      memoryFile('user', 'The user prefers Bun.')
    );
    writeFileSync(
      join(memoryDir, 'decision.md'),
      memoryFile('project', 'Chose Supabase.\n**Why:** self-hosting is easy.')
    );
    // A transcript so the real project path is recovered from its cwd.
    writeFileSync(
      join(projectDir, 'session.jsonl'),
      JSON.stringify({
        type: 'user',
        cwd: '/home/dev/repos/alpha',
        message: { role: 'user', content: 'hi' },
      }) + '\n'
    );

    const items = await new ClaudeCodeSourceAdapter().discover({
      homeDir: home,
      cwd: home, // no project CLAUDE.md here
    });

    const byPath = (needle: string) =>
      items.find((item) => item.sourcePath.includes(needle));

    expect(items.some((i) => i.sourcePath.endsWith('MEMORY.md'))).toBe(false);

    const profile = byPath('profile.md');
    expect(profile).toMatchObject({
      kind: 'preference',
      target: 'personal',
      content: 'The user prefers Bun.',
    });
    expect(profile?.projectHint).toBeUndefined();

    const decision = byPath('decision.md');
    expect(decision).toMatchObject({
      kind: 'decision',
      target: 'project',
      projectHint: '/home/dev/repos/alpha',
    });
  });

  // Kind from the frontmatter type (a project memory with a **Why:** is a
  // decision), and target by who it is about: the user, or the project.
  it.each([
    ['user', 'The user prefers Bun.', 'preference', 'personal'],
    ['feedback', 'Keep commits to one line.', 'convention', 'personal'],
    ['reference', 'The runbook lives in the wiki.', 'reference', 'project'],
    ['project', 'Chose X.\n**Why:** faster.', 'decision', 'project'],
    ['project', 'The port is 55322.', 'fact', 'project'],
    [undefined, 'An untyped note.', 'fact', 'project'],
  ])(
    'imports a memory of type %s as its kind and target',
    async (type, body, kind, target) => {
      const memoryDir = join(
        home,
        '.claude',
        'projects',
        '-home-dev-repos-alpha',
        'memory'
      );
      mkdirSync(memoryDir, { recursive: true });
      writeFileSync(
        join(memoryDir, 'one.md'),
        type === undefined ? body : memoryFile(type, body)
      );

      const [item] = await new ClaudeCodeSourceAdapter().discover({
        homeDir: home,
        cwd: home,
      });

      expect(item).toMatchObject({ content: body, kind, target });
    }
  );

  it('discovers user-global CLAUDE.md prose as personal conventions', async () => {
    mkdirSync(join(home, '.claude'), { recursive: true });
    writeFileSync(
      join(home, '.claude', 'CLAUDE.md'),
      ['# Global', '', '## ZM first', 'Query ZM before grep.'].join('\n')
    );

    const items = await new ClaudeCodeSourceAdapter().discover({
      homeDir: home,
      cwd: home,
    });

    const zm = items.find((i) => i.content.includes('Query ZM before grep.'));
    expect(zm).toMatchObject({ kind: 'convention', target: 'personal' });
    expect(zm?.sourcePath).toContain('CLAUDE.md#');
  });
});
