/**
 * A Claude Code auto-memory file: YAML-ish frontmatter (`name`, `description`,
 * `metadata.type`) followed by the fact body. The format is fixed and shallow,
 * so a targeted parser is enough — no YAML dependency.
 */
export interface ParsedMemoryFile {
  name?: string;
  description?: string;
  /** `metadata.type` — drives kind + scope routing. Absent if not declared. */
  type?: string;
  /** The fact itself (everything after the frontmatter), trimmed. */
  body: string;
}

const FRONTMATTER_RE = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/;

/** Reads a scalar `key: value` from the frontmatter block (top level). */
const readScalar = (frontmatter: string, key: string): string | undefined => {
  const match = frontmatter.match(new RegExp(`^${key}:\\s*(.+?)\\s*$`, 'm'));
  return match ? stripQuotes(match[1]!) : undefined;
};

/** Reads `metadata.type` from a `metadata:` block's indented `type:` line. */
const readMetadataType = (frontmatter: string): string | undefined => {
  const match = frontmatter.match(/^\s+type:\s*(.+?)\s*$/m);
  return match ? stripQuotes(match[1]!) : undefined;
};

const stripQuotes = (value: string): string =>
  value.replace(/^["']|["']$/g, '').trim();

/**
 * Parses an auto-memory file. When there is no frontmatter the whole text is
 * the body (a plain note), so nothing is lost.
 */
export const parseMemoryFile = (raw: string): ParsedMemoryFile => {
  const match = raw.match(FRONTMATTER_RE);
  if (!match) {
    return { body: raw.trim() };
  }
  const [, frontmatter, body] = match;
  return {
    name: readScalar(frontmatter!, 'name'),
    description: readScalar(frontmatter!, 'description'),
    type: readMetadataType(frontmatter!),
    body: (body ?? '').trim(),
  };
};
