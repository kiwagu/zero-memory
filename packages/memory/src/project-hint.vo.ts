import { Err, Ok, type Result } from 'oxide.ts';

/** How a project identity was expressed: a git remote url or a filesystem path. */
export type ProjectMatchKind = 'git_remote' | 'path';

export interface NormalizedProjectHint {
  kind: ProjectMatchKind;
  /** Canonical lookup key, e.g. `github.com/org/repo` or `/home/u/repo`. */
  key: string;
  /** ltree-safe label derived from the repo/directory name. */
  slug: string;
}

const GIT_REMOTE_PATTERN = /^(?:[a-z][a-z0-9+.-]*:\/\/|git@|ssh:\/\/)/i;

/** Lowercase [a-z0-9_] label for ltree scopes; hyphens become underscores. */
const slugify = (raw: string): string =>
  raw
    .toLowerCase()
    .replace(/\.git$/, '')
    .replace(/[^a-z0-9_]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .replace(/_{2,}/g, '_');

const normalizeGitRemote = (
  raw: string
): Result<NormalizedProjectHint, string> => {
  // scp-like syntax: git@host:org/repo(.git)
  const scpMatch = /^git@([^:/]+):(.+)$/.exec(raw);
  let host: string;
  let pathname: string;
  if (scpMatch) {
    host = scpMatch[1]!;
    pathname = scpMatch[2]!;
  } else {
    let url: URL;
    try {
      url = new URL(raw);
    } catch {
      return Err(`Unparseable git remote "${raw}".`);
    }
    host = url.hostname;
    pathname = url.pathname;
  }
  const segments = pathname
    .replace(/\.git$/, '')
    .split('/')
    .filter((segment) => segment.length > 0);
  if (segments.length === 0) {
    return Err(`Git remote "${raw}" has no repository path.`);
  }
  const key = `${host.toLowerCase()}/${segments.join('/').toLowerCase()}`;
  return Ok({ kind: 'git_remote', key, slug: slugify(segments.at(-1)!) });
};

const normalizePath = (raw: string): Result<NormalizedProjectHint, string> => {
  // Pure normalization (no fs access): collapse separators, drop trailing /.
  const key = raw.replace(/\/{2,}/g, '/').replace(/\/+$/, '') || '/';
  const lastSegment = key.split('/').filter(Boolean).at(-1);
  if (!lastSegment) {
    return Err(`Path hint "${raw}" has no usable segment.`);
  }
  const slug = slugify(lastSegment);
  if (slug.length === 0) {
    return Err(`Path hint "${raw}" yields an empty scope label.`);
  }
  return Ok({ kind: 'path', key, slug });
};

/**
 * Normalizes a raw project hint (whatever the client passed: a git remote in
 * https/ssh/scp form or a filesystem path) into a deterministic binding key
 * plus the ltree label used when a scope must be auto-created.
 */
export const normalizeProjectHint = (
  raw: string
): Result<NormalizedProjectHint, string> => {
  const trimmed = raw.trim();
  if (trimmed.length === 0) {
    return Err('Project hint must not be empty.');
  }
  return GIT_REMOTE_PATTERN.test(trimmed)
    ? normalizeGitRemote(trimmed)
    : normalizePath(trimmed);
};
