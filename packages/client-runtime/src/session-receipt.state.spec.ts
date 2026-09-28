import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  claimReceipt,
  loadReceiptState,
  recordCapturedMemories,
} from './session-receipt.state.js';

let dir: string;
let path: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'zm-receipt-state-'));
  path = join(dir, 'session-receipts.json');
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('receipt state file', () => {
  it('accumulates captured counts and keeps the first capture time', () => {
    recordCapturedMemories(path, 'sess-1', 2, 10);
    recordCapturedMemories(path, 'sess-1', 3, 20);

    expect(loadReceiptState(path)['sess-1']).toEqual({
      captured: 5,
      first_capture_at: 10,
      receipted: false,
      at: 20,
    });
  });

  it('claims the receipt once: the second claim is silent', () => {
    recordCapturedMemories(path, 'sess-1', 4, 10);

    const first = claimReceipt(path, 'sess-1', 20);
    expect(first).toMatchObject({ captured: 4, first_capture_at: 10 });

    expect(claimReceipt(path, 'sess-1', 30)).toBeNull();
  });

  it('claims a session with no captures (read-only session) as zero', () => {
    const claimed = claimReceipt(path, 'sess-empty', 5);
    expect(claimed).toMatchObject({ captured: 0 });
    expect(claimed?.first_capture_at).toBeUndefined();
  });
});
