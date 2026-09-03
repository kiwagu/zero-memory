/**
 * A minimal, dependency-free ZIP reader — the inverse of {@link ./zip.ts}, so a
 * user can re-import the exact `.zip` the dashboard produced. Parses the central
 * directory (robust to data descriptors) and decompresses entries: STORE
 * (method 0) verbatim, DEFLATE (method 8) via the browser-native
 * DecompressionStream, so OS-recompressed archives round-trip too. No zip64.
 */

const decoder = new TextDecoder();

/** Inflates a raw DEFLATE payload using the platform's DecompressionStream. */
async function inflateRaw(bytes: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([bytes as BlobPart])
    .stream()
    .pipeThrough(new DecompressionStream('deflate-raw'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

export interface UnzippedEntry {
  path: string;
  content: string;
}

/** Extracts every file entry from a ZIP archive as decoded UTF-8 text. */
export async function readZip(bytes: Uint8Array): Promise<UnzippedEntry[]> {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

  // End of central directory: scan backwards for its signature.
  let eocd = -1;
  for (let i = bytes.length - 22; i >= 0; i -= 1) {
    if (view.getUint32(i, true) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) {
    throw new Error('Not a ZIP archive (no end-of-central-directory record).');
  }

  const count = view.getUint16(eocd + 10, true);
  let ptr = view.getUint32(eocd + 16, true);
  const entries: UnzippedEntry[] = [];

  for (let n = 0; n < count; n += 1) {
    if (view.getUint32(ptr, true) !== 0x02014b50) {
      throw new Error('Corrupt ZIP: bad central directory header.');
    }
    const method = view.getUint16(ptr + 10, true);
    const compSize = view.getUint32(ptr + 20, true);
    const nameLen = view.getUint16(ptr + 28, true);
    const extraLen = view.getUint16(ptr + 30, true);
    const commentLen = view.getUint16(ptr + 32, true);
    const localOffset = view.getUint32(ptr + 42, true);
    const name = decoder.decode(bytes.subarray(ptr + 46, ptr + 46 + nameLen));

    // Data begins after the local header, whose own name/extra lengths may
    // differ from the central directory's — read them at the local header.
    const localNameLen = view.getUint16(localOffset + 26, true);
    const localExtraLen = view.getUint16(localOffset + 28, true);
    const dataStart = localOffset + 30 + localNameLen + localExtraLen;
    const payload = bytes.subarray(dataStart, dataStart + compSize);

    const raw = method === 0 ? payload : await inflateRaw(payload);
    // Directory entries end in '/' and carry no content; skip them.
    if (!name.endsWith('/')) {
      entries.push({ path: name, content: decoder.decode(raw) });
    }

    ptr += 46 + nameLen + extraLen + commentLen;
  }

  return entries;
}
