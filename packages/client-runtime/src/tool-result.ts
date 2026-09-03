import { toolErrorSchema } from '@workspace/contracts';

/**
 * Extracting the JSON payload from a zero-memory MCP tool result.
 *
 * The server returns the payload as the FIRST text content block and appends
 * any human/model notes — a promoted project-rules block, the remember
 * reminder — as SEPARATE trailing blocks. So the ONLY correct extraction is to
 * parse the first block. The older heuristic (join every block, then slice on
 * the first `\n---`) corrupted the payload whenever a note block preceded the
 * reminder's rule, or a memory body itself contained a `---` line: the slice
 * then cut mid-JSON and parsing threw, which upstream silently degraded to an
 * "offline" fallback even though the server had answered fine.
 */

interface TextBlock {
  readonly type: string;
  readonly text?: string;
}

// The SDK's CallToolResult is a rich, index-signatured type; these parsers sit
// at that boundary, so they take `unknown` and narrow internally rather than
// couple to the SDK's exact shape.
const contentOf = (result: unknown): TextBlock[] => {
  const content = (result as { content?: unknown } | null)?.content;
  return Array.isArray(content) ? (content as TextBlock[]) : [];
};

/** The text blocks of a tool result, in server order (non-text blocks dropped). */
export const toolTextBlocks = (result: unknown): string[] =>
  contentOf(result)
    .filter((item) => item.type === 'text' && typeof item.text === 'string')
    .map((item) => item.text as string);

/**
 * Human-readable prose out of a FAILED tool result (`isError`). The server
 * reports failures as a taxonomy body — `{error:{code,message}}` — so the raw
 * text is JSON; this unwraps it to the message a person should read. Anything
 * that is not that shape is passed through unchanged, so an unexpected failure
 * still surfaces whatever the server said.
 */
export const toolErrorMessage = (result: unknown): string => {
  const text = toolTextBlocks(result).join('\n');
  try {
    const parsed = toolErrorSchema.safeParse(JSON.parse(text));
    return parsed.success ? parsed.data.error.message : text;
  } catch {
    return text;
  }
};

/**
 * The parsed JSON payload of a tool result — always its first text block.
 * Throws when there is no text content (a malformed result the caller should
 * treat as a failure, not as an empty payload).
 */
export const parseToolPayload = <T = unknown>(result: unknown): T => {
  const [payload] = toolTextBlocks(result);
  if (payload === undefined) {
    throw new Error('tool result contained no text content');
  }
  return JSON.parse(payload) as T;
};
