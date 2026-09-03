import { describe, expect, it } from 'vitest';

import { createZip } from './zip';
import { readZip } from './unzip';

describe('readZip (round-trips createZip)', () => {
  it('recovers store-method entries verbatim, including UTF-8 and nesting', async () => {
    const entries = [
      { path: 'proj.zm/a-note--abc.md', content: 'Token price is a constant.' },
      {
        path: 'user.usr_x/original--def.md',
        content: 'トークンの価格は一定です。',
      },
    ];
    const back = await readZip(createZip(entries));
    expect(back).toEqual(entries);
  });

  it('skips directory entries and rejects non-zip input', async () => {
    const back = await readZip(createZip([{ path: 'x.md', content: 'hi' }]));
    expect(back).toHaveLength(1);
    await expect(readZip(new Uint8Array([1, 2, 3, 4]))).rejects.toThrow();
  });
});
