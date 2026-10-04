/** Per-string-field cap: long values are clipped to this many characters. */
export const MAX_STRING_LENGTH = 500;

/** Hard cap on the serialized payload; past this it collapses to a marker. */
export const MAX_PAYLOAD_BYTES = 8 * 1024;

/**
 * Keys whose value is something a person or an agent WROTE — a memory's text,
 * a transcript, a card's words, a name — rather than an identifier or a
 * choice. The log keeps that such a value was sent and how long it was, never
 * the value itself: a write the content guard refused for carrying a secret
 * still passes through here on its way to the error row, and the log outlives
 * the account that produced it.
 */
const CONTENT_KEYS = new Set([
  'content',
  'verbatim',
  'transcript_chunk',
  'transcriptChunk',
  'body',
  'title',
  'text',
  'reason',
  'description',
  'rule_text',
  'ruleText',
  'name',
  'source',
  'apiKey',
  'api_key',
]);

const clip = (value: string): string =>
  value.length > MAX_STRING_LENGTH
    ? `${value.slice(0, MAX_STRING_LENGTH)}…[${value.length - MAX_STRING_LENGTH} more]`
    : value;

const redact = (value: string): string => `[content, ${value.length} chars]`;

const sanitizeDeep = (value: unknown, key?: string): unknown => {
  if (typeof value === 'string') {
    return key !== undefined && CONTENT_KEYS.has(key)
      ? redact(value)
      : clip(value);
  }
  if (Array.isArray(value)) {
    return value.map((item) => sanitizeDeep(item, key));
  }
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [innerKey, inner] of Object.entries(value)) {
      out[innerKey] = sanitizeDeep(inner, innerKey);
    }
    return out;
  }
  return value;
};

/**
 * Turn a command instance into a safe, size-bounded audit payload:
 *   1. copy its own enumerable properties; a field someone wrote (see
 *      {@link CONTENT_KEYS}) is replaced by its length, every other string is
 *      clipped to {@link MAX_STRING_LENGTH};
 *   2. if the serialized result still exceeds {@link MAX_PAYLOAD_BYTES}, drop
 *      it entirely for a `{ truncated: true, command_keys: [...] }` marker.
 *
 * What remains names the operation — ids, kinds, scopes, choices — which is
 * what an audit answers; the words themselves live in the rows they created.
 */
export const sanitizeCommandPayload = (
  command: object
): Record<string, unknown> => {
  const keys = Object.keys(command);
  const sanitized = sanitizeDeep({ ...command }) as Record<string, unknown>;
  if (
    Buffer.byteLength(JSON.stringify(sanitized), 'utf8') > MAX_PAYLOAD_BYTES
  ) {
    return { truncated: true, command_keys: keys };
  }
  return sanitized;
};
