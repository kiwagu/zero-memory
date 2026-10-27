import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Real git, run the way the watcher's own git reads meet it: a throwaway
 * identity, no signing and no hooks from the machine's own configuration.
 */
const IDENTITY = {
  GIT_AUTHOR_NAME: 't',
  GIT_AUTHOR_EMAIL: 't@t',
  GIT_COMMITTER_NAME: 't',
  GIT_COMMITTER_EMAIL: 't@t',
};

export const git = (cwd: string, ...args: string[]): string =>
  execFileSync('git', ['-c', 'commit.gpgsign=false', ...args], {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, ...IDENTITY },
  }).trim();

/**
 * Commits one file (its name is its content) and returns the new sha. Each
 * message is its own paragraph, so a trailer goes in as the last one.
 */
export const commit = (
  cwd: string,
  file: string,
  ...messages: string[]
): string => {
  writeFileSync(join(cwd, file), file);
  git(cwd, 'add', file);
  const paragraphs = messages.length > 0 ? messages : [`add ${file}`];
  git(
    cwd,
    'commit',
    '-q',
    '--no-verify',
    ...paragraphs.flatMap((message) => ['-m', message])
  );
  return git(cwd, 'rev-parse', 'HEAD');
};

/**
 * Makes `cwd` a repository on `branch` with one commit — a branch with no
 * commit yet has no name for `rev-parse` to read — and, when given, an
 * `origin` remote the repository is then named after.
 */
export const initRepo = (
  cwd: string,
  { branch = 'main', origin }: { branch?: string; origin?: string } = {}
): void => {
  git(cwd, 'init', '-q', '-b', branch);
  if (origin) git(cwd, 'remote', 'add', 'origin', origin);
  git(
    cwd,
    'commit',
    '-q',
    '--no-verify',
    '--allow-empty',
    '-m',
    'chore: start'
  );
};
