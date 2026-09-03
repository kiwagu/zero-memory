/** One prose section of a CLAUDE.md file. */
export interface ClaudeMdSection {
  /** Heading text without the leading `#`s (empty for the preamble). */
  heading: string;
  /** The full section text (heading + body), trimmed — the memory content. */
  content: string;
  /** Stable slug of the heading, for a per-section source anchor. */
  slug: string;
}

/** `@`-import line: `@path/to/rule.mdc` — the distilled rules layer, skipped. */
const isImportLine = (line: string): boolean => /^@\S/.test(line.trim());

const isHeadingLine = (line: string): boolean => /^#{1,6}\s/.test(line);

const slugify = (heading: string): string =>
  heading
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60) || 'preamble';

/**
 * Splits a CLAUDE.md file into level-2 (`## `) sections, plus the preamble
 * before the first one. A section is KEPT only if it carries prose beyond
 * headings and `@`-rule imports — so a project CLAUDE.md that is just a list of
 * `@.cursor/rules/*` pulls yields nothing (the rules layer is imported
 * separately, or deliberately not at all).
 */
export const splitClaudeMdSections = (raw: string): ClaudeMdSection[] => {
  const lines = raw.split('\n');
  const blocks: { heading: string; body: string[] }[] = [];
  let current: { heading: string; body: string[] } = { heading: '', body: [] };

  for (const line of lines) {
    if (/^##\s/.test(line)) {
      blocks.push(current);
      current = { heading: line.replace(/^#+\s*/, '').trim(), body: [] };
    } else {
      current.body.push(line);
    }
  }
  blocks.push(current);

  const sections: ClaudeMdSection[] = [];
  for (const block of blocks) {
    const prose = block.body.filter(
      (line) =>
        line.trim().length > 0 && !isHeadingLine(line) && !isImportLine(line)
    );
    if (prose.length === 0) {
      continue; // heading-only or pure @-import section — nothing to import
    }
    const headingPart = block.heading ? `## ${block.heading}\n` : '';
    const content = `${headingPart}${block.body.join('\n')}`.trim();
    if (content.length === 0) {
      continue;
    }
    sections.push({
      heading: block.heading,
      content,
      slug: slugify(block.heading),
    });
  }
  return sections;
};
