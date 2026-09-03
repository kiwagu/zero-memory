import { z } from 'zod';

/**
 * A content path is always relative to the docs tree and always ends in a
 * markdown extension. Every segment is a plain kebab/alphanumeric name: no
 * absolute paths, no `..`, no dotfiles, no nested traversal of any kind.
 */
const segment = /^[a-z0-9]+(?:[-.][a-z0-9]+)*$/;

export const contentPathSchema = z
  .string()
  .trim()
  .min(1, 'Path is required')
  .max(200, 'Path is too long')
  .refine((value) => !value.startsWith('/'), 'Path must be relative')
  .refine((value) => /\.mdx?$/.test(value), 'Path must end in .md or .mdx')
  .refine((value) => {
    const segments = value.split('/');
    return segments.length <= 3 && segments.every((part) => segment.test(part));
  }, 'Path may contain only lowercase names, at most two folders deep');

export const uploadRequestSchema = z.object({
  path: contentPathSchema,
  content: z
    .string()
    .min(1, 'Content is required')
    .max(512_000, 'Content exceeds the 500 KB limit')
    .refine(
      (value) => value.startsWith('---'),
      'Content must open with a frontmatter block'
    )
    .refine(
      (value) => /^---\r?\n[\s\S]*?\r?\n---/.test(value),
      'Frontmatter block is not terminated'
    )
    // `[^\S\n]` — horizontal whitespace only. A plain `\s*` would span the
    // newline and let an empty `title:` borrow the next line's text.
    .refine(
      (value) => /^title:[^\S\n]*\S/m.test(value.split(/\r?\n---/)[0] ?? ''),
      'Frontmatter must set a title'
    )
    .refine(
      (value) =>
        /^description:[^\S\n]*\S/m.test(value.split(/\r?\n---/)[0] ?? ''),
      'Frontmatter must set a description'
    ),
  overwrite: z.boolean().default(false),
});

export type UploadRequest = z.infer<typeof uploadRequestSchema>;

export const uploadResultSchema = z.discriminatedUnion('status', [
  z.object({
    status: z.literal('written'),
    path: z.string(),
    url: z.string(),
    replaced: z.boolean(),
  }),
  z.object({
    status: z.literal('rejected'),
    message: z.string(),
  }),
]);

export type UploadResult = z.infer<typeof uploadResultSchema>;
