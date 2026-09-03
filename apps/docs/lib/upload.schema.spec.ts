/**
 * The upload contract is the only thing standing between an HTTP request and
 * a write into the repository's content tree, so its rejections are the
 * security surface: traversal, absolute paths, non-markdown targets, and
 * bodies that would render as a page with no frontmatter.
 */
import { describe, expect, it } from 'vitest';

import { contentPathSchema, uploadRequestSchema } from './upload.schema';

const body = [
  '---',
  'title: A page',
  'description: One line.',
  '---',
  '',
  'Body.',
].join('\n');

describe('contentPathSchema', () => {
  it.each([
    'index.mdx',
    'guides/new-page.mdx',
    'guides/nested/page.md',
    'concepts/memory-model.mdx',
  ])('accepts %s', (path) => {
    expect(contentPathSchema.safeParse(path).success).toBe(true);
  });

  it.each([
    ['traversal', '../../etc/passwd.md'],
    ['traversal mid-path', 'guides/../../secrets.md'],
    ['absolute path', '/etc/hosts.md'],
    ['non-markdown', 'guides/page.txt'],
    ['no extension', 'guides/page'],
    ['dotfile', 'guides/.env.md'],
    ['too deep', 'a/b/c/d.md'],
    ['uppercase', 'Guides/Page.mdx'],
    ['spaces', 'guides/my page.mdx'],
    ['empty', ''],
  ])('rejects %s', (_label, path) => {
    expect(contentPathSchema.safeParse(path).success).toBe(false);
  });
});

describe('uploadRequestSchema', () => {
  it('accepts a page with title and description frontmatter', () => {
    const parsed = uploadRequestSchema.safeParse({
      path: 'guides/new-page.mdx',
      content: body,
      overwrite: false,
    });

    expect(parsed.success).toBe(true);
  });

  it('defaults overwrite to false when it is absent', () => {
    const parsed = uploadRequestSchema.parse({
      path: 'guides/new-page.mdx',
      content: body,
    });

    expect(parsed.overwrite).toBe(false);
  });

  it.each([
    ['no frontmatter at all', 'Just prose.'],
    ['unterminated frontmatter', '---\ntitle: A page\ndescription: One.'],
    ['missing title', '---\ndescription: One line.\n---\n\nBody.'],
    ['missing description', '---\ntitle: A page\n---\n\nBody.'],
    ['empty title', '---\ntitle:\ndescription: One line.\n---\n\nBody.'],
    ['empty body', ''],
  ])('rejects content with %s', (_label, content) => {
    const parsed = uploadRequestSchema.safeParse({
      path: 'guides/new-page.mdx',
      content,
      overwrite: false,
    });

    expect(parsed.success).toBe(false);
  });

  it('rejects a body past the size ceiling', () => {
    const parsed = uploadRequestSchema.safeParse({
      path: 'guides/new-page.mdx',
      content: `${body}\n${'x'.repeat(512_001)}`,
      overwrite: false,
    });

    expect(parsed.success).toBe(false);
  });
});
