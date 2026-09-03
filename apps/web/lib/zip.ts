/**
 * A minimal, dependency-free ZIP writer using the STORE method (no
 * compression). Enough to package a memory export tree for the browser to
 * download, and deliberately tiny: keeping the export path — which carries the
 * user's own memory content out of the database — free of third-party code.
 *
 * Deterministic: modification time is pinned to zero and entries are written in
 * the order given, so the same tree produces the same archive. (The git-diff
 * guarantee lives in the extracted `.md` bytes, not the archive envelope.)
 * Scope: 32-bit sizes/offsets (no zip64); ample for a personal memory export.
 */

const encoder = new TextEncoder();

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (let i = 0; i < bytes.length; i += 1) {
    crc = CRC_TABLE[(crc ^ bytes[i]!) & 0xff]! ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function u16(n: number): Uint8Array {
  return new Uint8Array([n & 0xff, (n >>> 8) & 0xff]);
}

function u32(n: number): Uint8Array {
  return new Uint8Array([
    n & 0xff,
    (n >>> 8) & 0xff,
    (n >>> 16) & 0xff,
    (n >>> 24) & 0xff,
  ]);
}

function concat(chunks: Uint8Array[]): Uint8Array {
  const total = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}

export interface ZipEntry {
  /** POSIX-style path inside the archive, e.g. `proj.zm/note.md`. */
  path: string;
  /** File contents; encoded as UTF-8. */
  content: string;
}

/** Builds a STORE-method ZIP archive from the given entries. */
export function createZip(entries: ZipEntry[]): Uint8Array {
  const FLAG_UTF8 = 0x0800; // filename/comment are UTF-8

  const local: Uint8Array[] = [];
  const central: Uint8Array[] = [];
  let offset = 0;

  for (const entry of entries) {
    const name = encoder.encode(entry.path);
    const data = encoder.encode(entry.content);
    const crc = crc32(data);

    const localHeader = concat([
      u32(0x04034b50), // local file header signature
      u16(20), // version needed to extract
      u16(FLAG_UTF8), // general purpose bit flag
      u16(0), // compression method: store
      u16(0), // last mod time (pinned)
      u16(0), // last mod date (pinned)
      u32(crc),
      u32(data.length), // compressed size
      u32(data.length), // uncompressed size
      u16(name.length),
      u16(0), // extra field length
      name,
    ]);
    local.push(localHeader, data);

    central.push(
      concat([
        u32(0x02014b50), // central directory header signature
        u16(20), // version made by
        u16(20), // version needed to extract
        u16(FLAG_UTF8),
        u16(0), // compression: store
        u16(0), // mod time
        u16(0), // mod date
        u32(crc),
        u32(data.length),
        u32(data.length),
        u16(name.length),
        u16(0), // extra length
        u16(0), // comment length
        u16(0), // disk number start
        u16(0), // internal attributes
        u32(0), // external attributes
        u32(offset), // relative offset of local header
        name,
      ])
    );

    offset += localHeader.length + data.length;
  }

  const centralDir = concat(central);
  const eocd = concat([
    u32(0x06054b50), // end of central directory signature
    u16(0), // disk number
    u16(0), // disk with central directory
    u16(entries.length), // entries on this disk
    u16(entries.length), // total entries
    u32(centralDir.length),
    u32(offset), // central directory offset
    u16(0), // comment length
  ]);

  return concat([...local, centralDir, eocd]);
}
