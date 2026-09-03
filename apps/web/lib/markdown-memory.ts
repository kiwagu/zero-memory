/**
 * The render-relevant fields of a memory, structurally typed so this module
 * needs no cross-package import: both the DB `MemoryRow` and the server's
 * `export_memories` tool items satisfy it. (Web cannot import @workspace/
 * contracts under Turbopack/NodeNext — the same constraint noted below.)
 */
export interface RenderableMemory {
  id: string;
  content: string;
  content_original: string | null;
  content_lang: string | null;
  kind: string;
  scope: string;
  visibility: string;
  author_kind: string;
  agent_name: string | null;
  source: unknown;
  superseded_by: string | null;
  invalidated_at: string | null;
  created_at: string;
}

/**
 * Deterministic Markdown rendering of a single memory (memory-as-code): one
 * memory = one file, so an unchanged memory always renders byte-for-byte the
 * same and a re-export yields an empty git diff. The canonical English content
 * is the file body; any pre-translation original is kept alongside it behind a
 * machine-readable marker so the round-trip parser can drop it.
 *
 * NOTE (CLI symmetry): these are pure functions of a MemoryRow with no web
 * dependency. When the `zm-watcher export` subcommand lands they are the
 * natural thing to lift into a shared package so client and dashboard render
 * identical trees; kept in the web app for now to avoid the Turbopack/NodeNext
 * `.js`-internal-import constraint that blocks web from importing such packages.
 */

/** Marker that separates the canonical body from the original-language source. */
const ORIGINAL_MARKER = '<!-- zm:original';
const ORIGINAL_MARKER_RE = /\n<!-- zm:original(?: lang=([^\s]+))? -->\n/;

/** Frontmatter block: `---\n…\n---` at the very start, body follows. */
const FRONTMATTER_RE = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/;

/**
 * JSON with keys sorted at every level, so a jsonb column whose key order the
 * database does not guarantee still renders identically across exports.
 */
function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(',')}]`;
  }
  const entries = Object.keys(value as Record<string, unknown>)
    .sort()
    .map((key) => {
      const v = (value as Record<string, unknown>)[key];
      return v === undefined
        ? null
        : `${JSON.stringify(key)}:${stableStringify(v)}`;
    })
    .filter((entry): entry is string => entry !== null);
  return `{${entries.join(',')}}`;
}

/** kebab hint drawn from the first words of the content, for a readable slug. */
function slugHint(content: string): string {
  return content
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .split('-')
    .filter(Boolean)
    .slice(0, 6)
    .join('-')
    .slice(0, 48)
    .replace(/-+$/g, '');
}

/** The random id body (`mem_<rand>.<ts>` -> `<rand>`): unique and stable. */
function idBody(id: string): string {
  return id.replace(/^mem_/, '').split('.')[0] ?? id;
}

/**
 * File slug: readable content hint plus the id body, which guarantees
 * uniqueness and stability regardless of how the hint collides or is empty.
 */
export function memorySlug(
  memory: Pick<RenderableMemory, 'id' | 'content'>
): string {
  const hint = slugHint(memory.content);
  const body = idBody(memory.id);
  return hint ? `${hint}--${body}` : body;
}

/**
 * Tree path for a memory: `<scope>/<slug>.md`, with superseded/invalidated
 * memories moved under `archive/` so the temporal drift shows up as a file
 * move in the git diff rather than being dropped.
 */
export function memoryFilePath(memory: RenderableMemory): string {
  const archived = Boolean(memory.superseded_by || memory.invalidated_at);
  const leaf = `${memory.scope}/${memorySlug(memory)}.md`;
  return archived ? `archive/${leaf}` : leaf;
}

/** One `key: value` frontmatter line, or null when the value is empty. */
function line(key: string, value: string | null | undefined): string | null {
  return value ? `${key}: ${value}` : null;
}

/**
 * Renders a memory to a deterministic Markdown file. Fields are emitted in a
 * fixed order and empty ones skipped, so the output is stable for a given row.
 */
export function renderMemoryFile(memory: RenderableMemory): string {
  const source =
    memory.source && Object.keys(memory.source as object).length > 0
      ? stableStringify(memory.source)
      : null;

  const frontmatter = [
    line('id', memory.id),
    line('kind', memory.kind),
    line('scope', memory.scope),
    line('visibility', memory.visibility),
    line('lang', memory.content_lang ?? 'en'),
    line('created_at', memory.created_at),
    line('author_kind', memory.author_kind),
    line('agent_name', memory.agent_name),
    line('superseded_by', memory.superseded_by),
    line('invalidated_at', memory.invalidated_at),
    line('source', source),
  ].filter((entry): entry is string => entry !== null);

  const body = memory.content_original
    ? `${memory.content}\n\n${ORIGINAL_MARKER} lang=${
        memory.content_lang ?? 'unknown'
      } -->\n${memory.content_original}`
    : memory.content;

  return `---\n${frontmatter.join('\n')}\n---\n\n${body}\n`;
}

/** A memory recovered from an exported file — enough to re-import it. */
export interface ParsedExportedMemory {
  /** All frontmatter scalars, verbatim (e.g. `kind`, `scope`, `visibility`). */
  frontmatter: Record<string, string>;
  /** Canonical English content (the original-language section stripped off). */
  content: string;
  /** Pre-translation original, when the file carried one. */
  original?: { text: string; lang?: string };
}

/** Reads every top-level `key: value` scalar from a frontmatter block. */
function readFrontmatter(frontmatter: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const raw of frontmatter.split('\n')) {
    const match = raw.match(/^([a-z_]+):\s*(.+?)\s*$/);
    if (match) {
      out[match[1]!] = match[2]!;
    }
  }
  return out;
}

/**
 * Parses an exported memory file back into its parts. The inverse of
 * `renderMemoryFile`: frontmatter scalars plus the canonical body, with the
 * original-language section (if any) split back out. A file with no
 * frontmatter degrades to all-body, losing nothing.
 */
export function parseMemoryFile(raw: string): ParsedExportedMemory {
  const match = raw.match(FRONTMATTER_RE);
  const frontmatter = match ? readFrontmatter(match[1]!) : {};
  const bodyRaw = (match ? match[2]! : raw).trim();

  if (!bodyRaw.includes(ORIGINAL_MARKER)) {
    return { frontmatter, content: bodyRaw };
  }
  const split = bodyRaw.match(ORIGINAL_MARKER_RE);
  if (!split) {
    return { frontmatter, content: bodyRaw };
  }
  const content = bodyRaw.slice(0, split.index).trim();
  const original = bodyRaw.slice(split.index! + split[0].length).trim();
  return {
    frontmatter,
    content,
    original: { text: original, lang: split[1] },
  };
}
