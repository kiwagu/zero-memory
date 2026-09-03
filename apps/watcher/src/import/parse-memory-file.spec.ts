import { describe, expect, it } from 'vitest';

import { parseMemoryFile } from './parse-memory-file.js';

describe('parseMemoryFile', () => {
  it('reads name/description/metadata.type and trims the body', () => {
    const raw = [
      '---',
      'name: env-loading-gotcha',
      'description: Bun loads .env only from cwd',
      'metadata:',
      '  type: project',
      '---',
      '',
      'Turbo sets cwd=package, so put secrets in apps/<app>/.env.',
      '',
    ].join('\n');

    expect(parseMemoryFile(raw)).toEqual({
      name: 'env-loading-gotcha',
      description: 'Bun loads .env only from cwd',
      type: 'project',
      body: 'Turbo sets cwd=package, so put secrets in apps/<app>/.env.',
    });
  });

  it('strips surrounding quotes from scalar values', () => {
    const raw = [
      '---',
      'name: "quoted-name"',
      "description: 'quoted desc'",
      'metadata:',
      '  type: "user"',
      '---',
      'body',
    ].join('\n');

    const parsed = parseMemoryFile(raw);
    expect(parsed.name).toBe('quoted-name');
    expect(parsed.description).toBe('quoted desc');
    expect(parsed.type).toBe('user');
  });

  it('treats a file with no frontmatter as a plain body', () => {
    const parsed = parseMemoryFile('Just a note.\n');
    expect(parsed).toEqual({ body: 'Just a note.' });
  });
});
