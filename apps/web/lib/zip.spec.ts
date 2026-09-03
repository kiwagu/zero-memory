import { describe, expect, it } from 'vitest';

import { createZip } from './zip';

const view = (bytes: Uint8Array) => new DataView(bytes.buffer);

describe('createZip', () => {
  it('starts with a local file header and ends with an EOCD record', () => {
    const zip = createZip([{ path: 'a.md', content: 'hello' }]);
    // PK\x03\x04 local file header at offset 0.
    expect(view(zip).getUint32(0, true)).toBe(0x04034b50);
    // PK\x05\x06 end-of-central-directory somewhere near the tail.
    const tail = view(zip).getUint32(zip.length - 22, true);
    expect(tail).toBe(0x06054b50);
  });

  it('records the total entry count in the EOCD', () => {
    const zip = createZip([
      { path: 'a.md', content: 'a' },
      { path: 'b.md', content: 'b' },
      { path: 'c.md', content: 'c' },
    ]);
    // total entries field: 8 bytes into the 22-byte EOCD trailer.
    expect(view(zip).getUint16(zip.length - 22 + 10, true)).toBe(3);
  });

  it('is deterministic for the same tree', () => {
    const entries = [
      { path: 'proj.zm/one.md', content: 'first' },
      { path: 'proj.zm/two.md', content: 'second' },
    ];
    expect(createZip(entries)).toEqual(createZip(entries));
  });

  it('stores content uncompressed and verbatim', () => {
    const zip = createZip([{ path: 'x.md', content: 'PLAINTEXT' }]);
    expect(new TextDecoder().decode(zip)).toContain('PLAINTEXT');
  });
});
