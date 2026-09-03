#!/usr/bin/env bun
/**
 * Stop hook example: when the agent finishes responding, ship the new part
 * of the session transcript to the ingest_conversation tool so durable facts
 * are extracted and remembered automatically.
 *
 * Per-transcript byte offsets persist in the state directory, so each Stop
 * only sends what was added since the previous one; the server-side chunk
 * hash makes retries idempotent. Failures are silent (exit 0) — a down
 * memory server must never block the session.
 */
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join } from 'node:path';

import { callMcpTool, readHookEnv, readStdinJson } from './mcp-http-call.js';

const statePath = join(
  process.env.XDG_STATE_HOME ?? join(homedir(), '.local', 'state'),
  'zero-memory',
  'hook-offsets.json'
);

const loadOffsets = (): Record<string, number> => {
  try {
    return JSON.parse(readFileSync(statePath, 'utf8')) as Record<
      string,
      number
    >;
  } catch {
    return {};
  }
};

const saveOffsets = (offsets: Record<string, number>): void => {
  mkdirSync(dirname(statePath), { recursive: true });
  writeFileSync(statePath, JSON.stringify(offsets, null, 2));
};

/** user/assistant text lines only — tool traffic and meta lines are noise. */
const extractText = (jsonl: string): string => {
  const lines: string[] = [];
  for (const raw of jsonl.split('\n')) {
    if (raw.trim().length === 0) continue;
    let parsed: {
      type?: string;
      isMeta?: boolean;
      message?: {
        content?: string | Array<{ type?: string; text?: string }>;
      };
    };
    try {
      parsed = JSON.parse(raw) as typeof parsed;
    } catch {
      continue;
    }
    if (
      parsed.isMeta ||
      (parsed.type !== 'user' && parsed.type !== 'assistant')
    ) {
      continue;
    }
    const content = parsed.message?.content;
    const text =
      typeof content === 'string'
        ? content
        : (content ?? [])
            .filter((item) => item.type === 'text' && item.text)
            .map((item) => item.text!)
            .join('\n');
    if (text.trim().length > 0) {
      lines.push(`${parsed.type}: ${text.trim()}`);
    }
  }
  return lines.join('\n');
};

const main = async (): Promise<void> => {
  const payload = await readStdinJson();
  const transcriptPath =
    typeof payload.transcript_path === 'string' ? payload.transcript_path : '';
  if (!transcriptPath) return;

  const raw = readFileSync(transcriptPath, 'utf8');
  const offsets = loadOffsets();
  const offset = offsets[transcriptPath] ?? 0;
  const fresh = raw.slice(offset);
  if (fresh.trim().length === 0) return;

  const chunk = extractText(fresh);
  if (chunk.length === 0) {
    offsets[transcriptPath] = raw.length;
    saveOffsets(offsets);
    return;
  }

  const sessionId =
    typeof payload.session_id === 'string'
      ? payload.session_id
      : basename(transcriptPath, '.jsonl');
  const cwd = typeof payload.cwd === 'string' ? payload.cwd : process.cwd();

  await callMcpTool(readHookEnv(), 'ingest_conversation', {
    transcript_chunk: chunk,
    chunk_hash: createHash('sha256').update(chunk, 'utf8').digest('hex'),
    client: 'claude-code-stop-hook',
    conversation_id: sessionId,
    project_hint: cwd,
  });

  offsets[transcriptPath] = raw.length;
  saveOffsets(offsets);
};

main().catch(() => {
  // Best-effort: ingestion problems must never block the session.
  process.exit(0);
});
