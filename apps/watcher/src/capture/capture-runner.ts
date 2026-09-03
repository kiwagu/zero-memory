import { createLogger } from '@workspace/logger';

import { E2E_SERVER_URL } from '@workspace/client-runtime';
import {
  CAPTURE_USAGE,
  parseCaptureArgs,
  type CaptureArgs,
} from './capture-args.js';
import { callRemember } from '@workspace/client-runtime';

const logger = createLogger('capture');

/**
 * `capture` — the quick-capture CLI (`zm "fact"`): an instant `remember` from
 * any terminal, no agent session needed. The binary is already the machine's
 * authenticated OAuth client, so this is transport only — the content rides
 * the FULL standard write path server-side (content guard, embedder,
 * canonicalization, dedup).
 *
 * Scope default is the PROJECT resolved from the current directory: the cwd
 * travels as `project_hint` and the server routes it through the same project
 * bindings ingest uses (deterministic — no dependency on the async MCP roots
 * handshake). `--task` is the write-side entry for open loops: the captured
 * task surfaces in every briefing until closed.
 *
 * Unlike the hook subcommands this one is INTERACTIVE: it prints a human
 * result line and exits non-zero on failure — a swallowed error would make
 * the user think the fact was saved when it was not. Nothing is buffered
 * offline: a down server means "nothing written", said explicitly.
 */
export const runCapture = async (argv: readonly string[]): Promise<void> => {
  const parsed = parseCaptureArgs(argv);
  if ('error' in parsed) {
    console.error(`✗ ${parsed.error}\n\n${CAPTURE_USAGE}`);
    process.exitCode = 1;
    return;
  }
  const args: CaptureArgs = parsed;

  try {
    const result = await callRemember(
      {
        content: args.content,
        ...(args.kind !== undefined ? { kind: args.kind } : {}),
        ...(args.scope !== undefined
          ? { scope: args.scope }
          : { project_hint: process.cwd() }),
      },
      args.e2e ? E2E_SERVER_URL : undefined
    );

    const landed = result.scope ? ` → ${result.scope}` : '';
    const loopNote =
      args.kind === 'task' || args.kind === 'open-question'
        ? ' (open loop: surfaces in briefings until closed)'
        : '';
    console.log(
      result.deduplicated
        ? `✓ already known as ${result.memory_id}${landed}`
        : `✓ remembered ${result.memory_id}${landed}${loopNote}`
    );
    logger.info('capture done', {
      memoryId: result.memory_id,
      deduplicated: result.deduplicated ?? false,
      kind: args.kind ?? 'fact',
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`✗ not saved: ${message}`);
    logger.warn('capture failed', { error: message });
    process.exitCode = 1;
  }
};
