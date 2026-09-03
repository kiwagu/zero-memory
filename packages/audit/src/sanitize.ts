/** Per-string-field cap: long values are clipped to this many characters. */
export const MAX_STRING_LENGTH = 500;

/** Hard cap on the serialized payload; past this it collapses to a marker. */
export const MAX_PAYLOAD_BYTES = 8 * 1024;

const clip = (value: string): string =>
  value.length > MAX_STRING_LENGTH
    ? `${value.slice(0, MAX_STRING_LENGTH)}…[${value.length - MAX_STRING_LENGTH} more]`
    : value;

const truncateDeep = (value: unknown): unknown => {
  if (typeof value === 'string') {
    return clip(value);
  }
  if (Array.isArray(value)) {
    return value.map(truncateDeep);
  }
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, inner] of Object.entries(value)) {
      out[key] = truncateDeep(inner);
    }
    return out;
  }
  return value;
};

/**
 * Turn a command instance into a safe, size-bounded audit payload:
 *   1. copy its own enumerable properties, truncating every string field to
 *      {@link MAX_STRING_LENGTH};
 *   2. if the serialized result still exceeds {@link MAX_PAYLOAD_BYTES}, drop it
 *      entirely for a `{ truncated: true, command_keys: [...] }` marker.
 *
 * Commands carry no secrets by construction, but memory content can be large,
 * so the caps are mandatory. The keys marker keeps a truncated row diagnosable.
 */
export const sanitizeCommandPayload = (
  command: object
): Record<string, unknown> => {
  const keys = Object.keys(command);
  const truncated = truncateDeep({ ...command }) as Record<string, unknown>;
  if (
    Buffer.byteLength(JSON.stringify(truncated), 'utf8') > MAX_PAYLOAD_BYTES
  ) {
    return { truncated: true, command_keys: keys };
  }
  return truncated;
};
