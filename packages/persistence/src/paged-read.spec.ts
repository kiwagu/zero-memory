import { describe, expect, it, vi } from 'vitest';

import { readAllPages } from './paged-read.js';

/** A fake table that answers ranged reads the way PostgREST does. */
const table = (rowCount: number, serverCap = Infinity) => {
  const all = Array.from({ length: rowCount }, (_, i) => ({ id: i }));
  return vi.fn((from: number, to: number) =>
    Promise.resolve({
      data: all.slice(from, Math.min(to + 1, from + serverCap)),
      error: null,
    })
  );
};

describe('readAllPages', () => {
  it('collects every row across pages', async () => {
    const page = table(1203);
    const rows = await readAllPages(page, { pageSize: 500 });
    expect(rows).toHaveLength(1203);
    // 500 + 500 + 203 + one empty page that proves the end.
    expect(page).toHaveBeenCalledTimes(4);
  });

  it('keeps reading past a SHORT page — the bug this exists to prevent', async () => {
    // The server caps every response at 100 rows even though 500 were asked
    // for. A short page therefore means nothing about the end of the table.
    const page = table(250, 100);
    const rows = await readAllPages(page, { pageSize: 500 });
    expect(rows).toHaveLength(250);
  });

  it('stops on an empty page and asks for nothing more', async () => {
    const page = table(0);
    await expect(readAllPages(page)).resolves.toEqual([]);
    expect(page).toHaveBeenCalledTimes(1);
  });

  it('asks for ranges that tile the table without gaps or overlap', async () => {
    const page = table(1000);
    await readAllPages(page, { pageSize: 400 });
    expect(
      page.mock.calls.map(([from, to]: [number, number]) => [from, to])
    ).toEqual([
      [0, 399],
      [400, 799],
      [800, 1199],
      [1000, 1399],
    ]);
  });

  it('throws on a page error instead of returning what it has', async () => {
    const page = vi.fn(() =>
      Promise.resolve({ data: null, error: { message: 'connection reset' } })
    );
    await expect(readAllPages(page, { label: 'entities' })).rejects.toThrow(
      /entities failed at offset 0: connection reset/
    );
  });

  it('refuses to return a truncated read when the ceiling is reached', async () => {
    // A factory that ignores the range and always answers a full page is the
    // runaway this ceiling exists for.
    const page = vi.fn(() =>
      Promise.resolve({ data: [{ id: 1 }, { id: 2 }], error: null })
    );
    await expect(
      readAllPages(page, { pageSize: 2, maxRows: 6, label: 'edges' })
    ).rejects.toThrow(/edges exceeded 6 rows/);
  });
});
