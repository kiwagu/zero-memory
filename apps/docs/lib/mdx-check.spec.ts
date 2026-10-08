import { describe, expect, it } from 'vitest';

import { blankFrontMatter, checkDocsPage } from './mdx-check.js';

describe('checkDocsPage', () => {
  it('fails a placeholder that a reflow pushed out of its code span', async () => {
    // The defect that cost a release: a blank line inside an inline code span
    // ends the span, and `<platform>` starts a paragraph as a JSX tag.
    const page =
      '---\ntitle: Bundles\n---\n\nPass ``--target\n\n<platform>`` to build.\n';
    const problem = await checkDocsPage('bundles.mdx', page);
    expect(problem).not.toBeNull();
    expect(problem!.message).toMatch(/closing tag/iu);
    // Reported at the file's own line, front matter included.
    expect(problem!.line).toBe(7);
  });

  it('passes the same sentence with the placeholder kept inside the span', async () => {
    const page =
      '---\ntitle: Bundles\n---\n\nPass ``--target <platform>`` to build.\n';
    expect(await checkDocsPage('bundles.mdx', page)).toBeNull();
  });

  it('reads a .md page as Markdown, where angle brackets are not JSX', async () => {
    expect(
      await checkDocsPage('notes.md', 'A placeholder <platform> in prose.\n')
    ).toBeNull();
  });
});

describe('blankFrontMatter', () => {
  it('blanks the front matter but keeps its lines', () => {
    const page = '---\ntitle: A\ndescription: B\n---\n# Body\n';
    const blanked = blankFrontMatter(page);
    expect(blanked).toBe('\n\n\n\n# Body\n');
    expect(blanked.split('\n')).toHaveLength(page.split('\n').length);
  });

  it('leaves a page without front matter untouched', () => {
    expect(blankFrontMatter('# Body\n---\nnot front matter\n')).toBe(
      '# Body\n---\nnot front matter\n'
    );
  });
});
