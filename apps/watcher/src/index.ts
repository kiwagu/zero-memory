#!/usr/bin/env bun
/**
 * zero-memory-watcher — transcript ingestion daemon.
 *
 * Tails coding-agent transcript files (default: ~/.claude/projects), chunks
 * the conversational text, and ships each chunk to the MCP server's
 * ingest_conversation tool over streamable HTTP.
 *
 * The command list, flags and env vars live in `./usage.ts` (what `help`
 * prints) — one source of truth, so this header cannot drift from the CLI.
 * Notes that belong to the code rather than the help text:
 *
 * - `watch` starts the only long-running process and must be named
 *   EXPLICITLY: a bare or unknown invocation prints usage and exits, so a
 *   typo or a misconfigured hook can never trip a daemon.
 * - The hook subcommands own STDOUT for their protocol frame, so they force
 *   logging to stderr (`LOG_STDERR`) before doing anything else.
 * - `help` and `version` are answered before any other work: they must still
 *   work on a machine that is not logged in, not deployed, and offline.
 */
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { createLogger, setLogContextResolver } from '@workspace/logger';
import {
  parseBootstrapArgs,
  runBootstrap,
} from './bootstrap/bootstrap-runner.js';
import { runBrief } from './brief/brief-runner.js';
import { runGuide } from './guide/guide-runner.js';
import { runNudge } from './guide/nudge-runner.js';
import { parseHooksArgs, runHooks } from './hooks/hooks-runner.js';
import { parseImportArgs, runImport } from './import/import-runner.js';
import {
  runCheckpoint,
  runPostCompact,
} from './checkpoint/checkpoint-runner.js';
import { runStopIngest } from './ingest-hook/ingest-hook-runner.js';
import { runCapture } from './capture/capture-runner.js';
import { runLogs } from './logs/logs-runner.js';
import { runReceipt } from './receipt/receipt-runner.js';
import { runStatus, runStatusJson } from './status/status-runner.js';
import { runWatcherLogin } from './login/login-runner.js';
import { IngestClient } from '@workspace/client-runtime';
import { clientKindFromArgs, hookClient } from './hook-client.js';
import { getRunId } from './run-context.js';
import { WATCHER_USAGE } from './usage.js';
import { resolveVersion, runVersion } from './version/version-runner.js';
import { TranscriptWatcher } from './watcher.js';

// The runtime log is ALWAYS on: a non-empty ZM_LOG_FILE overrides only the
// LOCATION; unset or empty falls back to the default path so it can never be
// silently turned off. Set before any log call so every subcommand (the daemon
// and the plugin's short-lived brief/ingest hooks) writes the same lines the
// console shows — the diagnostics a user hands over.
if (!process.env.ZM_LOG_FILE) {
  process.env.ZM_LOG_FILE = join(
    homedir(),
    '.local',
    'state',
    'zero-memory',
    'watcher.log'
  );
}

const logger = createLogger('watcher');

// Correlate every log line emitted during a scan pass with its run id.
setLogContextResolver(() => {
  const runId = getRunId();
  return runId ? { runId } : undefined;
});

const main = async (): Promise<void> => {
  const command = process.argv[2];

  // Standard CLI entry points, handled before anything else: they must answer
  // on a machine that is not logged in, not deployed and offline. Help goes to
  // STDOUT with exit 0 (it was asked for) — only the unknown-command path
  // below prints it to stderr as an error.
  if (command === 'help' || command === '--help' || command === '-h') {
    process.stdout.write(`${WATCHER_USAGE}\n`);
    return;
  }

  if (command === 'version' || command === '--version' || command === '-v') {
    runVersion();
    return;
  }

  // Tag every server request this process makes with the running version, so
  // the server logs which plugin/watcher version each request came from (an
  // old client still ingesting becomes identifiable). Resolved once here;
  // `createAuthedTransport` reads it for the `x-zm-client-version` header.
  process.env.ZM_CLIENT_VERSION ??= resolveVersion().version;

  if (command === 'login') {
    // `login <url>` adopts that server (checked, then persisted) and authorizes
    // in one step; bare `login` reuses this machine's configured address.
    // Tokens are stored per server URL, so an e2e login never touches the real
    // server's credentials (and vice versa).
    await runWatcherLogin(process.argv.slice(3));
    return;
  }

  if (command === 'import') {
    await runImport(parseImportArgs(process.argv.slice(3)));
    return;
  }

  if (command === 'bootstrap') {
    await runBootstrap(parseBootstrapArgs(process.argv.slice(3)));
    return;
  }

  if (command === 'brief') {
    // A hook reads stdout for its protocol frame, so keep it clean: route any
    // log line (e.g. an OAuth token refresh) to stderr for this subcommand.
    // `--client cursor` reads a Cursor payload and emits a Cursor frame.
    process.env.LOG_STDERR = '1';
    await runBrief(
      process.argv[3] === 'task' ? 'task' : 'session-start',
      hookClient(clientKindFromArgs(process.argv.slice(3)))
    );
    return;
  }

  if (command === 'ingest') {
    // Stop-hook one-shot ingest (event-driven alternative to the watch daemon).
    // `--client cursor` reads a Cursor hook payload + transcript instead.
    process.env.LOG_STDERR = '1';
    await runStopIngest(hookClient(clientKindFromArgs(process.argv.slice(3))));
    return;
  }

  if (command === 'checkpoint') {
    // Compaction-boundary one-shot. Its anchor is BARE text on stdout, not a
    // JSON frame — that channel is handed to the summarizing model unparsed —
    // so keeping logs off stdout matters here as much as for the framed hooks.
    process.env.LOG_STDERR = '1';
    const adapter = hookClient(clientKindFromArgs(process.argv.slice(3)));
    if (process.argv[3] === 'post') await runPostCompact(adapter);
    else await runCheckpoint(adapter);
    return;
  }

  if (command === 'guide') {
    // Emit the machine-independent memory-first mandate as a hook's
    // additionalContext (wire on SessionStart) — a portable alternative to
    // patching ~/.claude/CLAUDE.md. `--client cursor` emits a Cursor frame.
    process.env.LOG_STDERR = '1';
    await runGuide(hookClient(clientKindFromArgs(process.argv.slice(3))));
    return;
  }

  if (command === 'nudge') {
    // PreToolUse companion: once-per-session "recall first" reminder on code
    // search (grep/glob). Keeps stdout for the frame; logs to stderr.
    process.env.LOG_STDERR = '1';
    await runNudge(hookClient(clientKindFromArgs(process.argv.slice(3))));
    return;
  }

  if (command === 'capture') {
    // Interactive quick-capture: stdout is the human result line, so logs go
    // to stderr like the hook subcommands.
    process.env.LOG_STDERR = '1';
    await runCapture(process.argv.slice(3));
    return;
  }

  if (command === 'receipt') {
    // SessionEnd one-shot: the session value receipt as a chat systemMessage
    // (Claude); on Cursor sessionEnd is fire-and-forget, so it is log-only.
    process.env.LOG_STDERR = '1';
    await runReceipt(hookClient(clientKindFromArgs(process.argv.slice(3))));
    return;
  }

  if (command === 'status') {
    process.env.LOG_STDERR = '1';
    // `status --json`: a one-shot classified probe printed to STDOUT (for a
    // session or script to poll), instead of the UserPromptSubmit hook frame.
    if (process.argv.slice(3).includes('--json')) {
      await runStatusJson();
      return;
    }
    // UserPromptSubmit trailer: surface the SPECIFIC server state (down /
    // unauthenticated / server-error / …) into the turn. Keeps stdout for the
    // frame; logs to stderr.
    await runStatus(hookClient(clientKindFromArgs(process.argv.slice(3))));
    return;
  }

  if (command === 'hooks') {
    // Print the hook set an installer should apply (`--profile`), or check what
    // is actually wired on this machine (`--check`). Both are plain stdout, not
    // a hook frame — no client payload is read.
    runHooks(parseHooksArgs(process.argv.slice(3)));
    return;
  }

  if (command === 'logs') {
    // Print/tail the runtime log to stdout — live diagnostics without --debug.
    await runLogs(
      process.argv.includes('-f') || process.argv.includes('--follow')
    );
    return;
  }

  // The long-running daemon must be launched EXPLICITLY with `watch` — never as
  // a bare/fallthrough default. So a misconfigured or accidental invocation
  // (and the plugin's short-lived brief/ingest hooks) can never trip a daemon.
  if (command !== 'watch') {
    console.error(
      (command === undefined
        ? WATCHER_USAGE
        : `zero-memory-watcher: unknown command "${command}"\n\n${WATCHER_USAGE}`) +
        '\n'
    );
    process.exit(1);
  }

  // `watch` takes one optional positional: the directory. Flags are not dirs —
  // `watch --help` must print usage, not "Watch directory does not exist: --help".
  const watchArg = process.argv[3];
  if (watchArg === '--help' || watchArg === '-h') {
    console.log(`usage: zero-memory-watcher watch [dir]\n\n${WATCHER_USAGE}`);
    return;
  }
  if (watchArg?.startsWith('-')) {
    console.error(
      `zero-memory-watcher watch: unknown flag "${watchArg}" (takes only [dir])`
    );
    process.exit(1);
  }
  const watchDir = watchArg ?? join(homedir(), '.claude', 'projects');
  if (!existsSync(watchDir)) {
    throw new Error(`Watch directory does not exist: ${watchDir}`);
  }

  // Announce which build is running the moment the daemon starts: the binary
  // hash churns on every rebuild, so this human-readable version+origin is the
  // identity an operator reads from the log to know what is actually watching.
  const version = resolveVersion();
  logger.info('starting watcher', {
    version: version.version,
    origin: version.origin,
    watchDir,
  });

  const client = new IngestClient();
  const watcher = new TranscriptWatcher({
    watchDir,
    // The daemon has no session receipt — the response counters are unused.
    sendChunk: async (input) => {
      await client.sendChunk(input);
    },
  });

  const shutdown = async (): Promise<void> => {
    logger.info('shutting down');
    await watcher.stop();
    await client.close();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown());
  process.on('SIGTERM', () => void shutdown());

  await watcher.start();
};

main().catch((error: unknown) => {
  logger.error('watcher failed', { error: String(error) });
  process.exit(1);
});
