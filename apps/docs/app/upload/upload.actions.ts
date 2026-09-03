'use server';

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';

import { revalidatePath } from 'next/cache';

import { uploadRequestSchema, type UploadResult } from '@/lib/upload.schema';

// The content tree this site serves. Kept in one place so the write path and
// the read path (source.config.ts) can never drift apart.
const CONTENT_ROOT = resolve(process.cwd(), '../../docs');

/**
 * Uploading writes to the repository's working tree, so it is off unless the
 * operator opts in with a shared secret. An unset secret is not a degraded
 * mode — the endpoint simply does not exist.
 */
function readUploadSecret(): string | null {
  const secret = process.env.ZM_DOCS_UPLOAD_TOKEN?.trim();
  return secret ? secret : null;
}

export async function isUploadEnabled(): Promise<boolean> {
  return readUploadSecret() !== null;
}

export async function uploadDocument(
  formData: FormData
): Promise<UploadResult> {
  const secret = readUploadSecret();

  if (!secret) {
    return {
      status: 'rejected',
      message:
        'Uploading is disabled on this deployment. Set ZM_DOCS_UPLOAD_TOKEN to enable it.',
    };
  }

  if (formData.get('token') !== secret) {
    return { status: 'rejected', message: 'Upload token does not match.' };
  }

  const parsed = uploadRequestSchema.safeParse({
    path: formData.get('path'),
    content: formData.get('content'),
    overwrite: formData.get('mode') === 'replace',
  });

  if (!parsed.success) {
    return {
      status: 'rejected',
      message: parsed.error.issues.map((issue) => issue.message).join('; '),
    };
  }

  const { path, content, overwrite } = parsed.data;
  const target = resolve(CONTENT_ROOT, path);

  // Belt and braces: the schema already rejects traversal, and the resolved
  // path must still land inside the content tree.
  const inside = relative(CONTENT_ROOT, target);
  if (inside.startsWith('..') || resolve(CONTENT_ROOT, inside) !== target) {
    return { status: 'rejected', message: 'Path escapes the content tree.' };
  }

  const existing = await readFile(target, 'utf8').catch(() => null);

  if (existing !== null && !overwrite) {
    return {
      status: 'rejected',
      message: `${path} already exists. Choose "Replace the page" to overwrite it.`,
    };
  }

  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, content.endsWith('\n') ? content : `${content}\n`);

  const url = join('/docs', path.replace(/\.mdx?$/, '')).replace(
    /\/index$/,
    ''
  );

  revalidatePath('/docs', 'layout');

  return {
    status: 'written',
    path,
    url,
    replaced: existing !== null,
  };
}
